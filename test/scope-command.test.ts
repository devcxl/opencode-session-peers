import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"

import plugin from "../src/index.ts"
import { CALLER_SESSION_ID, fakeHost } from "./fake-host.ts"

type Editor = Parameters<Parameters<Plugin.Context["command"]["transform"]>[0]>[0]
type Command = Parameters<Editor["add"]>[0]

async function loaded(options: { enabled?: boolean } = {}) {
  const host = fakeHost({ options, sessions: [CALLER_SESSION_ID, "ses_other"] })
  const commands: Command[] = []
  const context = {
    ...host.context,
    command: {
      transform: async (edit: (editor: Editor) => void) => {
        edit({ add: (command) => commands.push(command) })
        return { dispose: async () => {} }
      },
    },
  } as unknown as Plugin.Context
  const dispose = await plugin.setup(context)
  return { host, commands, dispose }
}

describe("server peers-scope command", () => {
  test("moves only the invoking session, and can move it back", async () => {
    const { host, commands, dispose } = await loaded()
    try {
      const command = commands.find((item) => item.name === "peers-scope")
      expect(command).toBeDefined()
      const invoke = (text: string) => command!.execute({
        sessionID: CALLER_SESSION_ID as never,
        prompt: { text },
        delivery: "steer",
      })
      await invoke("  team-a  ")
      expect((await host.call("peers", { action: "status" })).details).toMatchObject({ scope: "team-a" })
      expect((await host.call("peers", { action: "status" }, "ses_other")).details).toMatchObject({ scope: "default" })
      expect(host.prompts).toEqual([])
      expect(host.rpcs[0]?.events.some((event) => event.name === "changed")).toBe(true)
      await invoke("default")
      expect((await host.call("peers", { action: "status" })).details).toMatchObject({ scope: "default" })
    } finally {
      await dispose?.()
    }
  })

  test("rejects missing scope rather than changing it", async () => {
    const { host, commands, dispose } = await loaded()
    try {
      const command = commands.find((item) => item.name === "peers-scope")
      expect(command).toBeDefined()
      await expect(command!.execute({ sessionID: CALLER_SESSION_ID as never, prompt: { text: "  " }, delivery: "steer" }))
        .rejects.toThrow("usage: /peers-scope <scope>")
      expect((await host.call("peers", { action: "status" })).details).toMatchObject({ scope: "default" })
    } finally {
      await dispose?.()
    }
  })

  test("refuses a session not served by this location", async () => {
    const { commands, dispose } = await loaded()
    try {
      const command = commands.find((item) => item.name === "peers-scope")!
      await expect(command.execute({ sessionID: "ses_unknown" as never, prompt: { text: "team-a" }, delivery: "queue" }))
        .rejects.toThrow("this location does not serve that session")
    } finally {
      await dispose?.()
    }
  })

  test("reports when the plugin is disabled", async () => {
    const { commands, dispose } = await loaded({ enabled: false })
    try {
      const command = commands.find((item) => item.name === "peers-scope")!
      await expect(command.execute({ sessionID: CALLER_SESSION_ID as never, prompt: { text: "team-a" }, delivery: "steer" }))
        .rejects.toThrow("the plugin is disabled at this location")
    } finally {
      await dispose?.()
    }
  })
})
