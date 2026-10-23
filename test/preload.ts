/**
 * Test preload: the Solid JSX transform.
 *
 * The host compiles a TUI plugin's TSX with this transform at load time (the
 * loader installs it for `@opentui/solid`; see
 * `docs/research/tui-surface-data-path.md` §2.2), which is what makes JSX
 * expressions reactive. `bun test` would otherwise compile TSX to one-shot
 * JSX calls and every update after the first render would silently stop — a
 * green suite proving nothing about liveness. Registering the same transform
 * here keeps the tests honest about the runtime the dialog really gets.
 */

import "@opentui/solid/preload"
