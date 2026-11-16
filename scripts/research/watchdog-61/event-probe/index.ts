/** Metadata-only diagnostic fixture. Never records prompts, tool inputs or results. */
import { appendFileSync } from "node:fs"

export default {
  id: "watch61-event-shape-probe",
  async setup(ctx: {
    event: { subscribe(input: { signal: AbortSignal }): AsyncIterable<unknown> }
  }) {
    const path = process.env["WATCH61_EVENT_SHAPES"]
    if (path === undefined) return
    const controller = new AbortController()
    let count = 0
    void (async () => {
      for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
        if (typeof raw !== "object" || raw === null || count >= 256) continue
        const event = raw as Record<string, unknown>
        const type = event["type"]
        if (typeof type !== "string" || !/^(session\.|permission\.|form\.)/.test(type)) continue
        const data = event["data"] as Record<string, unknown> | undefined
        const location = event["location"] as { directory?: unknown } | undefined
        appendFileSync(path, `${JSON.stringify({
          type,
          created: typeof event["created"] === "number" ? event["created"] : null,
          directory: typeof location?.directory === "string" ? location.directory : null,
          sessionID: typeof data?.["sessionID"] === "string" ? data["sessionID"] : null,
          keys: Object.keys(data ?? {}).slice(0, 16),
        })}\n`)
        count++
      }
    })().catch(() => undefined)
    return () => controller.abort()
  },
}
