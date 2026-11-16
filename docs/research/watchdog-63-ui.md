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
   - Prompts the user to enter the child session ID (if not prefilled).
   - Pressing `m` or `tab` toggles between `alert` and `limited-correction`.
   - Pressing `enter` advances to the explicit review stage.
3. **Canonical terms review (`y: declare + prepare · n: cancel`):**
   - Displays the full canonical `WATCH_DELEGATION_TERMS`.
   - For `limited-correction`, also displays `WATCH_CORRECTION_TERMS`, the explicit
     declaration disclaimer (`Single-host declaration is not proof of uniqueness`),
     the channel disclaimer (`Controlled channel is not human authentication`), and
     the effective round parameters (aligning with #62).
   - User press `y` to issue `prepare` RPC. Pressing `n` or `escape` cancels without writes.
4. **Independent confirmation (`y: grant · n: cancel`):**
   - The returned challenge is stored strictly in the controller closure.
   - View displays only safe facts: target session, mode, scope directory, scope peer
     scope and expiration timestamp.
   - The challenge nonce never reaches the screen, Solid props or signals.
   - User press `y` to issue `confirm` RPC with the stored challenge and digest.
5. **Revocation (`r`):**
   - Pressing `r` prompts to revoke an existing delegation grant.
   - Carries only `{ operation: "revoke", sessionID, parentTaskID, expectedVersion, targetSessionID }`
     without a `mode` parameter.
   - Existing attempts and accepted reports in child sessions remain untouched and unreset.

## Lifecycle and nonce safety rules

- **Private closure storage:** the challenge nonce is stored only in the
  `createDelegationFlow` closure (`pending`), never in Solid signals, props, view
  state, logs, toasts, tools or events.
- **Fail-closed verification:** `prepare` verifies that `reviewSummary === WATCH_DELEGATION_TERMS`,
  parent task ID, expected version, and mode match the user's review. Any discrepancy
  discards the challenge and emits a generic nonce-safe toast.
- **Lifecycle cancellation:** closing the dialog, cancelling (`n` or `escape`), switching
  session, or task version advancement clears pending challenges immediately.
- **Graceful degradation:** if `port.watchDelegation` is omitted or unavailable, the
  view renders an explicit unavailable state and does not fail open.

## Targeted verification evidence

Targeted tests cover:
- `test/tui-watch-delegation.test.ts`: pure view rendering, unauthorized child redaction.
- `test/tui-watch-delegation-dialog.test.tsx`: dialog navigation, full canonical terms
  display for both alert and limited-correction modes, interactive typing and mode toggle,
  revocation prompt, short terminal (40h) visibility, and nonce redaction.
- `test/tui-watch-delegation-flow.test.ts`: exact RPC payloads for prepare/confirm/revoke,
  fail-closed rejection of altered terms without leaking nonces, and lifecycle isolation
  against late responses.
- `test/tui-watch-command.test.ts`: `/peers-watch children` read-only opening, argument
  prefilling without write, and `k` key navigation from the watch dialog.

### Test results
```bash
bun test test/tui*
```
Result: **199 pass, 0 fail (872 expect calls across 18 files)**

### Typecheck
```bash
bun run typecheck (tsc --noEmit)
```
Result: **0 errors**

## Unverified items and parent handoff

- No live TUI, server daemon or live OpenCode service was launched in this lane.
- Root documentation (`README.md`, `skill.ts`, `CONTEXT.md`) and multi-lane integration
  are left for final reconciliation by the parent session.
