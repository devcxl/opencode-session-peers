# #61 positive protocol plan (real host, candidate build)

Status: executed by the parent; stock-host runs failed, while the first
version-distinct repaired-host candidate passed the positive protocol.
The parent owns the verification worktree and its static candidate tuple.
The production whitelist remains empty. No live binary or live session was
modified.

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

- **Real-host evidence passed on the repaired candidate below:** full plugin load, target begin report, controlled
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

## Measured blocker (2026-11-16)

Three isolated runs completed enrollment, a real target `begin` tool call and
controlled grant confirmation. None produced a correction or spent an attempt.
The short configuration was verified through RPC: `idleMs=2000`, `tickMs=500`.
Runtime, declaration, location, owner and protocol gates passed in the candidate
build. Observation and wait-completeness gates failed:

> session predates continuous observation; event-only wait sources incomplete

A metadata-only trace resolved the cause. The target's `session.created`,
inbox, step, text and tool events carried the expected scratch directory.
`session.execution.started`, `session.execution.succeeded` and
`session.usage.updated` had no location stamp. Under the approved source-evidence
policy, the observer invalidated its previously established lifecycle coverage.
This is not a SQLite failure, a missing grant, or proof of a busy target.

Each run stopped its own service and stub, verified both ports closed, and
preserved the live service registry digest. Failure scratch was retained.
No normal-user authentication was copied and no paid provider was called.

The stock-host positive protocol is **not accepted**. Do not add the stock tuple
to the production whitelist, synthesize missing event locations, or reinterpret the
single-host declaration as source proof. An equivalent trusted public signal
needs separate review; otherwise the host must supply the missing provenance.
The ticket remains incomplete while that support condition is unmet.

`WATCH61_TRACE_EVENTS=1` optionally loads the research event-shape fixture on a
future isolated run. It records only bounded event types, timestamps, location,
session identifiers and data-key names, never prompt text, tool inputs/results,
grant challenges or dispatch correlations. The fixture is not a production
adapter and does not modify events.

## Isolated host-source candidate

The user chose to repair the host source without weakening observation policy.
Official `anomalyco/opencode` tag `v2.3.0` (`a6b15d33`) is cloned in the
verification tree's `.host-source`; local commits `de70f4f` and `2df0262` stamp
execution and usage events from the Session's own placement. No schema or
protocol changed. The parent inspected all five changed files.

Targeted host tests: execution/projector **98 pass**, related execution users
**375 pass / 11 skip**. The parent ran canonical root `bun run check`: passed,
including all 35 typecheck tasks; existing lint warnings remain.

The parent built with Bun 1.4.4 from `packages/cli`:

```bash
OPENCODE_VERSION=2.3.0-watchdog-location.1 OPENCODE_CHANNEL=watchdog-location \
bun run script/build.ts --single --skip-install --skip-web-ui
```

Artifact: `.host-source/packages/cli/dist/cli-linux-x64/bin/opencode`.
SHA-256: `93c16b937359c226eb77691c7453c5fdadb2b716e1b6da7434d7cc8fc6c5cb7a`.
`--version` reports `2.3.0-watchdog-location.1`; it is not the live binary.

The first probe stopped before plugin loading because the harness expected
`opencode.db`, but this distinct channel uses `opencode-watchdog-location.db`.
`WATCH61_DATABASE_CHANNEL=watchdog-location` now changes only the research
script's expected scratch filename, matching the host's `database-path.ts`.
It sets no host database override and changes no safety gate.

The repeated runtime probe **passed**: real `ctx.app.version` matched the
patched version, embedded SQLite `3.53.4`, WAL, synchronous `2`, busy timeout
`500`, tmpfs. Child `3988981` stopped with its port closed, and the live registry
digest stayed `fe79ebf3151c4a3fdb132d6b3193fca2`.
Evidence: `/tmp/opencode/watchdog-61-smoke-XzDmQD/`.
This is runtime evidence, **not a positive protocol pass**. The production
tuple remains empty pending the full candidate protocol.

### First repaired-host positive result

The parent ran the full runner with the same artifact, explicit
`WATCH61_OPENCODE_BIN`, `WATCH61_DATABASE_CHANNEL=watchdog-location`,
`WATCH61_KEEP_SCRATCH=1` and metadata-only tracing enabled. The separate plugin
worktree `watchdog-61-patched-verification` was based on `e7e83c5`; its only
production-source difference was the static candidate tuple
`2.3.0-watchdog-location.1/linux/x64`.

Result: **passed**. Real target `begin`, controlled grant, one automatic queue,
real target receipt with one continue permit, and new progress/reference recovery
all passed. Duplicate receipt returned no second permit; a different session was
refused with `E_WATCH_CALLER_MISMATCH`. Normal show contained no dispatch
correlation. The parent separately read the scratch ledger read-only: exactly
one permanent attempt, `recovered`, with one permit and `closed_reason=recovered`;
the business task remained `in-progress`, not falsely completed.

The parent also read `event-shapes.jsonl`: execution started/succeeded and usage
events now carried the actual scratch Session location. No plugin backfill was
used. Child `3990136` and the stub stopped, both ports closed, and the live
registry digest stayed `fe79ebf3151c4a3fdb132d6b3193fca2`.
Evidence: `/tmp/opencode/watchdog-61-positive-95uBPb/`.

This removes the measured host-interface blocker **for this exact candidate**,
not for stock `2.3.0`. It does not yet accept #61: the final closed-at recovery
guard, canonical UI terms, final full suite and two-axis review must finish,
followed by a candidate rerun. The production tuple remains empty meanwhile.
Real host SIGKILL, receipt-before-accepted race, stale-generation and power-loss
durability are not claimed by this run.
