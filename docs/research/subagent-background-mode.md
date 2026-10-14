# Can a subagent be spawned in detached/background mode? (opencode 2.0.27, Linux)

Research date: 2026-10-14. Host binary: `/usr/bin/opencode` = **opencode v2.0.27**
(Bun-compiled ELF, 210,367,968 bytes). Prior context:
`docs/research/subagent-lifecycle.md` (foreground `subagent` call blocks the parent's turn,
verified) and `docs/research/opencode-v2-plugin-api.md` (plugin API surface).

Method: targeted `grep -aob` + cached byte windows from the binary (offsets below), the installed
TypeScript typings, and **four experiments on a fully isolated spare server** (fresh
`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, project-scoped throwaway plugin, dedicated port).
Every claim is labelled **[ran]** (executed and observed) or **[inferred]** (read from code/typings).

Spare server (now stopped; see §8):

```
$ cd /tmp/opencode/bg/proj && XDG_DATA_HOME=/tmp/opencode/bg/data XDG_STATE_HOME=/tmp/opencode/bg/state \
    XDG_CACHE_HOME=/tmp/opencode/bg/cache OPENCODE_SERVER_PASSWORD='bg-probe-pw' \
    setsid nohup opencode serve --hostname 127.0.0.1 --port 49541 --print-logs > /tmp/opencode/bg/server.log 2>&1 &
```

---

## 0. Verdict

| Channel | Non-blocking child? | Evidence |
| --- | --- | --- |
| **The model** (built-in `subagent` tool) | **YES — `background:true`** tool argument. The tool returns in tens of ms with `status:"running"` and the runtime notifies the parent when the child finishes. | §1, experiment 1 |
| **Agent/config** | **NO.** No config or agent field selects it; the `experimental` config whitelist has no background key. | §1.4 |
| **A blockable foreground call already in flight** | **YES — `POST /api/session/:id/background`** moves it into background observation (204; the parked tool unblocks with `metadata.status:"running"`; a synthetic message is injected). Callable by any local process with the service password, including plugin code via `fetch`. | §2, §3, experiment 2 |
| **Plugin code calling `ctx.session.background`** | **NO — the plugin domain has no such method** (runtime `Object.keys(ctx.session)` lacks it). But plugin code **can** call the HTTP route with Basic auth, and plugin-created sessions/tools can achieve the same effect by not blocking at all. | §3 |
| **Does the parent stay able to answer mid-child-run in background mode?** | **YES.** Observed: child steered the idle parent at t+4.2 s; parent's new turn ran t+6.1 s→7.6 s and answered; the child was still running until t+31.6 s. Completion notification woke the parent again for a final turn. | §4, experiment 1 |
| **Plugin-created child sessions** | **YES, plugin `ctx.session.create({parentID})` works at runtime** (2.0.27 accepts and persists it, `SessionInfo.parentID` set), and such a child runs **entirely independently** of any parent turn — no blocking, no job, no completion notification. Blocking is a property of the `subagent` **tool**, not of parent-child sessions. | §5, experiment 3 |

---

## 1. The built-in `subagent` tool: a per-call `background` argument

### 1.1 Tool input schema **[inferred — quoted from the binary]**

Byte offsets (single-pass `grep -aob`): `opencode.tool.subagent` at 140,568,126;
`KL=o({agent` at **140,566,280**; description array `JL` begins at 140,567,499; `Dw=` at 140,565,849.

```js
// KL = the tool's input schema (offset 140,566,280)
KL = o({
  agent: t.annotate({description:"The type of specialized agent to use for this task. …"}),
  description: t.annotate({description:"A short 3-5 word label for the task, displayed to the user"}),
  prompt: t.annotate({description:"The task for the subagent to perform"}),
  model: Je(t).annotate({description:'NEVER set this unless the user explicitly asks for a particular model…'}),
  sessionID: Je(fo).annotate({description:"Continue a specific previous subagent conversation…"}),
  background: Je(P).annotate({description:"Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress."})
})
```

`Je(…)` is the optional wrapper used across the same schema (`Je(t)` for the string `model`), so
`background` is an **optional boolean**; the execute body also tests it strictly
(`N.background===!0`). The exact declaration of the minified `P` was not recovered (see §7), but
`background:true` was accepted and behaved as documented in experiment 1.

The tool description adds the mode to the model's prompt **[inferred]**:

```
Foreground (default) runs the subagent to completion and returns its final response.
Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.
Use background only for independent work that can run while you continue elsewhere.
```

### 1.2 The execute branches **[inferred]**

From the cached window (same bytes as `subagent-lifecycle.md` §1.2, re-verified for this work):

```js
let ye = {kind:"subagent", parentSessionID:I.sessionID, childSessionID:oe.id, agent:X.name, description:N.description};
if (yield*f.start(ye), le)                     // le = N.background === true
  return yield*f.background(ye), Dw(oe.id);    // <-- returns IMMEDIATELY, no block()
let ae = yield*r.block({id:oe.id, sessionID:I.sessionID}).pipe(/* interrupt+backgroundAll safety */);
if (ae?.type==="backgrounded") return yield*f.notify(ye,ae.info.started_at), Dw(oe.id);  // escape branch
```

* `f` = the `SubagentJob` service: `start` registers a job keyed by the **child session id**
  (`i.start({id:_.childSessionID,type:"subagent",title:_.description,metadata:{},recovery:_,run:…})`);
  `background:(_)=>{let f=yield*i.background(_.childSessionID); if(f) yield*A(_,f.started_at)}` where
  `A` is `SubagentJob.notify` (offset 140,446,604 region) — i.e. the explicit-background path
  **also arms the completion notification**.
* `Dw(oe.id)` (offset 140,565,849) is the immediate return value the model sees:

```
The subagent is working in the background (sessionID: <id>). You will be notified automatically when it finishes.
DO NOT sleep, poll for progress, ask the subagent for status, or duplicate this subagent's work; …
Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.
```

### 1.3 The completion notification **[inferred]**

`SubagentJob.notify` waits for the child job and calls `X2(e,i,{...info,recovery})`; `X2`
(offset **140,369,557**) is:

```js
var X2=d(function*(e,i,r){ if(r.status==="running")return; let l=r.recovery, m=r.output/…;
  if(yield*e.synthetic({ ...r.notificationID?{id:r.notificationID}:{},
      sessionID:l.parentSessionID, ...r.resume===!1?{resume:!1}:{}, description:l.description,
      text:`<subagent sessionID="${l.childSessionID}" state="${r.status}" description="${l.description}">\n${m}\n</subagent>`,
      metadata:{source:"subagent",childID:l.childSessionID,agent:l.agent,state:r.status} }),
     r.notificationID) yield*i.completeBackground(r.notificationID) });
```

So the parent receives a **synthetic inbox message** carrying the child's final text (observed in
both experiments), and `session.synthetic` with default `resume` **wakes an idle parent** (§4).

### 1.4 Not configurable by config/agent **[inferred]**

The config reader's whitelists (offset 140,189,952 for `subagent_depth","layout"`) are:

```js
fP=["logLevel","server","subagent_depth","layout"]
rP=["disable_paste_summary","batch_tool","openTelemetry","primary_tools","continue_loop_on_deny"]
oP=["id","whitelist","blacklist"]
```

There is no `background`/`detach`/`async` config key anywhere near the agent or experimental schema;
`experimental.subagent_depth` only controls nesting depth (quoted at 140,569,437 in the tool:
`z=jE(yield*m.entries(),"experimental")?.subagent_depth??1`). **Background is per tool-call only.**

---

## 2. `Job.background` / `Job.backgroundAll` — internal service, one production caller

Job service definition (offset ≈140,077,0xx–140,082,7xx, cached as `runner-block.txt`):

```js
l = … // transformer: {isBackgrounded:true, blockingSessions:new Map, …recovery?{notificationID:…}}
k = c("Job.background")(function*(rH){ /* detach the job rH; fire its `backgrounded` deferred: */
     … if(K.info&&K.backgrounded) yield*fH(K.backgrounded,K.info); return K.info }),
B = c("Job.backgroundAll")(function*(rH){ /* for every running non-backgrounded job with
     rH.sessionID in X.blockingSessions (and matching rH.type if given): yield*l(X);
     fire `backgrounded` deferreds with {discard:true} */ … }),
return v0.of({get:r,start:i,wait:m,block:T,background:k,backgroundAll:B,cancel:N,pendingBackground:R,completeBackground:LH})
```

All `backgroundAll` byte offsets in the binary (single `grep -aob` pass, 5 hits):

| Offset | Context |
| --- | --- |
| 92,994,416 / 92,994,564 | embedded client type/service surface (client-side names) |
| 140,081,256 | the `Job.backgroundAll` definition above |
| 140,082,743 | the `v0.of({…})` service surface |
| **140,233,356** | **the only production caller: `Session.background`** |

The single `Job.backgroundAll` caller (offset 140,233,290 `"Session.background"`):

```js
background: c("Session.background")(function*(K){
  yield*rH.get(K);
  let AH = yield*k.backgroundAll({sessionID:K});
  if (AH.length===0) return;                       // idle requests are a no-op
  yield*rH.synthetic({sessionID:K, text:["User requested that active blocking work be moved to the background.",
    "","Backgrounded work:", ...AH.map((IH)=>`- ${IH.type}: ${IH.title??IH.id}`),"",
    "The backgrounded work is still unfinished. Move on to other work if you can. … Do not wait, sleep, poll, or report the backgrounded work as complete until a later completion notification is added to the conversation."].join("\n")})
})
```

`Job.background` is called from `SubagentJob.background` (quoted §1.2) and nowhere else in the
paths I extracted. Both are members of the internal `@opencode/Job` Effect service — **not reachable
from plugin `ctx`**; the supported external entry point is the HTTP route below.

### 2.1 The HTTP route **[inferred, then ran]**

Offset 133,367,911:

```js
.add(Lr("session.background","/api/session/:sessionID/background",{params:{sessionID:fo},success:Ao,error:Tr})
 .middleware(i).annotateMerge(Ce({identifier:"session.background",summary:"Background blocking session tools",
 description:"Move active foreground backgroundable tools for this session into background observation. Idle requests are a no-op."})))
```

The 2.0.16 client typings already ship the method: `session background:` at
`~/.config/opencode/node_modules/@opencode/plugin/node_modules/@opencode/client/dist/promise/client.d.ts:76`,
input `SessionBackgroundInput = {sessionID}` (`…/generated/types.d.ts:6124-6128`), transport
`method:"POST", path: "/api/session/${sessionID}/background", successStatus:204, empty:true`
(`…/dist/chunks/service-timing-bpdjd9xk.js:528-535`).

---

## 3. Is `session.background` callable from plugin code?

### 3.1 The plugin domain does **not** expose it **[ran]**

Plugin setup logged the runtime surface from this 2.0.27 server:

```
$ head -1 /tmp/opencode/bg/events.jsonl
{"ms":306,"kind":"setup","pid":3900205,…,
 "sessionSurface":["command","compact","context","create","generate","get","hook","interrupt","move",
                   "prompt","remove","switchAgent","switchModel","synthetic","update","wait"],
 "typeofBackground":"undefined","typeofSynthetic":"function","typeofWait":"function","typeofCreate":"function"}
```

16 keys, **no `background`** (also no `list`, `active`, `message`, `inbox.*`). Plugins load lazily
on the first turn of a session in the project (server log `msg="loading plugin"` lines only appear
then; `events.jsonl` was empty until the first prompt) — a side observation worth knowing for
plugin debugging.

### 3.2 But plugin code can call the HTTP route **[ran]**

The probe plugin's tool `probe_bg_http_background` did exactly what user code would do:

```
$ # inside the child session, from plugin code (executed during experiment 1):
{"ms":35157,"kind":"http-bg-resolved","parentID":"ses_ec59b62fdffe1SJWwAsNEJmaUQ"}
{"ms":35157,"kind":"http-bg-start","target":"ses_ec59b62fdffe1SJWwAsNEJmaUQ",
 "pwSrc":"env:OPENCODE_SERVER_PASSWORD","hasPw":true}
{"ms":35160,"kind":"http-bg-done","target":"ses_ec59b62fdffe1SJWwAsNEJmaUQ","status":204,"body":""}
```

The plugin used `fetch("http://127.0.0.1:49541/api/session/<id>/background", {method:"POST",
headers:{authorization:"Basic "+base64("opencode:"+password)}})` and got **204**. On the real
machine the password comes from `~/.local/state/opencode/service.json` (`{url,password}`; Basic user
`opencode`) — that channel is already documented and verified in
`opencode-multiprocess-topology.md` §6/§1. The plugin implements that fallback too, but the env
var was present in the spare server, so the fallback was not exercised here (open question §7).

### 3.3 Moving a genuinely parked foreground call to the background **[ran — experiment 2]**

Session P2 was told to call `subagent` **without** background for a child that runs `sleep 25`,
then reply `PARENT2_DONE`; when its session is idle again reply `PARENT2_NOTIFIED`. Once the child
session appeared (parent parked inside `Job.block`), an *external* client ran:

```
$ curl -si -X POST -u opencode:bg-probe-pw http://127.0.0.1:49541/api/session/ses_ec59938b2ffeeQ6kZOGsQQZ8H9/background
HTTP/1.1 204 No Content
vary: Origin
Date: Wed, 14 Oct 2026 12:32:59 GMT
Connection: keep-alive
Keep-Alive: timeout=5
```

Timeline (ms since plugin T0; P2 = parent, CH = child; `events.jsonl`):

```
149207 P2  session.tool.called        (subagent, foreground)      <- parent parks in Job.block
149215 CH  session.created            (child starts)
     …   (external curl at ~149700–150000 → 204)
150964 P2  session.tool.success       id=fd688b765394              <- unblocked after 1,757 ms
150965 P2  session.inbox.enqueued     item=synthetic               <- "User requested…moved to the background"
152473 P2  session.inbox.delivered
152576 CH  session.tool.called        (shell sleep 25)
153759 P2  session.execution.succeeded                             <- P2 turn done, child STILL running
177606 CH  session.tool.success       (sleep 25 finished)
179503 CH  session.execution.succeeded
179503 P2  session.inbox.enqueued     item=synthetic               <- X2 "<subagent … state=completed>"
179528 P2  session.execution.started
180711 P2  session.execution.succeeded                             <- PARENT2_NOTIFIED
```

Stored conversation of P2 (`GET /api/session/<P2>/context`):

```
TOOL  | subagent completed | metadata {"sessionID":"ses_ec59934c…","status":"running","truncated":false}
ASST  | PARENT2_DONE
SYNTH | "User requested that active blocking work be moved to the background.\n\nBackgrounded work:\n- subagent: fg probe\n\nThe backgrounded work is still unfinished. …"
ASST  | Acknowledged; standing by for the completion notification.
SYNTH | metadata {source:"subagent", childID:"ses_ec59934c…", agent:"General", state:"completed"}
ASST  | PARENT2_NOTIFIED
```

So: the escape hatch works end-to-end over HTTP, and its mechanics are exactly
`Job.backgroundAll` → `backgrounded` deferred → tool's `ae?.type==="backgrounded"` branch
(`f.notify` + `Dw`) → `Session.background`'s synthetic message.

---

## 4. Does the parent stay idle-drainable in background mode? **[ran — experiment 1]**

Wake semantics (supporting code):

* `Session.prompt` (offset 140,222,607): `… if(w.resume!==!1) yield*f.wake(hH); return FH` —
  admission wakes the runner unless `resume:false`. Offset of the wake call: 140,223,079.
* `Session.synthetic` (offset 140,224,568): `… if(w.resume!==!1 && !revert) yield*f.wake(hH)` —
  the completion notification can wake an idle parent.

Experiment 1: P1 = parent (`developer`), told to call `subagent` with `background=true`; the child
was told to (1) `probe_bg_ping` the parent with `CHILD_SIGNAL_BG`, (2) call the plugin's HTTP
`/background` probe on the parent (idle → no-op), (3) `sleep 20`, (4) reply `CHILD_DONE_BG`. The
parent was told: after launch reply `PARENT_LAUNCHED_BG`; on any later message reply `PARENT_ACK_BG`;
on the completion notification reply `PARENT_FINAL_BG`.

Timeline (ms since plugin T0; P1 = parent, CH = child):

```
 28665 P1  session.tool.called        (subagent, background=true)
 28672 CH  child prompt-hook / created
 28699 P1  session.tool.progress      (running)
 28699 P1  session.tool.success       <- tool returned after 34 ms, metadata.status="running"
 29724 P1  session.execution.succeeded            <- P1 idle; child alive
 32908 *ping-admitted               {"to":P1,"tookMs":2}          <- child's steer admitted
 32917 P1  session.inbox.enqueued     item=user (seq 22)
 32954 P1  session.execution.started              <- PARENT WAKES WHILE CHILD RUNS
 33661 P1  session.step.started
 34544 P1  session.execution.succeeded            <- PARENT_ACK_BG done at t+34.5s
 35160 *http-bg-done                 {"status":204}               <- plugin fetch to /background
 37319 CH  session.tool.called        (shell sleep 20)
 57375 CH  session.tool.success
 60315 CH  session.execution.succeeded
 60315 P1  session.inbox.enqueued     item=synthetic               <- X2 completion notification
 60338 P1  session.execution.started
 61227 P1  session.execution.succeeded            <- PARENT_FINAL_BG
```

Stored conversation of P1:

```
ASST  | TOOL:subagent:completed
ASST  | PARENT_LAUNCHED_BG
OTHER | idle
USER  | (child steer → PARENT_ACK_BG turn)
ASST  | PARENT_ACK_BG
OTHER | idle
SYNTH | text starts "<subagent sessionID=… state=\"completed\" description=\"bg probe\">"
ASST  | PARENT_FINAL_BG
OTHER | idle
```

(The tool result content the model saw, from the same context:
`"The subagent is working in the background (sessionID: ses_ec59b0ba5ffe…). You will be notified
automatically when it finishes.\nDO NOT sleep, poll…"`, `metadata {sessionID, status:"running",
truncated:false}`.)

**Answer: yes.** With `background:true` the parent's turn ends; while the child runs the parent is
idle and drainable. An inbound `delivery:"steer"` from the child (admitted in 2 ms) started a new
parent turn within 46 ms and the parent answered ~16 s before the child finished. The child's
completion then woke the parent for a final turn. `delivery:"queue"` was not separately tested
(open question §7), but both deliveries go through the same `Session.prompt` wake path.

---

## 5. Plugin-created child sessions **[ran — experiment 3]**

### 5.1 `parentID` **is** accepted at runtime (correction to prior research)

`Session.create` in the binary (offset 140,229,408; the `parentID` check at 140,229,550):

```js
… let EH=K.parentID ? yield*_.get(K.parentID) : void 0;
    if(K.parentID && EH===void 0) return yield*new sL({sessionID:K.parentID});
    let z=EH?.location ?? K.location;
    if(z===void 0) return yield*re(Error("Session.create requires either location or an existing parentID"));
    … publish({sessionID:AH, parentID:K.parentID, location:z, … metadata:K.metadata??EH?.metadata, permissions:K.permissions??EH?.permissions, …})
```

The plugin probe called, from inside a tool of session P3:

```js
a = await ctx.session.create({ title:"plugin-child-no-parent", agent:"general" })
b = await ctx.session.create({ parentID: context.sessionID, title:"plugin-child-with-parent", agent:"general" })
```

Observed (`events.jsonl`; full object keys included):

```
{"ms":287313,"kind":"mkchild-a","id":"ses_ec5971953ffeahtv3c52L6wCTL","err":null,
 "keys":["id","projectID","agent","cost","tokens","time","title","location"]}
{"ms":287315,"kind":"mkchild-b","id":"ses_ec597194fffeJGtCQbXnZ0jCJr",
 "parentID":"ses_ec5976be8ffeeustdjrVGFDJIb","err":null,
 "keys":["id","parentID","projectID","agent","cost","tokens","time","title","location"]}
```

Persisted proof (isolated DB):

```
$ sqlite3 -readonly /tmp/opencode/bg/data/opencode/opencode.db \
  "select id, parent_id, agent, title from session_v2 where id in (…)"
ses_ec597194fffeJGtCQbXnZ0jCJr|ses_ec5976be8ffeeustdjrVGFDJIb|general|plugin-child-with-parent
ses_ec5971953ffeahtv3c52L6wCTL||general|plugin-child-no-parent
ses_ec5971fd6ffexczGGb4McBjfsk|ses_ec5976be8ffeeustdjrVGFDJIb|general|http-child-of-p3
ses_ec5976be8ffeeustdjrVGFDJIb||developer|bg-exp-3-plugin-child
```

and `GET /api/session/<id>` returns `parentID` for both plugin- and HTTP-created children.

> **This corrects `subagent-lifecycle.md` §7.7** ("it cannot set `parentID` through the plugin
> `SessionDomain`"). The 2.0.16 **typings** lack the field, but the **2.0.27 runtime** accepts,
> passes through, and persists it — the same decode-behaviour ("onExcessProperty":"ignore" in the
> config reader; here the session service itself takes `parentID`). The HTTP `POST /api/session`
> route accepts `parentID` too (verified: `http-child-of-p3` above), again ahead of its typings.

### 5.2 Such a child runs fully independently **[ran]**

The probe then prompted the created child (B) with "shell `sleep 6`, then reply
`PLUGIN_CHILD_DONE`" and returned immediately. Timeline:

```
285646 H  session.created             (HTTP child with parentID, never prompted)
287347 B  session.inbox.enqueued       item=user       <- ctx.session.prompt from the parent's tool
287348 P3 session.tool.success                          <- parent's tool returned the same ms
287373 B  session.execution.started
288583 P3 session.execution.succeeded                   <- P3 turn OVER, 17.2 s before B
294825 B  session.tool.success        (shell sleep 6 ended)
295793 B  session.execution.succeeded                   <- B replies PLUGIN_CHILD_DONE; context verified
```

* P3's turn ended normally, with **no block, no job, no synthetic message, no completion
  notification** — nothing was enqueued to P3 after B finished (its context is exactly
  `USER → TOOL → MKCHILD_DONE → idle`).
* B's context shows `shell` ran and it replied `PLUGIN_CHILD_DONE` on its own.

**Conclusion:** the parking behaviour is entirely a property of the `subagent` **tool** calling
`Job.block`. A parent-child session relationship by itself carries **no** blocking, no job, and no
notification wiring. A plugin can therefore spawn "helper" sessions (optionally with `parentID`
for bookkeeping) and drive them without any effect on the caller's turn — provided the plugin
never awaits them inside a tool call that the caller is waiting on (see `subagent-lifecycle.md`
§7.6 for the generic blocking-tool caveat).

---

## 6. Practical implications for `session-peers`

1. **Prefer `background:true`** when the *model* is asked to delegate: it is a documented tool
   argument, the parent stays idle, child steers land promptly, and completion arrives as a
   `<subagent state="completed">` synthetic message (with `metadata.source:"subagent"`).
2. **Do not rely on a plugin `background` method** — `ctx.session.background` does not exist. Use
   `fetch` against `http://127.0.0.1:<port>/api/session/<id>/background` with Basic
   `opencode:<password>` (password from `~/.local/state/opencode/service.json`), when an escape
   hatch for an already-parked foreground call is needed. It is a no-op when the session is idle,
   and injects a synthetic user-visible message when it acts — acceptable, but noisy: prefer
   never parking in the first place.
3. **Plugin-owned helper sessions work and are independent**: `ctx.session.create({parentID})`
   is accepted at runtime (typings lag), and prompting the new session starts it on its own
   runner. There is no automatic completion notification for these children — the plugin must
   implement its own bookkeeping/notification (or prompt the "parent" itself when done).
4. Background children are still **cancellable via the parent**: interrupting the parent
   interrupts/cancels the child job (prior research §6.3); the same `blockingSessions`/`scope`
   machinery applies once the call is inside `Job.block`. With `background:true` there is no
   `Job.block`, but a `SubagentJob` still exists (keyed by the child session id), so
   `Job.cancel`/`session.interrupt` semantics are worth re-checking if cancellation matters.

---

## 7. Unverified / open questions

1. **Exact schema declaration of `P`** (the `background` field type). `Je(P)` + the `===!0` test
   and successful `background:true` calls make "optional boolean" the only consistent reading,
   but the minimised definition of `P` was not located (`/api/tool` does not exist — 404 on the
   spare server — so the model-facing JSON Schema could not be dumped).
2. **`background:true` while continuing an existing child (`sessionID` passed).** The code
   distinguishes new children (`...(le&&K===void 0?{resume:!1}:{})`) from continued sessions; the
   resumed-runner interaction (prompt wake + `Job.start` early-return + `Job.background`) was not
   exercised.
3. **`delivery:"queue"` from child to idle parent** — only `steer` was tested; both share the
   same wake call, but queue-vs-steer drain ordering on an *idle* target was not observed.
4. **Reading `service.json` from plugin code** was implemented but not exercised (env password was
   present on the spare server, which is not the normal case). The file/credential channel itself
   is verified in `opencode-multiprocess-topology.md`.
5. **Does `Session.background` on a session with mixed blocking jobs (e.g. a background shell
   command) behave identically?** `Job.backgroundAll` filters by `blockingSessions` only, and
   `Session.background`'s synthetic lists `IH.type`/`title` — only the `subagent` case was
   exercised.
6. **Durability across server restart** for backgrounded jobs: `Job.pendingBackground` scans
   `job.background/<notificationID>` keys and `X2` calls `completeBackground`; the restart path
   (`SessionRestart`) was not exercised.
7. The 16-method runtime `ctx.session` surface on 2.0.27 includes `remove`/`compact`, which the
   installed 2.0.16 typings do not declare — one more instance of the version drift documented in
   `opencode-v2-plugin-api.md` §9.3.

---

## 8. Disclosures, cleanup, artifacts

* **Touched**: only the spare server on `127.0.0.1:49541` (pid 3900205, killed; port closed), the
  isolated dirs `/tmp/opencode/bg/**`, and a temporary read-only copy of
  `~/.local/share/opencode/auth.json` into the isolated data dir — **deleted after the tests**
  (`rm /tmp/opencode/bg/data/opencode/auth.json`).
* **The user's live service was not touched**: `~/.local/state/opencode/service.json`
  md5 `5b38756557f0d207b67f74fc57023d91` (unchanged vs the baseline recorded before this
  research session), service pid 3793275 alive, no requests sent to its port.
* Kept for re-verification (≈7 MB, inside `/tmp/opencode/bg/`):
  | Path | Contents |
  | --- | --- |
  | `/tmp/opencode/bg/events.jsonl` | full event log of all four experiments (296 lines) |
  | `/tmp/opencode/bg/proj/.opencode/plugins/probe-bg.ts` | the probe plugin (`probe_bg_ping`, `probe_bg_http_background`, `probe_bg_mkchild`) |
  | `/tmp/opencode/bg/test2.py` | the HTTP-background experiment driver (experiment 2) |
  | `/tmp/opencode/bg/p1-ctx.json`, `p2-ctx.json`, `p1-sid.txt`, `p3-sid.txt` | parent conversations + session ids |
  | `/tmp/opencode/bg/data/opencode/opencode.db` | isolated DB with the `session_v2.parent_id` proofs |
  | `/tmp/opencode/bg/server.log` | spare server log (plugin lazy-load evidence) |
* Binary extraction notes: all offsets validated with single-pass `grep -aob` against
  `/usr/bin/opencode` (2.0.27); no full-file text dumps were produced.
