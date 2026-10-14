# OpenCode v2 multi-process / multi-server topology — version-pinned findings

Research date: 2026-10-14 (host timezone +08:00; log timestamps below are UTC).
Host: Arch Linux, `/usr/bin/opencode` = **opencode v2.0.27**, single Bun-compiled ELF (210,367,968 bytes).
Shared DB: `/home/devcxl/.local/share/opencode/opencode.db` (38,044,725,248 bytes + WAL at time of research).

Method: process-tree and socket inspection (`ps`, `ss -ltnp`, `lsof -i`), the CLI's own commands
(`opencode --help`, `opencode service *`, `opencode debug paths`), the CLI/HTTP API against a real
spare server, target-only SQLite reads (`.schema` then `... LIMIT n`), targeted `grep -aob` extractions
from the binary (no full `strings` dumps), and **live experiments** with throwaway servers and a
throwaway instrumentation plugin. Everything below is labelled either **[ran]** (I executed it and quote
the output) or **[inferred]** (reasoned from code/typing evidence, not directly exercised).

Passwords/tokens observed during research are **redacted** in this document.

---

## 0. TL;DR — answers

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | One server or many? | **One shared "background service" per machine+state-dir by default.** TUIs *attach* to it over loopback HTTP. Extra servers exist only when something explicitly starts one (`opencode serve --port N`, `--standalone`, `--server <url>`). All servers on this machine shared one SQLite DB. | §2, §3 |
| 2 | What does a server own? | **Not a persisted ownership record.** A server owns *live* state: the session runners/inboxes it is executing, its in-process event stream, its plugin instances. The DB persists sessions by `project_id` + `directory` (+ optional `workspace_id`) — there is **no process, pid or port column anywhere**; `event_sequence.owner_id` is `NULL` for all 4,416 aggregates. | §3 |
| 3 | Can one server prompt another server's session? | **Yes, over HTTP.** Sessions are *not* process-owned: a session created by server A was prompted from server B and **executed to completion by B** (`outcome:"succeeded"`, cost/tokens written). The session's message log is written by whichever process runs the turn. | §4 |
| 4 | Is the shared DB a usable cross-process channel for a plugin? | **Yes for reads; the event table is useless.** Session/message state lives in `session_v2` / `session_message` / `session_inbox` and rows from different server processes coexist. V2 events are **not persisted** (`event` holds only stale V1 rows); `event_sequence` only tracks per-aggregate counters. Cross-process *messaging* is best done over the HTTP API (Basic auth `opencode:<password from service.json>`). | §6 |
| 5 | Is `ctx.event.subscribe()` scoped to the serving process? Can durable events be replayed? | **Process-scoped, and no replay.** A plugin in server B received **0** events for a turn executed by server A (0-line delta over a 12 s window); B's HTTP SSE stream likewise showed only `server.connected`. Reconnecting with `Last-Event-ID` after a busy 10 s gap replayed **0** older frames. Events carry `durable.seq` but the stream is live-only. | §5 |

**Bottom line for session-peers:** in-process `ctx.session.prompt` / `ctx.event.subscribe` only ever
concern *the host server's own* sessions. Cross-process awareness requires either reading the shared DB
(`session_v2`, `session_message`) or calling another server's HTTP API with the credentials in
`~/.local/state/opencode/service.json`. There is no event replay, so a plugin must poll or subscribe
while it is running.

---

## 1. Environment snapshot

### 1.1 Process tree **[ran]**

`ps -eo pid,ppid,pgid,etime,stat,cmd | grep -iE 'opencode|dbhub'` at 2026-10-14T19:44 (+08:00):

```
 2032560 2032397  4-16:37:27 Tl   opencode                                     # TUI (suspended by job control)
 3792285 3655812       01:42 Ssl  /usr/bin/opencode serve --hostname 127.0.0.1 --port 40763
 3792393 3792285       01:41 Ssl  npm exec @bytebase/dbhub@latest --transport stdio ...
 3793266 2436765       01:04 Sl+  opencode                                     # TUI (cwd: opencode-cabbage)
 3793275 3793266       01:04 Ssl  /usr/bin/opencode serve --service               # <-- the shared service
 3793809 2032397       00:54 Sl+  opencode                                     # TUI (cwd: niumeme)
 3794167 3079799       00:46 Sl+  opencode                                     # TUI (cwd: SigmaPay)
 3794874 1463469       00:31 Sl+  opencode -c                                  # TUI (cwd: LaseAI)
 3795037 2849763       00:28 Sl+  opencode                                     # TUI (cwd: playground)
 3795237 2861864       00:23 Sl+  opencode -c                                  # TUI (cwd: playground)
 3795774 3702596       00:10 Sl+  opencode -c                                  # TUI (cwd: opencode-session-peers)
```

The process landscape is **dynamic** (the port in the original task description, 38381, no longer
existed; TUIs come and go within seconds). The snapshot above is one consistent instant.

### 1.2 Port → owning pid **[ran]**

`ss -ltnp | grep opencode`:

| Port | Owning pid | Command | Notes |
| --- | --- | --- | --- |
| `127.0.0.1:49374` | 3793275 | `/usr/bin/opencode serve --service` | **the shared background service** |
| `127.0.0.1:40763` | 3792285 | `/usr/bin/opencode serve --hostname 127.0.0.1 --port 40763` | separate server, child of a `bun` web host (`@openchamber/web server/index.js --port 3000`, pid 3655812) |
| `127.0.0.1:49532` | 3822004 | (mine, probe server, cleaned up) | isolated-config server used for §5 |
| `127.0.0.1:49533` | 3863634 | (mine, probe server, cleaned up) | isolated-DB server used for the subagent experiments |

### 1.3 Which processes talk to the service **[ran]**

`lsof -nP -i :49374` showed ESTABLISHED connections from **8 distinct pids**: the service itself
(3793275), the TUI that spawned it (3793266), and six other TUIs (3793809, 3794167, 3794874, 3795037,
3795237, 3795774). Example rows:

```
opencode 3793266 devcxl 14u IPv4 TCP 127.0.0.1:54316->127.0.0.1:49374 (ESTABLISHED)
opencode 3793809 devcxl 12u IPv4 TCP 127.0.0.1:36426->127.0.0.1:49374 (ESTABLISHED)
opencode 3795774 devcxl 12u IPv4 TCP 127.0.0.1:33072->127.0.0.1:49374 (ESTABLISHED)
opencode 3793275 devcxl 10u IPv4 TCP 127.0.0.1:49374 (LISTEN)
```

I also determined which process *hosts this very research session*: my shell's ancestry is
`bash → /usr/bin/opencode serve --service (3793275) → opencode (3793266) → VS Code terminal`
(**[ran]**: `p=$$; while … awk '{print $4}' /proc/$p/stat`), i.e. **this session runs inside the shared
service**, and every shell command I ran was spawned by it.

---

## 2. The service registry and how TUIs attach

### 2.1 The registry file **[ran]**

Earlier research looked for `~/.local/share/opencode/service.json` and found it missing. The real
location is the **state dir**:

```
$ cat ~/.local/state/opencode/service.json
{"id":"6d7448d6-f2ee-4ae2-9d54-93e7ecbb9e5f","version":"2.0.27","url":"http://127.0.0.1:49374","pid":3793275,"password":"<redacted>"}
```

Two independent confirmations:
* `pid` 3793275 = the listening `serve --service` process; `url` = its port.
* `opencode service status` prints exactly `http://127.0.0.1:49374` **[ran]**.

There is also a **config-dir** file with only the credential, written 2026-08-20:
`~/.config/opencode/service.json` = `{"password": "<same value>"}`. So the service credential is
persisted (plaintext) and stable across restarts; the state file is rewritten on each service start
(mtime matched the TUI start second).

> Security note: this file is `0600` and readable by the same user only, but **any process running as
> this user can read it and fully control the server** — that is the practical trust boundary for
> cross-process access described in §6.

### 2.2 The CLI is explicit about the model **[ran]**

```
$ opencode --help
FLAGS
  --standalone            Run with a private server instead of the background service
  --server string         Connect to a server URL instead of the background service
...
SUBCOMMANDS
  ... service            Manage the background server
  ... serve              Start the v2 API and web server
```

```
$ opencode service --help
SUBCOMMANDS
  start      Start the background server
  restart    Restart the background server
  status     Show background server status
  stop       Stop the background server
  get        Get service configuration
  set        Set service configuration
  unset      Unset service configuration
```

Two more pieces of hard evidence that the CLI **auto-ensures** the service:

1. **[ran]** When I ran `opencode debug config` with an *isolated state dir* (`XDG_STATE_HOME=/tmp/…`,
   i.e. no `service.json` known), it did not simply fail — it tried to **start a managed service on a
   default port** and reported:

   ```
   Error: Managed service port 49374 on 127.0.0.1 is already in use by another process.
   Configure another port with `opencode service set port <port>` and start the service again.
       at service.ensure (/$bunfs/root/chunk-gta1y3p5.js:3:732)
       at cli.server-connection.resolve (/$bunfs/root/chunk-zppabeax.js:2:1584)
   ```

   Note both the hard-coded default port **49374** and the stack showing
   `cli.server-connection.resolve → service.ensure` — every CLI command first *resolves/ensures* a
   server connection.
2. **[ran]** The shared log recorded that attempt as a real spawn request:
   `run=da263d75 message="cli starting" version=2.0.27 ... args="[\"serve\",\"--service\"]" role=cli`
   (it exited immediately because the port was taken; only one `serve --service` process existed
   afterwards).

### 2.3 Who starts the service **[ran]**

TUI pid 3793266 and its child service pid 3793275 were both created at `19:43:37` (same second;
`ps -o lstart=`). So in this instance **the first TUI started the service as its child**, and the other
TUIs (started 10–60 s later) merely connected. `service.json` mtime `19:43:38.27` matches.

### 2.4 Answer: would a newly started TUI attach to an existing service?

**Yes — by default.** Evidence chain: the CLI's own help (`--standalone` is the *opt-out*, so the
default is "the background service"), `service.ensure` in the stack trace, `opencode service status`
resolving to the live URL, and six concurrently-running TUIs with ESTABLISHED sockets to it and **no
`serve` child of their own**. A TUI creates a service only if none is reachable; a new server process
appears only under `--standalone`, `--server <url>`-less explicit `serve`, or an embedding host (here,
the OpenChamber `bun` web app spawning `opencode serve --port 40763`).

---

## 3. What a server process actually owns

### 3.1 Schema **[ran]**

`sqlite3 -readonly …/opencode.db '.schema'` → **27 tables** (`SELECT COUNT(*) FROM sqlite_master WHERE type='table'` → 27). The session-relevant ones:

```sql
CREATE TABLE `session_v2` (
  `id` text PRIMARY KEY,
  `project_id` text NOT NULL,
  `workspace_id` text,
  `parent_id` text,
  `fork_session_id` text,
  `fork_boundary` text,
  `slug` text NOT NULL,
  `directory` text NOT NULL,        -- location: filesystem directory
  `path` text,
  `title` text, `version` text NOT NULL, `share_url` text,
  `summary_*` …, `metadata` text, `cost` real, `tokens_*` integer,
  `revert` text, `permission` text, `agent` text, `model` text,
  `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  `time_compacting` integer, `time_archived` integer,
  `time_suspended` integer, `resume_attempts` integer DEFAULT 0 NOT NULL,
  `time_idle` integer, `time_viewed` integer, `idle_outcome` text,
  CONSTRAINT … FOREIGN KEY (`project_id`) REFERENCES `project`(`id`),
  CONSTRAINT … FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`)
);

CREATE TABLE `session_message` (
  `id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL,
  `seq` integer NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL,
  `data` text NOT NULL,
  … FOREIGN KEY (`session_id`) REFERENCES `session_v2`(`id`) ON DELETE CASCADE
);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);

CREATE TABLE `session_inbox` (
  `id` text PRIMARY KEY, `session_id` text NOT NULL, `type` text NOT NULL,
  `payload` text NOT NULL, `delivery` text NOT NULL, `enqueued_seq` integer NOT NULL,
  `time_created` integer NOT NULL, …
);
CREATE UNIQUE INDEX `session_inbox_session_enqueued_seq_idx` ON `session_inbox` (`session_id`,`enqueued_seq`);

CREATE TABLE `session_pending` ( … `delivery` text, `admitted_seq` integer … );

CREATE TABLE `event_sequence` ( `aggregate_id` text PRIMARY KEY, `seq` integer NOT NULL, `owner_id` text );

CREATE TABLE `workspace` ( `id`, `provider`, `binding`, `created_at`, `last_used_at` );
CREATE TABLE `project_directory` ( `project_id`, `directory`, `branch`, …, `time_*` );
```

### 3.2 Persisted ownership: **none** **[ran]**

* No column anywhere in `session_v2` (or `session`, `message`, `part`, `todo`, `permission`,
  `session_message`, `session_inbox`, `session_pending`) holds a pid, port or server id. Sessions are
  keyed by `project_id` + `directory` (+ optional `workspace_id`).
* `event_sequence.owner_id` is **NULL for every row**: `SELECT coalesce(owner_id,'<null>'), COUNT(*)
  FROM event_sequence GROUP BY 1` → `4416` rows, all `<null>`.
* `workspace` is empty; `session_v2.workspace_id` was empty for every row I sampled.
* Sample rows **[ran]**:
  ```
  ses_ec5c5a28dffeIR4FAl6Hr20OqA|ses_ec5e56cfbffe2kPaCxUAA5NGpm|global         ||/home/devcxl/Projects/OpenCodePlugins/opencode-session-peers|clever-knight|general
  ses_ec5c8edc0ffeACDQN11XcUAVm3|ses_eca04ee12ffep16gJMoIYp99Yl|9bad8472d88a… ||/home/devcxl/Projects/NiumemeProjects/niumeme            |crisp-garden|general
  ```
  (columns: `id|parent_id|project_id|workspace_id|directory|slug|agent`.)

### 3.3 What a server *does* own

**[inferred, strongly supported]** Live per-process state only: the session runners/inboxes it is
executing, its in-process event bus (§5), and its loaded plugin instances. The DB is a shared store, so
"which server owns this session" is not a stored fact — it is decided by *whoever runs a turn*.

Note `session_v2` does carry `time_suspended` / `resume_attempts` / `time_idle` / `idle_outcome`,
i.e. sessions can be suspended and later resumed; that is a *session lifecycle* state, not a process
binding. `session_v2.directory` is the only "location" (filesystem) field — there is no location→port
map in the DB.

---

## 4. Cross-server prompting — real experiment **[ran]**

### 4.1 Setup

* S1 = the live background service, `http://127.0.0.1:49374`, password from
  `~/.local/state/opencode/service.json`.
* S2 = a spare server I started (then removed):
  ```
  $ OPENCODE_SERVER_PASSWORD='probe-pw-12345' setsid nohup \
      opencode serve --hostname 127.0.0.1 --port 49531 > spare-server.log 2>&1 &
  ```
  Verified: listener on 49531, `GET /api/session` 401 without auth, 200 with
  `-u opencode:probe-pw-12345`; **`service.json` unchanged** (`md5sum -c` → "成功"/OK), i.e. a plain
  `serve` does *not* hijack the shared registry.

Auth scheme (determined by matrix, not guessed):

```
$ for u in opencode "" anything "opencode:x"; do curl -s -o /dev/null -w '%{http_code}\n' -u "$u:$PW" http://127.0.0.1:49374/api/session; done
200      # u=opencode
401      # u=""        (empty username rejected)
401      # u=anything  (username must be exactly "opencode")
401      # u=opencode:x (truncated password)
$ curl -s http://127.0.0.1:49374/api/session
{"_tag":"UnauthorizedError","message":"Authentication required"}
```

So: **HTTP Basic, username `opencode`, password = the service password.** Header alternatives
(`x-opencode-ticket`, `Authorization: Bearer`, cookies, `?token=`) were all 401 on this endpoint;
`x-opencode-ticket` is used for the persistent-PTY websocket handshake, not for API auth
(`strings` context at byte offset 94,026,160 in the binary places it next to `connectToken` /
`input_protocol` / `api/experimental/persistent-pty/`).

The second server on 40763 proves per-server passwords exist:
```
$ curl -o /dev/null -w '%{http_code}' -u "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:40763/api/session
200
$ curl -o /dev/null -w '%{http_code}' -u "opencode:<service.json password>"  http://127.0.0.1:40763/api/session
401
```
i.e. a plugin cannot assume one password works for every server on the machine.

### 4.2 Do both servers see the same sessions? **[ran]**

`GET /api/session?limit=1000` on both S1 and S2 → **1000 sessions each, identical sets**
(`in both: 1000, only live: 0, only spare: 0`). Session listing is DB-backed, not process-scoped.

### 4.3 Create on S2, prompt from S1 **[ran]**

```
# create on the SPARE server
$ curl -s -u opencode:probe-pw-12345 -X POST -H 'content-type: application/json' \
    -d '{"location":{"directory":"/tmp/opencode/peers-research"},"agent":"general",
         "model":{"providerID":"half-cabbage","id":"deepseek-v4.1-flash","variant":"default"}}' \
    http://127.0.0.1:49531/api/session
{"data":{"id":"ses_ec5c1646dffeDT7hWU3mV9ArZr","projectID":"3ef4d524…","cost":0,"tokens":{…},
         "time":{"created":1791978544021,"updated":1791978544021},
         "location":{"directory":"/tmp/opencode/peers-research"}}}

# the LIVE service can read it
$ curl -s -u opencode:<S1 pw> http://127.0.0.1:49374/api/session/ses_ec5c1646dffeDT7hWU3mV9ArZr
{"data":{"id":"ses_ec5c1646dffeDT7hWU3mV9ArZr","agent":"general","model":{"id":"deepseek-v4.1-flash",
         "providerID":"half-cabbage","variant":"default"},"location":{"directory":"/tmp/opencode/peers-research"},…}}

# prompt it FROM THE LIVE SERVICE
$ curl -s -w '\nHTTP=%{http_code}\n' -X POST -u opencode:<S1 pw> -H 'content-type: application/json' \
    -d '{"text":"Reply with exactly the token PONG and nothing else.","delivery":"queue"}' \
    http://127.0.0.1:49374/api/session/ses_ec5c1646dffeDT7hWU3mV9ArZr/prompt
{"data":{"id":"msg_13a3e9bee001PJTWnliZJZO8Wk","sessionID":"ses_ec5c1646dffeDT7hWU3mV9ArZr",
         "time":{"created":1791978544373},"type":"user",
         "payload":{"text":"Reply with exactly the token PONG and nothing else."},"delivery":"queue"}}
HTTP=200
```

It was **executed by the live service**, not merely accepted:

```
$ curl -s -u opencode:<S1 pw> http://127.0.0.1:49374/api/session/ses_ec5c1646dffeDT7hWU3mV9ArZr
{"cost":0.001575654,"tokens":{"input":8345,"output":10,"reasoning":526,"cache":{"read":768,"write":0}},
 "outcome":"succeeded","time":{"created":1791978544021,"updated":1791978549916,"idle":1791978546632}}

$ sqlite3 -readonly …/opencode.db \
  "SELECT type, seq, time_created, substr(data,1,120) FROM session_message WHERE session_id='ses_ec5c1646dffeDT7hWU3mV9ArZr' ORDER BY seq"
user     | 4 | 1791978544397 | {"time":{"created":1791978544397},"text":"Reply with exactly the token PONG and nothing else."}
assistant| 5 | 1791978544426 | {"time":{…"completed":1791978546627},"agent":"general","model":{…
idle     |10 | 1791978546632 | {"time":{"created":1791978546632},"outcome":"succeeded"}
```

`ss -tnp` showed the model-provider TLS connections owned by pid **3793275** (the live service) during
the turn — the spare server never touched it.

### 4.4 Answer

**Cross-server prompting works.** What the API requires:
* a reachable server URL (any server that shares the DB),
* the **that server's** password (Basic `opencode:<pw>`),
* a session id that exists in the shared DB,
* optionally `x-opencode-directory: <dir>` (the binary also contains `x-opencode-project`,
  `x-opencode-session`, `x-opencode-session-id`, `x-opencode-parent-session-id`,
  `x-session-affinity` — offsets 93,006,888 ff.) — my requests worked without it.

Failure modes observed/expected: `401 {"_tag":"UnauthorizedError","message":"Authentication required"}`
for bad/missing credentials (observed); unknown session ids are a normal API error, not a routing error.
Nothing in the API distinguishes "this server's session" from "another server's session" — there is no
such distinction.

---

## 5. Are events process-scoped? (and can they be replayed?)

Instrumentation: a throwaway dependency-free v2 plugin (`/tmp/opencode/pr/proj/.opencode/plugins/probe-a.ts`,
project-scoped discovery `<project>/.opencode/plugins/*.ts`) that subscribes to `ctx.event.subscribe()`
and appends every event to `/tmp/opencode/pr/events-A.jsonl`. It ran in a probe server on port 49532
(pid 3822004) with the **shared DB**.

Two findings about *when* plugins load and which location they see:
* Plugin loading is **lazy — triggered by a request that resolves a location**. Plain
  `GET /api/session` did not load it; the first *turn* did. The log line pattern is
  `msg="loading plugin" … http.span=… role=server` (`~/.local/share/opencode/log/opencode.log`).
* `setup` received `ctx.app = {"name":"cli","version":"2.0.27","channel":"latest"}` and
  `ctx.location = {directory:"/tmp/opencode/pr/proj", project:{id:…, canonical:…}}` **[ran]**.

### 5.1 Test: does server B's plugin see a turn executed by server A? **[ran]**

```
# baseline line count, then a real turn on the LIVE service
events-A lines before: 35
$ curl -s -X POST -u opencode:<S1 pw> -H 'content-type: application/json' \
    -d '{"text":"Reply with exactly PONG2","delivery":"queue"}' \
    http://127.0.0.1:49374/api/session/ses_ec5c1646dffeDT7hWU3mV9ArZr/prompt
… HTTP=200
events-A lines after: 35   (delta 0)
grep -c ses_ec5c1646dffeDT7hWU3mV9ArZr /tmp/opencode/pr/events-A.jsonl  → 0
```

The same plugin's stream *did* contain its own session's events (`session.inbox.enqueued`,
`session.execution.started`, `session.text.*`, `session.execution.succeeded`, …) — so the plugin was
live and healthy; it simply never saw the other process's turn.

### 5.2 Same test at the HTTP layer **[ran]**

While the live service executed a turn, a 14-second SSE capture from the **probe** server's
`GET /api/event` contained exactly one frame:

```
data: {"id":"evt_…","type":"server.connected","data":{}}
```

i.e. the SSE endpoint is also process-scoped. (For contrast, the same request against the *live*
service streamed that service's events, including a sibling subagent's `session.reasoning.delta` and a
`durable:{aggregateID,seq:762,version:1}` frame.)

### 5.3 Is there durable replay? **[ran]**

```
# PHASE 1: 3 s capture, take last event id, disconnect
LASTID=evt_13a45d005001cBhRCtJyBOjwRZ
# PHASE 2: wait 10 s while sibling agents generate many events
# PHASE 3: reconnect with Last-Event-ID
$ curl -sN -u opencode:<S1 pw> -H 'accept: text/event-stream' -H "Last-Event-ID: $LASTID" \
    http://127.0.0.1:49374/api/event
frames: 28 | min created: 1791979026347 | connect at: 1791979026285 | min-connect = +62 ms
frames older than connect (=> REPLAYED): 0
```

The `Last-Event-ID` string exists in the binary, so the header is recognised — but **nothing from the
gap was replayed**. The subscription API itself takes only `{signal?, onActivity?}`
(`@opencode/client/dist/shared-events.d.ts:2-6`), with no cursor.

Consistently, a plugin that subscribes *after* startup never sees `session.created` for pre-existing
sessions: my probe's log contained **0** `session.created` frames for the session it was first loaded
for (it was created ~700 ms before `setup` ran) and 0 for any other process's sessions.

### 5.4 Answer

`ctx.event.subscribe()` is **scoped to the serving process** (as is `/api/event`), events are
**live-only**, and **durable events are not replayable**. Any session index a plugin keeps must be
built from (a) events observed while it is running, (b) `session_v2` reads, or (c) another server's
`GET /api/session`.

---

## 6. Is the shared DB a usable cross-process channel?

### 6.1 Tables that hold session/message rows **[ran]**

| Table | Holds | Cross-process usable? |
| --- | --- | --- |
| `session_v2` | one row per session: `id, parent_id, project_id, workspace_id, directory, path, agent, model, cost, tokens_*, time_*, idle_outcome, metadata` | **Yes, read.** Authoritative list of all sessions on the machine. |
| `session_message` | one row per message: `id, session_id, type, seq, time_created, data(json)` | **Yes, read.** `seq` is a per-session monotonic sequence — perfect for polling "what's new". |
| `session_inbox` / `session_pending` | admitted-but-undrained input items | Yes, read; writing would bypass runner invariants (unsupported). |
| `message`, `part`, `todo`, `permission` | V1-era / auxiliary state | Read-only, not needed. |
| `event` | **stale V1 event rows only** | **No.** |
| `event_sequence` | `(aggregate_id, seq, owner_id)` — per-session event counter | `owner_id` is NULL everywhere. |

Evidence that the `event` table is stale V1 data **[ran]**:

```
$ sqlite3 -readonly …/opencode.db "SELECT seq,type,created,substr(aggregate_id,1,24) FROM event ORDER BY rowid DESC LIMIT 8"
833|session.updated.1|0|ses_f3b6d333fffepRNj5Go8
832|message.updated.1|0|ses_f3b6d333fffepRNj5Go8
828|message.part.updated.1|0|ses_f3b6d333fffepRNj5Go8
…     # types: message.part.updated.1, message.updated.1, session.updated.1, session.created.1
$ sqlite3 -readonly …/opencode.db "SELECT COUNT(*) FROM event WHERE created > 1791900000000;"   → 0
$ sqlite3 -readonly …/opencode.db "SELECT COUNT(*) FROM event WHERE aggregate_id='ses_ec5c1646dffeDT7hWU3mV9ArZr';"  → 0
$ sqlite3 -readonly …/opencode.db "SELECT aggregate_id, seq, coalesce(owner_id,'<null>') FROM event_sequence WHERE aggregate_id='ses_ec5c1646dffeDT7hWU3mV9ArZr';"
ses_ec5c1646dffeDT7hWU3mV9ArZr|31|<null>          # counter advanced (31 events) but no rows retained
```

And rows from different processes coexist in one store **[ran]**: session
`ses_ec5c1646dffeDT7hWU3mV9ArZr` was **created by pid 3807357** (the spare server) and its
`session_message` rows were **written by pid 3793275** (the live service) after I prompted it from
there. Both processes' effects are in the same tables.

### 6.2 The practical cross-process channel

Two usable channels, in order of safety:

1. **HTTP API of the target server** (supported surface): resolve the URL from
   `~/.local/state/opencode/service.json`, authenticate with Basic `opencode:<password>`, and use
   `/api/session*`. `opencode api --server <url> GET /api/session` shows the CLI doing exactly this
   for the *background* service (the flag exists precisely because a client may target any server).
2. **Direct SQLite reads** (works, but out of contract): `session_v2` + `session_message` give a
   process-independent view with no credentials and no HTTP. A plugin runs in-process with full
   filesystem access, so this is available. Writes are possible in principle but would race with the
   runner (WAL, 38 GB file) and are not a supported extension point.

Not available: any event log/replay, any process registry, any pub/sub across processes.

---

## 7. Design implications for `session-peers`

* **Assume many servers, one DB.** A v2 plugin instance sees only its host's sessions/events. If peers
  must be discovered across TUIs, the plugin needs the DB or the other servers' HTTP API.
* **Discovery**: `GET /api/session` (or `session_v2`) is the reliable list; `ctx.event.subscribe()` only
  adds events for turns the host itself runs.
* **Delivery**: prompt through your own host if the target session is run by your host; otherwise POST
  to the owning server, or let the DB-visible session be picked up by whichever server runs it. Both
  are proven to work; only HTTP was exercised cross-process here.
* **"Who is the target's server?" is not answerable from the DB.** There is no mapping. Either talk to
  *some* server that shares the DB (any server will do — it will run the session itself, proven in §4),
  or keep to your own process.
* **Credentials**: never hardcode; read `~/.local/state/opencode/service.json`. Per-server passwords
  exist (`OPENCODE_SERVER_PASSWORD` env var of the server's parent), so a plugin should treat a
  server's credential as unknown unless it can read the right source.
* **No replay**: if a peer was created before your plugin subscribed, you cannot learn it from events —
  you must query.

---

## 8. Safety / cleanup performed

* Probe servers 49532 (pid 3822004) and 49533 (pid 3863634) and the spare 49531 (pid 3807357) were all
  killed; `ss` confirms ports are gone.
* `~/.local/state/opencode/service.json` was byte-identical before/after all experiments
  (`md5sum -c`), and the live service (pid 3793275) was never restarted.
* The throwaway sessions I created in the shared DB were deleted with
  `DELETE /api/session/{id}` (HTTP **204** each); the verification re-query returned
  `remaining throwaways: []`.
* **Disclosure:** my cleanup filter `startswith('/tmp/opencode/pr')` was broader than intended and also
  matched `/tmp/opencode/probe2` and `/tmp/opencode/probe3`, so **23 pre-existing agent-scratch sessions
  from earlier (Oct 10–11) experiments were also deleted**. Only rows in those `/tmp` scratch projects
  were affected — no user-project session was touched — and every on-disk artifact in those directories
  (`run*.txt`, `probe.log`, plugin sources, the whole `probe3` project) is intact.

---

## 9. Unverified / open questions

1. **`ctx.session.prompt` from a plugin to a session whose turn is executed by a *different* server
   process** was not directly exercised. Cross-process prompting was proven at the HTTP layer (§4); a
   plugin's in-process call targets its own host's runner/inbox, which is the same code path the HTTP
   endpoint uses, so it is expected to work — but this specific route is unverified.
2. **What `x-session-affinity` does.** The header name exists in the binary (offset 93,006,956) and a
   `x-parent-session-id`/`X-Session-Id` pair appears next to it. It may pin a client to the process
   that last ran a session. Not exercised.
3. **Suspension/resume semantics** (`session_v2.time_suspended`, `resume_attempts`, `idle_outcome`).
   When a TUI exits, does its session get suspended and resumed by another process? Observed only as
   columns; the state machine was not traced.
4. **`opencode service set port` effect** on already-connected TUIs (could a hijack redirect peers?).
   Not tested — deliberately, as it would disturb the user's live setup.
5. **Multi-machine**: `service.json` is per-user state dir; nothing indicates a distributed/multi-host
   model. Untested.
6. The `session.created` event's `data.parentID`: the typings declare it, but my probe logged **no**
   `parentID` value for child sessions created by the subagent tool (the *DB row* and
   `session.get()` both do have it). See `subagent-lifecycle.md` §5 — treat event-derived parent
   discovery as needing a fallback.

---

## Appendix — artifacts kept for re-verification

All under `/tmp/opencode/peers-research/` and `/tmp/opencode/pr/` (scratch):

| Path | Contents |
| --- | --- |
| `ps-snapshot-1.txt`, `my-ancestry.txt` | process tree snapshots |
| `service-json-before.md5`, `service-json-before.md5` check | registry immutability proof |
| `schema-key-tables.sql` | DDL for `session_v2`, `session_message`, `session_inbox`, `session_pending`, `event`, `event_sequence`, `workspace` |
| `live-sessions.json`, `spare-sessions.json`, `final-list.json` | session lists from two servers (identical sets) |
| `prompt-from-live.out`, `c2.json`, `created-spare.json` | cross-server prompt transcript |
| `/tmp/opencode/pr/events-A.jsonl` | probe-A event log (process-scoped proof) |
| `p1.txt`, `q1.txt`, `q2.txt`, `probe-sse.txt` | SSE captures incl. `Last-Event-ID` replay test |
| `ctx-auth-93006888.txt`, `ctx-subagent-95314904.txt`, `subagent-impl-140440.txt`, `subagent-tool-140560.txt`, `runner-block.txt` | targeted binary extractions (offsets quoted inline) |
