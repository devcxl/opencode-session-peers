# Plan (#26) — scratch notes, delete before the PR

Branch t17-sidebar, based on main (7bbf921). Worktree only.

## Decisions already settled (issue #26) — implemented, not re-litigated
1 read-only; 2 exactly what `peers list` resolves; 3 one scope (header names it); 4 unknown status
shows a reason; 5 row = title/directory/status/self/same-dir with a folded id; 6 empty names one of
three causes; 7 `sidebar.content` slot; 8 snapshot then events; 9 this location only; 10 one package,
two entrypoints (exports).

## Mechanism (measured, docs/research/tui-surface-data-path.md)
- server: `ctx.rpc.register(def, handlers)`, `registration.events.emit(name, data)`
- TUI: `context.client.rpc(def).method(input, {location, signal})`; `events.on(name, handler)`
- host entry resolution: local dir target -> `<dir>/tui` (Bun.resolveSync, NOT package exports);
  named package target -> `<name>/tui` (package exports). Measured with Bun.resolveSync on this machine.

## Files
- src/rpc.ts            public RPC contract + payload types + runtime guard (no host, no runtime deps)
- src/host/rpc.ts       ctx.rpc.register adapter (host layer only)
- src/surface.ts        RPC handler: the payload a reader gets
- src/peers/roster.ts   + report() (rows + why-empty evidence), + observe() (change signal)
- src/index.ts          wiring: register the surface always, connect change -> "changed" event
- src/host/tui.ts       TUI port: slot claim, client, palette, own location, session directory
- src/tui/index.tsx     TUI entrypoint (slot claim)
- src/tui/feed.ts       snapshot-then-events state; coalesced reads; no snapshot-before-subscribe gap
- src/tui/view.ts       pure view logic: rows, header, empty cause, folded id, status + reason
- src/tui/sidebar.tsx   the panel component
- tui.tsx               root shim: directory targets resolve <dir>/tui (measured), exports cover packages
- package.json          exports: ./tui, ./rpc; files
- test/fake-host.ts     + ctx.rpc fake (register, call, emitted events, output validated)
- test/rpc.test.ts      surface through the entry seam; enabled=false; liveness via events
- test/tui-view.test.ts pure view logic
- README.md             short factual section

## Verification
bun run typecheck; bun test; bun run harness; bun run harness --stub; captured TUI render; no other
location activated (checked by server logs / storage of the isolated instance).
