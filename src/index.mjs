export const TOOL_ID = 'third-party-outage-replay';
export const LIMITS = Object.freeze({ exportBytes: 1048576, policyBytes: 65536, depth: 16, scenarios: 1000, attempts: 5000, milliseconds: 5000 });
export const RULES = Object.freeze({ 'policy-invalid': 'warning', 'export-invalid': 'warning', 'export-incomplete': 'warning', 'no-evidence': 'warning', 'scenario-invalid': 'warning', 'observation-missing': 'warning', 'observation-inconsistent': 'warning', 'retry-limit-exceeded': 'error', 'timeout-exceeded': 'error', 'fallback-mismatch': 'error', 'operator-signal-missing': 'error', 'latency-budget-exceeded': 'error', 'limit-exceeded': 'warning', 'input-unreadable': 'warning', 'duplicate-key': 'warning' });
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const id = x => typeof x === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(x);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function depth(value) {
  const stack = [[value, 0, new Set()]];
  while (stack.length) {
    const [x, n, ancestors] = stack.pop();
    if (n > LIMITS.depth) return n;
    if (x && typeof x === 'object') {
      if (ancestors.has(x)) return LIMITS.depth + 1;
      const next = new Set(ancestors); next.add(x);
      for (const child of Object.values(x)) stack.push([child, n + 1, next]);
    }
  }
  return 0;
}
export function validPolicy(p) { return obj(p) && Object.keys(p).every(k => ['schemaVersion', 'maxRetries', 'timeoutMs', 'latencyBudgetMs', 'fallback'].includes(k)) && p.schemaVersion === '1' && Number.isSafeInteger(p.maxRetries) && p.maxRetries >= 0 && p.maxRetries <= 10 && Number.isSafeInteger(p.timeoutMs) && p.timeoutMs >= 1 && p.timeoutMs <= 60000 && Number.isSafeInteger(p.latencyBudgetMs) && p.latencyBudgetMs >= 1 && p.latencyBudgetMs <= 300000 && ['cached', 'error'].includes(p.fallback); }

export function replayOutages(exportDoc, policy, { now = Date.now, deadline = now() + LIMITS.milliseconds } = {}) {
  const findings = [], replays = [];
  const add = (ruleId, pointer, message, file = '@export') => {
    if (!Object.hasOwn(RULES, ruleId)) throw new Error('unknown rule');
    findings.push({ ruleId, severity: RULES[ruleId], message, location: { file, pointer } });
  };
  const finish = checked => {
    findings.sort((a, b) => cmp(a.location.file, b.location.file) || cmp(a.location.pointer, b.location.pointer) || cmp(a.ruleId, b.ruleId));
    return { schemaVersion: '1', tool: TOOL_ID, status: findings.some(f => f.severity === 'warning') ? 'incomplete' : findings.length ? 'fail' : 'pass', summary: { checked, errors: findings.filter(f => f.severity === 'error').length, warnings: findings.filter(f => f.severity === 'warning').length }, findings, replays };
  };
  if (!validPolicy(policy)) { add('policy-invalid', '', 'Outage replay policy is invalid', '@policy'); return finish(0); }
  if (depth(exportDoc) > LIMITS.depth) { add('limit-exceeded', '', 'JSON depth limit exceeded'); return finish(0); }
  if (!obj(exportDoc) || !Object.keys(exportDoc).every(k => ['schemaVersion', 'complete', 'scenarios'].includes(k)) || exportDoc.schemaVersion !== '1' || typeof exportDoc.complete !== 'boolean' || !Array.isArray(exportDoc.scenarios)) { add('export-invalid', '', 'Captured outage export is invalid'); return finish(0); }
  if (exportDoc.scenarios.length > LIMITS.scenarios) { add('limit-exceeded', '/scenarios', 'Scenario record limit exceeded'); return finish(0); }
  if (!exportDoc.scenarios.length) { add('no-evidence', '/scenarios', 'At least one captured scenario is required'); return finish(0); }
  if (!exportDoc.complete) add('export-incomplete', '/complete', 'Export declares partial scenario coverage');
  const ids = new Set();
  let attempts = 0;
  for (let i = 0; i < exportDoc.scenarios.length; i++) {
    if (now() > deadline) { add('limit-exceeded', '', 'Evaluation time limit exceeded'); return finish(i); }
    const s = exportDoc.scenarios[i], pointer = `/scenarios/${i}`;
    if (!obj(s) || !Object.keys(s).every(k => ['id', 'attempts', 'observed'].includes(k)) || !id(s.id) || ids.has(s.id) || !Array.isArray(s.attempts) || !s.attempts.length) { add('scenario-invalid', pointer, 'Scenario identity or attempts are invalid'); continue; }
    ids.add(s.id);
    attempts += s.attempts.length;
    if (attempts > LIMITS.attempts) { add('limit-exceeded', '/scenarios', 'Attempt record limit exceeded'); return finish(i); }
    let bad = false, firstSuccess = -1, sum = 0;
    for (let j = 0; j < s.attempts.length; j++) {
      const a = s.attempts[j];
      if (!obj(a) || !Object.keys(a).every(k => ['outcome', 'latencyMs'].includes(k)) || !['timeout', 'unavailable', 'malformed', 'success'].includes(a.outcome) || !Number.isSafeInteger(a.latencyMs) || a.latencyMs < 0) { bad = true; break; }
      if (a.outcome === 'success' && firstSuccess < 0) firstSuccess = j;
      sum += a.latencyMs;
      if (a.latencyMs > policy.timeoutMs) add('timeout-exceeded', `${pointer}/attempts/${j}`, 'Attempt exceeded configured timeout');
    }
    if (bad || (firstSuccess >= 0 && firstSuccess !== s.attempts.length - 1)) { add('scenario-invalid', pointer, 'Attempt sequence or outcome is invalid'); continue; }
    const o = s.observed;
    if (!obj(o) || !Object.keys(o).every(k => ['attemptCount', 'fallback', 'operatorSignalled', 'totalLatencyMs'].includes(k)) || !Number.isSafeInteger(o.attemptCount) || o.attemptCount < 1 || !['cached', 'error', 'none'].includes(o.fallback) || typeof o.operatorSignalled !== 'boolean' || !Number.isSafeInteger(o.totalLatencyMs) || o.totalLatencyMs < 0) { add('observation-missing', `${pointer}/observed`, 'Application observation is missing or unusable'); continue; }
    if (o.attemptCount !== s.attempts.length || o.totalLatencyMs < sum) add('observation-inconsistent', `${pointer}/observed`, 'Observed count or latency conflicts with captured attempts');
    if (s.attempts.length > policy.maxRetries + 1) add('retry-limit-exceeded', pointer, 'Attempt sequence exceeded configured retry limit');
    const terminal = firstSuccess >= 0 ? 'recovered' : 'failed', expectedFallback = terminal === 'failed' ? policy.fallback : 'none';
    if (o.fallback !== expectedFallback) add('fallback-mismatch', pointer, 'Application fallback differs from deterministic policy');
    if (terminal === 'failed' && !o.operatorSignalled) add('operator-signal-missing', pointer, 'Failed dependency did not produce an operator signal');
    if (o.totalLatencyMs > policy.latencyBudgetMs) add('latency-budget-exceeded', pointer, 'Observed latency exceeded policy budget');
    replays.push({ location: { file: '@export', pointer }, terminal, expectedFallback, failedAttempts: s.attempts.filter(a => a.outcome !== 'success').length, observedLatencyMs: o.totalLatencyMs });
  }
  return finish(exportDoc.scenarios.length);
}
