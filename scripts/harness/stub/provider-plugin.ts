/**
 * The stub provider, as the instance's own config directory sees it.
 *
 * The harness copies this file into `<scratch>/config/opencode/plugins/`, where
 * opencode discovers local plugins beside its config. It must stay
 * dependency-free: the scratch config directory has no `node_modules`, so a
 * bare import of `@opencode/plugin` would not resolve. `define` is the
 * identity function, so the plain object below is the same registration the
 * package would produce.
 *
 * The two `SESSION_PEERS_HARNESS_STUB_*` names are read by this file and set by
 * `instanceEnvironment` in `instance.ts`; `test/harness-stub.test.ts` pins that
 * the two sides agree. The API key is the literal word "stub": the stub server
 * never checks it, and no developer credential is involved.
 */

const providerID = "harness-stub"
const baseURL = process.env["SESSION_PEERS_HARNESS_STUB_URL"]

interface ProviderEditor {
  readonly provider: {
    readonly transform: (callback: (editor: ProviderTransformEditor) => void) => Promise<void>
  }
  readonly integration: {
    readonly transform: (callback: (editor: IntegrationTransformEditor) => void) => Promise<void>
  }
}

interface ProviderTransformEditor {
  add(input: { info: Record<string, unknown>; models: readonly Record<string, unknown>[] }): void
}

interface IntegrationTransformEditor {
  readonly method: {
    update(input: { integrationID: string; method: Record<string, unknown> }): void
  }
}

export default {
  id: "session-peers-harness-stub-provider",
  async setup(ctx: ProviderEditor): Promise<void> {
    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: providerID,
        method: { type: "env", names: ["SESSION_PEERS_HARNESS_STUB_API_KEY"] },
      })
    })

    await ctx.provider.transform((editor) => {
      editor.add({
        info: {
          id: providerID,
          name: `${providerID} (session-peers harness)`,
          activation: "enabled",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { provider: providerID, baseURL },
        },
        models: [
          {
            id: "stub",
            modelID: "stub",
            providerID,
            name: "Harness stub",
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 0 },
            cost: [],
            status: "active",
            enabled: true,
            limit: { context: 200_000, output: 8_192 },
          },
        ],
      })
    })
  },
}
