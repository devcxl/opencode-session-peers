# #61 isolated runtime smoke plan

Status: the parent reviewed and executed the runtime-only probe on 2026-11-16.
The production queue/receipt protocol is not yet verified; automatic sending
remains closed.

## Assets

- `scripts/research/watchdog-61/probe-plugin/index.ts` — a local plugin that
  runs inside the child opencode service and records the **actual embedded**
  SQLite version, `journal_mode`, `synchronous`, `busy_timeout`, process
  platform/arch, app version and the scratch database path.
- `scripts/research/watchdog-61/run-probe.ts` — starts one throwaway
  `opencode serve` with the existing harness primitives, a minimal whitelist
  environment, a scratch HOME and the four scratch XDG directories, a random
  loopback port and an explicit client URL. It never uses `opencode api` or
  default service discovery.

Explicit confirmation is required:

```bash
WATCH61_SMOKE_CONFIRM=1 bun scripts/research/watchdog-61/run-probe.ts
```

Optional: `WATCH61_OPENCODE_BIN=/path/to/opencode` and
`WATCH61_KEEP_SCRATCH=1`. The default binary is `/usr/bin/opencode`.

## Isolation

- Scratch root: `/tmp/opencode/watchdog-61-smoke-<random>`. The parent ran with
  `TMPDIR=/tmp`, so the harness's default scratch base resolved to `/tmp/opencode`.
- `HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` and
  `XDG_CONFIG_HOME` all point inside that root.
- Base environment is a whitelist: `PATH`, scratch `HOME`, scratch `TMPDIR`,
  locale and `TZ`. `OPENCODE_*`, provider keys, `SESSION_PEERS_WATCH_STATE_DIR`
  and other inherited secrets are absent, not blanked after inheritance.
- No `authSource` is passed. The offline stub path, if used later, gets only
  the literal `stub` key; no developer credential is copied or printed.
- `startInstance` picks a free `127.0.0.1` port and passes the explicit URL to
  its client; it never reads the live `service.json` URL for requests.
- The probe requests the model list for `layout.projectA` to initialize its
  project-scoped plugin, then creates one explicit session (no prompt). Session
  creation alone did not initialize the plugin on the measured host. The
  recorded directory must be that scratch project.
- The live `service.json` md5 and pid/url are read only as isolation evidence.
  The probe never writes it, never restarts the live service and never sends a
  request to the live URL.
- The child runs detached in its own process group; `stop()` closes the port
  and kills that group with a bounded grace period. Failure paths stop the
  child before reporting.
- Success requires all of: a runtime record, the scratch project directory,
  the scratch probe database, the child pid, `stopped === true`,
  `portClosed === true`, and an unchanged live `service.json` digest. A
  scratch directory is removed only after a clean stop; otherwise it is kept
  for diagnosis without secrets.

## Decision after the probe

1. If the embedded SQLite is older than 3.51.3, or WAL/FULL/busy_timeout/local
   filesystem cannot be established, the runtime gate stays closed. Report the
   exact observed facts; do not change `sqliteVersion`, do not use an external
   Bun version, and do not run the positive protocol.
2. If the embedded runtime is supported, the **tuple whitelist** is still empty
   until the isolated production protocol is executed and reviewed. The probe
   alone does not add a tuple or enable automatic sending.
3. Only after explicit parent authorization may a second script exercise the
   real first queue/receipt path. Pass 1 has no production queue to drive.

## Positive protocol (not implemented in pass 1)

When authorized later, the isolated run should cover:

- first automatic attempt only; real `queue` delivery, never steer/interrupt;
- prompt binding task/generation/attempt/correlation and a real-caller receipt;
- receipt before prompt return; late accepted/timeout monotonic merge;
- no second continue permit on a repeated receipt;
- wrong caller, stale generation, downgraded grant and reused result reference;
- crash after send and before accounting: `sending` remains unknown, no replay;
- every expected failure stays alert-only and sends no prompt.

These are not claimed by the probe or by the FakeHost tests.

## Runtime-only observations

The initial run created a session but produced no probe record. It failed
closed; its child stopped, its port closed, and the live registry digest was
unchanged. Adding the existing harness's model-discovery initialization made
the second run pass:

| Fact | Observed in the child service |
| --- | --- |
| OpenCode / platform | 2.3.0 / linux / x64 |
| Embedded SQLite | 3.53.4 |
| Journal / synchronous | wal / 2 (FULL) |
| `busy_timeout` readback | 500 ms |
| Filesystem type | 16914836 (`0x01021994`, tmpfs) |
| Project / database / pid | Matched the scratch project, probe DB and child |
| Teardown | Child stopped after SIGTERM; port closed |
| Live service registry | Before/after digest identical |

No prompt was sent and no developer authentication was copied. These facts
establish a usable candidate runtime for later isolated protocol tests, not
production-ledger durability, support for arbitrary filesystems, or permission
to add a verified tuple. Both scratch directories were retained for inspection.
