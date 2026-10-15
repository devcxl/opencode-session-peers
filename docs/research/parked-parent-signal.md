# The parked-parent signal: what a parent's transcript can prove (opencode v2.0.29, Linux)

Research date: 2026-10-15. Host binary: `/usr/bin/opencode` = **opencode v2.0.29**, 211,064,288 bytes,
md5 `6653617a3eb61ea49192fbd7325d4d3a` — the same binary as `tool-result-metadata-undefined.md` and
`ask-reply-handshake.md`. Prior notes: `subagent-lifecycle.md` (a foreground `subagent` call parks the
parent), `subagent-background-mode.md` (`background: true` does not).

Method: three fully isolated opencode instances (own `XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`/
`XDG_CONFIG_HOME`, own database, dedicated port, own `OPENCODE_SERVER_PASSWORD`), the plugin under test
installed from the project's `.opencode/opencode.json`, the developer's provider plugin and `auth.json`
copied in for the runs and deleted at teardown. One instance additionally carried a throwaway probe
plugin whose tool read the caller's parent transcript from *inside* the child session. Every claim below
is **[ran]**.

## 0. What this note corrects

ADR-0002 says the parked-parent detection reads "the parent's … running tool call is the `subagent`
call **for this session**". On 2.0.29 that attribution is not possible: a running `subagent` call names
no child session at all — not in its input, not in its progress metadata — for the whole run. The
parking itself is trivially observable (`name: "subagent"`, `state.status: "running"`), and reading it
as the parking is what the implementation does; see §4 for what that over-covers and §5 for the cost.

## 1. Where the child id was expected

`subagent-lifecycle.md` §1.2 quotes the tool's execute body: for a **new** child the model passes no
`sessionID`, the tool creates the session itself, and the only place the new id appears in the tool's
own call is the progress update it sends to its caller:

```js
yield*I.progress({sessionID:oe.id,status:"running"}),        // I = the parent's tool context
yield*i.prompt({sessionID:oe.id, …});
…
let ae = yield*r.block({id:oe.id, sessionID:I.sessionID})    // parked from here until the child ends
```

For a **continued** child the model passes `sessionID`, so the call's input would carry it.

## 2. Measurement: the running call carries no child id

Two independent sources, both while a real foreground child was running.

**(a) The HTTP context route**, read from outside while the parent was parked (t ≈ +2.5 s after the
call started, child running):

```json
{ "type": "tool", "id": "call_00_hfp7ufgeuj5pgakgtxuuc37i", "name": "subagent", "executed": false,
  "state": { "status": "running",
             "input": { "agent": "general", "description": "fg ask", "prompt": "You are a probe. …" },
             "metadata": {} },
  "time": { "created": 1792028646226, "ran": 1792028646751 } }
```

`input.sessionID` absent (a new spawn, as expected) and **`metadata` is `{}`** — the progress update is
not in the message part. The same part once the child had finished (t+21.5 s) carries the id, which is
what a post-hoc reader sees:

```json
"state": { "status": "completed", "metadata": { "sessionID": "ses_ec2cd021affejoKQsDFYy04j7P",
                                               "status": "completed", "truncated": false } }
```

**(b) The plugin-side read** (`ctx.session.context({sessionID: parentID})` from inside the child, via a
probe tool) at two points in the parked window, 2.1 s and 15.9 s after the call started:

```
at 1792028403671 me ses_ec2c8a062ffe7qbKMeNZOaijc0 parent ses_ec2c8b264ffeOuJAwK9cQ7lok9
    subagent running input.sessionID None metadata {} time {'created': 1792028400927, 'ran': 1792028401559}
at 1792028416809 me ses_ec2c8a062ffe7qbKMeNZOaijc0 parent ses_ec2c8b264ffeOuJAwK9cQ7lok9
    subagent running input.sessionID None metadata {} time {'created': 1792028400927, 'ran': 1792028401559}
```

Two reads, one before and one after the child had spent 10 s asleep: the metadata never fills in while
the call is running. The plugin-side read itself works — `ctx.session.context` answers for a session in
the same location and returns the running part — so the probe has a real signal, just not a
child-attributable one.

**Also observed:** while parked, both sessions' roster records say `status: "busy"` (the roster is not
part of the rule; recorded because it is a second signal a future host could lean on).

## 3. What each side sees, before and after the rule change

With the rule reading only a child id that the host never writes, a foreground child's ask **stalled the
full configured ask timeout** (120 s in the run below; the stock default is 10 minutes) and the parent's
transcript received the question only *after* the `subagent` call returned:

```
child's peers call: ran=1792028116884 completed=1792028236894 elapsed=120010 ms (timeout)
parent's transcript: the question appears at 1792028442969 — after the subagent call completed at
                     1792028442960
```

With the rule reading the running call itself, the same scenario, live:

```
tool input : {"action": "ask", "to": "ses_ec2c4f105ffesyFbiL9pl5A9ZA", "message": "FG-CHILD-QUESTION: …"}
tool result: [{"type":"text","text":"\"Supervisor\" is your parent session and cannot answer inside this
              turn: it is inside a subagent call that has not returned. Use \"send\" to hand it the
              question together with your recommendation, or raise it in your final report."}]
metadata   : {"delivered":false,"code":"E_TARGET_UNREACHABLE","retryable":false,
              "sessionID":"ses_ec2c4f105ffesyFbiL9pl5A9ZA","parentProbe":"parked","truncated":false}
timing     : ran=1792028648918 completed=1792028648926 -> 8 ms
```

and the parent's own transcript at that moment was exactly the running part of §2(a) — `metadata: {}`.

**A background child** (same host, same plugin), asking while its parent stayed idle:

```
child's peers call: ran=1792028681157 completed=1792028684167 -> 3010 ms
tool result: [{"type":"text","text":"**Reply from Supervisor BG:**\nBG-PARENT-ANSWER"}]
child session outcome while the answer landed: still running
```

## 4. The rule's shape, and its over-approximation

The rule reads: **the parent's transcript holds a `subagent` call whose status is `running`** → parked.
That is not an attribution, and it deliberately over-covers: a parent parked on *another* child (a
background child and a foreground sibling can coexist) also cannot drain its inbox, so an ask to it
would stall just the same, and refusing it is the honest answer. The direction of the approximation is
the safe one for this channel: it can refuse an ask whose parent is parked on someone else, and it never
lets the deadlock case through.

Two limits, recorded rather than hidden:

- **A stale running part.** A server restart during a foreground call leaves the part `running` while
  the job it waited on is gone; a child that survived that restart and then asked would be refused a
  parent that could in fact answer. Nothing measured here reaches that state (`subagent-lifecycle.md`
  §6.3 shows an interrupt closing the part as `error`), and the refusal tells the child what to do with
  the question instead of dropping it.
- **The `background: true` window.** The call is `running` for the ~34 ms between the progress update
  and the return; an ask landing inside it is refused although the parent is about to become idle.

## 5. The skill surface is real, and a plugin's skill reaches the model

`@opencode/plugin` 2.0.16 declares `ctx.skill: SkillDomain` (`transform`, `reload`, plus `SkillApi`),
and the 2.0.29 binary's promise adapter builds it (`skill:{list,transform,reload}`). Registered through
`ctx.skill.transform(editor => editor.add({id, name, description, path, content}))` in the instance's
`setup`, the skill is listed by the location's skill API:

```
GET /api/skill  (x-opencode-directory: <project>)  -> 200; 52 skills; session-peers-supervisor present=true
{ "id": "session-peers-supervisor", "name": "session-peers-supervisor",
  "description": "How a subagent session reaches the session that spawned it with the peers tool, and
                  why a parent that wants to be asked must spawn the child with background: true.",
  "path": "/…/src/skill.ts", "content": "# session-peers supervisor channel\n…" }
```

The model's guidance list is built from exactly these records, filtered to those with a `description`
and without `autoinvoke: false` (the 2.0.29 `SkillInstructions.load` quoted in the extraction window),
so a registered skill with a description is what a parent sees in its `<available_skills>` section.
No file has to exist at `path`; only a `path` whose basename is `SKILL.md` triggers a directory scan.

## 6. Disclosures and artifacts

- **Touched:** three throwaway `opencode serve` instances on ports 45229 / 44929 / 35135 (+ one boot
  that answered 503 and was stopped by the harness), each with its own XDG dirs and database under
  `/tmp/opencode/t8-supervisor/`; all SIGTERMed, ports closed, isolated databases left in scratch. The
  provider plugin copy and `auth.json` copy were deleted at teardown.
- **`~/.local/state/opencode/service.json`** is byte-identical before and after every run
  (md5 `bc39454dae86f66d7c99293cf4197a34`); the live service was never signalled or queried.
- Scratch: `/tmp/opencode/t8-supervisor/` — `live.ts` (acceptance pair), `signal.ts` + `probe/`
  (the two plugin-side reads), `skill-check.ts`, `evidence/` and `signal-evidence/` (raw JSON captures
  quoted above), `live-run.log`.
