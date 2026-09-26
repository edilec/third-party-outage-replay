# Third-Party Outage Replay

`TOOL_ID=third-party-outage-replay`. A zero-dependency Node 22+ offline reporter for exported local dependency-failure mock traces and observed application behavior. It does not call, slow, disrupt, or retry an external dependency. The export is evidence supplied by a separate local harness; this tool checks it against bounded retry, timeout, fallback, latency and operator-signal policy.

```sh
node bin/third-party-outage-replay.mjs --root examples/passing --policy policy.json --export export.json
node bin/third-party-outage-replay.mjs --root examples/failing --policy policy.json --export export.json
```

The first example exits 0 after three captured failed attempts and matching `cached` fallback. The second exits 1 with `retry-limit-exceeded` at `/scenarios/0`. `@export` and `@policy` are logical source roles, not host paths; pointers locate records in the exact input file named at invocation. Reports never echo scenario IDs, mock payloads or source file paths.

## Export contract

Policy: `{"schemaVersion":"1","maxRetries":2,"timeoutMs":100,"latencyBudgetMs":300,"fallback":"cached"}`. `maxRetries` is 0–10, so the allowed attempt count is `maxRetries + 1`; `timeoutMs` is 1–60,000 and `latencyBudgetMs` is 1–300,000. Fallback is `cached` or `error`. Unknown policy keys are invalid configuration.

Export: `{"schemaVersion":"1","complete":true,"scenarios":[...]}`. At least one scenario and explicit `complete:true` are required for pass. A scenario has a unique slug `id`, a nonempty `attempts` array, and `observed`. Each attempt is `{outcome,latencyMs}`, with outcome `timeout`, `unavailable`, `malformed`, or `success` and nonnegative integer latency. A `success` must be the last attempted outcome. `observed` has `attemptCount`, `fallback` (`cached`, `error`, `none`), `operatorSignalled` boolean, and `totalLatencyMs`. Unsupported keys at every export level are incomplete rather than silently ignored.

For an all-failed trace the expected fallback is the policy fallback and an operator signal must be recorded; for a trace ending in success the expected fallback is `none`. The auditor compares the observed count with captured attempts, requires observed latency to cover their sum, flags any attempt above `timeoutMs`, and checks the total against `latencyBudgetMs`. It never manufactures an approval or a fallback; it reports what the export says the application did. `replays` contains only terminal state, expected fallback, failed-attempt count, observed numeric latency and source ordinal.

## Rules and exits

| Rule | Severity | Meaning |
| --- | --- | --- |
| `retry-limit-exceeded`, `timeout-exceeded`, `fallback-mismatch`, `operator-signal-missing`, `latency-budget-exceeded` | error | Captured application behavior violates policy. |
| `policy-invalid`, `export-invalid`, `scenario-invalid`, `observation-missing`, `observation-inconsistent` | warning | Configuration or captured observation unusable/contradictory. |
| `export-incomplete`, `no-evidence`, `limit-exceeded`, `input-unreadable`, `duplicate-key` | warning | Partial/vacuous/bounded input failure. |

Warnings make status `incomplete` and exit 2 even alongside policy errors. Otherwise errors make `fail` and exit 1; complete matching evidence makes `pass` and exit 0. Invalid CLI usage, root, escaped/symlinked path, or policy produce exit 2 with empty stdout and fixed stderr. Unreadable, undecodable, unparseable, oversized or duplicate-key export input emits an incomplete JSON report on stdout. JSON keys are compared after escape decoding, so contradictory `complete` fields cannot pass through last-value-wins parsing. Findings sort by code-unit `(source role, JSON pointer, rule)`.

## Limits and non-goals

Export 1,048,576 bytes; policy 65,536 bytes; JSON depth 16; 1,000 scenarios; 5,000 total attempts; 5,000 ms evaluation time with injected clock. Limits are inclusive; N+1 is incomplete for export evidence or invalid configuration for policy. Inputs are strict UTF-8 and realpath-confined inside `--root`. The tool writes nothing and makes no network calls. There is no mock server, live HTTP probe, retry scheduler, outage injector, production fallback execution, or assertion that a captured trace proves behavior outside the export. The library exports `TOOL_ID`, `LIMITS`, `RULES`, `validPolicy` and `replayOutages(exportDoc,policy,{now,deadline})`.

Run `npm run check` for syntax and behavioral tests.
