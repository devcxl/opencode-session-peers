# #63 real-host no-extra-wakeup plan (runner implemented, not executed)

Status: runner and pure stub tests implemented; not executed. This lane did not
start a real host, TUI, service or live API. The parent owns the isolated
real-host run after review; the runner reuses the existing #61 harness safety
pattern rather than inventing a second one.

## What this must prove, and what it must not claim

Prove through the complete plugin entry and a real isolated host:

- a controlled delegation grant plus a public `delegate` adds no prompt,
  generation, steer or interrupt to the parent or child at delegation time;
- the child reaches exactly one correction queue only after its own report and
  a trusted idle sample; the queue is `queue`, never `steer`;
- the child's real receipt issues one continue permit; a source revoke before
  the receipt records seen without a permit;
- a scope change or source revoke discovered without opening the panel stops
  the next send/receipt;
- the parent's normal context is not prompted by delegation alerts.

It must stay honest: the final host-fact check and host enqueue are not one
transaction. Do not claim retraction of an accepted message, exactly-once
delivery, a stop-proof, multiple-host support, or that an execution success is
business completion.

## Isolation

- Scratch root via `mkdtemp` under `/tmp/opencode`; `TMPDIR=/tmp`.
- Scratch `HOME`, `TMPDIR`, `XDG_DATA_HOME`, `XDG_STATE_HOME`,
  `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`.
- Minimal whitelist environment: `PATH`, scratch values, locale, `TZ`. Do not
  inherit `OPENCODE_*`, provider keys, `SESSION_PEERS_WATCH_STATE_DIR` or any
  credential. No `authSource`; the offline deterministic stub uses only the
  literal `stub` provider key.
- Random loopback port; client URL taken from the started instance. Never use
  `opencode api`, default service discovery or the live URL.
- The child service is detached in its own process group. Stop must report
  `stopped=true` and `portClosed=true`; the live service registry digest must
  be identical before and after. Remove scratch only after those checks.
- Do not print passwords, auth values, raw prompts, tool arguments, grant
  challenges, correlations or task goals. Record bounded metadata only:
  session ids, booleans, counts, event types, timestamps, ledger status.
- Do not modify the verified static tuple in the production source. The only
  accepted fixture tuple remains `2.3.0-watchdog-location.1/linux/x64` and must
  pass the isolated runtime probe (embedded SQLite/WAL/synchronous/busy
  timeout/filesystem).

## Candidate host

Use the exact repaired artifact already accepted by #61, or a future tuple the
parent adds through the same static gate after its own protocol pass. The runner
must refuse to start if the observed tuple is stock `2.3.0`, a new version, or
any other platform/arch. A config/env/model override must not lower the gate.

## Flow

1. Start the isolated host and stub. Probe the real tuple and the embedded
   SQLite facts. Load the complete plugin through a location-scoped request
   (the #61 harness uses `models(projectA)`); do not call the live URL.
2. Create the parent session in the scratch project with the deterministic
   model. If the public host API can create a direct child session, use it and
   assert the host-reported `parentID`; otherwise perform one ordinary
   subagent delegation through the stub as the original business step, then
   snapshot both transcripts and assert the delegation flow below adds no
   further user message.
3. Enroll the parent's own task through the real `peers` tool (alert-only).
   Snapshot parent/child user-message counts, generations and interrupts.
4. Call the controlled sibling `watchDelegation` prepare with
   `deployment: "single-host-same-location"` and `mode: "limited-correction"`;
   assert the review contains the exact delegation and correction texts and
   `derivesCorrectionGrant: true`. Confirm with the returned challenge. This is
   a panel/RPC action, not a model tool.
5. Call the public `delegate` operation through the real `peers` tool with the
   parent task, concrete child, request id, goal, mode and expected version.
   Assert:
   - the child link is recorded with the fresh `parentID`, directory and
     scope;
   - the parent and child user-message counts did not increase from delegation
     itself;
   - there is no generation, steer or interrupt.
6. In the child's existing normal turn, have the deterministic stub call
   `peers({action:"watch",watch:{operation:"report",kind:"begin",...}})`. Then
   let the child become normally idle with a bounded scratch `idleMs` (e.g.
   2s) and `tickMs` (e.g. 250ms). Do not fake host timestamps.
7. Assert exactly one correction queue: one user message beginning
   `[session-peers correction]`, one permanent attempt, delivery `queue`; no
   steer, generation or interrupt. The stub parses the prompt's concrete
   `taskID`/`attemptID`/`correlation` and calls the real child receipt tool:
   exactly one `continuePermit=true`; a second duplicate receipt has
   `continuePermit=false`.
8. Without reading `watch` or `watchDelegationView`, revoke the source
   delegation through the controlled RPC. A further child receipt must record
   seen with no permit. If a new attempt is eligible, the executor must not
   send; the ledger's durable source check must refuse.
9. Scope-change variant: in a fresh scratch task, move the child to another
   scope through the existing roster/`setScope` path (or another controlled
   scope fact) and do not open the panel. The next receipt and any executor
   round must refuse; assert no goal/report/alert leaks into the parent's
   context.
10. Confirm the parent's normal model context was not started by delegation or
    alert creation: no prompt request, no generation and no interrupt; a
    context hook may add text only on the next normal request.
11. Stop the child and stub; verify both ports closed and the live registry
    digest unchanged. Keep failure scratch without secrets if a step fails.

## Evidence split

- Real host should prove: complete entry load, controlled grant over the real
  RPC, public delegate over the real tool, no delegation-time wakeup, one
  trusted-idle queue, child receipt permit, revoke-before-receipt refusal,
  scope-change refusal, isolation.
- Fake/unit evidence already covers: revoked-before-claim and
  revoke-during-authority-lookup races, unknown delivery retention, hard
  attempt limits, schema/idempotency, RPC readers, view redaction and the
  no-guard fail-closed path.
- Real host is not evidence for exactly-once, retraction, power-loss
  durability, multi-host uniqueness or a stop-proof.

## Implemented runner and stub

This lane adds `scripts/research/watchdog-63/no-extra-wakeup.ts`, its pure
`protocol.ts`, and `stub.ts`. They reuse the #61 harness for scratch
`HOME`/four XDG dirs, the literal stub provider, explicit loopback, owned child
stop and the live-registry digest. No shared client, source, schema, runtime
gate or host database is changed.

### Child creation fact

The typed public `SessionCreateInput` has no `parentID`; `SessionInfo` reports
it. The typed `SessionImportInput` (`POST /api/experimental/session/import`)
does accept `parentID`, but it imports a transcript and is not the ordinary
business path. The runner therefore uses the plan's fallback: one real
`subagent` tool turn driven by the deterministic stub creates the direct child,
and the runner reads the child back through the public session list/get API and
asserts `parentID === parent.id`. It does not use the experimental import, does
not fake a lookup and does not write the host database. The subagent's first
turn is idle; it never reports a task begin before the parent task is enrolled.
The reviewed host source requires `agent` on the subagent input, so the exact
args are `prompt=WATCH63_CHILD_IDLE`, `description=...`, `agent=general`
(the default subagent agent with no model override, inheriting the parent's
stub model); this version always backgrounds and has no background input, so
the runner does not send one.

### Count baseline

The child creation and its initial subagent turn are allowed to settle before
the first baseline. A synthetic child-completion message is counted as a native
host report only when **all** of these hold: `type=synthetic`,
`metadata.source="subagent"`, `metadata.childID=<current child>`, and the text
tag's `sessionID` is the same child. A bare `<subagent>` tag, another child's
report, missing metadata, or a tag/child mismatch is not exempt; a metadata
match with an inconsistent tag is counted as invalid and fails closed. The
initial native report is before the baseline, not a plugin wake. The previous
positive run failed `the child begin driver generated in the parent` because
this native host behavior was mis-attributed; the assertion now separates it.

Then:

- RPC enroll is compared before/after: parent/child user, assistant, correction,
  native-host-report, other-synthetic and inbox counts must not change.
- The explicit parent begin tool turn is a fresh baseline (one parent driver
  user; child unchanged).
- `watchDelegation` prepare, confirm and the read-only parent view are compared
  before/after: all bounded counts and the assistant count must be unchanged.
- The explicit public `delegate` driver may add one parent user message and its
  own driver generation; child user/assistant/native/other-synthetic, correction
  and parent/child inbox counts must not change. A bounded settle must show no
  further user, assistant, correction, synthetic or inbox growth.
- The explicit child begin driver adds one child user turn, exactly one native
  host subagent report for that child, and exactly one parent stub response to
  that host report. Parent user and correction do not grow; no other synthetic
  report appears. This is **not** called "no parent wake": the parent generated
  because of the host's native report, and the runner did not block or bypass it.
- Final versus after-delegate: positive adds exactly one explicit parent
  wrong-caller driver user and zero negative add; parent correction does not
  grow. Positive has three child turns (begin, automatic correction, duplicate)
  and therefore three native host reports; negative has two. Parent assistant
  grows by at least one per native report and at most that plus the explicit
  wrong-caller driver (zero negative). The child adds its explicit begin (and
  duplicate in positive) plus exactly one automatic correction user prompt; one
  spent attempt; no correction steer and no interrupted outcome. All counts are
  settled twice; assistant is compared too. The report labels
  `nativeHostReports`, `nativeHostReportSource=host-subagent-completion`,
  `parentGeneratedByHostReports`, and `watchPluginExtraPrompts=0`; it does not
  call host-report generation a plugin extra prompt.

### Scenarios

- `WATCH63_SCENARIO=positive`: A-C. Real subagent child, RPC enroll, real parent
  begin, controlled `watchDelegation` prepare/confirm with exact canonical
  reviews and `derivesCorrectionGrant=true`, real public `delegate`, child begin,
  one trusted-idle queue, real child receipt permit, progress recovery, duplicate
  receipt without a second permit, parent wrong-caller receipt refused.
- `WATCH63_SCENARIO=revoke`: fresh child/task. The stub holds the first
  correction response behind a bounded latch; the runner revokes the source
  delegation through the controlled RPC, then releases the original receipt
  turn. The receipt records seen without a permit (`duplicate=false`,
  `continuePermit=false`, delegation reason); the parent view redacts task and
  alerts.
- `WATCH63_SCENARIO=scope`: fresh child/task. The same latch is released only
  after the public `setScope` RPC moves the child scope; the receipt gets no
  permit and the parent view is redacted. No watch/view is read while the
  receipt is latched.

The runner keeps the raw RPC answers only in private locals. The positive final
`watch` raw JSON is asserted not to contain the dispatch correlation before the
loose bounded reader is used; the negative `watchDelegationView` raw JSON is
asserted not to contain the parent goal before its fields are read. The final
child `watch` raw answer is checked for correlation in both variants.

Queue proof is honest: the runner records one correction user prompt and no
observed correction steer. Native subagent reports may legitimately appear in
the parent inbox with delivery=steer; that is host report delivery, not a
watch/correction steer, and the runner reports it separately. If the public
inbox retains consumed delivery metadata, it records that the correction item
was `queue`; if the host retains none, the report says
`entry-delivery-queue-only` rather than claiming a runtime queue observation.
The entry `correctionDelivery` source and its tests remain the queue evidence.

The runner does not wait five minutes or try to spend all three attempts; the
#62 controlled-clock public entry already proves the three-attempt limit. It
does not claim retraction, exactly-once delivery, a stop proof, multi-host
uniqueness or power-loss durability.

### Commands (parent runs after review)

The runner refuses without an explicit confirmation, plugin path and approved
allocation; it also refuses without the patched binary path.

```bash
TMPDIR=/tmp WATCH63_REAL_CONFIRM=1 \
WATCH63_PLUGIN=/path/to/parent-final-reviewed-worktree \
WATCH63_OPENCODE_BIN=/home/devcxl/Projects/OpenCodePlugins/opencode-session-peers/.worktrees/watchdog-61-verification/.host-source/packages/cli/dist/cli-linux-x64/bin/opencode \
WATCH63_SCENARIO=positive \
bun scripts/research/watchdog-63/no-extra-wakeup.ts
```

Use `WATCH63_SCENARIO=revoke` or `scope` for the fresh refusal cases. Add
`WATCH63_KEEP_SCRATCH=1` to keep a successful scratch; failures are kept
automatically. The report prints only bounded booleans, counts, ids, version
facts, paths and a generic/controlled failure; no prompt, goal, challenge,
correlation, credential or password.

The runner requires the approved patched binary by its fixed SHA-256
(`93c16b937359c226eb77691c7453c5fdadb2b716e1b6da7434d7cc8fc6c5cb7a`), then reads
the real `watch` RPC ledger facts and requires
`2.3.0-watchdog-location.1/linux/x64`, embedded SQLite `3.53.4`, WAL, FULL and a
positive busy timeout. It does not inject a candidate tuple or force a config
gate. `WATCH63_PLUGIN` must point at the parent's final reviewed plugin, not at
the earlier #63 writer tree; the runner dynamically reads that plugin's
canonical terms and uses loose bounded readers for the payload fields it needs,
so a later integrated plugin is not rejected by an older strict reader.

### Evidence split

- Real host should prove: complete entry load, controlled grant over the real
  RPC, public delegate over the real tool, no delegation-time wakeup, one
  trusted-idle queue, child receipt permit, revoke-before-receipt refusal,
  scope-change refusal, isolation.
- Fake/unit evidence already covers: revoked-before-claim and
  revoke-during-authority-lookup races, unknown delivery retention, hard
  attempt limits, schema/idempotency, RPC readers, view redaction and the
  no-guard fail-closed path.
- Real host is not evidence for exactly-once, retraction, power-loss
  durability, multi-host uniqueness or a stop-proof.
- `test/watch-delegation-research.test.ts` only exercises the pure scripted
  model/directive plan, exact subagent args, native-report metadata/tag
  classification and the latch predicate; it starts no host or model.
  Targeted result in this lane: 10 pass, 0 fail, 49 expectations; overall
  `tsc --noEmit` and `git diff --check` are clean. The runner itself was not
  executed here; the parent's first positive run and the native-report
  attribution are recorded above.
