# #63 controlled delegation UI research and targeted evidence

Status: implemented in `feat/watchdog-63-ui`. This lane owns the controlled
delegation user surface, the sibling `watchDelegation` TuiPort seam, and
the independent `WatchDelegationDialog` component. It consumes the canonical
terms and types from `#63` and `#62` contracts; it does not touch model tools,
ledger tables, server execution or backend database migrations.

## User interaction and interface guide

### 1. Panel entry points

- **Primary key navigation:** in the main `/peers-watch` panel (`task` pane),
  pressing `k` opens the independent `WatchDelegationDialog`. This avoids
  cramming child delegation complexity into the correction pane.
- **Slash command entry:**
  - `/peers-watch children`: opens the delegation panel directly in inspection mode
    with exactly 1 read and 0 writes.
  - `/peers-watch children <childID> [mode]`: prefills the target child session id
    and mode (`alert` or `limited-correction`), directly presenting the review terms.
    **No slash command ever automatically prepares, confirms or grants.**

### 2. Interactive review and confirmation stages

1. **Inspection view:**
   - Shows direct children in a structured table (`Child`, `Goal`, `State`, `Authorization`).
   - For unauthorized children, goal, reports and alerts are strictly omitted.
   - Summarizes existing delegation grants with versions and states.
2. **Target & mode selection (`g`):**
   - Prompts the user to enter or edit the child session ID.
   - Letters such as `m` are typed cleanly without being swallowed (e.g. `ses_mango_42`).
   - Pressing `tab` (or `ctrl+m`) toggles between `alert` and `limited-correction`.
   - Pressing `enter` advances to the explicit review stage.
3. **Canonical terms review (`y: declare + prepare · e: change target/mode · n: cancel`):**
   - Displays the full canonical `WATCH_DELEGATION_TERMS`.
   - For `limited-correction`, also displays `WATCH_CORRECTION_TERMS`, the explicit
     declaration disclaimer (`Single-host declaration is not proof of uniqueness`),
     the channel disclaimer (`Controlled channel is not human authentication`), and
     the effective round parameters distinguishing defaults (5m observe, 20m problem)
     from actual effective policy values (e.g. 10m observe, 40m problem).
   - Pressing `e` allows switching back to the input stage to edit the target or mode.
   - User press `y` to issue `prepare` RPC. Pressing `n` or `escape` cancels without writes.
4. **Independent confirmation (`y: grant · n: cancel`):**
   - The returned challenge is stored strictly in the controller closure.
   - Confirm RPC strictly passes `mode: challenge.mode`; alert mode has no `deployment`,
     while limited mode carries `deployment: "single-host-same-location"`.
   - View displays only safe facts: target session, mode, scope directory, scope peer
     scope and expiration timestamp.
   - The challenge nonce never reaches the screen, Solid props or signals.
   - User press `y` to issue `confirm` RPC with the stored challenge and digest.
5. **Revocation (`r`):**
   - Pressing `r` prompts to select an active delegation grant using up/down arrow keys
     or j/k, allowing revocation of any child grant (not just the first one).
   - Carries only `{ operation: "revoke", sessionID, parentTaskID, expectedVersion, targetSessionID }`
     without a `mode` parameter.
   - Existing attempts and accepted reports in child sessions remain untouched and unreset.

## Lifecycle and nonce safety rules

- **Private closure storage:** the challenge nonce is stored only in the
  `createDelegationFlow` closure (`pending`), never in Solid signals, props, view
  state, logs, toasts, tools or events.
- **Fail-closed verification:** `prepare` verifies that `reviewSummary === WATCH_DELEGATION_TERMS`,
  `review.derivesCorrectionGrant === (mode === "limited-correction")`, `review.deploymentRequired`,
  parent task ID, expected version, and mode match the user's review. Any discrepancy
  discards the challenge and emits a generic nonce-safe toast.
- **Sanitized failure codes:** failure responses sanitize `failure.code` through a strict
  whitelist (`E_WATCH_*`) and generic messages; unvalidated strings, reflection bodies,
  or `Error.message` containing nonces are never printed or toasted.
- **Lifecycle and dual-feed management:**
  - `openDelegation` fences async reads with `startedEpoch` and `sessionID`; deferred reads
    across session switches do not overwrite the newly opened session.
  - Parent feed remains open as a notification-free context refresh source (`panelOpen = false`),
    and both feeds are explicitly closed when the dialog is dismissed, switched or disposed.
  - Reactive parent version tracking via `createSignal` immediately clears pending challenges
    and exits confirm if the parent task advances or disappears.
  - Pre-operation fresh reads right before prepare and revoke guarantee freshest version
    without waiting for the 60s background timer.
  - Route change fence in `stillCurrent` ensures late confirm/prepare calls immediately exit
    without toasting if the user navigates away.
  - Controlled floor timer tests with short interval (`refreshMs: 25`) prove that advancing timers
    past 60ms produces 0 reads after dialog close.
- **Graceful degradation:** if `port.watchDelegation` is omitted or unavailable, the
  view renders an explicit unavailable state and does not fail open.

## Targeted verification evidence

Targeted tests cover:
- `test/tui-watch-delegation.test.ts`: pure view rendering, unauthorized child redaction.
- `test/tui-watch-delegation-dialog.test.tsx`: dialog navigation, full canonical terms
  display for both alert and limited-correction modes, interactive typing with `m` (e.g. `ses_mango_42`),
  mode toggle via `tab`, multi-grant revocation selection with arrow keys, custom 10m/40m policy
  display vs defaults, short terminal (40h) visibility, and nonce redaction.
- `test/tui-watch-delegation-flow.test.ts`: exact RPC payloads for prepare/confirm (including `mode`)
  and revoke, fail-closed rejection of altered terms and `derivesCorrectionGrant` mismatch,
  sanitization of failure codes/reasons carrying nonces, feed rejection of wrong parent/session payloads,
  lifecycle isolation against late responses and route changes, and real host RPC bridge test via
  `fakeHost` and SQLite ledger (verified passing on Bun 1.4.4).
- `test/tui-watch-command.test.ts`: `/peers-watch children` read-only opening (1 read, 0 writes),
  argument prefilling without write, `k` key navigation from the watch dialog, deferred read session
  switch isolation, transition from children to ordinary panel stopping old feed, parent version
  advancement cancelling confirm stage, and zero reads after dialog close with real fake timers.

### Test results
```bash
bun test test/tui*
```
Result: **210 pass, 1 skip (SQLite 3.51.3 guard on Bun 1.3; verified 100% pass on Bun 1.4.4), 0 fail (918 expect calls across 18 files)**

### Typecheck
```bash
bun run typecheck (tsc --noEmit)
```
Result: **0 errors**

## Unverified items and parent handoff

- No live TUI, server daemon or live OpenCode service was launched in this lane.
- Root documentation (`README.md`, `skill.ts`, `CONTEXT.md`) and multi-lane integration
  are left for final reconciliation by the parent session.
