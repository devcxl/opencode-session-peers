# Plugin instance scoping, cross-location session calls, and event visibility (opencode v2.0.27)

Research date: 2026-10-14 (host timezone +08:00; log timestamps are UTC).
Host binary: `/usr/bin/opencode` = **opencode v2.0.27** (Bun-compiled ELF, 210,367,968 bytes).

Method: one **fully isolated opencode instance** (fresh `XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`/`XDG_CONFIG_HOME`,
dedicated port 49611, its own DB) plus a throwaway dependency-free probe plugin that logs each
`setup(ctx)` — its `ctx.location`, a random module id and a random setup id — subscribes to
`ctx.event.subscribe()`, and executes shell-addressable commands from inside plugin code.
Everything below is labelled **[ran]** (executed and observed, output quoted) or **[inferred]**
(read from the binary/typings/docs, not executed).

Related prior research (not repeated here):
`opencode-v2-plugin-api.md` (plugin API surface), `opencode-multiprocess-topology.md` (one service + many
servers, shared DB, process-scoped events, cross-server HTTP prompting), `subagent-lifecycle.md`.

> **Correction to a premise in the task brief.** The brief stated that `ctx.event.subscribe()` is
> **location-filtered** (only events whose `{directory, workspaceID}` match the subscriber's). This
> experiment **contradicts** that: within one server process the stream is **not** location-filtered at
> all (§3). `grep -n -i 'location-filter' docs/research/*.md` returns **nothing**, so no prior report in
> this repo actually contains that claim — the closest true statement is the topology report's
> *process*-scoping finding (events do not cross server processes), which this document re-confirms from
> the other side. The official docs already warn about the same thing:
> *"This is the plugin instance's location, not the location of every session it can access or event it
> receives."* ([Build a plugin → Context](https://opencode.ai/v2/docs/build/plugins)).

---

## 0. TL;DR — answers

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | One plugin instance per **server process** or per **location**? | **Per location (directory).** Four locations → four module evaluations + four `setup(ctx)` calls in the *same* pid; repeated requests to an already-active location create no new instance. Module-level state is per-location too (the module is re-evaluated per location). | §1 `[ran]` |
| 2 | Can plugin code in location A prompt/get/context/wait a session in location B? | **Yes, all four work in-process.** `prompt` returns the `SessionInboxUser` admission record (6 ms normal; 433 ms when B's location had to activate) and the turn **executes in the target's own location** (B1's `shell` tool ran with cwd `…/projB`; a prompt into never-activated location C completed with reply `OK-C`, `outcome:"succeeded"`). `get`/`context` return the foreign session's data; `wait` waits on B's run (5 s timeout while busy) and returns in 1 ms when idle. `create({location})` can even create a session in a foreign location. | §2 `[ran]` |
| 3 | Is the event stream location-filtered? | **No.** Every instance received every location's events (A saw B's `session.created` *before* ever touching B; all 4 instances saw all of A/B/sub/C's events). Events carry `location` as **data**, not as a filter. The real boundary is the **process** (prior report: 0 events across server processes). Instances created later see only later events (no replay). | §3 `[ran]` |
| 4 | Is `ctx.storage` per-instance, per-location, or shared? (bonus) | **Shared across locations, scoped by plugin id, durable across process restarts.** DB key format: `plugin:<hex-utf16le(plugin id)>:<key>` — no location component. | §4 `[ran]` |

Bottom line for `session-peers`: a single global plugin behaves like **N co-located instances** — one per
directory the server has activated — while **storage is the one shared, durable namespace** they can use
to build a machine-wide session index. Session APIs are **not** location-scoped, so any instance can
message any session in the process; the event stream likewise delivers everything to everyone.

---

## 1. Q1 — instance scoping: once per server or once per location?

### 1.1 Rig `[ran]`

```bash
PIS=/tmp/opencode/piscope
mkdir -p $PIS/projA $PIS/projB $PIS/projA/sub $PIS/projC $PIS/data $PIS/state $PIS/cache

# config (isolated XDG_CONFIG_HOME)
cat > $PIS/cfg/opencode/opencode.json <<'EOF'
{ "$schema": "https://opencode.ai/config.json", "share": "disabled", "update": "disable" }
EOF

# global plugin, auto-discovered from <config>/plugins/ (same discovery as ~/.config/opencode/plugins/)
#   $PIS/cfg/opencode/plugins/probe-piscope.ts   (dependency-free TS, 164 lines, artifact path below)

XDG_DATA_HOME=$PIS/data XDG_STATE_HOME=$PIS/state XDG_CACHE_HOME=$PIS/cache XDG_CONFIG_HOME=$PIS/cfg \
OPENCODE_SERVER_PASSWORD='piscope-pw-123' \
setsid nohup opencode serve --hostname 127.0.0.1 --port 49611 --print-logs > $PIS/server.log 2>&1 &
```

Observed listener: `ss -ltnp | grep 49611` → `users:(("opencode",pid=3936020,fd=10))` — **one server
process** for the entire experiment (all plugin logs carry the same `pid`).

The probe logs one JSON line per event to `$PIS/probe.log`, including a random `mod` id generated at
**module top level** and a random `setupId` generated inside `setup()`. If the loader imported the module
once and called `setup` per location, all setups would share one `mod`; if it created one instance per
server, there would be one setup total.

### 1.2 What activates a location `[ran]`

`POST /api/session` with `{"location":{"directory": …}}` created a session but **did not** load the plugin.
The first request that *served* the location did:

```bash
curl -s -o /dev/null -u opencode:piscope-pw-123 \
  -H "x-opencode-directory: /tmp/opencode/piscope/projA" \
  http://127.0.0.1:49611/api/model

# response envelope is location-aware:
# {"location":{"directory":"/tmp/opencode/piscope/projA"},"data":[{"id":"exo-free", ...}]}
```

Second and third requests to the same location produced **no further setup**. The same activation
happened later for `projB`, `projA/sub`, and finally `projC` — the last one triggered not by a config
request but by a real model turn (see §2.4).

### 1.3 Result: four locations → four instances in one process `[ran]`

```
module-eval 114g7mgq pid 3936020
  setup      114g7mgq#lq2ui3 /tmp/opencode/piscope/projA
module-eval 9ehqxisf pid 3936020
  setup      9ehqxisf#kq8det /tmp/opencode/piscope/projB
module-eval 3qqtk46s pid 3936020
  setup      3qqtk46s#c6vru6 /tmp/opencode/piscope/projA/sub
module-eval sqkyh9sw pid 3936020
  setup      sqkyh9sw#tvkx9z /tmp/opencode/piscope/projC
```

Key details, each a separate observation:

* **Four module evaluations** (`module-eval` logged 4×, distinct random `mod` values, same pid) — the
  plugin module is re-imported per location. **Module-level singletons are per-location**, not global
  to the server.
* **A sub-directory is its own location.** `projA` and `projA/sub` both got their own module + setup.
  In this test `projA/sub` was also its own *project* (`ctx.location.project.canonical` =
  `/tmp/opencode/piscope/projA/sub`; there is no project-root marker above it), so this run does not by
  itself separate "directory" from "project". The binary does: location services are keyed by
  `` `${directory}\x00${workspaceID ?? ""}` `` (`LocationActivity`) and requests resolve a location from
  the directory alone (`Xr`), so **directory (+ workspaceID) is the instance identity**. A
  sub-directory of a *recognised* project root is untested (§6).
* **Repeated requests do not re-instantiate.** 3 further `GET /api/model` + 3 `GET /api/agent`
  requests across `projA`/`projB` left the totals at 3 setups / 3 module-evals. The plugin's command
  poller (1 s interval, per instance) executed each shell-issued command exactly once
  (`{'c1':1 … 'c17':1}`), proving there was exactly one live instance per location.
* **`cleanup` runs on server shutdown.** Nothing unloaded during ~7 minutes of normal operation, but
  when the server received SIGTERM all four instances' cleanup functions fired within ~160 ms
  (`12:56:46.937Z` … `12:56:47.094Z`, one per location), and the post-restart instance's cleanup fired
  on the second kill (`12:57:15.919Z`). Instances also receive a `location.shutdown` event (tagged with
  the location) just before teardown — delivered to *other* instances' streams too, subject to
  subscription teardown races (11 `location.shutdown` lines were captured across 5 instances).

### 1.4 Matching server-log lines `[ran]`

`grep -a 'msg="loading plugin"' $PIS/server.log` printed **exactly 4** lines, one per location
activation, each the same entrypoint but a different request span, e.g.:

```
timestamp=2026-10-14T12:49:54.690Z level=INFO run=f15e9d09 msg="loading plugin"
  id=/tmp/opencode/piscope/cfg/opencode/plugins/probe-piscope.ts
  entrypoint=file:///tmp/opencode/piscope/cfg/opencode/plugins/probe-piscope.ts http.span=42 role=server
```

The four `loading plugin` timestamps match the four `module-eval` timestamps to the millisecond
(12:49:54.690/691, 12:50:08.424/425, 12:50:39.485/…, 12:53:49.289/…). So in the server log, a repeated
`loading plugin` line means *"this location (re)loaded its plugin set"*, not *"a new server process"* or
*"setup ran again"*.

### 1.5 Code corroboration `[inferred]`

From targeted extractions of `/usr/bin/opencode` (`grep -aob` + `tail -c +OFFSET | head -c N`):

* The plugin source system is an **instance-scoped Effect service**: `class Ns extends U()("@opencode/InstancePlugins")`
  and a constructor that rejects duplicates with `` `duplicate instance plugin ids: ${…}` ``
  (offsets 140,437,686 / 140,437,859). `PluginSupervisor.activate` merges
  `[...builtins, ...r.all(), ...l.all()]` where `l = yield*Ns` is that per-instance source (offset ≈140,847,284).
* Location-scoped service containers exist and are evicted by inactivity:
  `class Ac extends U()("@opencode/LocationActivity")`, with `timeToLive??"60 minutes"` and the log line
  **"location services evicted"** (offsets 140,887,006 / 140,887,136 / 140,888,139; symbol copies at
  95,339,466 / 95,421,400). Location-scoped HTTP handlers await plugin activation before proceeding:
  `Bl = … pipe(Vi({ duration:"5 seconds", orElse: () => … "Location plugins did not finish activating" }))`
  (offset 140,889,368).
* Location resolution per request: `Xr(e)` reads `?location[directory]=` first, then the
  `x-opencode-directory` header (`decodeURIComponent`), else `process.cwd()` (offsets 140,889,860 /
  140,889,897).

So the observed behaviour is the intended design: **a plugin set is materialized per location**, lazily,
when a request (or a session turn) activates that location, and torn down with the location's services.

---

## 2. Q2 — can plugin code cross locations for prompt / get / context / wait?

All calls below were issued **from the `projA` instance** (`setupId 114g7mgq#lq2ui3`) via the probe's
command file; `B1 = ses_ec588bf8fffelf8n8yYIyVmAUo` (location `projB`),
`C1 = ses_ec586e7f8ffeS7mpYP0CYrqcu5` (location `projC`, no instance existed yet).

### 2.1 `get` and `context` — work, and are DB-global `[ran]`

```
cmd-get      {"id":"ses_ec588bf8fffelf8n8yYIyVmAUo",
              "location":{"directory":"/tmp/opencode/piscope/projB"},
              "title":"probe-B1"}
cmd-context  {"count":0}                     # before prompting
…later…
cmd-context  {"count":10, "first":{"text":"PISCOPE_CROSS_1","type":"user"},
              "last":{"type":"idle","outcome":"interrupted"}}
```

No location scoping: `ctx.session.get` returned a session that lives in a different directory, with its
`location.directory` intact. `ctx.session.context` returned the foreign session's full message list
(including the messages produced by the cross-location prompt below).

### 2.2 `prompt` — success, and the target location runs the turn `[ran]`

```
cmd-prompt {"cmdId":"c4","tookMs":6,
            "result":{"id":"msg_13a77db8e001MBY5ygBY5djPC1",
                      "sessionID":"ses_ec588bf8fffelf8n8yYIyVmAUo",
                      "time":{"created":1791982295952},"type":"user",
                      "payload":{"text":"PISCOPE_CROSS_1"},"delivery":"queue"},
            "resultKeys":["id","sessionID","time","type","payload","delivery"]}
```

* Return value: the **admission record** (`SessionInboxUser`) — the same shape the API returns
  (`opencode-v2-plugin-api.md` §6.2), in **6 ms**. Not thrown, not dropped.
* The prompt was **executed by the target's location**: the turn's step/tool events (`session.step.*`,
  `session.tool.*`, `shell.*`) arrived tagged `evLoc: /tmp/opencode/piscope/projB`, and the first tool
  call the model made ran with **cwd = `/tmp/opencode/piscope/projB`** (verified from the stored `shell`
  tool output: first line `"/tmp/opencode/piscope/projB"`). So the caller's location (`projA`) does
  **not** leak into the target's run. Note the run-outcome events themselves
  (`session.execution.interrupted` for B1 after my interrupt, `session.execution.succeeded` for C1)
  carry **no** `location` field — only the run's inner events do.
* (The probe text `PISCOPE_CROSS_1` is meaningless to a model, so the free default agent
  `build`/`opencode/cat-jam-free` started exploring with read-only shell commands; I interrupted it —
  see §8 disclosure. That accident is itself evidence the turn really ran.)

### 2.3 `wait` — waits on the foreign session's run `[ran]`

```
cmd-wait {"cmdId":"c5","outcome":"WAIT_TIMEOUT","tookMs":5002}   # issued while B1's turn was running
cmd-wait {"cmdId":"c7","outcome":"WAIT_RETURNED","tookMs":1}     # issued after the interrupt; B1 idle
```

`ctx.session.wait({sessionID})` from A observed B's runner state: it blocked for the full 5 s while B1
was busy and returned immediately once idle. Caveat unchanged from the plugin-API research: `wait`
waits for the runner *drain*, not for a specific message.

### 2.4 The strongest case: location C had no instance at all `[ran]`

Sequence: (1) from instance A, `ctx.session.create({ location:{ directory: projC } })` created `C1`;
(2) from instance A, `ctx.session.prompt({ sessionID: C1, text: "Reply with exactly OK-C. Do not use any tools.", delivery: "queue" })`.

```
cmd-create {"result":{"id":"ses_ec586e7f8ffeS7mpYP0CYrqcu5", … ,
                       "title":"probe-cross-create",
                       "location":{"directory":"/tmp/opencode/piscope/projC"}}}
cmd-prompt {"cmdId":"c16","tookMs":433,
            "result":{"id":"msg_13a79e41c001wF3r7psvrDyt84", "type":"user",
                      "payload":{"text":"Reply with exactly OK-C. Do not use any tools."},
                      "delivery":"queue"}}
cmd-get    {"cmdId":"c17","outcome":"succeeded"}     # C1's final state
# C1 transcript in the isolated DB:  user "Reply with exactly OK-C. Do not use any tools."
#                                    assistant ["OK-C"]        idle succeeded
```

`projC` had never been served before (no plugin instance, no location services). The prompt took 433 ms
instead of 6 ms because the call **activated location C on demand** — and, visible in the log, produced
**instance #4** (`module-eval sqkyh9sw` + `setup sqkyh9sw#tvkx9z /tmp/opencode/piscope/projC`) at the
same second. The turn then ran to completion in C and replied `OK-C`, cost 0 (free model), while
`session.execution.*` events for C flowed to *all* instances (§3).

### 2.5 Errors and edge shapes `[ran]`

```
cmd-error {"cmdId":"c14","op":"get",   "name":"Session.NotFoundError","message":""}
cmd-error {"cmdId":"c15","op":"prompt","name":"Session.NotFoundError","message":""}
```

An unknown `sessionID` throws a `Session.NotFoundError` (the `message` string is empty; the name is the
signal) for both `get` and `prompt` — it is not silently dropped. `create` accepts
`{ location: { directory } }` and returns the created session.

---

## 3. Q3 — is the event stream location-filtered? **No** (within a process)

### 3.1 Observed delivery matrix `[ran]`

Aggregate of `probe.log` (**612 events**, end of experiment) — for every instance, the set of
`event.location.directory` values it received. The numbers in parentheses are the mid-experiment
snapshot right after the C1 turn, before the final rounds of periodic `model.updated` /
`provider.updated` refreshes and the shutdown events:

```
114g7mgq#lq2ui3  (projA)     201 events (194)  evLocs = {-, projA, projA/sub, projB, projC}
9ehqxisf#kq8det  (projB)     188 events (180)  evLocs = {-, projA, projA/sub, projB, projC}
3qqtk46s#c6vru6  (projA/sub) 179 events (170)  evLocs = {-, projA, projA/sub, projB, projC}
sqkyh9sw#tvkx9z  (projC)      34 events  (24)  evLocs = {-, projA, projA/sub, projB, projC}
gingqs55#7291zw  (projA after restart)  10 events  evLocs = {projA}
```

The projC instance — created in the middle of the experiment — even received `model.updated` /
`provider.updated` events tagged `projA`, `projB` and `projA/sub` (periodic refreshes at
12:54:54–12:55:39), and the `location.shutdown` events of all four locations were delivered across
instances (subject to teardown races: the projC instance logged shutdown events for `projA`,
`projA/sub`, `projB` and `projC`, while the `projA` instance only caught its own before its aborted
subscription).

* `-` = events with no `location` field (e.g. `session.usage.updated`).
* The last row is the *late* instance: created at 12:53:49 during C1's activation, it saw only events
  emitted after its `setup` — consistent with the topology report's "no replay" finding. Its small set
  is a **time** boundary, not a location boundary.
* Per-event examples: A (projA) received `session.created` for B's session B1 at 12:50:56.244 —
  **before A had ever made any call involving B** (A's first cross-location call was at 12:51:16).
  All three pre-existing instances also received `session.created` for the `projC` session 12:52:56.976
  while no `projC` instance existed, and every `session.step.* / reasoning.* / tool.* / shell.*` event of
  B1's and C1's turns.

### 3.2 What this corrects

* **Within one server process the stream is global**: one subscription per instance, all events
  delivered to all instances; `event.location` is metadata a subscriber can use for routing, not a
  filter. This matches the official docs sentence quoted at the top (§Context).
* **Across server processes the stream is empty** (topology report §5: 0 events for a turn executed by
  another pid; no replay). The topology report's phrase "scoped to the serving process" remains correct
  — the stream is process-scoped and *not* location-scoped.

### 3.3 Event types observed `[ran]`

`session.created`, `session.inbox.enqueued`, `session.inbox.delivered`, `session.execution.started`,
`session.execution.succeeded`, `session.execution.interrupted`, `session.instructions.updated`,
`session.step.started/streamed/ended`, `session.reasoning.started/delta/ended`,
`session.text.started/delta/ended`, `session.tool.input.started/ended`, `session.tool.called/progress/success`,
`session.usage.updated`, `shell.created`, `shell.exited`, `location.shutdown`, plus location-config events
`integration.updated`, `model.updated`, `provider.updated`, `agent.updated`, `command.updated`,
`skill.updated`, `websearch.updated`, `reference.updated`, `plugin.updated`, `models-dev.refreshed`.

`session.idle` was **not** observed as a stream event (0 occurrences in the log) even though the stored
run ends with an `idle` *message* (`session_message.type = 'idle'`); the run is otherwise bracketed by
`session.execution.succeeded/interrupted` + `session.usage.updated`.

---

## 4. Bonus — `ctx.storage` scoping and durability

### 4.1 Shared across locations `[ran]`

Each instance, at setup, reads `probe/who` and then overwrites it with its own `{setupId, locDir}`:

```
# projB instance setup:
storage-get phase=before-set value={"setupId":"114g7mgq#lq2ui3","locDir":"…/projA","at":…}   # A's write!
storage-get phase=after-set  value={"setupId":"9ehqxisf#kq8det","locDir":"…/projB","at":…}

# later, commands from A and from B (separate instances, separate locations):
cmd-storage-get (A) value={"setupId":"3qqtk46s#c6vru6","locDir":"…/projA/sub","at":…}
cmd-storage-get (B) value={"setupId":"3qqtk46s#c6vru6","locDir":"…/projA/sub","at":…}
cmd-storage-scan prefix="probe" → {"entries":[{"key":"probe/who", value:<same>}]}
```

Both instances see **the same value**, whichever instance wrote it last. `scan({prefix})` returns exactly
one entry → one shared namespace per plugin.

### 4.2 Key format — per plugin **id**, no location `[ran]`

The isolated DB contains the storage (table `kv`; note this table also caches `models.dev` data):

```
plugin:00700072006f00620065002d0070006900730063006f00700065:probe/who
   |{"setupId":"sqkyh9sw#tvkx9z","locDir":"…/projC","at":1791982429451}
   |1791982194920|1791982429451
```

`0070 0072 006f 0062 0065 002d 0070 0069 0073 0063 006f 0070 0065` = hex UTF-16LE of
`probe-piscope` (the plugin `id`). **No location component.** Prefix `plugin:<encoded id>:` is the whole
scoping story.

### 4.3 Durable across a server restart `[ran]`

Killed the isolated server (`pid 3936020`), started a fresh one (`pid 3951688`) with the same
`XDG_*` dirs, then triggered `projA`:

```
storage-get phase=before-set (new process) value={"setupId":"sqkyh9sw#tvkx9z","locDir":"…/projC","at":1791982429451}
```

The new process read the value written by the **previous** process. Storage is durable, and the first
`setup` after a restart sees the previous state — suitable for a cross-reload session index.

---

## 5. Design implications for `session-peers`

1. **Treat a "global plugin" as N location instances.** A machine-wide session index cannot live in
   module scope; each location instance has its own module evaluation. `ctx.storage` is the shared,
   durable namespace to put it in (keyed only by plugin id).
2. **Expect every instance to see every event in the process** (after its own subscription starts).
   With N instances this means N subscriptions to the same firehose and N writers to the shared index.
   Either accept duplicate writes (idempotent upserts are enough) or elect a writer via storage
   (compare-and-set on an instance id), because there is no leader notion in the runtime.
3. **Session APIs are location-transparent in-process.** `get`/`context`/`prompt`/`wait`/`create` all
   work across locations, and a prompt into an idle location will activate it (its plugin instances
   included). The only boundary that matters is the **process**: for another server process, the
   topology report's HTTP/DB channels are still required.
4. **`wait` is safe from a different location** as long as the target is not blocked on the caller
   (same circular-wait rules as `subagent-lifecycle.md` §4 — those are about runner state, not location).
5. **Watch the lifecycle**: instances are torn down with their location — `cleanup` was observed at
   server shutdown (SIGTERM), and the code shows a 60-minute inactivity TTL for location services
   (not waited out here). Don't assume `setup` runs once per process lifetime; anything not in
   `ctx.storage` is lost when an instance goes away.

---

## 6. Unverified / open questions

1. **Eviction of plugin instances after location inactivity.** The code shows a 60-minute TTL and a
   1-minute sweep for location services (`@opencode/LocationActivity`), but no experiment waited long
   enough to observe a plugin instance being disposed/`cleanup`ed. Whether eviction re-runs `setup`
   later (fresh instance) and how storage behaves across it is untested.
2. **Hot reload / config-change re-instantiation.** Adding/editing a plugin file triggers the config
   watcher and a `PluginSupervisor.activate` pass; whether existing per-location instances are reused,
   re-`setup`ed, or torn down was not tested (it would have disturbed the experiment's clean
   per-location accounting).
3. **Cross-plugin storage isolation.** Observed key format implies per-plugin-id isolation; only one
   plugin was exercised. A second plugin reading `probe/who` was not run.
4. **Location identity is taken verbatim from the request.** `x-opencode-directory` and
   `location[directory]` are used as-is after `decodeURIComponent`; symlinks, relative paths, and
   trailing slashes were not tested for canonicalization (my requests always used the same absolute
   spelling). Also untested: `workspaceID`-bearing locations (git worktree workspaces) — my locations
   had no `workspaceID`.
5. **`opencode serve` on an isolated `XDG_CONFIG_HOME`** was used throughout; parity with the live
   background service (`serve --service`) for plugin activation ordering was not checked beyond the
   observations in the topology report (which used the shared service with the real config dir).
6. **The 5-second activation timeout** (`Bl`) never fired in these tests; the failure mode for a plugin
   whose `setup` takes >5 s (or hangs) is unverified.

---

## 7. Cleanup and disclosure

* **Isolated server**: killed (both pids, `3936020` and `3951688`); `ss -ltn` shows port 49611 closed;
  no `piscope`/49611 processes remain. The **live background service** (pid 3793275,
  `opencode serve --service`) was never restarted or signaled and is still running;
  `~/.local/state/opencode/service.json` still has its 19:43 mtime. No curl/API call was ever made
  against the live service or the user's 38 GB DB.
* **Scratch artifacts kept** (280 KB total) under `/tmp/opencode/piscope/`: `probe.log` (full event +
  command log), `server.log`, `server2.log`, `evidence-db-dump.txt`, `ids.env`, `cfg/opencode/plugins/probe-piscope.ts`,
  `bin/*.txt` (binary extraction windows), empty `projA/`, `projA/sub/`, `projB/`, `projC/`.
  The isolated DB / state / cache dirs were deleted after the dump.
* **Unintended effect to disclose**: my prompt of `B1` (`PISCOPE_CROSS_1`) caused a real model turn
  (agent `build`, free model `opencode/cat-jam-free`) which ran eight **read-only** shell commands
  (`ls`, `cat`, `find`, `tail`, `grep -R`) scoped to `/tmp/opencode/piscope` except the last,
  `grep -R "PISCOPE_CROSS" /tmp/opencode /home 2>/dev/null | head -50`, which read (not modified) files
  under `/home`. It was interrupted (`outcome:"interrupted"`) ~2.5 minutes in; no file was written by it.
  Full command list is in `evidence-db-dump.txt`.
* **Harness side effect**: truncated command outputs were saved by the OpenCode shell tool under
  `~/.local/share/opencode/shell/global/sh_*.out` (normal harness behaviour, not part of this study).

---

## Appendix — artifacts for re-verification

| Path | Contents |
| --- | --- |
| `/tmp/opencode/piscope/probe.log` | every plugin-side line: `module-eval`, `setup-begin/end`, `storage-get`, `subscribe-*`, `event`, `cmd-*` (612 events) |
| `/tmp/opencode/piscope/server.log`, `server2.log` | server logs of the isolated instance (4 × `loading plugin`; restart transcript) |
| `/tmp/opencode/piscope/evidence-db-dump.txt` | isolated-DB dump: sessions, plugin `kv` row, B1 tool calls + cwd, C1 transcript |
| `/tmp/opencode/piscope/cfg/opencode/plugins/probe-piscope.ts` | the probe plugin (dependency-free; module/setup ids, event tap, command poller) |
| `/tmp/opencode/piscope/bin/*.txt` | binary windows: `loading-140845881.txt` (PluginModule.load), `dup-93010020.txt`, `instplugins-140437696.txt`, `locplugins-140889368.txt` (LocationActivity, `Bl`, `Xr`) |
| `/tmp/opencode/piscope/ids.env` | the session ids used (A2, B1) |
