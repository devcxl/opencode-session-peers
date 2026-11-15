# Watchdog ledger research assets (issue #57)

These files are a one-off capability experiment, not production code. The
report is `docs/research/watchdog-ledger-validation.md`.

## What runs

| Command | What it proves |
| --- | --- |
| `bun scripts/research/watchdog-ledger/runtime-probe.ts` | Boots an isolated `opencode serve` with private HOME/XDG/port and loads a project plugin that imports `bun:sqlite`, sets WAL/`synchronous=FULL`/`busy_timeout`, runs a unique constraint and a `BEGIN IMMEDIATE` transaction, and inspects `ctx.storage`. |
| `bun scripts/research/watchdog-ledger/run.ts` | Runs the real multi-process SQLite experiments (registration, quota, pending/unknown, crash, handover, seal, busy timeout, durability, corruption, LWW negative control, single-host identity). |

Both accept `WATCHDOG_LEDGER_ARTIFACTS` (defaults to
`/tmp/opencode/watchdog-ledger-evidence/...`). Evidence is written there; the
report cites the measured values, not a checked-in binary artifact.

The runtime probe accepts `OPENCODE_BIN` to point at a specific release. The
experiments use `process.execPath` for children, so running the runner with
Bun 1.4.4 makes every child use the same runtime.

## Safety

- No model is called.
- The probe instance uses a scratch `HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, a random loopback port, and a local
  scratch project.
- The runner never opens the host's `opencode.db`, service password, auth file,
  or a running user session.
- All child processes have a timeout; the probe server is stopped in `finally`.
- All databases live under the artifact root and are safe to delete.

## Files

- `ledger-core.ts` — open/schema/pragmas and read helpers.
- `ledger-ops.ts` — registration, reserve, send marker, outcome, handover, seal.
- `ledger.ts` — facade used by the scenarios and worker.
- `worker.ts` — one process per action; crash/raw-send/lost-update controls.
- `scenarios-*.ts` — the experiment matrix.
- `runtime-probe.ts`, `probe-plugin/` — the OpenCode runtime fact check.
