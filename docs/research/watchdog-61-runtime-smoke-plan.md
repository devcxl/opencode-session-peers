# #61 isolated runtime smoke plan

Status: proposed, not executed. The parent must review this plan and the script
paths before anyone starts a real opencode service.

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

- Scratch root: `/tmp/opencode/watchdog-61-smoke-<time>-<pid>`.
- `HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` and
  `XDG_CONFIG_HOME` all point inside that root.
- Base environment is a whitelist: `PATH`, scratch `HOME`, scratch `TMPDIR`,
  locale and `TZ`. `OPENCODE_*`, provider keys, `SESSION_PEERS_WATCH_STATE_DIR`
  and other inherited secrets are absent, not blanked after inheritance.
- No `authSource` is passed. The offline stub path, if used later, gets only
  the literal `stub` key; no developer credential is copied or printed.
- `startInstance` picks a free `127.0.0.1` port and passes the explicit URL to
  its client; it never reads the live `service.json` URL for requests.
- The live `service.json` md5 and pid/url are read only as isolation evidence.
  The probe never writes it, never restarts the live service and never sends a
  request to the live URL.
- The child runs detached in its own process group; `stop()` closes the port
  and kills that group with a bounded grace period. Failure paths stop the
  child before reporting.

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
