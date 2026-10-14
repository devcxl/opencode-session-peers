# Built-in subagent lifecycle and concurrency (opencode 2.0.27, Linux)

Research date: 2026-10-14. Host binary: `/usr/bin/opencode` = **opencode v2.0.27**
(Bun-compiled ELF, 210,367,968 bytes), DB at `~/.local/share/opencode/opencode.db`.

Method: targeted extraction from the shipped binary (plain `grep -aob` for byte offsets and
`tail -c +OFFSET | head -c N` for windows — never a whole-file `strings` dump), cross-checked against
the installed TypeScript typings, plus **three real experiments** in a fully isolated opencode instance
(fresh DB, redirected `XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, project-scoped throwaway
plugin, dedicated port). Every claim is labelled **[ran]** (executed and observed) or **[inferred]**
(read from code/typings).

The instrumented instance: `opencode serve --hostname 127.0.0.1 --port 49533` (pid 3863634),
DB `/tmp/opencode/pr/dataB/opencode/opencode.db`, plugin
`/tmp/opencode/pr/projB/.opencode/plugins/probe-b.ts`, event log `/tmp/opencode/pr/events-B.jsonl`.
All probe servers were killed and no user session was touched; sessions in this instance are in the
isolated DB only.

---

## 0. Verdict on the crux

> If a child session calls `ctx.session.prompt({ sessionID: <parent>, text, delivery: "steer" })`
> **while the parent is blocked waiting for that child** —
> what happens: admitted, deferred, or dropped?

**Admitted immediately, deferred until the parent unblocks, never dropped — and it deadlocks if and
only if the child then waits for the parent.**

Measured, in one process, with the real built-in `subagent` tool:

| Event | Relative time | Evidence |
| --- | --- | --- |
| parent calls the `subagent` tool | t+3,157 ms | `session.tool.called {tool:"subagent"}` |
| child session created, child starts | t+3,166 ms | `session.created` for the child |
| child steers the parent (`delivery:"steer"`) | t+7,075 ms | `ctx.session.prompt` returned in **2 ms** |
| steer item enqueued in the **parent's** inbox | t+7,087 ms | `session.inbox.enqueued {itemType:"user"}` |
| child finishes (after `sleep 12`) | t+25,715 ms | child `session.execution.succeeded` |
| parent's `subagent` tool returns | t+25,715 ms | `session.tool.success` for the same call id |
| steer item **delivered** to the parent | t+25,715 ms | `session.inbox.delivered` — **18,638 ms after admission** |
| parent's conversation | — | `… → assistant(tool call) → user:"CHILD_SIGNAL_1" → assistant:"PARENT_DONE"` |

And the deadlock case: a child that steers the parent and then calls
`ctx.session.wait({ sessionID: parent })`:

```json
{"name":"probe_child_ask","state":{"status":"completed",
  "input":{"text":"CHILD_ASK_1","timeoutMs":15000},
  "content":[{"type":"text","text":"ASK_RESULT STILL_BLOCKED_AFTER_15000ms"}]},
 "time":{"created":1791979777347,"ran":1791979777741,"completed":1791979792750}}
```

`completed − ran = 15,009 ms`: the child's wait never returned while the parent was blocked in the
`subagent` tool. The parent only processed `CHILD_ASK_1` after the child's run ended.

So: **fire-and-forget child→parent messaging through a blocked parent is safe and lossless.
Request/response (the child waiting for a parent reply) is a real deadlock.**

---

## 1. How the built-in `subagent` tool creates a child session

### 1.1 The tool definition **[inferred — quoted from the binary]**

Extraction (offsets in bytes):

```
$ grep -aob 'opencode\.tool\.subagent' /usr/bin/opencode
95314904:opencode.tool.subagent
140568126:opencode.tool.subagent
$ tail -c +140560000 /usr/bin/opencode | head -c 30000 > subagent-tool-140560.txt
```

From that window (minified, quoted verbatim, newlines added at `;`/`,` boundaries for readability):

```js
… JL = ["Spawns an agent in a child session to work on the specified task.",
"The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
"New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
"Foreground (default) runs the subagent to completion and returns its final response.",
"Background mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.",
"Use background only for independent work that can run while you continue elsewhere."].join("\n"),

YL = { id:"opencode.tool.subagent", effect: c("SubagentTool.Plugin")(function*(e){
  let i=yield*ad, r=yield*v0, l=yield*ZL, m=yield*hs, A=yield*vu, _=yield*Ih, f=yield*Or,
      w=c("SubagentTool.resolveModel")(function*(T){ … });
  yield*e.tool.transform((T)=>T.add({
    name: dl,                       // var dl="subagent"  (same window)
    options:{codemode:!1},          // direct tool, NOT folded into the Code Mode catalog
    description: JL, input: KL, output: XL,
    execute: (N,I)=>a(function*(){ … })
  })).pipe(j),
  yield*e.tool.hook("execute.before", …);
  let k=(T)=>a(function*(){ let N=T.tools[dl]; if(!N) return; … });
  yield*e.session.hook("context",k), yield*e.session.hook("compaction",k), yield*e.session.hook("generate",k)
})};
```

`var dl="subagent"` is defined in the same window — so the **model-facing tool name is `subagent`**,
and it is exposed directly to the model (not through `execute`).

### 1.2 The `execute` body — verbatim core **[inferred]**

```js
execute:(N,I)=>a(function*(){
  let R=yield*i.get(I.sessionID).pipe(y((he)=>new so({message:`Parent session not found: ${I.sessionID}`,error:he}))),
      B=R, H=0;
  while(B.parentID) H++, B=yield*i.get(B.parentID).pipe(y((he)=>new so({message:`Parent session not found: ${B.parentID}`,error:he})));
  let z=jE(yield*m.entries(),"experimental")?.subagent_depth ?? 1;
  if(H>=z) return yield*new so({message:`Subagent depth limit reached (${z}). Increase "experimental.subagent_depth" to allow nested subagents.`});

  let X=yield*l.resolve(N.agent);
  if(X===void 0) return yield*new so({message:`Unknown agent: ${N.agent}`});
  if(X.mode==="primary") return yield*new so({message:`Agent ${N.agent} cannot run as a subagent`});
  yield*A.assert({action:dl,resources:[X.id],save:[X.id],sessionID:I.sessionID,agent:I.agent,
                  source:{type:"tool",messageID:I.messageID,id:I.id}}).pipe(y((he)=>new so({message:`Subagent denied: ${X.id}`,error:he})));

  let K = N.sessionID===void 0 ? void 0 : yield*i.get(N.sessionID).pipe(y((he)=>new so({message:`Subagent session not found: ${N.sessionID}`,error:he})));
  if(K!==void 0 && K.parentID!==I.sessionID) return yield*new so({message:`Session ${K.id} is not a child of the current session`});

  let Y = N.model===void 0 ? void 0 : yield*w(N.model);
  if(K!==void 0){ let he=K.agent!==X.id, we=Y??(he?X.model:void 0);
    yield*Kr([ he?i.switchAgent({sessionID:K.id,agent:X.id}):g, we===void 0?g:i.switchModel({sessionID:K.id,model:we}) ])
      .pipe(y((fe)=>new so({message:`Failed to switch subagent session: ${K.id}`,error:fe}))) }

  let te = Y ?? X.model ?? R.model,                                  // model: tool arg → agent's model → PARENT's model
      oe = K ?? (yield*i.create({ parentID: I.sessionID,             // <-- parentID IS passed
                                  title: N.description,
                                  agent: Sl.make(N.agent),
                                  model: te })
                 .pipe(y((he)=>new so({message:`Parent session not found: ${I.sessionID}`,error:he})))),
      le = N.background===!0;

  yield*I.progress({sessionID:oe.id,status:"running"}),
  yield*i.prompt({ sessionID:oe.id,
                   text: K===void 0 ? ["You are a subagent spawned by another session.",N.prompt].join("\n") : N.prompt,
                   ...(le&&K===void 0?{resume:!1}:{}) })
    .pipe(y((he)=>new so({message:`Failed to prompt subagent: ${oe.id}`,error:he})));

  let ye={kind:"subagent",parentSessionID:I.sessionID,childSessionID:oe.id,agent:X.name,description:N.description};
  if(yield*f.start(ye), le) return yield*f.background(ye), Dw(oe.id);

  let ae = yield*r.block({id:oe.id, sessionID:I.sessionID})          // <-- THE BLOCKING PRIMITIVE
             .pipe(Ia(()=>Kr([ i.interrupt(oe.id), r.cancel(oe.id) ],{discard:!0})));
  if(ae?.type==="backgrounded") return yield*f.notify(ye,ae.info.started_at), Dw(oe.id);
  if(ae?.info.status==="error")     return yield*new so({message:`Subagent failed (sessionID: ${oe.id}): ${ae.info.error??"unknown error"}`});
  if(ae?.info.status==="cancelled") return yield*new so({message:`Subagent cancelled (sessionID: ${oe.id})`});
  return { sessionID:oe.id, status:"completed", output: ae?.info.output ?? od }
}).pipe(h((R)=>({ output:R,
   content: R.status==="completed" ? `<subagent sessionID="${R.sessionID}" state="completed">\n${R.output}\n</subagent>` : R.output,
   metadata:{sessionID:R.sessionID,status:R.status} })))
```

**Answers:**

| Question | Answer |
| --- | --- |
| Does it pass `parentID`? | **Yes** — `i.create({ parentID: I.sessionID, title, agent, model })`. Confirmed in the DB (§1.3). |
| Which agent/model does the child get? | Agent = the tool's `agent` argument (must be non-`primary`; `Agent ${N.agent} cannot run as a subagent` otherwise). Model = explicit tool `model` arg → else the subagent agent's model → else the **parent's** model (`Y ?? X.model ?? R.model`). |
| Which location/directory? | **Inherited from the parent** — `create()` is called with `parentID` and no `location`; observed child `directory` == parent `directory` (§1.3). |
| Any other constraints? | Depth limit `experimental.subagent_depth ?? 1` (so nested subagents fail with `Subagent depth limit reached (1)…`); a permission check on action `subagent` with resource = the requested agent id; passing an existing `sessionID` continues that child, and is rejected unless `K.parentID === I.sessionID`. |
| Child's first message | Prefixed with `"You are a subagent spawned by another session.\n"` + the task (only for new children). |
| Return value | Foreground: `<subagent sessionID="…" state="completed">…</subagent>` + `metadata:{sessionID,status}`; background: immediately with `metadata.status = "running"`. |

Also relevant: subagent-mode agents are only *advertised* to the parent if allowed —
`(yield*l.list()).filter((B)=>B.mode!=="primary" && !B.hidden && hC(dl,B.id,I.permissions).effect!=="deny")`
— and their ids/descriptions are appended to the tool description at request time
(`session.hook("context"|"compaction"|"generate")`).

### 1.3 Persisted proof of the child relationship **[ran]**

From the isolated instance's DB:

```
$ sqlite3 -readonly /tmp/opencode/pr/dataB/opencode/opencode.db \
  "SELECT id, parent_id, agent, directory FROM session_v2 WHERE id IN
   ('ses_ec5b0a9d8ffe4Yb9guXb7711bu','ses_ec5b0b637ffeNxoHhVPSn0q5I3')"
ses_ec5b0a9d8ffe4Yb9guXb7711bu|ses_ec5b0b637ffeNxoHhVPSn0q5I3|general|/tmp/opencode/pr/projB
ses_ec5b0b637ffeNxoHhVPSn0q5I3||developer|/tmp/opencode/pr/projB
```

The first row is the child created by the `subagent` tool call `call-95437297-…` in the parent session;
`parent_id` is set, the agent is the requested `general`, and the directory equals the parent's.

### 1.4 A practical prerequisite discovered the hard way **[ran]**

Because the tool is registered with `options:{codemode:!1}` **and gated by the agent permission
`subagent`**, an agent that denies that action never sees the tool. On this machine:

```
$ curl -s -u opencode:<pw> http://127.0.0.1:49533/api/agent | jq …
general   : mode=subagent  permissions: {"action":"*","resource":"*","effect":"allow"},
                                          {"action":"subagent","resource":"*","effect":"deny"}
developer : mode=primary   permissions: {"action":"*","resource":"*","effect":"allow"}
subagent-mode agents: ['general','explore','deep-think','subagent/translator']
primary agents      : ['developer','plan','deep-research','teacher']
```

With `agent:"general"` as the parent, the model's own reasoning listed its tools
(`edit, glob, grep, probe_child_ping, read, shell, skill, websearch, write, execute, antigravity_*`)
and stated "there's no 'subagent' tool" — and indeed it never called it. With `agent:"developer"` the
tool was callable immediately. **All experiments below therefore use a `developer` parent and a
`general` child.**

---

## 2. Blocking semantics

### 2.1 The primitive **[inferred]**

`r.block({id: childSessionID, sessionID: parentSessionID})` resolves to the generic job service
(`v0`, returned as `v0.of({get,start,wait,block,background,backgroundAll,cancel,pendingBackground,completeBackground})`).
The relevant code, extracted at offset ≈140,077,000 (`runner-block.txt`):

```js
// v0 service surface
return v0.of({get:r,start:i,wait:m,block:T,background:k,backgroundAll:B,cancel:N,pendingBackground:R,completeBackground:LH})

// Job.start: a job entry carries a per-job set of sessions that are blocked on it
let nH={info:{id:rH.id,type:rH.type,title:rH.title,status:"running",started_at:AH,metadata:rH.metadata,…},
        done:IH, backgrounded:EH, scope:eH, blockingSessions:new Map, isBackgrounded:!1, consumed:!1, recovery:rH.recovery};

// Job.wait: supports an optional timeout …
m=c("Job.wait")(function*(rH){ … if(rH.timeout===void 0) return {info:yield*Ct(K.done),timedOut:!1};
     if(rH.timeout<=0) return {info:Gt(K),timedOut:!0};
     let AH=yield*Ct(K.done).pipe(af(rH.timeout)); … })

// Job.block: registers the CALLING session in the child job's blockingSessions, then awaits done|backgrounded
T=d(function*(rH){ let K=yield*uy(e.jobs,(AH)=>{
     let IH=AH.get(rH.id);
     if(!IH) return [{type:"missing"},AH];
     if(IH.info.status!=="running") return [{type:"finished",info:Gt(IH),generation:IH.scope},AH];
     if(IH.isBackgrounded) return [{type:"backgrounded",info:Gt(IH)},AH];
     return [{type:"wait",wait:{done:IH.done,backgrounded:IH.backgrounded,generation:IH.scope}},
             new Map(AH).set(rH.id,{...IH,blockingSessions:vd(IH.blockingSessions,rH.sessionID)})]});   // add sessionID
   …
   return yield*ii( Ct(K.wait.done).pipe(h((AH)=>({type:"finished",info:AH}))),
                    Ct(K.wait.backgrounded).pipe(h((AH)=>({type:"backgrounded",info:AH}))))
            .pipe(ze((AH)=>AH.type==="finished"?A(rH.id,K.wait.generation):g), ht(_(rH))) });             // remove on interrupt

// _: remove the session from blockingSessions
_=d(function*(rH){ yield*ox(e.jobs,(K)=>{ let AH=K.get(rH.id);
     if(!AH||AH.info.status!=="running"||AH.isBackgrounded) return K;
     return new Map(K).set(rH.id,{...AH,blockingSessions:Fd(AH.blockingSessions,rH.sessionID)}) }) });

// Job.backgroundAll: detach every job that some session is blocking on  (the escape hatch)
B=c("Job.backgroundAll")(function*(rH){ … for(let[z,X]of AH){ … if(!X.blockingSessions.has(rH.sessionID)) continue;
     let Y=yield*l(X); … } … });

// Job.cancel
N=c("Job.cancel")(function*(rH){ … let z={...EH,blockingSessions:new Map,info:{...EH.info,status:"cancelled",completed_at:K}}; … })
```

* The wait is on the child job's `done`/`backgrounded` **Deferred** — i.e. the parent's tool call
  suspends until the child's *run* finishes. `block` has **no timeout parameter** (`wait` does, but the
  subagent tool does not use `wait`).
* `blockingSessions` is the runner's model of "who is waiting on this job". `Job.backgroundAll({sessionID})`
  walks jobs and detaches those blocked by that session — this is what makes "background this work"
  possible, and it is why the tool has an `ae?.type==="backgrounded"` return branch.

### 2.2 Observed blocking **[ran]**

Experiment 1 (child runs `sleep 12` via the shell tool):

```
t+3,157 ms  parent  session.tool.called   {tool:"subagent"}   id=call-95437297-…
t+3,166 ms  child   session.created
t+3,189 ms  parent  session.tool.progress {status:"running"}
…
t+25,699 ms child   session.execution.succeeded
t+25,699 ms parent  session.tool.success  id=call-95437297-…      <-- unblocks exactly here
```

The parent's tool call lasted **22,558 ms** = the child's whole run. No timeout fired.

### 2.3 Can the parent's runner do anything else meanwhile?

* The **process** is not blocked: the child ran to completion inside the same server process while the
  parent sat in the tool, and unrelated sessions' events kept flowing.
* The **parent's turn** cannot advance: it is inside the tool call's fiber.
* The parent's **inbox still accepts** input (admission took 2 ms — §3), but its **drain is blocked**
  (delivery only after the tool returns — §3). This distinction is the key mechanism of the crux.
* A plugin running in the same process can do arbitrary work meanwhile (that is how the probe tool ran
  inside the child).

---

## 3. Crux experiment 1 — child steers the blocked parent **[ran]**

### 3.1 Rig

```
$ XDG_DATA_HOME=/tmp/opencode/pr/dataB XDG_STATE_HOME=/tmp/opencode/pr/stateB \
  XDG_CACHE_HOME=/tmp/opencode/pr/cacheB OPENCODE_SERVER_PASSWORD='probe-b-pw' \
  setsid nohup opencode serve --hostname 127.0.0.1 --port 49533 --print-logs &
```
The plugin (project-scoped, dependency-free) subscribes to events, registers a `session.hook("prompt")`
tap, and exposes `probe_child_ping`, which does:

```ts
const info = await ctx.session.get({ sessionID: context.sessionID })
const parentID = info.parentID
const t0 = Date.now()
const res = await ctx.session.prompt({ sessionID: parentID, text: input.text, delivery: "steer" })
// logs: parentID, tookMs, res.id/res.type/res.delivery
```

Parent prompt: *'You have a tool named "subagent". Call it exactly once now with agent="general" and
prompt="First call the tool probe_child_ping with text \"CHILD_SIGNAL_1\". Then call the shell tool with
command: sleep 12. Then reply with exactly CHILD_DONE."…'*

### 3.2 Observed timeline (ms since probe T0; delta lines elided)

```
298414 event   session.created              sid=ses_ec5b0b637ffe… (parent, developer)
298424 event   session.inbox.enqueued       sid=parent itemType=user seq=1
298479 event   session.execution.started    sid=parent
301007 event   session.tool.input.started   sid=parent tool="subagent"
301571 event   session.tool.called          sid=parent id=call-95437297-…  seq=10
301578 prompt-hook                          sid=ses_ec5b0a9d8ffe… text="You are a subagent spawned by another session.\nFirs…"
301580 event   session.created              sid=ses_ec5b0a9d8ffe… (child, general)
301580 event   session.tool.progress        sid=parent id=call-95437297-…      <-- parent parked in the tool
301603 event   session.execution.started    sid=child
305081 event   session.tool.input.started   sid=child tool="probe_child_ping"
305489 event   session.tool.called          sid=child id=call_00_pwnvhf4nscr8cb8z121z6plc
305489 ping-self    {"me":"ses_ec5b0a9d8ffe…","parentID":"ses_ec5b0b637ffe…","agent":"general", …}
305490 prompt-hook  {"sid":"ses_ec5b0b637ffe…","text":"CHILD_SIGNAL_1","delivery":"steer"}   <-- admitted to the BLOCKED parent
305491 ping-admitted {"to":"ses_ec5b0b637ffe…","tookMs":2,"resType":"user","resDelivery":"steer"}
305501 event   session.inbox.enqueued       sid=PARENT itemType=user seq=14        <-- queued while parent is blocked
305513 event   session.tool.success         sid=child id=call_00_pwnvhf4nscr8cb8z121z6plc
308559 event   session.tool.called          sid=child tool="shell" (sleep 12)
320635 event   session.tool.success         sid=child tool="shell"
324129 event   session.execution.succeeded  sid=child
324129 event   session.tool.success         sid=parent id=call-95437297-…            <-- parent unblocks
324129 event   session.inbox.delivered      sid=PARENT seq=17                        <-- steer now delivered
325188 event   session.execution.succeeded  sid=parent
```

Cross-check in the parent's stored conversation:

```
parent message types: ['user', 'assistant', 'user', 'assistant', 'idle']
USER   : "You have a tool named \"subagent\". Call it exactly once now with agent=\"general\" and prompt=\"First call the tool pr…
USER   : "CHILD_SIGNAL_1"
ASST   : PARENT_DONE
```

### 3.3 Conclusions

* **Admission while blocked: yes.** `ctx.session.prompt({delivery:"steer"})` is synchronous admission into
  the target's inbox; it returned in **2 ms** with a `SessionInboxUser` record, and the item appeared as
  `session.inbox.enqueued` — while the parent was inside the tool.
* **Processing while blocked: no.** The inbox item was `delivered` only at the same millisecond the
  `subagent` tool returned — **18,638 ms** after admission.
* **Loss: none.** The text appeared in the parent's conversation as a user message and the parent then
  produced its reply.
* No rejection, no error, no "busy" back-pressure. `delivery:"queue"` vs `"steer"` affects *drain order*
  (see the plugin-API research §6.3) but not whether a blocked runner can drain at all.

---

## 4. Crux experiment 2 — ask-and-wait deadlocks **[ran]**

Same rig, with a second probe tool:

```ts
await ctx.session.prompt({ sessionID: parentID, text: input.text, delivery: "steer" })
const verdict = await Promise.race([
  ctx.session.wait({ sessionID: parentID }).then(() => "PARENT_WENT_IDLE"),
  new Promise((r) => setTimeout(() => r(`STILL_BLOCKED_AFTER_${timeoutMs}ms`), timeoutMs)),
])
```

Child task: *"First call the tool probe_child_ask with text \"CHILD_ASK_1\" and timeoutMs 15000. After
that tool returns, reply with exactly CHILD_DONE."*

Observed:

```json
{"name":"probe_child_ask",
 "state":{"status":"completed","input":{"text":"CHILD_ASK_1","timeoutMs":15000},
          "content":[{"type":"text","text":"ASK_RESULT STILL_BLOCKED_AFTER_15000ms"}]},
 "time":{"created":1791979777347,"ran":1791979777741,"completed":1791979792750}}
```

```
completed − ran = 15,009 ms            # ctx.session.wait({sessionID: parent}) never returned
```

Parent's stored conversation afterwards:

```
USER  : "You have a tool named \"subagent\". Call it exactly once now …"
TOOL  : {"name":"subagent","state":{"status":"completed", "input":{…}, …}}
USER  : "CHILD_ASK_1"                  # the steer finally landed
ASST  : "PARENT_DONE"
```

**Verdict:** the child's `wait` on the parent *cannot* be satisfied while the parent is blocked in the
`subagent` tool, because the parent's runner cannot drain its inbox until that tool returns — and the
tool cannot return until the child's run ends. Classic circular wait. It is bounded only by whatever
timeout the child imposes itself (here 15 s) or by an external escape (§6). Note that the API gave the
child no error: it simply never completed — a *silent* hang until its own timeout.

Why it does not deadlock without the wait: `ctx.session.prompt` is admission-only (2 ms), so a
fire-and-forget steer cannot hold the child. The cycle only forms when the child blocks on something
that requires the parent to *process* the message.

---

## 5. How a plugin can tell "this is a subagent child, and its parent is X"

Everything below is what I could actually reach from plugin code **[ran]** (logged by the probe):

| Signal | Reachable from a plugin? | Evidence |
| --- | --- | --- |
| **`SessionInfo.parentID` via `ctx.session.get({sessionID})`** | **Yes — authoritative.** | `ping-self {"me":"ses_ec5b0a9d8ffe…","parentID":"ses_ec5b0b637ffe…", …}`. `infoKeys` for the child: `['id','parentID','projectID','agent','model','cost','tokens','time','title','location']`; for a primary session `parentID` is absent. |
| **The calling session of a tool invocation** | Yes: `ToolContext.sessionID` (+ `agent`, `messageID`, `id`) | same log line (`agent:"general"`, `toolCall:"call_00_pwnvhf4nscr8acc…"`). This is how the child learned *its own* id. |
| **`SessionInfo.agent` + the agent list's `mode`** | Yes, but only a heuristic | Children must use a non-`primary`, non-hidden agent (enforced by the tool: `Agent ${N.agent} cannot run as a subagent`); `developer`/`plan`/… are primary. Useful as a secondary check, never as the primary one. |
| **`session.created` event `data.parentID`** | **Unreliable in this build.** | My probe logged `session.created` for the child **without** a `parentID` value (`{"type":"session.created","sid":"ses_ec5b0a9d8ffe…"}` — the key was `undefined` and was dropped by `JSON.stringify`), even though the DB row and `session.get()` both have it. Treat event-derived parent discovery as needing a `session.get()` fallback. |
| **`OPENCODE_SESSION_ID` env var** | **Not in the plugin/server process.** | `tr '\0' '\n' < /proc/3793275/environ \| grep -c OPENCODE_SESSION_ID` → **0**. It *is* injected into the **shell tool subprocess**: my own shell env contained `OPENCODE_SESSION_ID=ses_ec5c5a28dffeIR4FAl6Hr20OqA`, `OPENCODE=1`, `AGENT=1`, `AI_AGENT=opencode`, `OPENCODE_TERMINAL=1`. So it is a channel for *child processes*, not for plugin code. Other `OPENCODE_*` names present in the binary include `OPENCODE_SERVER_PASSWORD`, `OPENCODE_PASSWORD`, `OPENCODE_CLIENT`, `OPENCODE_TERMINAL`, `OPENCODE_SIMULATE` (grep -o list), but none carries a session→parent mapping. |
| **Persisted**: `session_v2.parent_id` | Yes (DB read) | §1.3. |
| **HTTP headers**: `x-opencode-parent-session-id`, `x-opencode-session-id`, `x-opencode-session` | Present in the binary (offset 93,009,412 ff.), not exercised by me | Likely per-request routing/session context; not a plugin API. |

**Recommended identification logic for session-peers:**
`ctx.session.get({sessionID: <id>})` → if `parentID` is set, it is a child; the parent is `parentID`.
For the *other* direction (does X have children?), the plugin cannot enumerate children through
`ctx.session` (no `list`), so it must use another server's `GET /api/session?parentID=<id>` or read
`session_v2.parent_id`.

---

## 6. Timeout and interrupt

### 6.1 Is there a timeout on the subagent tool? — **No built-in timeout** **[inferred + ran]**

* The tool's inputs are `agent`, `description`, `prompt`, `model`, `sessionID`, `background` (from the
  description strings; the only numeric knob mentioned anywhere near it is the depth limit). No timeout
  field is present in the tool's input schema.
* The blocking path is `Job.block({id, sessionID})`, which has **no** timeout, unlike
  `Job.wait({id, timeout})` (`runner-block.txt` quote in §2.1).
* Observed: the parent stayed blocked 22.6 s for a 12 s child (exp. 1) and ≥15 s in exp. 2, with nothing
  firing. So the wait is effectively unbounded.
* The only implicit bound is the **child's own** behaviour (its run ending) or an external action.

### 6.2 Escape hatches (from the code)

* `Job.backgroundAll({sessionID})` — detaches every job that `sessionID` is blocking on
  (`if(!X.blockingSessions.has(rH.sessionID)) continue`), which yields the tool's
  `ae?.type==="backgrounded"` branch and returns to the parent with `metadata.status` still `running`.
* `SubagentJob.background({childSessionID, …})` → `i.background(childSessionID)` (the same path the tool
  uses for `background: true`), then `SubagentJob.notify` waits for the child and re-wakes the parent
  (`i.wait({id: childSessionID})` → resume) when it finishes.
* `Job.cancel(id)` / `session.interrupt`.

### 6.3 Does the parent's interrupt cancel the child? — **Yes** **[ran]**

Experiment 3: child told to run `sleep 40`; at t≈10 s I interrupted the **parent**:

```
$ curl -s -u opencode:probe-b-pw -X POST -H 'content-type: application/json' -d '{"resume":false}' \
    http://127.0.0.1:49533/api/session/ses_ec5ac0b93ffeC0zSF4p3N4MuC8/interrupt
{"interrupted": true}

parent: {"outcome":"interrupted","time":{"created":1791979943022,"updated":1791979953044,"idle":1791979953046}}
child : {"outcome":"interrupted","tokens":{…},"cost":0.000295326,"time":{…,"idle":1791979953054}}
```

* Both ended `interrupted`; the child's idle timestamp (…953054) is **8 ms** after the parent's
  (…953046) — the child's 40 s sleep was cut short.
* The parent's tool call was closed as an aborted tool error:

```json
{"type":"tool","name":"subagent","executed":false,
 "state":{"status":"error",
          "input":{"agent":"general","description":"sleep test","prompt":"Call the shell tool with command: sleep 40…"},
          "error":{"type":"aborted","message":"Tool execution interrupted (sessionID: ses_ec5ac056dffeSicjW1nYlFEEtn)"},
          "metadata":{"sessionID":"ses_ec5ac056dffeSicjW1nYlFEEtn","status":"running"}}}
```

This matches the code path: on interruption of the tool, `Ia(() => Kr([i.interrupt(oe.id), r.cancel(oe.id)], {discard:!0}))`
interrupts **and cancels** the child job.

---

## 7. Consequences for `session-peers`

1. **Never make a child block on its parent while the parent is inside the `subagent` tool.** That is the
   one guaranteed deadlock. The child must use `delivery:"steer"` (or `"queue"`) fire-and-forget.
2. **Child→parent notifications are reliable-enough**: 2 ms admission, durable inbox row, delivered in
   order after the tool returns, visible in the parent's conversation. A plugin that only *notifies* is safe.
3. **Deadlock detection is the plugin's job.** Nothing in the runtime reports "you are waiting on a
   session that is blocked in the tool that started you". A child asking for a reply must implement its
   own timeout and, ideally, check `SessionInfo` of its parent (e.g. `parentID` set + the parent's
   `outcome`/`time.idle`) or use `opencode.tool.subagent`'s background mode instead.
4. **Prefer the `background:true` path for parent-side request/response.** In background mode the parent's
   tool returns immediately (`if(le) return f.background(ye), Dw(oe.id)`) and the runtime notifies the
   parent when the child finishes (`SubagentJob.notify` → `i.wait` → resume) — so the parent's inbox is
   never blocked, and steer/queue delivery from the child lands promptly.
5. **Identify children via `ctx.session.get(...).parentID`,** not via the `session.created` event (the
   event's `parentID` was missing in my probe) and not via `OPENCODE_SESSION_ID` (absent from the server
   process).
6. **`ctx.session.wait({sessionID})` is only safe when the target session is not blocked on you.** With a
   plugin-owned tool that blocks its caller, a peer calling `wait` on it will hang exactly like the child
   in experiment 2 — the same circular wait applies to *any* plugin tool that blocks. Design tools to be
   non-blocking (return a handle, deliver asynchronously) if peers may wait on them.
7. **Session creation is cheap and location-inheriting**: a plugin can `ctx.session.create({...})` and
   prompt it, but it cannot set `parentID` through the plugin `SessionDomain` (`SessionCreateInput` has
   no `parentID`; only the built-in tool's internal `create` call sets it). So plugin-managed "children"
   are not recognized as subagents by the runtime (no depth accounting, no `subagent` permission).

---

## 8. Unverified / open questions

1. **Exact tool input schema (`KL`)** — I quoted the field names from the tool's own parameter
   descriptions (`agent`, `description`, `prompt`, `model`, `sessionID`, `background`) but did not
   extract the schema object itself, so I cannot swear there is no extra optional field (e.g. a hidden
   timeout). No timeout was observed in behaviour.
2. **`x-opencode-parent-session-id` semantics** — present in the binary; not exercised. It is the most
   likely "server-side session context" header for a child request.
3. **Whether `session.created` normally carries `parentID`** — the typings say yes
   (`SessionCreated.data.parentID?`), my probe captured no value for a real child. Possible explanations
   (event emitted before `parent_id` was written, or a different code path for tool-created children)
   were not distinguished.
4. **What actually resumes a *background* subagent's parent** — the code path
   (`SubagentJob.notify` → `i.wait({id: childSessionID})` → `X2(e,i,{...k,recovery})`) was not traced to
   its observable effect in a session, and I did not run a background-mode experiment.
5. **`experimental.subagent_depth` > 1** (nested subagents) was not exercised; only the default-1
   rejection path is evidenced by the code (and by the fact that agents with `subagent: deny`, like
   `general`, cannot nest regardless).
6. **Ownership of the child when the parent's server dies** — the job/runner state lives in the parent's
   process; a restart would leave the child session persisted but its `backgrounded`/`done` deferred
   gone. Not tested (would require killing a live server).
7. Whether `ctx.session.prompt` to a parent **in a different server process** is admissible was not
   tested here; see `opencode-multiprocess-topology.md` §4 for the cross-server HTTP result and §9.1 for
   the open question.

---

## Appendix — artifacts kept for re-verification

| Path | Contents |
| --- | --- |
| `/tmp/opencode/pr/projB/.opencode/plugins/probe-b.ts` | the instrumentation plugin (event tap, `session.hook("prompt")`, `probe_child_ping`, `probe_child_ask`) |
| `/tmp/opencode/pr/events-B.jsonl` | full event/timeline log of all three experiments (`ms`, `kind`, payload; includes `ping-self`, `ping-admitted`, `ask-*`) |
| `/tmp/opencode/peers-research/parent*-ctx.json`, `parent2-ctx.json`, `parent3-ctx.json` | stored conversations of the parent sessions (tool results, steered messages) |
| `/tmp/opencode/peers-research/subagent-tool-140560.txt` | 30 KB binary window containing `SubagentTool.Plugin` (name `dl="subagent"`, `options:{codemode:!1}`, full execute body) |
| `/tmp/opencode/peers-research/subagent-impl-140440.txt` | 22 KB window containing `SubagentJob` (`start`, `background`, `notify`) |
| `/tmp/opencode/peers-research/runner-block.txt` | 20 KB window containing the job service (`start/wait/block/background/backgroundAll/cancel`) and every `blockingSessions` use |
| `/tmp/opencode/peers-research/agents-b.json` | agent list showing `general` mode/permissions (`subagent: deny`) vs `developer` |
| `/tmp/opencode/pr/dataB/opencode/opencode.db` | isolated DB with `session_v2.parent_id` proof (probe sessions only) |
