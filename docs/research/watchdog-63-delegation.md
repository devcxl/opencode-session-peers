# #63 direct-child delegation lane

Status: implementation slice in `watchdog-63-delegation` (branch
`feat/watchdog-63-delegation`, based on the accepted #61 integration commit
`987670e`). This lane owns delegation authorization/revocation, child
enrollment orchestration and the independent child view. It consumes the #61
correction grant, receipt and executor; it does not change retry/episode policy,
the attempt pane, the existing watch operation DTO or the shared panel
skeleton. #62 changes `WATCH_CORRECTION_TERMS` and the execution policy in
parallel; this lane imports the one canonical constant and binds it into the
delegation digest dynamically.

## Trusted facts

- **Direct parent:** `SessionLookup.get(child).parentID` from the host's
  `Session.Info`; `src/host/session.ts` already exposes it as
  `SessionRecord.parentID`. A missing field is "not proven direct", never an
  inferred relation. Only one hop is accepted; a delegated task cannot delegate
  again.
- **Location:** the host-reported `directory` of both sessions must equal the
  grant's recorded location.
- **Visibility scope:** scope is a plugin fact, not a host proof.
  `createScopeFactReader` uses a recorded roster row first (`recorded`); it uses
  the configured scope only for a session this same instance serves
  (`configured`). A missing or throw-away fact is `null` and refuses a
  delegated action; it is never an arbitrary fallback that would cross scopes.
- **Limitation:** the trust boundary remains one OS user (ADR-0004). A
  controlled RPC is not human authentication, and the host parentID is only as
  good as the host record. The plugin never reads host credentials or a private
  host database.

## Authorization model

- A **controlled delegation grant** is separate from a correction grant. Only
  the sibling `watchDelegation` RPC (prepare/confirm/revoke) can create it; the
  model-facing tool cannot prepare, confirm or widen it. `watchGrant` keeps its
  original semantics.
- The grant binds one parent task, one concrete direct child, a maximum mode
  (`alert` or `limited-correction`), the location, the peer scope, the current
  owner activation, the parent generation and the reviewed task version.
- The canonical delegation summary and the current canonical
  `WATCH_CORRECTION_TERMS` are both shown on the controlled surface and both
  enter `delegationTermsDigest`, together with the parent/target/mode/scope and
  owner/generation/version. A later correction-terms change therefore cannot
  reuse an old challenge. The two texts are kept separate; the delegation
  summary is bounded to its own shorter field.
- A `limited-correction` grant requires the explicit
  `single-host-same-location` declaration and derives the child task's existing
  correction grant **in the same SQLite transaction** as the child enrollment.
  The derived grant records `source_delegation_grant_id/version` internally,
  uses the normal correction terms digest/deployment/correlation mechanism, and
  is not a model-supplied mode upgrade. An `alert` grant derives no correction
  grant.
- Two direct children have independent `(parent_task_id, target_session_id)`
  grant pairs. Revoking one does not silently revoke the other. Revocation
  marks the source grant revoked, marks the derived child correction grant
  revoked, and preserves permanent attempts including `accepted`, `unknown`,
  `reserved` and receipt facts. It never claims the accepted message was
  retracted or that spent attempts were restored.
- A delegated task cannot use the ordinary `prepareCorrectionGrant` path to
  replace its derived grant; it must revoke and re-grant delegation. The
  ordinary self-task correction path is unchanged.

## Enrollment and late children

The reserved `delegate` operation reuses the already approved request fields:
`taskID` (the parent task), `targetSessionID`, `requestId`, `goal`, `mode` and
`expectedVersion`. The child reports and receipts through the existing target
caller path; the parent cannot report or receipt as the child.

Enrollment requires: an active self-enrolled parent task owned by the current
activation, an active grant for that exact child, a fresh host `parentID`
equal to the parent session, one location and one scope, a non-wider mode, and
no live child task occupying the child's one slot. A late child is enrolled and
classified as late; the plugin sends no prompt, generates no text, replays no
business task and does not interrupt a foreground child or peer wait.

A repeated `requestId` is idempotent even when the earlier child task is
completed or ended: it returns that history without creating a new task,
prompting, or replaying old work. A new `requestId` is a new explicit
supervision request; once the child's previous task has released its live slot
it may create a new child task, but it still does not wake the child or replay
the old business task. Host idle, a last execution result of `succeeded` or a
process restart is never treated as business completion; only the target's
explicit `completed` report is.

## Fresh authority and receipts

A delegated child's authority is rechecked on every relevant action, not only
when the panel is read:

1. `WatchLedger.delegatedAuthority(taskID)` reads the task, link, source grant
   and parent task in one SQLite read.
2. `createDelegationAuthority().check(taskID)` reads the current host parent,
   child and both scopes; it then **re-reads the ledger** and refuses if the
   task version, generation, link grant version, grant state/version or parent
   task changed during the await. Closing is checked before and after.
3. `delegatedAuthorityGate` applies the same direct-parent/location/scope/mode
   policy to the current facts.
4. The ledger repeats the durable part inside reserve/claim/receipt:
   source grant active and version-bound to the link, source owner equal to the
   parent owner and the current activation, source generation equal to the
   parent generation, one-hop link still present, parent
   active/self/uncompleted/owned, child task identity unchanged, and the child
   correction grant's generation separately bound to the child generation.
   Parent and child generations are never assumed equal; the source grant's
   mode and deployment must cover the derived correction.

The service `receipt` path is `async`: it awaits the fresh check before the
ledger receipt, and on refusal passes an internal `authorityRefusalReason` so
the receipt is recorded as **seen without a continue permit**, not as a
successful receipt. A delegated task with no wired authority guard is refused
the permit (never fail-open); a self-enrolled task keeps the #61 synchronous
behavior and needs no delegation check. `actions/watch.ts` awaits that receipt
call. The executor awaits the same helper before its pre-reserve gate and again
after reserve before claim; the ledger's internal check still guards any race
between the helper and the claim.

The executor order is now: `sameLocation` → `refreshObservation` → final
delegated-authority await → synchronous `observationFor`/task/snapshot/gate →
reserve; after reserve, `sameLocation` → `refreshObservation` → final
delegated-authority await → synchronous reads/gate/claim. There is no await
between the final authority check and the synchronous claim decision. Activity,
a wait or a task version that changes during that final await invalidates the
observer's stored view (`observationFor` returns null or the new non-idle
state) and aborts. The pre-check sample may only tighten the result; if either
the pre-check or the post-await stored view is missing, untrusted, waiting or
not an idle candidate, the round is refused. A tie on the same `observedAt`
uses the current stored view, not a pre-await refreshed one. `isDelegatedTask`
true requires the helper to return both `required` and `allowed`; a missing
hook or a false `required` is refused. A reserved attempt that fails this final
check is aborted and left spent, never refunded.

Known race, stated honestly: the final host-fact check and host enqueue are
not one transaction. The ledger prevents a new reservation/claim/permit based
on an old persisted outcome, but it cannot prove the host has not enqueued a
message nor retract an accepted message. No stop-proof or exactly-once claim is
made.

## Persistence (schema 10 proposal for union)

This lane owns only delegation DDL and the internal
`source_delegation_*` columns; #62 owns its policy columns. The parent merges
the final schema-10 union. Old schema 9 is rejected (its missing delegation
tables or the stored schema version closes the ledger); there is no shim,
fallback store or second authority database.

- `watch_delegation_grants`: `grant_id` PK, parent task/session, reviewed
  parent version, confirming owner activation, mode, state/version/generation,
  concrete target, directory,
  peer scope, optional deployment statement, canonical summary, digest,
  confirmation id, grant/revoke time. A partial unique index allows one active
  grant per parent/target pair.
- `watch_delegation_challenges`: challenge nonce PK, parent task/version,
  generation, caller/owner, mode, target, directory/scope, deployment, digest,
  summary, expiry, consumed time; one open challenge per parent/target.
- `watch_delegated_tasks`: child task PK, source grant id/version, parent task
  and session, target, verified parentID/directory/scope/source, verified time.
- `watch_correction_grants` gains nullable internal
  `source_delegation_grant_id` / `source_delegation_grant_version`; they are not
  in the public watch task DTO.

Transactions: confirm consumes one challenge and writes one grant; delegate
enrollment writes task + enrollment request + link (+ derived correction grant
for limited mode) atomically; revoke writes the source grant + derived
correction grant revocations atomically and leaves attempts untouched.

## Independent child view

`src/watch/delegation-view.ts` and `src/watch/delegation-contract.ts` add a
separate read-only view: parent, grants, children and each child's target, real
task/supervision state, authorization source/mode/version/scope, actual
correction capability and alerts only after the fresh check. An unauthorized
child returns identifiers and a reason with `task: null` and `alerts: null`;
the reader rejects a payload that pairs `authorized: false` with content. The
delegation reader reuses the existing full task/capability/controls/alerts
validators from `watch/contract.ts`; it does not shallow-cast or accept unknown
keys. It also rejects `authorized` disagreeing with `authorization.allowed`,
and a nested task whose `taskID`/`targetSessionID`/`initiatorSessionID` does not
match the outer child. The ordinary `show` of a delegated child by its parent
is refused with `E_WATCH_UNSUPPORTED`, and `show` without a task id returns the
session's own target task. `src/tui/watch-delegation.ts` renders the same
boundary without touching the shared panel skeleton.

## Server wiring

- `createDelegationAuthority({ ledger, sessions, scopeOf, activationID,
  closing, now })` returns `check(taskID)` and `facts(sessionID)`. The watch
  application accepts either that object or a factory
  `(ledger) => createDelegationAuthority({ ledger, ... })`, so the parent wires
  the application's own ledger handle instead of opening a second authority
  database.
- `createScopeFactReader({ configScope, directory, sessions, peers })` is the
  recorded/configured scope source.
- `WatchApplication.delegate`, `prepareDelegationGrant`,
  `confirmDelegationGrant`, `revokeDelegationGrant`, `delegationView` and
  `checkDelegatedAuthority` are the application entries.
- `src/index.ts` creates the scope reader and a delegation-authority factory
  with the application's own ledger, and registers both sibling RPC methods.
- `src/rpc.ts` exports the delegation readers/types and registers
  `watchDelegation` and `watchDelegationView`.
- `src/actions/watch.ts` routes `delegate` and non-self `enroll` through the
  reserved `taskID`/`targetSessionID`/`requestId`/`goal`/`mode`/
  `expectedVersion` fields; the model cannot call the grant/confirm RPC.
- `src/watch/executor.ts` has an optional
  `checkDelegatedAuthority?: (taskID) => Promise<{required, allowed}>`.
  `CorrectionExecutorAuthority.isDelegatedTask(taskID)` lets it fail closed if
  the hook is missing. The hook runs before the pre-reserve gate and again
  after reserve before claim; all observations used afterward are re-sampled,
  and closing/task version are re-read after each await. A `required &&
  !allowed` result aborts without sending; the ledger repeats the durable
  check.

## Evidence

Environment: `bun` 1.4.4 at `/tmp/opencode/bun-1.4.4/bun-linux-x64/bun`
(embedded SQLite 3.53.4). The default local Bun 1.3.13 embeds SQLite 3.51.2, so
ledger tests skip there by the existing runtime guard; they are not weakened.

Targeted red/green:

- `test/watch-delegation-policy.test.ts`: 22 pass (direct child, wrong/absent
  parent, grandchild, cross-location/scope, revoked, mode cap, recursion,
  owner/version, completed/late/busy child, closing, digest text/owner/version).
- `test/watch-delegation-ledger.test.ts`: 10 pass (real SQLite, derived grant,
  independent children, idempotent request and scope-provenance idempotency,
  revoked source, reserve/claim refusal with attempt facts retained,
  accepted/unknown facts retained, and pause-before-receipt seen/no permit).
- `test/watch-delegation-authority.test.ts`: 9 pass (self task, fresh allow,
  revoke/pause/scope/parentID/child deletion, configured-scope source,
  revoke-during-read, closing-during-read).
- `test/watch-delegation-service.test.ts`: 17 pass (prepare/confirm/delegate/
  view/revoke, wrong parent/scope, confirm fresh parentID/scope/deletion
  refuses without consuming the nonce, revoke before delegate, own-show
  preference, parent-as-child report/receipt refusal, redacted control,
  completed-child read, completed repeat idempotency, parent correction grant
  not a delegation, downgrade retaining spent facts, receipt after revoke and
  scope change with no permit, missing guard fail-closed, self-task receipt
  permit regression).
- `test/watch-delegation-contract.test.ts`: 12 pass (strict readers reuse the
  full task/capability/controls/alerts validators; malformed nested task/
  alerts/authorization rejected; no consent/checked/nonce in normal view, no
  content on unauthorized view, RPC parse/deployment/revoke shape).
- `test/watch-delegation-entry.test.ts`: 6 pass (plugin setup/FakeHost:
  controlled grant, public delegate, child begin/waiting, parent view, revoke,
  only-child report/receipt, model grant refusal, non-self reserved fields,
  one real queue and child receipt permit, revoke-before-receipt no permit).
- `test/watch-delegation-executor.test.ts`: 6 pass (scope/parentID change
  during the final post-reserve refresh with an aborted spent attempt, activity/
  wait/task-version change during the final authority await, scope change and
  source revoke during the pre-reserve authority await, revoke after reserve
  before claim, unknown delivery retained and not replayed after revoke).
- `test/tui-watch-delegation.test.ts`: 4 pass (authorized rows, unauthorized
  redaction, revoked grant notes, failure tone).
- `test/watch-delegation-policy.test.ts` and `test/watch-delegation-ledger.test.ts`
  also pass under the default Bun for the pure parts; the ledger file skips
  under SQLite 3.51.2.
- `bun run typecheck` passes.

Not claimed/verified in this lane: the full plugin entry delegation flow (the
parent wires the public action/RPC/panel), the full suite, real host execution,
a live TUI render, executor wiring, schema union, and #64 handover. No full
suite, serve, TUI or live host was started; no credentials or private host
database were read.
