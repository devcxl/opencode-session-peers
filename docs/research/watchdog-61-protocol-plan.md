# #61 positive protocol plan (real host, candidate build)

Status: proposed, **not executed**. The parent owns the verification worktree,
the static candidate tuple and the decision to run. This plan does not change
the production whitelist, the live binary, the probe scripts or the UI.

## What this must prove

An actual `opencode` service process loads the **complete plugin entry**
`src/index.ts` and its real host adapters, service, observer, ledger, executor,
tool and RPC. The runner must not instantiate `createCorrectionExecutor` alone
or seed a grant/attempt and call it production acceptance.

The only source-level difference in the verification worktree is a static
candidate tuple added to `VERIFIED_APP_TUPLES` in
`src/watch/correction.ts`. No model input, config value or environment variable
can enable it. The production tree keeps the empty whitelist.

Measured candidate facts from the parent probe: `/usr/bin/opencode` 2.3.0,
linux/x64, embedded SQLite 3.53.4, WAL, `synchronous=2`, `busy_timeout=500`,
tmpfs. These prove a candidate runtime only; they do not prove the production
ledger/queue/receipt path or power-loss durability.

## Isolation and environment

- Scratch root via `mkdtemp` under `/tmp/opencode`; the caller sets
  `TMPDIR=/tmp` so the harness base is fixed. Scratch `HOME`, `TMPDIR`,
  `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`.
- Minimal whitelist base env: `PATH`, scratch `HOME`, scratch `TMPDIR`, locale,
  `TZ`. Do not inherit `OPENCODE_*`, provider keys,
  `SESSION_PEERS_WATCH_STATE_DIR` or any credential. No `authSource`; the
  offline stub uses the literal `stub` key only.
- Random loopback port, explicit client URL from the started instance, never
  `opencode api` or default service discovery. No request to the live URL.
- The instance is detached in its own process group. Stop must return
  `stopped=true` and `portClosed=true`; the live `service.json` digest must be
  identical before and after. Only then remove scratch. Never print a
  password, auth value, raw prompt or correlation in the report.
- Load trigger: after boot, call `models(projectA)` (a location-scoped
  request). Creating a session alone does not load the project plugin. Then
  create the session in `projectA` with the deterministic stub model.

## Deterministic stub

A research-only OpenAI-compatible stub under `scripts/research/watchdog-61/`
answers `/chat/completions`; it is not the fixed harness stub and never reaches
a paid model. It reads only the conversation the harness/host wrote:

1. A directive prompt makes the target session call
   `peers({ action: "watch", watch: { operation: "report", ... } })` for
   `begin`, so protocol participation is a real tool result.
2. The correction prompt written by the executor contains a concrete receipt
   JSON, the task id, state version, attempt id, ordinal and correlation. The
   stub parses that JSON and calls the **real** `peers` receipt tool with it;
   it does not receive those values from the runner.
3. After a receipt result with `continuePermit=true`, the stub calls
   `peers({ action: "watch", watch: { operation: "report", taskID,
   expectedVersion: <prompt state version>, kind: "progress", reportId,
   evidence: { summary, reference: "new-host-result" } } })`.
4. A later directive asks for the same receipt again (duplicate) or asks a
   second session to submit it with a different caller.

No runner direct tool invocation or forged tool context is used for receipt.

## Flow

1. RPC `watch` `enroll` as the controlled initiator with an explicit request id
   and goal. This must not start a prompt.
2. Prompt the target with the begin directive. The real tool result must show
   `Protocol participation: seen`; the turn ends normally.
3. RPC `watchGrant` `prepare` with
   `deployment: "single-host-same-location"`, then `confirm` with the challenge,
   generation, terms digest and same declaration. The response must show
   `mode=limited-correction`, `state=granted`, `actual` still closed until the
   runtime gate passes.
4. Wait for the configured trusted-idle window. Use a legal small test config
   only if the production parser accepts it (e.g. `idleMs: 2000`,
   `tickMs: 500`); otherwise use the bounded 2-minute window. Do not fake host
   timestamps or busy/idle.
5. The real executor (same application object) reserves, rechecks, claims and
   queues **once**. The target transcript must gain exactly one user message
   beginning `[session-peers correction]`, and the ledger must show exactly one
   permanent attempt used. Neither count may be zero or greater than one.
6. The stub parses the prompt and calls the real target tool receipt. Evidence:
   tool input has the prompt's task/attempt/correlation; metadata
   `continuePermit=true`; no correlation appears in a later `show`.
7. The stub posts new progress with a new reference. The ledger must mark
   `recovered`; the receipt alone must not.
8. Duplicate directive: a second real receipt call must return
   `continuePermit=false` and `duplicate=true`; after duplicate and wrong-caller
   phases, the correction-prompt count stays one and exactly one receipt result
   carried `continuePermit=true`.
9. Wrong caller: a second local session submits the same task/attempt/
   correlation. The real tool must return `E_WATCH_CALLER_MISMATCH`, with no
   permit and no ledger change.
10. Close the scratch session/service; verify child stop, closed port, closed
    stub port, and unchanged live-registry digest. Keep failure scratch without
    secrets if any step fails.

## Evidence split

- **Real host in this run:** full plugin load, target begin report, controlled
  grant RPC, trusted idle sample, one automatic queue, target tool receipt,
  duplicate receipt, wrong-caller receipt, progress/new-reference recovery,
  stop/port/registry isolation.
- **Already covered by unit/ledger/FakeHost evidence, not claimed real here:**
  receipt arriving before the delivery result, unknown delivery non-replay,
  SIGKILL after send/before accounting, stale generation, unsupported runtime
  downgrade, closing during an in-flight queue.
- The production build with the empty tuple must **not** queue at all. The
  runner should report that as a safe downgrade, not as a positive protocol
  pass.

## Commands (parent runs after review)

```bash
TMPDIR=/tmp WATCH61_POSITIVE_CONFIRM=1 \
WATCH61_VERIFICATION_PLUGIN=/path/to/verification-worktree \
bun scripts/research/watchdog-61/positive-runner.ts
```

The runner refuses to start without both the explicit confirmation and the
verification plugin path. It never modifies the candidate tuple.
