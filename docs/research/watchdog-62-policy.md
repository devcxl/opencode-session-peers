# Watchdog #62 — bounded automatic correction policy

Status: implementation evidence for the `feat/watchdog-62-policy` lane.
Base: `987670e` (accepted #61 first-correction slice). Worktree:
`/home/devcxl/Projects/OpenCodePlugins/opencode-session-peers/.worktrees/watchdog-62-policy`.

## Scope

This lane evolves only the automatic correction policy, its persisted episode
budget, and the attempt/recovery display. It does not add delegation, resume,
ownership transfer, a quality-judge model, or a new public watch operation DTO.
The six safety facts remain unchanged: one OpenCode service, same OS user and
location, supported runtime tuple, one open attempt, once-only claim, and the
three permanent attempt rows.

## Policy

- A task has at most three permanent automatic attempts. The fourth reservation
  is refused by the ledger; the executor never sends it.
- The first reserve of one continuous problem fixes an episode snapshot:
  `episode_started_at`, `episode_deadline_at`, and the effective
  `episode_observation_ms` / `episode_window_ms`. Later attempts in the same
  episode copy those values. Reload, re-confirmation, re-grant, or a changed
  config cannot move the deadline.
- A real recovery (new progress report, new result reference, permit-backed
  closure) ends the episode. A normal-wait closure also ends that round without
  being recorded as recovery; after the matching wait is cleared, a fresh idle
  candidate and every gate are satisfied, the next reserve starts a new episode
  with the current config. Spent attempts remain spent.
  Abort, rejection, unknown, unconfirmed recovery, ordinary activity, reload,
  re-confirmation and re-grant do not end or refresh the active episode.
  Task completion ends supervision; it never creates a new episode.
- After each attempt, another attempt is allowed only at or after the persisted
  observation boundary. The next attempt still needs a trusted continuous idle
  candidate and all existing gates; the one-open constraint prevents overlap.
  The cooldown uses the persisted `episode_observation_ms` of the true previous
  attempt (filtering out the executor's own reservation for this lookup), not
  the current episode's policy. A closed episode therefore keeps its promised
  observation after a config downchange, and a new episode's longer observation
  cannot be re-applied to the old attempt's cooldown. The current round still
  uses its configured values for its own deadline/window and for the display;
  only the prior-attempt cooldown reads the prior attempt's snapshot.
- The ledger enforces the time facts atomically with the reservation and the
  send claim: a continuing episode rejects a reserve before its fixed start or
  at/after its fixed deadline, rejects a reserve before the latest attempt's
  persisted observation completes, and rejects a claim at/after the stored
  deadline or before the fixed start. The gate remains an early decision, not
  the only freshness check.
- A first reservation is included in the episode deadline. The executor's final
  recheck therefore sees an expired episode even when the fresh lookup after the
  first reservation took longer than the window, and aborts the spent attempt
  without sending. The executor's own reservation is ignored only for
  used/pending/cooldown accounting, not for the episode deadline.
- A clock before the fixed episode start, an expired deadline, an unsafe clock,
  a busy/waiting/blocked/revoked/unknown/missing-receipt state, an observation
  gap, or an unsupported runtime stops the automatic path. The executor does not
  try to spend the third attempt for its own sake.
- The third real recovery is displayed as a success. When the permanent quota is
  then spent, the stop reason only prevents a fourth automatic attempt; a later
  stall produces the existing idle alert and no send.

## Persistence and schema

The ledger schema is now 10. This lane adds only four columns to
`watch_correction_attempts`:

```sql
episode_started_at INTEGER NOT NULL,
episode_deadline_at INTEGER NOT NULL,
episode_observation_ms INTEGER NOT NULL CHECK (episode_observation_ms > 0),
episode_window_ms INTEGER NOT NULL CHECK (episode_window_ms > 0)
```

`episode_deadline_at` must equal `episode_started_at + episode_window_ms`;
the open-time integrity check rejects rows where it does not. The active episode
is the latest attempt row unless that row was closed by recovery, normal wait or
task completion. No new table and no #63 delegation DDL are included here. The
final schema-10 union with the delegation tables is parent-owned. A schema-9
database or identity anchor is rejected (`unsupported_schema`), with no shim.

`WatchCorrectionSnapshot.episode` carries the active fixed snapshot to the
policy gate. Each internal `WatchCorrectionAttemptRecord` also carries its
persisted `episodePolicy` (not a public view/DTO field). After filtering the
executor's own reservation, the gate takes the true previous attempt's anchor
and persisted observation for the cooldown, while the view exposes the current
round's policy and the old `nextAttemptAt` boundary separately. The attempt
history exposes `normal-wait` / `task-completed` closure through the existing
stop-reason field, and recovery through the existing recovery view.

## Configuration

`watch.correctionObservationMs` defaults to 300000 ms and accepts 300000..
3600000. `watch.correctionWindowMs` defaults to 1200000 ms and accepts
300000..7200000. The defaults are defaults, not a hard maximum: a round fixes
the configured values it starts with, and the next round uses the then-current
values. Invalid values (zero, negative, fractional, NaN, infinite, non-number,
or out of range) are rejected as that value and fall back to the safe default
with a load warning; they are not coerced, truncated, or treated as a runtime
disable switch. A window shorter than the observation window is allowed: the
episode can expire after one attempt, and the UI reports the fixed deadline
instead of extending it.

## Contract and UI

Only correction-view fields/enums changed: `executionPolicy` is
`bounded-three-attempt`, capability `correction` is `bounded`, a `policy` view
was added (`observationMs`, `windowMs`, `windowStartedAt`, `windowEndsAt`,
`nextAttemptAt`), and stop reasons `correction-window` and
`post-attempt-observation` were added. Watch operation request DTOs, delegation
views and the shared panel skeleton are untouched. The correction pane shows the
effective policy, used/remaining permanent attempts, fixed window end,
next-attempt time, attempt closure reasons, unconfirmed recovery, and the
third-success explanation. The focused grant review adds only a display line
with the current effective observation/window values from the existing
correction policy view; it does not add a DTO or change the grant challenge.

`WATCH_CORRECTION_TERMS` is the canonical 500-character text. It states the
three-attempt permanent budget, the five-minute / twenty-minute **defaults**,
that a round fixes its configured values and the next round uses current values,
the no-reset rule, the normal-wait/recovery round boundary, that a matched clear
is required only when a wait existed, the single-service / same OS user/location
limit, that the single-host declaration is not proof and the channel is not
human authentication, unknown=alert-only, safety pause not stopping business
work, and that queue admission is not consumption and is irreversible. The
review shows the current effective values next to these defaults, so a custom
40-minute window is not hidden behind the default text. The digest remains
bound to the terms text, not to the process config: the plugin does not hot-swap
an owner activation's config, the effective values are shown at review, and
binding the digest to config would require a coordinated grant/schema change
without changing the owner/authorization boundary. Old-term grants still fail
closed at the existing prepare/confirm/reserve/claim/receipt checks. The UI
imports the canonical value; no copy exists.

## Tests and evidence

Targeted run (Bun 1.4.4):

- 22 watch/config/TUI files: 305 pass, 0 fail, 1795 expectations.
- `entry`, `rpc`, `boundaries`: 33 pass, 0 fail, 180 expectations.
- Overall `tsc --noEmit` and `git diff --check`: clean.

New coverage includes real SQLite/ledger tests for the persisted episode and
config reload, the normal-wait round and remaining quota, the recovery round,
schema-10 columns and schema-9 rejection, executor tests for three actual sends
and no fourth, first-reservation deadline expiry before claim, abort-then-full-
observation, concurrent kicks, reserve/claim fixed-deadline rejection, a real
ledger+executor cross-round test where a closed attempt's 5-minute cooldown and
a new episode's 10-minute policy must not be conflated, and observer+executor
tests for normal-wait clear → new idle episode and for three spent attempts →
idle alert only. `test/watch-policy.test.ts` also drives the
full plugin entry with a test-only supported app-version fixture (real ledger,
real runtime facts, real queue, tool receipts/progress, controlled clock): three
automatic queue sends and no fourth.

Red evidence while developing (temporary reversions, then restored):

- Disabling the fixed window/observation checks made the five-minute boundary,
  deadline, and first-reservation recheck tests fail with `eligible: true`.
- Treating `normal-wait` as non-terminal made the ledger new-episode test fail.
- Removing the attempt-limit success note made the TUI third-success test fail.
- Using the own reservation's episode policy for the prior cooldown made the
  own-reservation gate test and the real ledger+executor cross-round test fail:
  the old 5-minute cooldown became 10 minutes and the second attempt was
  aborted without a send.
- Removing the reserve cooldown check made the normal-wait cooldown test fail;
  removing the claim deadline check made the boundary test fail.
- Removing the grant-review effective line made the custom-policy review test
  fail.

## Not verified here

- Real host positive protocol is parent-owned and was not started in this lane.
- No full-suite run, real-minute waits, TUI live run, service start, upstream
  push, or #63 delegation behavior was attempted.
- Real host SIGKILL, stale-generation and schema-10 union with #63 are parent
  integration checks.
- README, skill text, CONTEXT and shared ADRs remained parent-owned in this lane.

## Parent integration evidence

Integration `2343425` combines schema 10 with #63, the public entry, UI and
accurate bounded-policy model/user text. Parent Bun 1.4.4 full suite:
**779 pass, 0 fail, 3644 expectations across 66 files**; overall typecheck
and diff check clean. The controlled-clock three-attempt evidence above is not
a real five-minute host wait. The #63 real-host positive and two negative
protocols passed on the exact supported artifact; see
`watchdog-63-realhost-plan.md` for evidence and limitations. Real-host SIGKILL,
early-receipt race, stale-generation and power-loss durability remain unverified.

Parent Standards and Spec reviews accepted the combined implementation and
documentation (`2343425` plus `2adb009`) with no blocking finding. The reviewer
explicitly rechecked the ignored-own-reservation/prior-policy cooldown and
closed that old finding; historical #61 ADR wording is not the current policy.
