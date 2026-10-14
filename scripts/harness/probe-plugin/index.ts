/**
 * The harness fixture plugin.
 *
 * It exists to prove, on every run, that a plugin declared in a project's
 * `.opencode/opencode.json` is discovered and that its `setup` runs once per
 * location. It is dependency-free on purpose, so it loads even when the plugin
 * under test cannot import anything, and it writes only inside the harness
 * scratch directory named by the environment.
 *
 * The variable name is `SESSION_PEERS_HARNESS_PROBE_LOG`, declared in
 * `scripts/harness/paths.ts` as `PROBE_LOG_ENV`.
 */

import { appendFileSync } from "node:fs"

interface ProbeContext {
  readonly location: { readonly directory: string }
  readonly app: { readonly version: string }
}

const logPath = process.env["SESSION_PEERS_HARNESS_PROBE_LOG"]

export default {
  id: "session-peers-harness-probe",
  async setup(ctx: ProbeContext): Promise<void> {
    if (logPath === undefined || logPath.length === 0) return
    const record = { pid: process.pid, directory: ctx.location.directory, version: ctx.app.version }
    appendFileSync(logPath, `${JSON.stringify(record)}\n`)
  },
}
