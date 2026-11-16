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
policy gate. The view exposes the effective policy and the fixed window; the
attempt history exposes `normal-wait` / `task-completed` closure through the
existing stop-reason field, and recovery through the existing recovery view.

## Configuration

`watch.correctionObservationMs` defaults to 300000 ms and accepts 300000..
3600000. `watch.correctionWindowMs` defaults to 1200000 ms and accepts
300000..7200000. Invalid values (zero, negative, fractional, NaN, infinite,
non-number, or out of range) are rejected as that value and fall back to the
safe default with a load warning; they are not coerced, truncated, or treated as
a runtime disable switch. A window shorter than the observation window is
allowed: the episode can expire after one attempt, and the UI reports the fixed
deadline instead of extending it.

## Contract and UI

Only correction-view fields/enums changed: `executionPolicy` is
`bounded-three-attempt`, capability `correction` is `bounded`, a `policy` view
was added (`observationMs`, `windowMs`, `windowStartedAt`, `windowEndsAt`,
`nextAttemptAt`), and stop reasons `correction-window` and
`post-attempt-observation` were added. Watch operation request DTOs, delegation
views and the shared panel skeleton are untouched. The correction pane shows the
configured policy, used/remaining permanent attempts, fixed window end, attempt
closure reasons, unconfirmed recovery, and the third-success explanation.

`WATCH_CORRECTION_TERMS` is the canonical 500-character text. It no longer says
“first automatic attempt only”; it states the three-attempt permanent budget,
the five-minute observation, the twenty-minute continuous-problem cap, the
no-reset rule, the normal-wait/recovery round boundary, the single-service /
single-host declaration limits, unknown=alert-only, safety pause semantics and
the non-consumption/irreversible admission. The grant digest changed, so grants
created under the old text fail closed at the existing prepare/confirm/reserve/
claim/receipt checks. The UI imports the canonical value; no copy exists.

## Tests and evidence

Targeted run (Bun 1.4.4):

- 22 watch/config/TUI files: 298 pass, 0 fail, 1722 expectations.
- `entry`, `rpc`, `boundaries`: 33 pass, 0 fail, 180 expectations.
- Overall `tsc --noEmit` and `git diff --check`: clean.

New coverage includes real SQLite/ledger tests for the persisted episode and
config reload, the normal-wait round and remaining quota, the recovery round,
schema-10 columns and schema-9 rejection, executor tests for three actual sends
and no fourth, first-reservation deadline expiry before claim, abort-then-full-
observation, concurrent kicks, and observer+executor tests for normal-wait
clear → new idle episode and for three spent attempts → idle alert only.

Red evidence while developing (temporary reversions, then restored):

- Disabling the fixed window/observation checks made the five-minute boundary,
  deadline, and first-reservation recheck tests fail with `eligible: true`.
- Treating `normal-wait` as non-terminal made the ledger new-episode test fail.
- Removing the attempt-limit success note made the TUI third-success test fail.

## Not verified here

- Real host positive protocol is parent-owned and was not started in this lane.
- No full-suite run, real-minute waits, TUI live run, service start, upstream
  push, or #63 delegation behavior was attempted.
- Real host SIGKILL, stale-generation and schema-10 union with #63 are parent
  integration checks.
- README, skill text, CONTEXT and shared ADRs remain parent-owned; `src/skill.ts`
  still contains the old first-attempt wording.
