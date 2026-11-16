import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

import plugin from "../src/index.ts"
import { PEERS_SKILL } from "../src/skill.ts"
import { fakeHost } from "./fake-host.ts"

const rootText = (name: string): string => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")

describe("watch model-facing contract", () => {
  test("the registered tool admits the delegated mode without granting authority", async () => {
    const host = fakeHost({ options: { enabled: false } })
    const dispose = await plugin.setup(host.context)
    try {
      const input = host.tools.find((tool) => tool.name === "peers")?.input
      expect(input).toMatchObject({
        properties: {
          watch: {
            properties: {
              mode: { enum: ["alert", "correct", "limited-correction"] },
            },
          },
        },
      })
      const text = JSON.stringify(input)
      expect(text).toContain("controlled delegation grant")
      expect(text).not.toContain("Grant, delegation, transfer and resume remain")
      expect(text).not.toContain("This build only accepts the calling session")
      expect(host.prompts).toHaveLength(0)
      expect(host.generations).toHaveLength(0)
      expect(host.interrupts).toHaveLength(0)
    } finally {
      await dispose?.()
    }
  })

  test("skill and README explain bounded rounds and controlled direct-child enrollment", () => {
    for (const text of [PEERS_SKILL.content, rootText("README.md")]) {
      expect(text).toContain('operation: "delegate"')
      expect(text).toContain("watchDelegation")
      expect(text).toContain("three permanent")
      expect(text).toContain("watch.correctionObservationMs")
      expect(text).toContain("watch.correctionWindowMs")
      expect(text).not.toContain("first-attempt")
      expect(text).not.toContain("only the first attempt")
      expect(text).toContain("parentID")
      expect(text).toContain("scope")
    }
    expect(PEERS_SKILL.content).not.toContain("supports only the calling session")
  })

  test("domain terminology no longer describes a first-attempt-only executor", () => {
    const context = rootText("CONTEXT.md")
    expect(context).not.toContain("首次自动尝试")
    expect(context).toContain("纠正轮次")
    expect(context).toContain("直接委派授权")
  })
})
