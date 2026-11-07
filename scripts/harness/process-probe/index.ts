/** Test-only provenance: record which server executes a peers tool call, not its content. */
import { appendFileSync } from "node:fs"

export default {
  id: "session-peers-process-probe",
  async setup(ctx: {
    tool: { hook(name: "execute.before", callback: (event: { tool: string; sessionID: string; input: unknown }) => void): Promise<unknown> }
  }) {
    const path = process.env["SESSION_PEERS_PROCESS_PROBE_LOG"]
    if (path === undefined) throw new Error("missing isolated process probe log")
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "peers" || typeof event.input !== "object" || event.input === null) return
      const action = (event.input as { action?: unknown }).action
      if (typeof action !== "string") return
      appendFileSync(path, `${JSON.stringify({ pid: process.pid, sessionID: event.sessionID, action })}\n`)
    })
  },
}
