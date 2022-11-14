import test from 'node:test';
import assert from 'node:assert/strict';
import { replayOutages, TOOL_ID } from '../src/index.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policy = { schemaVersion: '1', maxRetries: 2, timeoutMs: 100, latencyBudgetMs: 300, fallback: 'cached' };
const scenario = { id: 'dependency-a', attempts: [{ outcome: 'timeout', latencyMs: 100 }, { outcome: 'unavailable', latencyMs: 20 }, { outcome: 'malformed', latencyMs: 20 }], observed: { attemptCount: 3, fallback: 'cached', operatorSignalled: true, totalLatencyMs: 140 } };
const exportDoc = { schemaVersion: '1', complete: true, scenarios: [scenario] };

test('captured local failures deterministically require fallback and operator signal', () => {
  const report = replayOutages(exportDoc, policy);
  assert.equal(TOOL_ID, 'third-party-outage-replay');
  assert.equal(report.status, 'pass');
  assert.equal(report.replays[0].terminal, 'failed');
  assert.equal(report.replays[0].expectedFallback, 'cached');
  assert.equal(JSON.stringify(report).includes('dependency-a'), false);
});

test('failed dependency exceeding retry limit fails at scenario ordinal', () => {
  const extra = { ...scenario, attempts: [...scenario.attempts, { outcome: 'unavailable', latencyMs: 20 }], observed: { ...scenario.observed, attemptCount: 4, totalLatencyMs: 160 } };
  const report = replayOutages({ ...exportDoc, scenarios: [extra] }, policy);
  assert.equal(report.status, 'fail');
  assert.equal(report.findings[0].ruleId, 'retry-limit-exceeded');
  assert.equal(report.findings[0].location.pointer, '/scenarios/0');
});

test('wrong fallback or missing operator signal fails; missing observed evidence is incomplete', () => {
  assert.equal(replayOutages({ ...exportDoc, scenarios: [{ ...scenario, observed: { ...scenario.observed, fallback: 'error' } }] }, policy).status, 'fail');
  assert.equal(replayOutages({ ...exportDoc, scenarios: [{ ...scenario, observed: { ...scenario.observed, operatorSignalled: false } }] }, policy).status, 'fail');
  assert.equal(replayOutages({ ...exportDoc, scenarios: [{ ...scenario, observed: undefined }] }, policy).status, 'incomplete');
});

test('successful attempt stops replay without fallback', () => {
  const success = { ...scenario, attempts: [{ outcome: 'unavailable', latencyMs: 20 }, { outcome: 'success', latencyMs: 30 }], observed: { attemptCount: 2, fallback: 'none', operatorSignalled: false, totalLatencyMs: 50 } };
  const report = replayOutages({ ...exportDoc, scenarios: [success] }, policy);
  assert.equal(report.status, 'pass');
  assert.equal(report.replays[0].terminal, 'recovered');
});

test('scenario and attempt N/N+1, depth N/N+1, and injected deadline N/N+1', () => {
  const scenarios = n => ({ ...exportDoc, scenarios: Array.from({ length: n }, (_, i) => ({ ...scenario, id: `scenario-${i}` })) });
  assert.equal(replayOutages(scenarios(1000), policy).status, 'pass');
  assert.equal(replayOutages(scenarios(1001), policy).status, 'incomplete');
  const ten = { ...scenario, attempts: Array.from({ length: 10 }, () => ({ outcome: 'unavailable', latencyMs: 1 })), observed: { attemptCount: 10, fallback: 'cached', operatorSignalled: true, totalLatencyMs: 10 } };
  const more = n => ({ ...exportDoc, scenarios: Array.from({ length: 500 }, (_, i) => ({ ...ten, id: `scenario-${i}`, attempts: i === 499 ? [...ten.attempts, ...Array.from({ length: n - 5000 }, () => ({ outcome: 'unavailable', latencyMs: 1 }))] : ten.attempts, observed: i === 499 ? { ...ten.observed, attemptCount: 10 + n - 5000, totalLatencyMs: 10 + n - 5000 } : ten.observed })) });
  assert.equal(replayOutages(more(5000), { ...policy, maxRetries: 10 }).status, 'pass');
  assert.equal(replayOutages(more(5001), { ...policy, maxRetries: 10 }).status, 'incomplete');
  const nested = n => { const d = structuredClone(exportDoc); let x = d; for (let i = 0; i < n; i++) { x.extra = {}; x = x.extra; } return d; };
  assert.equal(replayOutages(nested(16), policy).findings[0].ruleId, 'export-invalid');
  assert.equal(replayOutages(nested(17), policy).findings[0].ruleId, 'limit-exceeded');
  assert.equal(replayOutages(exportDoc, policy, { now: () => 5000, deadline: 5000 }).status, 'pass');
  assert.equal(replayOutages(exportDoc, policy, { now: () => 5001, deadline: 5000 }).status, 'incomplete');
});

test('timeout and latency bounds fail; partial export is unknown', () => {
  const late = { ...scenario, attempts: [{ outcome: 'timeout', latencyMs: 101 }], observed: { attemptCount: 1, fallback: 'cached', operatorSignalled: true, totalLatencyMs: 301 } };
  const report = replayOutages({ ...exportDoc, scenarios: [late] }, policy);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.findings.map(f => f.ruleId), ['latency-budget-exceeded', 'timeout-exceeded']);
  assert.equal(replayOutages({ ...exportDoc, complete: false }, policy).status, 'incomplete');
});

test('CLI config errors are empty stdout; unreadable export is an incomplete report', () => {
  const root = mkdtempSync(join(tmpdir(), 'outage-test-'));
  writeFileSync(join(root, 'policy.json'), JSON.stringify(policy));
  const run = (...args) => spawnSync(process.execPath, ['bin/third-party-outage-replay.mjs', '--root', root, ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  const bad = run('--policy', 'policy.json', '--unknown', 'x');
  assert.equal(bad.status, 2); assert.equal(bad.stdout, '');
  const missing = run('--policy', 'policy.json', '--export', 'missing.json');
  assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).status, 'incomplete');
  const outside = mkdtempSync(join(tmpdir(), 'outage-out-'));
  writeFileSync(join(outside, 'export.json'), JSON.stringify(exportDoc));
  symlinkSync(join(outside, 'export.json'), join(root, 'link.json'));
  const escape = run('--policy', 'policy.json', '--export', 'link.json');
  assert.equal(escape.status, 2); assert.equal(escape.stdout, '');
});

test('export byte N/N+1, strict UTF-8 and duplicate completeness keys', () => {
  const root = mkdtempSync(join(tmpdir(), 'outage-bytes-'));
  writeFileSync(join(root, 'policy.json'), JSON.stringify(policy));
  const plain = JSON.stringify(exportDoc);
  const run = () => spawnSync(process.execPath, ['bin/third-party-outage-replay.mjs', '--root', root, '--policy', 'policy.json', '--export', 'export.json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  writeFileSync(join(root, 'export.json'), plain + ' '.repeat(1048576 - Buffer.byteLength(plain)));
  assert.equal(run().status, 0);
  writeFileSync(join(root, 'export.json'), plain + ' '.repeat(1048577 - Buffer.byteLength(plain)));
  assert.equal(JSON.parse(run().stdout).findings[0].ruleId, 'limit-exceeded');
  writeFileSync(join(root, 'export.json'), Buffer.from([0xff]));
  assert.equal(JSON.parse(run().stdout).findings[0].ruleId, 'input-unreadable');
  for (const raw of [plain.replace('"complete":true', '"complete":false,"complete":true'), plain.replace('"complete":true', '"com\\u0070lete":false,"complete":true')]) {
    writeFileSync(join(root, 'export.json'), raw);
    assert.equal(JSON.parse(run().stdout).findings[0].ruleId, 'duplicate-key');
  }
});

test('policy byte N/N+1 and duplicate keys are invalid configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'outage-policy-bytes-'));
  const plain = JSON.stringify(policy);
  writeFileSync(join(root, 'export.json'), JSON.stringify(exportDoc));
  const run = () => spawnSync(process.execPath, ['bin/third-party-outage-replay.mjs', '--root', root, '--policy', 'policy.json', '--export', 'export.json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  writeFileSync(join(root, 'policy.json'), plain + ' '.repeat(65536 - Buffer.byteLength(plain)));
  assert.equal(run().status, 0);
  writeFileSync(join(root, 'policy.json'), plain + ' '.repeat(65537 - Buffer.byteLength(plain)));
  const over = run(); assert.equal(over.status, 2); assert.equal(over.stdout, '');
  writeFileSync(join(root, 'policy.json'), plain.replace('"schemaVersion":"1"', '"schemaVersion":"0","schemaVersion":"1"'));
  const duplicate = run(); assert.equal(duplicate.status, 2); assert.equal(duplicate.stdout, '');
});

test('reports never echo scenario IDs or raw mock data', () => {
  const secret = 'canary-private-value';
  const suspect = { ...scenario, id: secret, extra: secret };
  const report = replayOutages({ ...exportDoc, scenarios: [suspect] }, policy);
  assert.equal(report.status, 'incomplete');
  assert.equal(JSON.stringify(report).includes(secret), false);
});
