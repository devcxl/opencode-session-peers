/**
 * Where the watchdog keeps its own security ledger.
 *
 * The path is plugin state, not session content and not the host's database:
 * `$XDG_STATE_HOME/opencode-session-peers/watchdog/watch-ledger.sqlite3`, or
 * `~/.local/state/...` when XDG is unset. The ledger itself validates that the
 * resolved path is absolute, canonical and not a symlink; this adapter only
 * chooses the fixed location. `SESSION_PEERS_WATCH_STATE_DIR` is an isolated
 * test/harness override, never a model-facing option.
 */

import { homedir } from "node:os"
import { join, resolve } from "node:path"

export const WATCH_STATE_DIR_ENV = "SESSION_PEERS_WATCH_STATE_DIR"

export function watchStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[WATCH_STATE_DIR_ENV]?.trim()
  if (override !== undefined && override.length > 0) return resolve(override)
  const stateHome = env["XDG_STATE_HOME"]?.trim()
  const base = stateHome !== undefined && stateHome.length > 0 ? stateHome : join(homedir(), ".local", "state")
  return resolve(join(base, "opencode-session-peers", "watchdog"))
}

export function watchLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(watchStateDirectory(env), "watch-ledger.sqlite3")
}
