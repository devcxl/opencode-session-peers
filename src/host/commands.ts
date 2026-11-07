/** Server command registration, independent of any particular client. */
import type { Plugin } from "@opencode/plugin"

export interface CommandRegistrar {
  registerScope(run: (sessionID: string, input: string) => Promise<void>): Promise<void>
}

export function commandRegistrar(command: Pick<Plugin.Context["command"], "transform">): CommandRegistrar {
  return {
    async registerScope(run) {
      await command.transform((editor) => {
        editor.add({
          name: "peers-scope",
          description: "Move this session to a peer scope",
          execute: ({ sessionID, prompt }) => run(sessionID, prompt.text),
        })
      })
    },
  }
}
