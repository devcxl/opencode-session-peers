import { join } from "node:path"

import { scratchLayout, type ScratchLayout } from "../../harness/paths.ts"

/** Match a reviewed build's database name; never change the host's environment. */
export function candidateLayout(root: string, id: string, channel?: string): ScratchLayout {
  const layout = scratchLayout(root, id)
  if (channel === undefined) return layout
  if (!/^[a-zA-Z0-9._-]+$/.test(channel)) throw new Error("invalid research build channel")
  // Host v2.3.0 packages/cli/src/database-path.ts; no runtime DB overrides.
  const filename = ["latest", "dev", "beta", "next", "prod"].includes(channel)
    ? "opencode.db"
    : `opencode-${channel}.db`
  return { ...layout, database: join(layout.data, "opencode", filename) }
}
