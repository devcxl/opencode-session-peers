/**
 * The host's normal model-context hook, as a narrow port.
 *
 * A plugin may append system text to the request the session is already making;
 * it cannot use this hook to start a turn. That is exactly the watchdog's
 * "participation in the next normal context, no extra wakeup" requirement. The
 * hook's SDK shape stays here; the application supplies plain text.
 */

import type { Plugin } from "@opencode/plugin"

import type { SessionID } from "../domain/types.ts"

export interface ContextInjection {
  dispose(): Promise<void>
}

export interface ContextInjector {
  register(provider: (sessionID: SessionID) => string | undefined | Promise<string | undefined>): Promise<ContextInjection>
}

export function contextInjector(session: Pick<Plugin.Context["session"], "hook">): ContextInjector {
  return {
    async register(provider) {
      const registration = await session.hook("context", async (input) => {
        const text = await provider(input.sessionID)
        if (text !== undefined && text.length > 0) {
          input.system.push({ type: "text", text })
        }
      })
      return { dispose: () => registration.dispose() }
    },
  }
}
