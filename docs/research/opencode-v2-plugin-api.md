# OpenCode v2 Plugin API — version-pinned reference

Research date: 2026-10-14
Researcher scope: the opencode v2 plugin/extension API as installed on this machine plus its official docs.
Method: read the installed package's TypeScript declarations, the compiled binary's embedded plugin
loader, the local plugin log, and the official docs. Every claim below is cited with a local file path +
line number, a quoted signature, or a URL.

---

## 0. TL;DR for an engineer building a plugin

- A v2 plugin **default-exports a plain object** `{ id: string, setup(ctx) }` — or `{ id, effect(ctx) }` for
  the Effect variant. `Plugin.define()` is **identity**; it only provides types.
- `setup` receives one context object that is *an in-process OpenCode server client plus plugin-only
  extension points* (transforms, hooks, `reload`, `storage`, `event`, `rpc`).
- Plugins run **in the same process as the opencode server**, are loaded with a dynamic `import()` of a
  `file://` URL, and are **hot-reloaded** when any tracked local file in their import graph changes.
- Tools are registered through a synchronous `ctx.tool.transform(editor => editor.add({...}))` with a
  **plain JSON Schema** `input`. `execute` is `async` and receives an `AbortSignal`, so a tool **can block
  and await** arbitrary work (including `ctx.session.wait({ sessionID })`).
- Inter-session messaging primitives exist: `ctx.session.prompt({ sessionID, text, delivery })` can target
  **any** session ID, `ctx.session.wait({ sessionID })` blocks until idle, and `ctx.event.subscribe()`
  streams `session.created` / `session.idle` / `session.status` / `session.execution.*` events.
- **There is no `session.list()` in the plugin context** (see §6). Session discovery must be built from
  events or from a separately constructed `@opencode/client`.

---

## 1. What is installed on this machine

| Fact | Value | Evidence |
| --- | --- | --- |
| `which opencode` | `/usr/bin/opencode` | shell: `which opencode` |
| `opencode --version` | `opencode v2.0.27` | shell: `opencode --version` |
| Install kind | single compiled **Bun executable**, 210,367,968 bytes, "ELF 64-bit LSB executable … not stripped" | `file /usr/bin/opencode` |
| Embedded runtime | Bun-compiled with modules under `/$bunfs/root/chunk-*.js` | `grep -o '/\$bunfs/root/chunk-[^"]*' ` on `strings /usr/bin/opencode` |
| Config dir | `/home/devcxl/.config/opencode` | `opencode debug paths` |
| Data dir | `/home/devcxl/.local/share/opencode` | `opencode debug paths` |
| State dir | `/home/devcxl/.local/state/opencode` | `opencode debug paths` |
| Database | `/home/devcxl/.local/share/opencode/opencode.db` (SQLite, ≈38 GB + WAL) | `opencode debug paths`; `ls -la ~/.local/share/opencode/` |
| Log | `/home/devcxl/.local/share/opencode/log/opencode.log` | `ls ~/.local/share/opencode/log/` |

The binary is **not** a global npm package and there is no `node_modules/opencode`. There *is*, however, a
user-managed npm tree at `~/.config/opencode/node_modules/` that exists to supply plugin authoring types
and runtime deps.

### 1.1 Plugin packages present locally

`~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@opencode/plugin": "2.0.16",
    "@opentui/core": "0.5.12",
    "@opentui/solid": "0.5.12"
  }
}
```

**This is the authoritative type surface for the running host**, and it is *older than the binary*:

| Component | Version | Evidence |
| --- | --- | --- |
| opencode binary | **2.0.27** | `opencode --version` |
| `@opencode/plugin` (npm, local) | **2.0.16** | `~/.config/opencode/node_modules/@opencode/plugin/package.json:4` |
| `@opencode/client` (nested dep of plugin) | **2.0.16** | `~/.config/opencode/node_modules/@opencode/plugin/node_modules/@opencode/client/package.json:4` |
| `@opencode/schema` | **2.0.16** | `~/.config/opencode/node_modules/@opencode/schema/package.json` |
| `@opencode/protocol` | **2.0.16** | `~/.config/opencode/node_modules/@opencode/protocol/package.json` |
| `@opencode/plugin` (npm latest) | **2.0.29** | `npm view @opencode/plugin version` |
| `@opencode-ai/plugin` (the **v1** package) | 1.19.0 | `npm view @opencode-ai/plugin version` |

> **Version-drift warning.** The official v2 docs describe a slightly newer API than the locally installed
> 2.0.16 typings (e.g. docs list `ctx.session.remove` and `ctx.session.compact`; 2.0.16 does not declare
> them). See §9. Write code against the **installed** types, or pin `@opencode/plugin` to the version you
> intend to target.

`@opencode/plugin`'s own description on npm is *"Authoring interfaces and runtime loader support for
OpenCode V2 plugins"* (npm search metadata for `@opencode/plugin`).

### 1.2 Where plugins are declared and discovered

Declared in `opencode.json(c)` under the **`plugins`** key (array of `string | {package, options}`):

- Schema: `~/.config/opencode/node_modules/@opencode/schema/dist/config.d.ts:74` →
  `plugins: Schema.decodeTo<Schema.optional<Schema.toType<Schema.$Array<Schema.Union<readonly [Schema.String, typeof ConfigPlugin.Entry]>>>>, …>`
- Entry shape: `@opencode/schema/dist/config/plugin.d.ts:3-9`
  ```ts
  readonly package: Schema.String;
  readonly options: Schema.decodeTo<Schema.optional<Schema.toType<Schema.$Record<Schema.String, Schema.Unknown>>>, …>;
  export declare const Plugin: Schema.Union<readonly [Schema.String, typeof Entry]>;
  ```
- Live example on this machine — `/home/devcxl/.config/opencode/opencode.json`:
  ```jsonc
  "plugins": [
    "/home/devcxl/Projects/OpenCodePlugins/opencode-antigravity",
    // "/home/devcxl/Projects/OpenCodePlugins/opencode-code-plan-usage"
  ],
  ```

Discovery layout (docs, [Configure plugins](https://opencode.ai/v2/docs/plugins/)):

```text
.opencode/
└── plugins/
    ├── concise.ts
    ├── reviewer.js
    └── acme-package/
```

```text
~/.config/opencode/plugins/
```

> A `plugins/` directory beside a project-root `opencode.json(c)` is **not** discovered automatically.
> (`https://opencode.ai/v2/docs/plugins/`, "Discover" section.)

Confirmed live in the server log — plugin files in `~/.config/opencode/plugins/` are loaded by the
**server** role:

```
timestamp=2026-10-14T11:13:41.983Z level=INFO run=cc0ccf1f msg="loading plugin" id=/home/devcxl/.config/opencode/plugins/local.ts entrypoint=file:///home/devcxl/.config/opencode/plugins/local.ts http.span=29 role=server
timestamp=2026-10-14T11:13:41.985Z level=INFO run=cc0ccf1f msg="loading plugin" id=/home/devcxl/Projects/OpenCodePlugins/opencode-antigravity entrypoint=file:///home/devcxl/Projects/OpenCodePlugins/opencode-antigravity/index.ts http.span=31 role=server
```
(`~/.local/share/opencode/log/opencode.log`)

Note the two distinct entrypoints: a bare `.ts` file resolves to **that file**; a directory resolves to
`<dir>/index.ts` (see §3.2).

### 1.3 Local plugin directory inventory

- `~/.config/opencode/plugins/` — 5 v2 `.ts` plugins written by the user:
  `command-guard.ts`, `env-protection.ts`, `half-cabbage-provider.ts`, `local.ts`,
  `volcengine-coding-plan-provider.ts`
- `~/.config/opencode/tui-plugins/titlebar-spinner/tui.ts` — a **CLI/TUI** plugin
- `~/.cache/opencode/packages/` — package-plugin cache: `@devcxl/opencode-cabbage@1.2.0`,
  `@devcxl/opencode-memory@latest`, `@prevalentware/opencode-goal-plugin`
- `opencode plugin list` (run in `/tmp/opencode`) printed only:
  ```
  ID  VERSION  SOURCE
  -   local    /home/devcxl/.config/opencode/tui-plugins/titlebar-spinner
  ```
  i.e. the CLI lists **CLI/TUI** plugins only; server plugins loaded from `~/.config/opencode/plugins/`
  and from the `plugins` array do not appear there.

### 1.4 A real, working local v2 plugin (best local example)

`/home/devcxl/Projects/OpenCodePlugins/opencode-antigravity/` — `package.json` declares
`"@opencode/plugin": "^2.0.16"`, `"name": "opencode-antigravity-v2"`, `"description": "Unofficial
OpenCode V2 plugin …"`. Its `index.ts` and `src/` are a complete, working v2 plugin using provider
transforms, AI-SDK hooks, storage, and tool registration. Read it before writing new code.

Also read `~/.config/opencode/plugins/command-guard.ts`, which is a minimal, correct v2 example:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "command-guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool !== "shell") return
      const input = event.input as { command?: unknown } | null
      const cmd = typeof input?.command === "string" ? input.command : ""
      if (!cmd.trim()) return
      for (const rule of DANGEROUS_PATTERNS) {
        if (rule.re.test(cmd)) {
          throw new Error(`Blocked dangerous command: ${rule.name} (${rule.reason}).\nCommand: ${cmd}`)
        }
      }
    })
  },
})
```

---

## 2. The plugin module contract — exact export signature

### 2.1 The Promise (default) entrypoint

`~/.config/opencode/node_modules/@opencode/plugin/dist/promise/plugin.d.ts:54-59`:

```ts
export type Cleanup = () => Promise<void> | void;
export interface Plugin {
    readonly id: string;
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
}
export declare function define(plugin: Plugin): Plugin;
```

`define` is a no-op at runtime — `dist/promise/plugin.js:1-3`:

```js
export function define(plugin) {
    return plugin;
}
```

So the runtime requirement is simply: `export default { id, setup }`.

### 2.2 The Effect entrypoint (`@opencode/plugin/effect`)

`~/.config/opencode/node_modules/@opencode/plugin/dist/effect/plugin.d.ts:54-58`:

```ts
export interface Plugin<R = Scope.Scope> {
    readonly id: string;
    readonly effect: (context: Context) => Effect.Effect<void, never, R>;
}
export declare function define<R = Scope.Scope>(plugin: Plugin<R>): Plugin<R>;
```

### 2.3 How the host actually validates a loaded module

The binary contains the loader schema (`strings /usr/bin/opencode`, one-line minified module):

```js
var TU=o({default:v([
  o({id:t,effect:So((e)=>typeof e==="function")}),
  o({id:t,setup:So((e)=>typeof e==="function")})
])});
```

and the loader:

```js
let w=yield*ue(()=>l?i.read(f):jS(f).then(...));
let k=(yield*ie(TU)(w.module).pipe(y((N)=>new uc({message:"Plugin must export a default definition with an id and an effect or setup function.",cause:N})))).default,
T="effect"in k?k:IQ(k);
```

Quoted error string (verbatim, from the binary): **`"Plugin must export a default definition with an id and
an effect or setup function."`**

Loader also records features and source:

```js
return{id:T.id,features:{..._.tui?{tui:!0}:{},..._.rpc?{rpc:!0}:{}},revision:JSON.stringify([e,w.version]),
source:Ul.isAbsolute(e.target)?{type:"local",path:SU(f)}:{type:"package",target:e.target,...A?.version?{version:A.version}:{}},
effect:(N)=>T.effect({...N,options:e.options})};
```

### 2.4 V1 + V2 in one entrypoint

V2 ignores `server()`. From [Overview](https://opencode.ai/v2/docs/build/plugins):

> - V1 calls `server()` and uses the returned hooks.
> - V2 reads the default export's `id` and `setup()` (or `effect()` for Effect plugins), ignoring `server()`.

```ts
import { Plugin } from "@opencode/plugin"

export default {
  ...Plugin.define({
    id: "example",
    async setup(ctx) { /* V2 */ },
  }),
  async server() { return { "tool.execute.before": async () => {} } },
}
```

---

## 3. The plugin context — exact shape

### 3.1 Full interface (installed 2.0.16)

`~/.config/opencode/node_modules/@opencode/plugin/dist/promise/plugin.d.ts:25-53`:

```ts
export interface Context {
    readonly app: App;
    readonly location: Location.Info;
    readonly options: PluginOptions;
    readonly agent: AgentDomain;
    readonly aisdk: AISDKDomain;
    readonly command: CommandDomain;
    readonly event: EventDomain;
    readonly experimental: {
        readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read">;
    };
    readonly integration: IntegrationDomain;
    readonly mcp: MCPDomain;
    readonly model: ModelDomain;
    readonly generate: GenerateApi;
    readonly permission: PermissionDomain;
    readonly plugin: Pick<PluginApi, "list">;
    readonly provider: ProviderDomain;
    readonly reference: ReferenceDomain;
    readonly rpc: RpcDomain;
    readonly session: SessionDomain;
    readonly shell: ShellDomain;
    readonly skill: SkillDomain;
    readonly storage: StorageDomain;
    readonly tool: ToolDomain;
    readonly vcs: VcsDomain;
    readonly websearch: WebSearchDomain;
    readonly worktree: WorktreeDomain;
}
```

Supporting types:

- `dist/app.d.ts:1-5`
  ```ts
  export interface App {
      readonly name: string;
      readonly version: string;
      readonly channel: string;
  }
  ```
- `dist/options.d.ts:1` → `export type PluginOptions = Readonly<Record<string, any>>;`
- `dist/storage.d.ts:2-14`
  ```ts
  export interface StorageEntry { readonly key: string; readonly value: Schema.Json; }
  export interface StorageScanOptions { readonly prefix: string; readonly after?: string; readonly limit?: number; }
  export interface StorageScanResult { readonly entries: readonly StorageEntry[]; readonly next?: string; }
  ```
- `dist/promise/storage.d.ts:3-8`
  ```ts
  export interface StorageDomain {
      readonly get: (key: string) => Promise<Schema.Json | undefined>;
      readonly set: (key: string, value: Schema.Json) => Promise<void>;
      readonly remove: (key: string) => Promise<void>;
      readonly scan: (options: StorageScanOptions) => Promise<StorageScanResult>;
  }
  ```

`ctx.location` is documented as *the location where this plugin instance is loaded*, **not** the location of
every session it can access or event it receives
([Overview](https://opencode.ai/v2/docs/build/plugins), "Context").

`ctx.options` comes from the object form in `opencode.json(c)` and is passed through by the loader
(`effect:(N)=>T.effect({...N,options:e.options})` in the binary).

### 3.2 Entrypoint resolution — `@opencode/plugin/host`

`~/.config/opencode/node_modules/@opencode/plugin/dist/host.js:4-33`:

```js
export function resolve(target) {
    const entry = (subpaths) => {
        for (const subpath of subpaths) {
            const specifier = target.name
                ? [target.name, subpath].filter(Boolean).join("/")
                : path.resolve(target.directory, subpath || "index");
            try { return resolveModule(specifier, target.directory); }
            catch (error) { /* … only ENOENT/ENOTDIR/MODULE_NOT_FOUND/ERR_MODULE_NOT_FOUND/… are swallowed … */ }
        }
        return undefined;
    };
    return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) };
}
export function load(entrypoint) {
    return importModule(entrypoint);
}
```

So a **directory** plugin may expose up to three entrypoints:

| Entrypoint | Directory form | Package form |
| --- | --- | --- |
| `server` | `<dir>/server.*` then `<dir>/index.*` | `<pkg>/server` then `<pkg>` |
| `tui` | `<dir>/tui.*` | `<pkg>/tui` |
| `rpc` | `<dir>/rpc.*` | `<pkg>/rpc` |

Loader behaviour for a **local absolute path** target, from the binary:

```js
let _ = l && (yield*ue(()=>py(e.target))).isFile() ? {server: MU(e.target).href} : yield*D(()=>Eg(A??{directory:e.target}))
```

i.e. if the target is an absolute path to an existing **file**, the `server` entrypoint is that exact file
URL and there is no `tui`/`rpc`; if it is a **directory**, `Host.resolve({ directory })` is used.

> Local note: `/home/devcxl/.config/opencode/tui-plugins/titlebar-spinner/tui.ts` contains a first-hand
> comment claiming v2.0.22's TUI loader "silently skips local plugin targets that resolve to an existing
> file" — consistent with the `isFile()` branch above producing no `tui` entrypoint. **Not re-verified
> against 2.0.27.**

### 3.3 TUI/CLI plugin context (separate API)

`@opencode/plugin/tui`, `~/.config/opencode/node_modules/@opencode/plugin/dist/tui/plugin.d.ts:1-8`:

```ts
export type Cleanup = () => Promise<void> | void;
export interface Definition {
    readonly id: string;
    readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void;
}
export declare function define(plugin: Definition): Definition;
```

The TUI `Context` lives in `dist/tui/context.d.ts` (461 lines) and is a **different** object: OpenTUI
renderer, `ui.dialog` / `ui.toast` / `ui.router` / `ui.panel` / `ui.tabs`, `keymap`, `data`, `client`
(full OpenCode API client), `theme`, `storage`. Real usage in this repo's environment:
`~/.config/opencode/tui-plugins/titlebar-spinner/tui.ts` uses `context.ui.router.current()`,
`context.data.session.status(id)`, `context.data.session.get(id)?.title`, `context.renderer.setTerminalTitle(…)`.

CLI plugins are configured separately — `/home/devcxl/.config/opencode/cli.json`:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [{ "package": "./tui-plugins/titlebar-spinner" }]
}
```

The binary confirms `cli.json` is the v2 CLI config with `$schema` `https://opencode.ai/v2/cli.json`
(`dm extends U()("@opencode/cli/config/Config")` … `join(i.config,"cli.json")`).

---

## 4. Runtime model: in-process, capabilities, hot reload

### 4.1 In-process

Plugins are `import()`-ed into the **server process**:

- Log: `msg="loading plugin" … role=server` (`~/.local/share/opencode/log/opencode.log`)
- `Host.load(entrypoint)` → `importModule(entrypoint)` (`dist/host.js:31-33`)
- `dist/promise/adapter.js` builds the promise context by calling the host's **Effect services directly**
  — e.g. `prompt: adaptApiMethod(SessionEndpoints["session.prompt"], host.session.prompt)`
  (`dist/promise/adapter.js:423`). The HTTP endpoint schemas are used only to encode/decode arguments and
  results; there is no HTTP round-trip.
- `event.subscribe` wraps an in-process Effect stream:
  ```js
  event: {
      subscribe: (options) => streams(host.event.subscribe().pipe(Stream.mapEffect((event) => Schema.encodeUnknownEffect(OpenCodeEvent)(event)), Stream.map((event) => event)), options),
  },
  ```
  (`dist/promise/adapter.js:223-226`)

### 4.2 What a plugin can access

Because it runs in the host process, a plugin is ordinary JS/TS: `node:fs`, `fetch`, `process.env`,
`child_process`, sockets, timers, etc. Nothing in the plugin API sandboxes this.

The docs frame this positively rather than as a sandbox
([Migrate plugins from V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1)):

> | `$` Bun shell helper | import and manage the process API your plugin uses |

and

> Use the cleanup function … subprocesses, … resources the plugin owns.
> … Use `ctx.storage` instead of inventing a global file when state belongs to a plugin; its JSON values
> are durable and scoped to the plugin.

**Access is gated once, at load time**, by permissions under the `integration.use` action, keyed
`plugin:<target>` — from the binary's `PluginModule.load`:

```js
return{load:(k,T)=>a(function*(){
  let N=k.target.lastIndexOf("@"),
  I=Ul.isAbsolute(k.target)||N<=0?k.target:k.target.slice(0,N);
  if(b0(dh(yield*e.entries(),i.current()),"integration.use",`plugin:${I}`)==="deny")return{blocked:!0};
  return yield*NU(k,w,T)}),...}
```

### 4.3 Hot reload + ESM cache busting

`@opencode/plugin/dist/source.js` implements a content-digest cache keyed on the entrypoint, tracking
**every local file** in the import graph (files under `node_modules` are excluded from the tracked set):

```js
read: async (entrypoint) => {
    …
    const previous = sources.get(entrypoint);
    if (previous && [...previous.files].every(([file, item]) => item.digest === digest(file, item.directory)))
        return previous.loaded;
    …
    track(fileURLToPath(entrypoint));
    const { prepareSource } = await import("#plugin-source");
    const prepared = await prepareSource(entrypoint, track);
    …
    sources.set(entrypoint, { loaded, files });
}
```

`source.node.js` appends `?__opencode_reload=<generation>` to every resolved local URL and installs
`registerHooks({ resolve })` from `node:module` to bust Node's ESM cache:

```js
const fresh = (specifier) => { const url = new URL(specifier); url.searchParams.set("__opencode_reload", version); return url.href; };
…
const specifier = fresh(entrypoint);
return { version: specifier, load: () => Host.load(specifier), dispose: () => hook.deregister() };
```

There is a matching Bun variant (`dist/source.bun.js`) selected by the package `imports` map
(`"#plugin-source": { "bun": "./dist/source.bun.js", "node": "./dist/source.node.js", … }`,
`@opencode/plugin/package.json`). `localSource` in `source.js` accepts `file://`, `./`, `../`, and absolute
paths and resolves them relative to the config directory.

### 4.4 Lifecycle, registration, unloading

- `setup` runs on load; it may return a cleanup function (`dist/promise/plugin.d.ts:54,57`).
- Hook/transform registrations return a `Registration`:
  `dist/promise/registration.d.ts:1-13`
  ```ts
  export interface Registration { readonly dispose: () => Promise<void>; }
  export interface ModelHookOptions { readonly providerID?: string; }
  export type Hooks<Spec> = <Name extends keyof Spec>(name: Name, callback: (input: Spec[Name]) => Promise<void> | void) => Promise<Registration>;
  export type Transform<Input> = (callback: (input: Input) => void) => Promise<Registration>;
  ```
- `dist/promise/adapter.d.ts:3-11`:
  > Hook registrations created during the async `setup` attach to the plugin's scope, so unloading the
  > plugin disposes them.

### 4.5 Plugin identity and de-duplication

- `id` is required and stable; storage is scoped by it
  ([Migrate from V1](https://opencode.ai/v2/docs/build/plugins/migrate-v1): *"Every V2 plugin needs a
  stable `id`. Plugin storage is scoped by this ID…"*).
- The supervisor drops duplicates: from the binary's `PluginSupervisor.resolve`,
  ``error:`Duplicate plugin ID: ${H.id}` ``.
- Built-in plugins use an `opencode.` prefix. Full list extracted from the binary includes
  `opencode.tool.subagent`, `opencode.tool.read/write/edit/glob/grep/shell/patch/webfetch/websearch`,
  `opencode.tools` (the Code Mode catalog), `opencode.config.*`, `opencode.provider.*`, `opencode.vcs.git`,
  `opencode.warming`, `opencode.wellknown`, `opencode.storybook`, `opencode.notifications`, `opencode.stats`,
  `opencode.skill`, `opencode.plan`, `opencode.agent`, `opencode.command`, `opencode.mcp.codemode.defaults`,
  `opencode.models.dev`, `opencode.diffs`, `opencode.merman`, `opencode.latex`.
  Docs note two built-ins ignore removal: `opencode.config.policy` and `opencode.provider.opencode`
  ([Configure plugins](https://opencode.ai/v2/docs/plugins/)).

---

## 5. Hooks — the full set (installed 2.0.16)

### 5.1 Tool hooks — `dist/promise/tool.d.ts:29-52`

```ts
interface ToolHooks {
    readonly "execute.before": {
        tool: string;
        readonly sessionID: Session.ID;
        readonly agent: Agent.ID;
        readonly messageID: SessionMessage.ID;
        readonly id: Tool.CallID;
        input: unknown;
    };
    readonly "execute.after": {
        readonly tool: string;
        readonly sessionID: Session.ID;
        readonly agent: Agent.ID;
        readonly messageID: SessionMessage.ID;
        readonly id: Tool.CallID;
        readonly input: unknown;
    } & ({ readonly status: "completed"; result: Tool.Result; } | { readonly status: "error"; error: Tool.Error; });
}
```

`execute.before` is **fallible**: throwing aborts the tool. The local `command-guard.ts` relies on this.
The Effect variant declares the failure type explicitly
(`dist/effect/tool.d.ts:44-47`):
```ts
export interface ToolFailures extends Record<keyof ToolHooks, unknown> {
    readonly "execute.before": Tool.Error;
    readonly "execute.after": never;
}
```

### 5.2 Session hooks — `dist/promise/session.d.ts:129-145`

```ts
export interface SessionHooks {
    readonly prompt: SessionPrompt;
    readonly context: SessionContext;
    readonly compaction: SessionCompaction;
    readonly generate: SessionGenerate;
    readonly title: SessionTitle;
    readonly "model.request": SessionModelRequest;
    readonly "http.request": SessionHttpRequest;
    readonly "http.response": SessionHttpResponse;
    readonly "experimental.ws.handshake": SessionWebSocketHandshake;
    readonly "experimental.ws.send": SessionWebSocketSend;
    readonly "experimental.ws.receive": SessionWebSocketReceive;
    readonly retry: SessionRetry;
}
export type SessionDomain = Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait" | "context"> & {
    readonly hook: ModelHooks<SessionHooks>;
};
```

`SessionPrompt` (`dist/promise/session.d.ts:13-19`):

```ts
export interface SessionPrompt {
    readonly sessionID: Session.ID;
    readonly messageID: SessionMessage.ID;
    prompt: Types.DeepMutable<PromptInput.Prompt>;
    metadata?: Record<string, unknown>;
    delivery: SessionInbox.Delivery;
}
```

The `prompt` hook fires **once at admission**, not before every model call. Docs
([Hooks → Prompt admission](https://opencode.ai/v2/docs/build/plugins)):

> - `delivery` is `"steer"` by default and can be changed to `"queue"`.
> - Session and message IDs are readonly; a hook cannot redirect admission.
> - Synthetic messages, shell messages, compaction controls, and move controls do not [run the hook].
> - The hook runs once during admission, not before every model call.
> - Provider scoping is unavailable because model resolution happens after admission.

`retry` returns a decision (`dist/promise/session.d.ts:115-128`):

```ts
export type SessionRetryDecision = { retry: false } | { retry: true; delay: number };
export interface SessionRetry {
    readonly sessionID: Session.ID;
    readonly agent: Agent.ID;
    readonly model: Model.Ref;
    readonly error: SessionError.Error;
    readonly attempt: number;
    decision: SessionRetryDecision;
}
```

### 5.3 Other hooks

| Hook | Signature location |
| --- | --- |
| `permission.evaluate` | `dist/promise/permission.d.ts:6-18` — `{ sessionID, agent?, action, resources, metadata?, source?, effect, message? }` |
| `shell.create.before` | `dist/promise/shell.d.ts:2-11` — `{ command, cwd, timeout, shell, env }` (mutate `env` to inject vars) |
| `aisdk.sdk` / `aisdk.language` | `dist/promise/aisdk.d.ts:4-19` — provider `Model.Info` + `sdk`/`language` out-params |
| `session.*` model scoping | `ModelHooks` takes `{ providerID }` only for specs whose event has a `model` field (`dist/promise/registration.d.ts:9-11`) |

V1→V2 hook migration table is at
<https://opencode.ai/v2/docs/build/plugins/migrate-v1>.

---

## 6. Sessions, messages, and inter-session primitives

This is the core section for a session-peers plugin.

### 6.1 What `ctx.session` exposes — and what it does **not**

`SessionDomain` (quoted in §5.2) is a `Pick` over `SessionApi`. The generated client's full `session` surface
is much larger — `@opencode/client/dist/promise/client.d.ts:29-89` declares
`list, stats, create, import, export, active, get, remove, fork, switchAgent, switchModel, update, move,
prompt, command, skill, synthetic, shell, compact, wait, revert, context, diff, inbox, instructions,
generate, log, interrupt, background, message, form, environment, view`.

**Methods available to a v2 plugin (2.0.16), and their input types:**

| Method | Input (from `@opencode/client/dist/promise/generated/types.d.ts`) | Output |
| --- | --- | --- |
| `create` | `SessionCreateInput` (L3689): `{ id?, title?, agent?, model?, location?, metadata? }` | `SessionInfo` |
| `get` | `{ sessionID: string }` | `SessionInfo` |
| `switchAgent` | `{ sessionID, agent }` | `void` |
| `switchModel` | `{ sessionID, model: { providerID, id, variant? } }` | `void` |
| `prompt` | `SessionPromptInput` (L5369) | `SessionInboxUser` |
| `generate` | `{ sessionID, prompt: string }` (L6092) | `{ text: string }` |
| `command` | `SessionCommandInput` (L5657): `{ sessionID, name, text, files?, agents?, skills?, delivery? }` | `void` |
| `synthetic` | `SessionSyntheticInput` (L5863): `{ sessionID, id?, text, description?, metadata?, delivery?, resume? }` | `SessionInboxSynthetic` |
| `interrupt` | `{ sessionID, resume? }` (L6115) | `SessionInterruptResponse` |
| `update` | `SessionUpdateInput` (e.g. title / metadata) | `void` |
| `move` | `SessionMoveInput`: `{ sessionID, directory, delivery? }` | `void` |
| `wait` | `SessionWaitInput` (L5961): `{ sessionID }` | `void` |
| `context` | `{ sessionID }` (L5995) | `SessionMessageInfo[]` |

**Not exposed** in 2.0.16: `list`, `active`, `remove`, `compact`, `fork`, `stats`, `log`, `inbox.*`,
`message.get`, `form.*`, `background`, `revert.*`, `diff`, `instructions.*`, `shell`, `skill`,
`environment`, `view`, `import`, `export`.

> **Consequence for session-peers:** there is **no direct way to enumerate sessions** from `ctx.session`.
> `ctx.session.prompt({ sessionID })` works for any session ID you already know. See §7 for the two
> viable discovery paths.

### 6.2 `SessionPromptInput` — effective flattened shape

The generated type is code-gen flattened (`X["field"]` self-indexing). Its effective shape, read from
`types.d.ts:5369-5925`:

```ts
interface SessionPromptInput {
  sessionID: string
  id?: string | null
  text: string                              // required — PromptInput.Prompt.text
  files?: ReadonlyArray<{ uri: string; name?: string; description?: string; mention?: { start: number; end: number; text: string } }>
  agents?: ReadonlyArray<{ name: string; mention?: { start; end; text } }>
  skills?: ReadonlyArray<{ id: string; name: string; text?: string; mention?: { start; end; text } }>
  metadata?: Record<string, JsonValue>
  delivery?: "steer" | "queue" | null
  resume?: boolean | null
}
```

`PromptInput.Prompt` is authoritative for the required field —
`@opencode/schema/dist/prompt-input.d.ts:46-48`:
```ts
export declare const Prompt: Schema.Struct<{
    readonly text: Schema.String;
    readonly files: …
```
i.e. **`text` is required**; `files`, `agents`, `skills` are optional.

Return value (`types.d.ts:3101-3110`):
```ts
export type SessionInboxUser = {
    id: string;
    sessionID: string;
    time: { created: number };
    type: "user";
    payload: SessionInboxUserPayload;
    delivery: SessionInboxDelivery;
};
```

### 6.3 `delivery: "steer" | "queue"` — semantics

From the binary's `SessionPrompt.prepare`:

```js
let f=yield*(yield*UE).trigger("session","prompt",{sessionID:H.session.id,messageID:H.messageID,prompt:structuredClone({…}),
  metadata:structuredClone(H.input.metadata),delivery:H.input.delivery??"steer"})
```

→ default is **`"steer"`**.

From `SessionInbox.promote` and `SessionInbox.nextPromotable` in the binary:

```js
var V$=(H,e)=>H.select().from(UH).where(Fo(de(UH.session_id,e),de(UH.delivery,"steer"))).orderBy(ci(UH.enqueued_seq)).all()…
… if(A!=="input")return; let f=yield*H.select().from(UH).where(Fo(de(UH.session_id,e),de(UH.delivery,"queue"))).orderBy(ci(UH.enqueued_seq)).limit(1).get()
```

→ `steer` items are promoted/drained ahead of `queue` items; `queue` items wait in FIFO order. Docs:
*"`delivery` is `"steer"` by default and can be changed to `"queue"`"*
([Hooks → Prompt admission](https://opencode.ai/v2/docs/build/plugins)).

### 6.4 `wait` — the blocking primitive

`SessionWaitInput = { readonly sessionID: string }`, output `void`
(`@opencode/client/dist/promise/generated/types.d.ts:5961-5967`).

Implementation in the binary:

```js
awaitIdle: l   where  l=(k)=>F(()=>{let B=e.get(k); if(B===void 0)return g; return Ct(B.done).pipe(Vu,Z(l(k)))})
```
and
```js
wait: (input) => … session.wait …
```
Docs: `await ctx.session.wait({ sessionID })` under *"Rename, interrupt, or wait for a session"*
([Sessions](https://opencode.ai/v2/docs/build/plugins)).

**`wait` blocks until the session runner goes idle.** That is the "wait for a reply" primitive an agent
can call from inside a tool. Note `wait` waits for the whole drain, not for a specific message.

### 6.5 `SessionInfo` — what a session record contains

`@opencode/client/dist/promise/generated/types.d.ts:2779-2805`:

```ts
export type SessionInfo = {
    id: string;
    parentID?: string;
    fork?: { sessionID: string; boundary: SessionForkBoundary; };
    projectID: string;
    agent?: string;
    model?: ModelRef;
    cost: MoneyUSD;
    tokens: TokenUsageInfo;
    outcome?: "succeeded" | "failed" | "interrupted";
    time: { created: number; updated: number; idle?: number; viewed?: number; archived?: number; };
    title?: string;
    subpath?: string;
    metadata?: SessionMetadata;
    permissions?: PermissionRuleset;
    revert?: SessionRevert;
    location: LocationPublicRef;
};
```

`parentID` is how sub-agent (child) sessions are distinguished — relevant because
`opencode.tool.subagent` is a built-in tool.

`SessionStatus` (`types.d.ts:571-587`) is `{ type: "idle" } | { type: "retry", … } | { type: "busy" }`.

### 6.6 Session discovery via `ctx.event`

`dist/promise/event.d.ts:1-3`:

```ts
import type { EventApi } from "@opencode/client/promise/api";
export interface EventDomain extends Pick<EventApi, "subscribe"> {
}
```

Client signature (`@opencode/client/dist/promise/client.d.ts:10-12`):

```ts
event: {
    subscribe(options?: SharedEvents.SubscribeOptions): AsyncIterable<import("./index.js").V2Event>;
};
```

`SharedEvents.SubscribeOptions` (`@opencode/client/dist/shared-events.d.ts:2-6`):

```ts
export type SubscribeOptions = {
    readonly signal?: AbortSignal;
    /** Reports transport activity on the shared stream, including keepalive frames that carry no event. */
    readonly onActivity?: () => void;
};
```

The event union (`types.d.ts:3301`, `V2Event`) includes, per session:

`SessionCreated` (`session.created`), `SessionAgentSelected`, `SessionModelSelected`, `SessionMoved`,
`SessionRenamed`, `SessionMetadataUpdated`, `SessionPermissions`, `SessionViewed`, `SessionUsageUpdated`,
`SessionDeleted`, `SessionForked`, `SessionInboxDelivered`, `SessionInboxEnqueued`,
`SessionInboxCancelled`, `SessionInboxDeliveryChanged`, `SessionExecutionStarted`,
`SessionExecutionSucceeded`, `SessionExecutionFailed`, `SessionExecutionInterrupted`,
`SessionInstructionsUpdated`, `SessionSynthetic`, `SessionSkillActivated`, `SessionShellStarted/Ended`,
`SessionStepStarted/Streamed/Ended/Failed`, `SessionTextStarted/Delta/Ended`,
`SessionReasoningStarted/Delta/Ended`, `SessionToolInputStarted/Delta/Ended`,
`SessionToolCalled/Progress/Success/Failed`, `SessionRetryScheduled`, `SessionCompactionStarted/Delta/Ended/Failed`,
`SessionRevertStaged/Cleared/Committed`, `SessionStatusUpdated`, `SessionIdle`, …
plus non-session events (`FilesystemChanged`, `PermissionAsked/Replied`, `TuiPromptAppend`,
`TuiCommandExecute`, `TuiToastShow`, `TuiSessionSelect`, `CommandUpdated`, `SkillUpdated`, `VcsBranchUpdated`,
`McpStatusChanged`, `PluginUpdated`, `ConfigUpdated`, …).

Concrete shapes (`types.d.ts`):

```ts
// L2806-2834
export type SessionCreated = {
    id: string; created: number; metadata?: { [x: string]: any };
    type: "session.created";
    durable: { aggregateID: string; seq: number; version: 1; };
    location?: LocationRef;
    data: { sessionID: string; projectID: string; location: LocationRef; subpath?: string;
            parentID?: string; slug: string; title?: string; agent?: string; model?: ModelRef;
            metadata?: SessionMetadata; permissions?: PermissionRuleset; };
};

// L1736-1747
export type SessionIdle = {
    id: string; created: number; metadata?: { [x: string]: any };
    type: "session.idle";
    location?: LocationRef;
    data: { sessionID: string; };
};

// L2396-2408
export type SessionStatusUpdated = {
    id: string; created: number; metadata?: { [x: string]: any };
    type: "session.status";
    location?: LocationRef;
    data: { sessionID: string; status: SessionStatus; };
};
```

There is also a durable vs. non-durable split: `SessionEventDurable` (`types.d.ts:3291`) lists the subset
carrying `durable: { aggregateID, seq, version }`. `session.created`, `session.deleted`,
`session.execution.*`, `session.inbox.*`, `session.compaction.*`, `session.revert.*` are durable;
`session.idle` and `session.status` are **not** (no `durable` field).

### 6.7 The `inbox` concept (relevant background)

Input is admitted into a per-session **inbox** before execution. From the binary:

```js
var Mp=c("SessionInbox.make")(function*(){ let e=(yield*Ka).db, A=yield*bn,
  I=c("SessionInbox.reconcile")(…),
  f=c("SessionInbox.admit")(function*(T){ … let k=yield*A.publish(OQ,{inboxID:T.id,sessionID:T.sessionID,item:T.item})… }),
  …
  i=c("SessionInbox.cancel")((T)=>N$(T,A.publish(vq,{sessionID:T.sessionID,inboxID:T.id}))),
  m=c("SessionInbox.steer")((T)=>N$(T,A.publish(Cq,{sessionID:T.sessionID,inboxID:T.id,delivery:"steer"}))),
  _=c("SessionInbox.queue")((T)=>N$(T,A.publish(Cq,{sessionID:T.sessionID,inboxID:T.id,delivery:"queue"})));
```

Item types (`@opencode/schema/dist/session-inbox.d.ts:166-331`): `user`, `synthetic`, `compaction`, `move`.
**A v2 plugin cannot read or mutate another session's inbox** (no `session.inbox.*` in the domain).

### 6.8 Message reads

`ctx.session.context({ sessionID })` returns `SessionMessageInfo[]`
(`types.d.ts:5995-6000` → `{ data: Array<SessionMessageInfo> }["data"]`).

Message record types (`types.d.ts`): `SessionMessageAgentSelected` (107), `SessionMessageSynthetic` (131),
`SessionMessageSystem` (143), `SessionMessageSkill` (155), `SessionMessageShell` (168),
`SessionMessageIdle` (242), `SessionMessageLocationSwitched` (684),
`SessionMessageModelSelected` (787), `SessionMessageToolState*` (192-215),
`SessionMessageCompactionRunning` (220), `SessionMessageCompactionCompleted` (~2587),
`SessionMessageAssistant` (~3180), `SessionMessageUser`.
`ctx.session.get({ sessionID })` also accepts `message.get`-style reads through the client but not the
plugin domain.

### 6.9 RPC — out-of-process / cross-plugin calls

`dist/promise/rpc.d.ts:1-22`:

```ts
export interface RpcCallContext<M extends Rpc.Method> {
    readonly signal: AbortSignal;
    readonly error: Rpc.ErrorFactory<M>;
}
export type RpcHandlers<D extends Rpc.PortableDefinition> = {
    readonly [Name in keyof D["methods"]]: (input: Rpc.Output<D["methods"][Name]["input"]>, context: RpcCallContext<D["methods"][Name]>) => Promise<Rpc.HandlerOutput<D["methods"][Name]["output"]> | Rpc.HandlerError<D["methods"][Name]["output"]>>;
};
export interface RpcRegistration<D extends Rpc.PortableDefinition> extends Registration {
    readonly events: { readonly emit: (...args: Rpc.EventInput<D>) => Promise<void>; };
}
export interface RpcDomain extends RpcApi<…> {
    readonly register: <const D extends Rpc.PortableDefinition>(definition: D, handlers: RpcHandlers<NoInfer<D>>) => Promise<RpcRegistration<D>>;
}
```

Doc example and semantics: <https://opencode.ai/v2/docs/build/plugins/rpc/>. A registered RPC is callable
in-process via `ctx.rpc(Definition)`, and (per the docs) from the **TUI** plugin via
`context.client.rpc(Definition)`. The presence of an `rpc` **entrypoint** in `Host.resolve` means a plugin
package can ship a separate `rpc` implementation that runs in a different process.

---

## 7. Session discovery — the two viable paths (analysis)

`ctx.session.list` does not exist in the plugin domain (2.0.16 **or** the 2.0.29-era docs, which add
`remove` and `compact` but still no `list`). The two workable approaches:

**(a) Event-driven index.** Subscribe in `setup`, maintain a `Map<SessionID, SessionInfo>`:

```ts
export default Plugin.define({
  id: "peers.index",
  async setup(ctx) {
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        switch (event.type) {
          case "session.created":
            // event.data.sessionID, projectID, location, parentID, slug, title, agent, model
            break
          case "session.deleted":
            break
          case "session.idle":
          case "session.status":
            break
        }
      }
    })()
    return () => controller.abort()
  },
})
```
Limitation: only sees events that occur **after** the subscription starts; sessions created earlier are
invisible unless persisted (`ctx.storage`) across reloads. Events are location-tagged
(`event.location`), and the docs warn `ctx.location` is *this plugin instance's* location, not every event's.

**(b) Construct an `@opencode/client` yourself.** `@opencode/client@2.0.16` is a real dependency of
`@opencode/plugin` (nested at
`~/.config/opencode/node_modules/@opencode/plugin/node_modules/@opencode/client/`), exposing the full API
including `session.list(input?: SessionListInput)` → `SessionsResponse`:

```ts
export type SessionListInput = {
    readonly limit?: number; readonly order?: "asc" | "desc"; readonly search?: string;
    readonly parentID?: string | null; readonly directory?: string; readonly project?: string;
    readonly subpath?: string; readonly cursor?: string;
};                                  // types.d.ts:3566-3646
export type SessionsResponse = {    // types.d.ts:3159-3164
    data: Array<SessionInfo>;
    cursor: { previous?: string | null; next?: string | null };
};
```

`OpenCode.make(options: ClientOptions)` (`@opencode/client/dist/promise/client.d.ts:1-6`) requires a
`baseUrl` (46 occurrences of `baseUrl` in the binary) — i.e. you must know the server URL. **How to obtain
that URL from inside a plugin is not documented and was not verified** (see §10).

**(c) `session.search`-style tools already shipped by peers plugins.** Several community plugins
(`opencode-tell-sessions`, `opencode-mesh`) implement discovery themselves; see §8.

---

## 8. Tools: registration, typing, and blocking

### 8.1 The tool contract

`@opencode/schema/dist/tool.d.ts`:

```ts
export interface Context {                                  // L10-16
    readonly sessionID: Session.ID;
    readonly agent: Agent.ID;
    readonly messageID: SessionMessage.ID;
    readonly id: CallID;
    readonly progress: (update: Metadata) => Effect.Effect<void>;
}
export type Metadata = Readonly<Record<string, any>>;        // L7
export type Options = BaseOptions & ({ codemode?: true; pinned?: boolean } | { codemode: boolean; pinned?: never });   // L25-31
export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema;         // L32
export interface Result<Output …> {                          // L66-70
    readonly output?: OutputValue<Output>;
    readonly content?: string | ReadonlyArray<Content>;
    readonly metadata?: Metadata;
}
export type Info<Input …, Output …> = {                      // L71-78
    readonly name: string;
    readonly input: Input;
    readonly description: string;
    readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>;
    readonly output?: Output;
    readonly options?: Options;
};
```

`Content` is a union of `{ type: "text"; text: string }` and
`{ type: "file"; uri: string; mime: string; name?: string }` (`tool.d.ts:56-65`).

The **Promise** view (`dist/promise/tool.d.ts:9-28`) replaces the Effect types with a Promise executor and an
`AbortSignal`:

```ts
export interface ToolContext extends Omit<Tool.Context, "progress"> {
    readonly signal: AbortSignal;
    readonly progress: (update: Tool.Metadata) => Promise<void>;
}
export type Info<Input extends Tool.ValueSchema<any> = Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined = Tool.ValueSchema<any> | undefined> = Omit<Tool.Info<Input, Output>, "execute"> & {
    readonly execute: (input: Parameters<Tool.Info<Input, Output>["execute"]>[0], context: ToolContext) => Promise<Tool.Result<Output>>;
};
export interface ToolEditor {
    list(): readonly (Info & { readonly id: string })[];
    get(id: string): (Info & { readonly id: string }) | undefined;
    namespace(namespace: Tool.Namespace): void;
    add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(tool: Info<Input, Output>): void;
    /** Updates an existing tool; missing IDs are ignored. */
    update(id: string, update: (tool: Types.Mutable<Info>) => void): void;
    remove(id: string): void;
}
export interface ToolDomain {
    readonly transform: Transform<ToolEditor>;
    readonly reload: () => Promise<void>;
    /** Currently registered tools, after every transform, keyed by effective name. */
    readonly list: () => Promise<readonly (Info & { readonly id: string })[]>;
    readonly hook: Hooks<ToolHooks>;
}
```

### 8.2 Registering a tool — real, working example

From `/home/devcxl/Projects/OpenCodePlugins/opencode-antigravity/src/tools.ts` (working on this machine):

```ts
await ctx.tool.transform((editor) => {
  editor.add({
    name: USAGE_TOOL_NAME,
    options: { codemode: false },
    description: `Report Antigravity account usage: quota per model, plan limits and which models the connected account can use. Use when the user asks about remaining quota, rate limits or available Antigravity models.`,
    input: USAGE_INPUT,          // a plain JSON Schema object literal
    async execute(_rawInput: unknown, context) { /* … */ },
  })
})
```

`USAGE_INPUT` / `IMAGE_INPUT` in the same file are plain JSON Schema literals:

```ts
const IMAGE_INPUT = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", description: "What the image should show." },
    aspectRatio: { type: "string", enum: [...IMAGE_ASPECT_RATIOS], description: "…" },
    model: { type: "string", description: "…" },
    path: { type: "string", description: "…" },
  },
  required: ["prompt"],
} as const;
```

The docs make the `transform` being **synchronous** explicit
([Tools](https://opencode.ai/v2/docs/build/plugins)):

> Register, update, and remove tools with a synchronous transform, including in Promise plugins. Load
> external data before registering or reloading. A later valid registration overrides the same effective
> tool name.

Naming rules from the same page:

> Use `update` and `remove` with the effective tool name, including its namespace (`acme_greeting` above).
> Dots in namespaces and unsupported characters in tool names become `_`. … creating a tool requires `add`
> with a complete definition. … Invalid updates are logged and leave the previous definition intact.

Namespace registration: `editor.namespace({ name: "acme", description: "Customer account tools" })`.
The binary's tool-catalog builder confirms the flattening rule and that `execute` is reserved:
```
w=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/   // simulated tool names must be provider-safe
'direct simulated tool name "execute" is reserved'
```

### 8.3 `codemode` vs direct tools, and `pinned`

From the binary:

```js
function dl(H,e={}){ let A=e.budget??pl, I=wD(H.tools), … }   // pl=2000 → Code Mode catalog budget
```
and the Code Mode prompt text:
```
The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.
No Code Mode tools are currently available. Later Code Mode catalog updates may add or remove tools.
Do not call `execute` unless there is at least one available Code Mode tool.
```

- `options: { codemode: false }` → the tool is exposed **directly** to the model.
- `options.codemode !== false` (default `true`) → the tool is folded into a **Code Mode catalog** behind
  the built-in `execute` tool, subject to a descriptive budget (`pl = 2000`).
- `options.pinned: true` → prevents eviction from the Code Mode catalog.

The canonical built-in example is in the binary:
```js
yield*e.tool.transform((B)=>B.add({name:Ap,options:{codemode:!1},description:Lw(),input:QL,output:IL,execute:(H,z)=>a(function*(){ … })}))
```

### 8.4 Blocking / awaiting — the answer for inter-session messaging

A tool `execute` is a plain `async` function (`dist/promise/tool.d.ts:14`) whose context carries an
`AbortSignal`. Nothing prevents long-running awaits:

```ts
async execute(input, context) {
  await ctx.session.prompt({ sessionID: target, text: "ping" })
  await ctx.session.wait({ sessionID: target })   // blocks until the target goes idle
  const messages = await ctx.session.context({ sessionID: target })
  return { content: summarize(messages) }
}
```

Docs explicitly endorse passing the signal to cancellable work
([Tools](https://opencode.ai/v2/docs/build/plugins)):

> Promise tool executors receive `context.signal`. Pass it to cancellable work such as `fetch` so stopping
> the Session also stops the underlying operation.

Caveats found in the code (not documented):

- `ctx.session.wait` waits for the session's **runner drain** to go idle, not for a specific message. If the
  target was already busy for an unrelated reason, `wait` returns after that work finishes, so you cannot
  attribute a reply by waiting alone — you must diff `ctx.session.context()` before/after, or correlate by
  message ID.
- `ctx.session.prompt` returns the **admission record** (`SessionInboxUser`), not the assistant reply.
- `prompt` defaults to `delivery: "steer"`, which injects into a **running** turn. Use `delivery: "queue"`
  when you want the target to start a fresh turn after it goes idle.
- Tool execution is per-tool-call; a plugin tool cannot outlive the session that invoked it except through
  `ctx.storage`, timers, or a `background`-style mechanism (which is not in the plugin domain).

---

## 9. Official docs, and drift vs. the installed version

### 9.1 URLs (all verified reachable during this research)

| Page | URL |
| --- | --- |
| Plugins (configure/discover/control/manage) | <https://opencode.ai/v2/docs/plugins/> |
| Build a plugin — overview, context, transforms | <https://opencode.ai/v2/docs/build/plugins> |
| Migrate plugins from V1 | <https://opencode.ai/v2/docs/build/plugins/migrate-v1> |
| Effect plugins | <https://opencode.ai/v2/docs/build/plugins/effect> |
| RPC | <https://opencode.ai/v2/docs/build/plugins/rpc/> |
| CLI (TUI) plugins | <https://opencode.ai/v2/docs/build/plugins/cli> |
| Internal V2 plugin design plan (repo) | <https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/v2/effect/PLAN.md> |

A mirror exists at `https://dev.opencode.ai/v2/docs/build/plugins` with identical content.

Package repository metadata (`@opencode/plugin/package.json`, `@opencode/protocol/package.json`,
`@opencode/schema/package.json`, `@opencode/client/package.json`) all point at
`git+https://github.com/anomalyco/opencode.git` with `directory: packages/<name>`. Note the **org is
`anomalyco`, not `sst`** in v2-era packages.

### 9.2 Docs are bundled locally? — No

There is no local docs bundle for the plugin API. The only docs present under the config dir are unrelated:
`~/.config/opencode/docs/dev/research/task-decomposition-dag.md`. The `$schema` URLs referenced by config
files (`https://opencode.ai/config.json`, `https://opencode.ai/v2/cli.json`) are remote.

### 9.3 Drift table — docs vs. installed `@opencode/plugin@2.0.16`

| Item | Installed 2.0.16 | Official docs (≈2.0.29) |
| --- | --- | --- |
| `ctx.session.remove` | **absent** | documented |
| `ctx.session.compact` | **absent** | documented |
| `ctx.session.command` input | `{ sessionID, name, text, files?, agents?, skills?, delivery? }` (`types.d.ts:5657`) | example shows `{ sessionID, command: "review", arguments: "--staged" }` |
| `ctx.vcs.branches` | not in `dist/promise/vcs.d.ts` (only `get/base/status/diff/branch.list`) | `ctx.vcs.branches({ search, limit })` documented |
| `VcsDefinition.init` | not declared | documented |
| Effect `ToolDomain.list` return | `Effect.Effect<…>` | docs show Promise-typed in the "Reference" blocks (a docs simplification) |
| `Plugin.define` | identity function | identity function (consistent) |

Also note the **docs' `SessionContext` reference block omits `move` and `context`**, while 2.0.16 declares
them — the docs list is not exhaustive.

Practical guidance: vendor or pin `@opencode/plugin` to the exact version you target, and treat the docs as
"latest", not "installed".

---

## 10. Existing community plugins for inter-session / inter-agent messaging

Do not reinvent. Inventory as of 2026-10-14, from npm registry metadata
(`https://registry.npmjs.org/<name>` and `/-/v1/search`) plus the projects' own READMEs surfaced in search.

| Package | Latest | Last publish | Declared deps | Protocol | Notes |
| --- | --- | --- | --- | --- | --- |
| **`opencode-mesh`** | 1.2.0 | 2026-10-13 | `@opencode/plugin` **2.0.26** + `@opencode-ai/plugin` ^1.18.30 + `@opencode-ai/sdk` ^1.4.10 | **Dual V1+V2** | The most v2-ish existing option. Tools `mesh_peers`, `mesh_send`; receipts `via:"admitted"` / `via:"queued"`; SQLite outbox + per-process claimer; ships an agent skill. README states on V2 it posts `{text, delivery}` to `/api/session/:sessionID/prompt`. |
| **`opencode-collaboration`** (formerly/sibling of `opencode-plugin-peers`) | 1.1.9 | 2026-10-14 | `zod`; peer `@opencode-ai/plugin >=1.18.29` | V1 (object form) | "Cross-session messaging … modeled after Claude Code's cross-session messaging". Tools `list_agents` / `send_message`; slash commands `/peers`, `/peers-name`, `/peers-inbox`, `/peers-outbox`; inbound policy `accept`/`auto`/`hold`/`refuse`; UDS (macOS/Linux) or loopback TCP (Windows) transport; durable spool with ACKs; a `peerPermissions` mode for auto-approving peer-triggered turns; separate TUI entry. |
| `opencode-plugin-peers` (GitHub `jkrandom-sudo/opencode-plugin-peers`) | 0.2.4 | 2026-09-15 | `zod` | V1 | Predecessor of the above; README describes `promptAsync` injection, one endpoint per session, v1+v2 registry. |
| `opencode-relay` | 0.0.10 | 2026-03-06 | — | V1 | Multi-instance relay across **ports**; tools `relay-connect`, `relay-chat`, `relay-broadcast`; identifies instances by `OPENCODE_PORT` env var; posts to `/session/{id}/prompt_async`. |
| `opencode-cross-session-messaging` (GitHub `kinminghao/cross-session-messaging`) | 0.2.21 | 2026-07-04 | `@opencode-ai/plugin` ^1.17.4, `@opentui/solid`, `solid-js` | V1 | File-based IPC in `~/.local/state/opencode/messages/`, registry at `.../agents-registry.json`. Tools `register_session`, `list_sessions`, **`ask_session(sessionId, question, timeoutMs?)` — a blocking question/answer**, exactly the primitive session-peers needs. Explicitly documents "no deadlock detection", "no authentication", "no cross-session history". |
| `oh-my-msgcode` (GitHub `GonGe1018/oh-my-msgcode`) | 0.1.3 | 2026-04-19 | `@opencode-ai/plugin` ^1.4.17 | V1 | Shared JSON store in `~/.oh-my-msgcode/`; tools `register_agent`, `send_message`, `broadcast_message`, `check_messages`, `ack_message`, `list_agents`, channels. Auto-injection via `promptAsync` on idle or 5 s poll. |
| `opencode-tell-sessions` | 1.0.0 | 2026-08-16 | `@opencode-ai/plugin` next, `@opencode-ai/sdk` 1.18.16, `@opencode-ai/client` next, `effect` 4.0.0-beta.101 | V1+V2 claim | "Inter-session direct messaging (DM) for OpenCode V1 & V2". Tools `session_search` (find session by title/date/content) and `session_send`; prefixes the target message with `@source-title`. |
| `opencode-asl` (AgentSyncLayer) | 0.10.2 | 2026-04-21 | `@opencode-ai/plugin` ^1.4.0, `ioredis` | V1 | Redis pub/sub + SQLite FTS history; 11 tools (`bus_send`, `bus_listen`, `bus_status`, `bus_agents`, advisory file claims, …); project-scoped by path hash. External dependency (Redis). |
| `@arcanemachine/inter-agent-opencode` | 0.2.4 | 2026-10-14 | `@opencode-ai/plugin` ^1.19.0 | V1 | Client for a **separately managed `inter-agent-core` server** over loopback WebSocket + shared secret; `/inter-agent-*` palette commands; server tools `inter_agent_send/broadcast/list/status/read_messages`; requires OpenCode `>=1.18.15 <1.19.0`. |
| `@brutalsystems/tincan-opencode` | 2.5.0 | 2026-10-13 | — | unclear | "the receive half, so an opencode session can be messaged by a live Claude Code" — cross-tool, not opencode↔opencode. |

**Closest prior art for session-peers:**
1. `opencode-mesh` — the only published plugin already depending on `@opencode/plugin` **2.x**, i.e. the
   v2 API. Read its delivery/receipt design.
2. `opencode-collaboration` — the most mature messaging UX (discovery, gating, ACKs, permission mode),
   but still V1-protocol.
3. `opencode-cross-session-messaging` — the only one implementing a **blocking `ask_session`**
   request/response; its documented gaps (no deadlock detection, no auth, no shared history) are exactly
   the design decisions session-peers must make explicitly.

**What none of them appear to do:** use the v2 plugin context as the *only* transport (i.e. no file
spool, no external daemon, no HTTP to another process). A v2-native design would rely on
`ctx.session.prompt` + `ctx.event.subscribe` + `ctx.session.wait` inside one server process, and would need
an explicit answer to the multi-process case (several opencode instances → several servers), because
plugins cannot see sessions owned by a different server process.

---

## 11. Unverified / open questions

1. **Which `@opencode/plugin` copy a local `.ts` plugin actually imports at runtime.**
   `~/.config/opencode/node_modules/@opencode/plugin` (2.0.16) exists and is resolvable from
   `~/.config/opencode/plugins/*.ts`, but the binary also embeds its own bundled adapter modules
   (`@opencode/plugin/promise/*` appear in `strings`). Whether the binary injects a module alias for the
   non-`tui` entrypoint (it demonstrably does for `@opencode/plugin/tui` via
   `additional:{"@opencode/plugin/tui":{Plugin:rq,…}}`) was **not** determined. Practical impact is small
   because `define` is identity and the loader validates `{ id, setup | effect }`, but a plugin importing
   *runtime helpers* from the package could get a different version than the host.
2. **How a plugin obtains the server's HTTP `baseUrl`.** Not exposed in `Context`; `ctx.app` has only
   `{name, version, channel}`. A path to it exists (e.g. parsing the service/port file, or a caller-supplied
   option) but was not verified. An `OPENCODE_PORT`-style variable is referenced only by the third-party
   `opencode-relay` README, **not** found in the local binary's env-var list.
3. **`~/.local/share/opencode/service.json` was unreadable/empty** (`opencode service get` printed `{}`,
   the file was not shown by `cat`), so the running service's advertised URL could not be confirmed.
4. **`OPENCODE_SESSION_ID` semantics.** The binary sets `ae.env.OPENCODE_SESSION_ID=z.sessionID` — but in
   the *shell tool* subprocess env, not for plugin code. Whether the server process exposes its own session
   id to plugins was not verified.
5. **`session.wait` exact semantics.** Read from the binary as `SessionRunner.awaitIdle` ("wait for the
   session's runner drain"). Not tested at runtime; edge cases (already-idle vs. never-started, error
   propagation, timeouts) are unverified. There is no timeout parameter in `SessionWaitInput`.
6. **`durable` event replay.** Whether `ctx.event.subscribe()` can replay durable events from before the
   subscription (e.g. via a cursor) was not determined; the subscription API takes only
   `{ signal?, onActivity? }`.
7. **`opencode plugin list` does not show server plugins**, so there is no verified CLI for inspecting a
   loaded server plugin's version/revision at runtime. `ctx.plugin.list()` exists but its output shape
   (`PluginListOutput`) was not read.
8. **Multi-server / multi-process sessions.** All evidence indicates a plugin sees only its own server
   process's sessions. Not directly verified against a two-instance setup.
9. **The TUI `.ts`-file-vs-directory quirk** in
   `~/.config/opencode/tui-plugins/titlebar-spinner/tui.ts` (comment: v2.0.22 TUI loader skips local
   targets that resolve to an existing file) was **not** re-verified against 2.0.27, and the server loader in
   2.0.27 demonstrably *does* accept an absolute file path.
10. **`@@` `@opencode-ai/plugin` vs `@opencode/plugin`.** Many published plugins still depend on the V1
    package `@opencode-ai/plugin`; the docs' V1/V2 dual-support story (object-form `server()` supported
    from OpenCode `1.18.29`) explains why. Which of those actually work on 2.0.27 was not tested.

---

## 12. Minimal correct v2 plugin skeleton (synthesized from verified facts)

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "session-peers",

  async setup(ctx) {
    // 1. Maintain a session index from the event stream (no ctx.session.list exists).
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.created") { /* event.data.sessionID, title, location, parentID */ }
        if (event.type === "session.deleted") { /* drop */ }
      }
    })()

    // 2. Expose a tool. `execute` may block; pass context.signal into cancellable work.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "peers_send",
        description: "Send a message to another OpenCode session and optionally wait for a reply.",
        input: {
          type: "object",
          properties: {
            sessionID: { type: "string" },
            text: { type: "string" },
            wait: { type: "boolean" },
          },
          required: ["sessionID", "text"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const { sessionID, text, wait } = input as { sessionID: string; text: string; wait?: boolean }
          const before = await ctx.session.context({ sessionID })
          await ctx.session.prompt({ sessionID, text, delivery: "queue" })
          if (!wait) return { content: `delivered to ${sessionID}` }
          await ctx.session.wait({ sessionID })            // blocks until the target is idle
          const after = await ctx.session.context({ sessionID })
          // correlate new assistant messages: compare `after` against `before`
          return { content: JSON.stringify(after.slice(before.length)) }
        },
      })
    })

    // 3. Release resources on unload.
    return () => controller.abort()
  },
})
```

Pin `@opencode/plugin` to the exact version you target (here `2.0.16`); the installed host is
opencode `2.0.27`.
