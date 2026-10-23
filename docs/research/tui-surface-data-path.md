# The TUI surface: how a TUI plugin reaches a server plugin's state (opencode v2.0.29)

Research date: 2026-10-15 (host timezone +08:00; log timestamps are UTC).
Host binary: `/usr/bin/opencode` = **opencode v2.0.29** (211,064,288 bytes, md5
`6653617a3eb61ea49192fbd7325d4d3a`, mtime 2026-10-15 00:56 +0800).
Types: `@opencode/plugin` **2.0.16** (and its nested `@opencode/client` **2.0.16**) at
`~/.config/opencode/node_modules/`.

Question answered: **can a TUI-side plugin (the sidebar surface) obtain data that lives in a
server-side plugin's state, specifically the `session-peers` roster in the server plugin's
`ctx.storage` namespace — and by which mechanisms, at what cost?**

Method: the installed typings, targeted extraction from the 2.0.29 binary, the official docs, and
**three experiments in four isolated TUI runs** (own `XDG_*` dirs, own DB, own ports; a
throwaway server plugin registered an RPC whose output was the server's `ctx.storage` value, and a
throwaway TUI plugin called it from inside a real TUI run). Everything below is labelled
**[ran]** (executed and observed, output quoted) or **[inferred]** (read from
typings/binary/docs, not executed).

Related prior notes (not repeated here): `opencode-v2-plugin-api.md` (plugin context, RPC typings,
TUI entrypoint, storage domain), `plugin-instance-scoping.md` (per-location plugin instances;
storage shared per plugin id, durable, key format `plugin:<hex-utf16le(id)>:<key>`).

---

## 0. TL;DR — answers

| # | Question | Answer | Evidence |
| --- | --- | --- | --- |
| 1 | Does 2.0.16 typings + 2.0.29 binary support a server plugin RPC called by a TUI plugin? | **Yes.** Typed on both sides, implemented in the binary (`/api/rpc/:rpcID/:method`), and proven end-to-end: the TUI plugin received the server plugin's storage value. The docs' claim is **true for this pair**. | §1 `[ran]` |
| 2 | What does the TUI context have, and what can it render? | Context: `options, location, app, renderer, client, data, attention, theme, themeMode, markdown, keymap, storage, ui`. It renders through a **slot tree** (`sidebar.content` / `sidebar.footer` / `session.panel` / `prompt.footer…` / `home.footer…` / `session.composer.top` / `app`), full plugin pages via `ui.router`, dialogs, toasts, panels, tabs, keymap commands, markdown code-block renderers. **A sidebar element rendered on screen carrying server-plugin data** was captured. | §2 `[ran]` |
| 3 | Other supported paths to server-side plugin storage? | Only the **plugin's own RPC** is a supported read path. A second supported path is the **plugin's event stream** (push, live-only). Reading the **SQLite DB directly** is physically possible but undocumented (key format now confirmed on a live isolated DB). There is **no HTTP storage route** and no client API method for it. | §3 `[ran]`/`[inferred]` |
| 4 | Does the TUI context provide the TUI's own `directory`? | **Yes**: `context.location` (typed `LocationRef \| undefined`; at runtime `{directory, project:{id,directory,canonical}}`) and `data.location.default()` (`{directory}`). A sidebar gets its per-session scope from the slot input `sessionID` + `data.session.get(sessionID).location.directory`; `context.location` is the TUI process's own location and can differ from the open session's. | §4 `[ran]` |
| 5 | Cheapest mechanism for a live roster? | RPC warm cost **2–4 ms** (first call into a never-activated location: **122 ms**). Polling = 1 request/interval, staleness = interval, simplest. Event push = no per-event request on the TUI side, but live-only (no replay) so it needs an RPC snapshot first. Costs in §5. | §5 `[ran]` |

---

## 1. Q1 — server plugin RPC reachable from the TUI: yes on this pair

### 1.1 Typings (server side)

`~/.config/opencode/node_modules/@opencode/plugin/dist/promise/rpc.d.ts:5-22`:

```ts
export interface RpcCallContext<M extends Rpc.Method> {
    readonly signal: AbortSignal;
    readonly error: Rpc.ErrorFactory<M>;
}
export type RpcHandlers<D extends Rpc.PortableDefinition> = {
    readonly [Name in keyof D["methods"]]: (input: Rpc.Output<D["methods"][Name]["input"]>, context: RpcCallContext<D["methods"][Name]>) => Promise<...>;
};
export interface RpcRegistration<D extends Rpc.PortableDefinition> extends Registration {
    readonly events: { readonly emit: (...args: Rpc.EventInput<D>) => Promise<void>; };
}
export interface RpcDomain extends RpcApi<Pick<RpcCallOptions, "signal"> & { readonly location?: never; readonly headers?: never; }> {
    readonly register: <const D extends Rpc.PortableDefinition>(definition: D, handlers: RpcHandlers<NoInfer<D>>) => Promise<RpcRegistration<D>>;
}
```

`ctx.rpc` is on the plugin `Context` (`dist/promise/plugin.d.ts:44` → `readonly rpc: RpcDomain;`). The portable definition
shape (`id`, `methods[].input/output`, `events[].schema`) is in `@opencode/schema/dist/rpc.d.ts`
(`PortableDefinition`), and `Rpc.define` is a validator that only rejects error names starting
with `rpc.` (`@opencode/schema/dist/rpc.js`).

### 1.2 Typings (TUI/client side)

`@opencode/client/dist/promise/rpc.d.ts:7-31`: `RpcCallOptions { location? }`,
`RpcClient<D>` = one method per definition method **plus**
`events.subscribe(name)` / `events.on(name, handler)`, and
`RpcApi = <D extends Rpc.PortableDefinition>(definition: D) => RpcClient<D>`.

`@opencode/client/dist/promise/client.d.ts:6-9` — the `OpenCode.make()` client returns
`rpc: RpcApi<...> & { call: ... }`. `OpenCodeClient = ReturnType<typeof OpenCode.make>`
(`dist/promise/index.d.ts:13`), and the TUI `Context` carries
`readonly client: OpenCodeClient` (`@opencode/plugin/dist/tui/context.d.ts:449`).

The official docs state the intent verbatim
([RPC](https://opencode.ai/v2/docs/build/plugins/rpc/), "Call → Plugin"): *"Plugins already have an
OpenCode client. For example, a TUI plugin can create the same RPC subclient from
`context.client`"* — the example is `const acme = context.client.rpc(Acme)`.

### 1.3 The binary (2.0.29) — the call path

Offsets are byte offsets in `/usr/bin/opencode`.

* **HTTP route** — `rpc.call` → `POST /api/rpc/:rpcID/:method`, payload `{input}`, response
  `{output}`, tagged *"Call a plugin RPC"* / *"Dispatch a method to the currently registered RPC at
  the requested location."* (route text at ≈133,461,906; summary string at 133,462,081).
* **Server dispatch** (module text ≈141,012,950):

  ```js
  var Jy=Ca(ut,"server.rpc",(e)=>e.handle("rpc.call",({params:i,payload:r})=>a(function*(){
    yield*Eh;
    let l=yield*(yield*HT).call(i.rpcID,i.method,r.input);
    return l===void 0?{}:{output:l}
  }).pipe(M(...),Ms((u)=>ao("rpc call failed",{rpc:i.rpcID,method:i.method,defect:u})...)))));
  ```
* **The `@opencode/Rpc` service** — `class HT extends U()("@opencode/Rpc")` @140,345,325, with
  `Rpc.register` @140,345,785, `Rpc.emit` @140,346,060, `Rpc.call` @140,346,349. `Rpc.call(rpcID,
  method, input)`: no registration → `err("rpc.unavailable", \`RPC is unavailable: ${id}\`)`
  @140,346,429; unknown method → `rpc.method_not_found` / ``Unknown RPC method: ${id}.${method}``
  @140,346,665; input/output validated against the portable schema → `rpc.invalid_input` /
  `rpc.invalid_output` @140,347,114. Registrations live in a `Map` inside the service instance,
  and dispatch resolves that service **at the request's location**.
* **Client side** — `rpc.call` builds
  `` POST /api/rpc/${encodeURIComponent(e.rpcID)}/${encodeURIComponent(e.method)} `` with
  `query:{location:e.location}` and `body:{input:e.input}` @133,167,451; the definition-based
  `client.rpc(def)` factory (`Client.Rpc.event` @133,692,367) wraps it, maps errors to plain
  `{type, message, data?}` objects, and implements `events.subscribe(name)` as a **filter over the
  client's event stream** on `` `rpc.${id}.${name}` ``.
* **Tangent, but load-bearing:** the built-in `opencode.browser` plugin registers an RPC the same
  way — `yield*e.rpc.register(W$,{attach:...})` (module text ≈140,766,732) — so this is the API the
  host itself relies on.

### 1.4 Proof `[ran]` — the experiment

Throwaway server plugin (`/tmp/opencode/tui-rpc/plug/server.ts`), declared in the isolated
`opencode.json` as a **directory** target. It writes `probe/roster = {peers:["alpha","beta"]}` to
`ctx.storage` and registers one RPC method `roster` returning the storage value plus
`pid`/`location`. Throwaway TUI plugin (`/tmp/opencode/tui-rpc/plug-tui/tui.tsx`), declared in the
isolated `cli.json`, calls `context.client.rpc(definition).roster({})` from `setup`.

`/tmp/opencode/tui-rpc/server-plugin.log` (server process):

```
2026-10-15T13:37:44.725Z setup pid=24460 location={"directory":"/tmp/opencode/tui-rpc/projectA",...}
2026-10-15T13:37:44.725Z storage written
2026-10-15T13:37:44.725Z rpc registered
2026-10-15T13:37:46.974Z rpc roster called pid=24460 input={}
```

`/tmp/opencode/tui-rpc/tui-plugin.log` (TUI process):

```
2026-10-15T13:37:45.471Z setup pid=24451 cwd=/tmp/opencode/tui-rpc/projectA
2026-10-15T13:37:45.471Z context keys: options,location,app,renderer,client,data,attention,theme,themeMode,markdown,keymap,storage,ui
2026-10-15T13:37:45.471Z context.location: {"directory":"/tmp/opencode/tui-rpc/projectA","project":{"id":"a56f...","directory":"/tmp/opencode/tui-rpc/projectA","canonical":"/tmp/opencode/tui-rpc/projectA"}}
2026-10-15T13:37:45.471Z data.location.default(): {"directory":"/tmp/opencode/tui-rpc/projectA"}
2026-10-15T13:37:45.471Z typeof context.client: object; typeof context.client.rpc: function
2026-10-15T13:37:46.974Z t+1500 OK in 3ms: {"from":"server-plugin","pid":24460,"locDir":"/tmp/opencode/tui-rpc/projectA","storage":"{\"peers\":[\"alpha\",\"beta\"],\"at\":1792071464725}","at":1792071466974}
```

Different processes (TUI 24451, server 24460), different logs, and **the server's plugin storage
value arrived in the TUI plugin in 3 ms**. Two independent calls followed (2 ms each).

Error contract observed `[ran]`: while the server plugin was *not yet loaded*, the same call
returned `{"type":"rpc.unavailable","message":"RPC is unavailable: tui-probe"}` in 2–3 ms
(`tui-plugin.log`, first run) — i.e. failures surface as the typed plain objects documented by
`RpcClient` and handled in the local prior art (`opencode-code-plan-usage/src/tui/sidebar.tsx:219-225`).

### 1.5 Version-drift correction found while running this `[ran]`

In 2.0.29 a **file** target in the server config `plugins` array is rejected: the isolated server
log shows
`level=WARN message="configured plugin path must be a directory" target=/tmp/opencode/tui-rpc/plug/server.ts role=server`
(`/tmp/opencode/tui-rpc/xdg/data/opencode/log/opencode.log`, 13:36:23.831Z; the same string is in
the binary at 140,533,859). Pointing the config at the containing directory (which resolves
`<dir>/server.ts`) worked. This contradicts the 2.0.27-era claim in `opencode-v2-plugin-api.md`
(§3.2 last paragraph / §11.9) that the server loader accepts an absolute file path; the earlier
experiment there used *auto-discovery* (`<config>/plugins/*.ts`), not a config-array target, so the
two are not directly comparable. **Not re-tested for auto-discovered files in 2.0.29** (see §6).

**Answer to Q1: yes — the docs' claim holds for 2.0.16 typings + 2.0.29 binary, proven by
experiment.**

---

## 2. Q2 — what the TUI context is, and what it can render

### 2.1 The context

Runtime keys observed `[ran]` (run §1.4, same list in all runs):
`options, location, app, renderer, client, data, attention, theme, themeMode, markdown, keymap,
storage, ui`.

Declared interface — `@opencode/plugin/dist/tui/context.d.ts:444-460`:

| Member | Type | Notes |
| --- | --- | --- |
| `options` | `Readonly<Record<string, any>>` | from `cli.json` plugin entry |
| `location` | `LocationRef \| undefined` (d.ts:446) | TUI's own location — see §4 |
| `app` | `{version, channel}` (d.ts:232-235) | |
| `renderer` | `CliRenderer` (`@opentui/core`) | e.g. `setTerminalTitle` (live example: `~/.config/opencode/tui-plugins/titlebar-spinner/tui.ts:61`) |
| `client` | `OpenCodeClient` = `ReturnType<OpenCode.make>` | **full API client incl. `rpc(def)`** |
| `data` | `Data` (d.ts:33-111) | reactive TUI data layer |
| `attention` | `{notify(...)}` (d.ts:271-273) | desktop notification + sound |
| `theme`, `themeMode` | `ResolvedTheme`, `"dark"\|"light"` | |
| `markdown` | `{registerCodeBlockRenderer(language, renderer)}` (d.ts:454-456) | |
| `keymap` | `Keymap` (d.ts:375-395) | layers, commands, palette/slash, dispatch |
| `storage` | `Storage` (d.ts:6-22) | **TUI-local** durable (`store`) and in-memory (`memory`) solid stores — *not* the server's plugin storage |
| `ui` | `UI` (d.ts:396-443) | `dialog`, `toast`, `format.path`, `router`, `panel`, `tabs`, `slot` |

`context.data` (d.ts:33-111) is the TUI's own synchronized view: `session.list/get/root/family/
cost/status`, `session.pending.*`, `session.message.*`, `session.permission.*`, `session.form.*`
(reply/cancel included), `project.*`, `shell.*`, and per-location collections
(`data.location.default()`, `.vcs`, `.agent`, `.command`, `.integration`, `.mcp`, `.model`,
`.provider`, `.reference`, `.skill`). It is the same class of data the server plugin's RPC can
expose, but it has **no plugin-storage concept at all**.

### 2.2 What it can render

The host UI is a **slot tree** (`context.d.ts:150-178`):

```ts
export interface SlotMap {
    readonly app: Readonly<Record<string, never>>;
    readonly "home.footer": …; readonly "home.footer.status": …;
    readonly "prompt.footer": …; readonly "prompt.footer.status": …; readonly "prompt.footer.file": …;
    readonly "session.composer.top": { readonly sessionID: string };
    readonly "session.panel": PanelInput;
    readonly "sidebar.content": { readonly sessionID: string };
    readonly "sidebar.footer": { readonly sessionID: string };
}
```

A claim (`SlotClaim`, d.ts:199-231) targets one path with exactly one of
`prepend | append | before | after | replace`, and `ui.slot(claim)` returns a dispose function
(d.ts:441-442). The doc comment (d.ts:150-160) states paths are "documented API: coarse, few, and
kept stable across host refactors".

Beyond slots, `context.ui` also provides:

* **full views**: `ui.router.register(page: Page)` + `ui.router.navigate({type:"plugin", id, name, data})`
  (d.ts:112-131, 402-406) — plugin route `{type:"plugin", id, name, data?}`;
* **panels**: `ui.panel.open(name, {presentation:"panel"|"fullscreen"})` renders in the
  `session.panel` slot (`PanelInput` d.ts:137-149, `ui.panel` d.ts:407-419);
* **dialogs** (`ui.dialog.alert/confirm/prompt/select/show`, d.ts:311-322), **toasts**
  (d.ts:245-247), **tabs** (d.ts:420-440), **keymap commands** with palette and slash surfaces
  (`KeymapCommand` d.ts:323-349 — `palette: true`, `slash: {name, aliases, arguments}`), and
  markdown code-block renderers.

So: **not only commands and full views** — there is a real sidebar surface.

The binary implements the same machinery `[inferred]`: plugin loading/validation
(`Invalid V2 TUI plugin module:` @136,194,303), the slot provider
(`slots: {register, resolved}`, `_$(t)` slot mount with the error
`` Slot "${i}" is mounted inside "${...}" but its path does not extend it `` @136,195,734), and
`plugin reconciliation` runs at CLI startup (`role=cli`, @136,187,622). The `@opencode/plugin/tui`
module the plugin imports is provided by an import rewrite in the TUI:
`additional:{"@opencode/plugin/tui":{Plugin:Dq,PluginContextProvider:LB,usePlugin:Iq}}` @136,174,711.

### 2.3 Proof `[ran]` — the sidebar really renders, with server data

Run 3: an isolated server (`opencode serve --port 49711`, password in its log), one session created
over HTTP, then a real TUI (`opencode --server … --session ses_ec02f56f0ffeX6YBmgt4PudA7D`) inside a
220×50 pty (`script`, capture kept at `/tmp/opencode/tui-rpc/tui3.typescript`). The TUI plugin
registered `append: "sidebar.content"` and rendered the RPC result. The ANSI capture contains:

```
[5;179H  PEERS_PROBE_MARKER
[6;179H  roster: {"from":"server-plugin",
[7;179H  "pid":25515,"locDir":"/tmp/opencode/
[8;179H  tui-rpc/projectA","storage":"{\
[9;179H  "peers\":[\"alpha\",\"beta\"],\"at\":
[10;179H  1792072017910}","at":1792072018710}
```

(`[row;colH` = cursor position; column 179 = the sidebar region of the 220-column screen.) The
rendered text is the server plugin's `ctx.storage` value, produced in the server process
(pid 25515) and drawn in the TUI process (TUI plugin pid 25658,
`/tmp/opencode/tui-rpc/tui-plugin3.log`). This is the strongest form of the answer to the task's
central question.

---

### 2.4 Proof `[ran]` — the roster dialog: command registration and the TUI half's loading

Three isolated TUI runs (the appendix's recipe; plugin = this package, `a9f97d4` and the
review-fix branch) measured what a refactor may otherwise assume. Captures are ephemeral
(`/tmp/peers-repro/*.typescript`), the facts below are the durable part:

1. **`context.keymap.layer` called from `setup()` registers the command** — the `/peers`
   command showed up in the prompt's slash completion and opened its dialog. The typing's
   "owned by the calling component" does *not* mean setup-time registration fails on
   2.0.29; a report of "the command does not appear" on a setup-registered command is
   more likely the plugin not being loaded at all.
2. **A server-side declaration loads the package's TUI half beside it** — with
   `cli.json` `plugins: []`, the dialog still opened. The README's `cli.json`
   declaration is therefore redundant on 2.0.29 (harmless, and version-proof advice),
   not a requirement for the TUI half to load.
3. **The dialog is live**: `reading the roster…` swapped in place to the empty-cause
   line (`No peer in this scope loads the plugin.`) without reopening.

## 3. Q3 — every path from a TUI surface to server-side plugin state

Route inventory `[inferred]` (2.0.29 route table in the binary; the plugin-related groups):
`plugin.list` (`GET /api/plugin`), `plugin.check`, `plugin.update`, and
`rpc.call` (`POST /api/rpc/:rpcID/:method`). **There is no route that reads plugin storage**, and
the `@opencode/client` API surface has no storage member.

| Path | What it is | What it requires | Documented? | Verdict |
| --- | --- | --- | --- | --- |
| **A. Plugin RPC** | `client.rpc(def).method(input, {location, signal})` → `POST /api/rpc/:rpcID/:method` | The **server plugin must register** the RPC (definition id + schemas); the plugin must be loaded at the target location (a request into a not-yet-active location activates it first, see §5); server credentials if the server enforces auth (the TUI's own client carries them). | **Yes** — docs ("Call → Plugin"), typings both sides, two local prior arts (`opencode-code-plan-usage/src/tui/sidebar.tsx` + `src/server/index.ts`; present on this machine, currently commented out of the live config) | **The supported path.** `[ran]` 3 runs |
| **B. Plugin events** | Server `registration.events.emit(name, data)` → TUI `client.rpc(def).events.on/subscribe("name", …)` or `data.on("rpc.<id>.<name>", …)` | Same definition registered; subscriber must be connected **before** the event (live-only, no replay; docs: *"Event subscriptions are live only, so disconnected subscribers miss events"*). No extra request per event. | **Yes** — docs ("Subscribe"), typings (`RpcClient.events`), event union `V2EventRpc` (`types.d.ts:707-718`) | `[ran]` — see §5 |
| **C. Read the SQLite DB directly** | Open `$XDG_DATA_HOME/opencode/opencode.db` (or `~/.local/share/opencode/opencode.db`), table `kv`, keys `plugin:<hex-utf16le(plugin id)>:<key>` | Filesystem path of the data dir; a SQLite driver (Bun's `bun:sqlite` is in-process; Node 22+ `node:sqlite`); decode the surrogate key. No auth, no RPC. | **No** — internal schema; the key format was established by experiment in `plugin-instance-scoping.md` §4.2 and **re-confirmed here** `[ran]` on the isolated DB: `plugin:007400750069002d00700072006f00620065002d007300650072007600650072:probe/roster` → `{"peers":["alpha","beta"],"at":1792071584932}` (hex decodes to `tui-probe-server`), read read-only with `bun:sqlite` | Works, undocumented; couples the TUI to DB internals |
| **D. Any other HTTP route** | — | — | — | **None exists**: `plugin.*` returns metadata (id/version/source/status) only; `debug.location` lists/evicts locations; `integration`/`credential` are auth stores. `[inferred]` from the full route table + `@opencode/client/promise/api` surface |
| **E. TUI-side storage** | `context.storage.store()/memory()` | — | Yes (d.ts:6-22) | **TUI-local only** ("persisted to disk, survives hot reloads and TUI restarts, and stays live-synced across running TUI instances") — an independent namespace, not the server plugin's |

A note on C: the storage namespace is *shared across locations and durable*
(`plugin-instance-scoping.md` §4), so a DB read would see the same roster — but it bypasses the
plugin's own access logic, its schema validation, and any future key-format change. Nothing
prevents a TUI plugin from doing it (plugins are unsandboxed JS in the TUI process); nothing
documents or supports it.

---

## 4. Q4 — does the TUI context give the plugin its own `directory`?

**Yes, twice, plus per-session scope via the slot input.** `[ran]`

1. `context.location` — declared `readonly location: LocationRef | undefined`
   (`dist/tui/context.d.ts:446`), where
   `LocationRef = { directory: string; workspaceID?: string }`
   (`@opencode/client/dist/promise/generated/types.d.ts:271-274`).
   At runtime on 2.0.29 it is richer than the type: run 1/2 logged
   `{"directory":"/tmp/opencode/tui-rpc/projectA","project":{"id":"a56f…","directory":"…/projectA","canonical":"…/projectA"}}`
   (a structural superset — assignable to `LocationRef`).
2. `context.data.location.default()` — typed `LocationRef` (d.ts:91), at runtime exactly
   `{"directory":"/tmp/opencode/tui-rpc/projectA"}`.
3. **Per-session scope**: the sidebar slot input is `{ readonly sessionID: string }`
   (d.ts:172-177), and session records carry `location: LocationPublicRef` (`= {directory}`,
   `types.d.ts:2805`, `20-22`) — i.e. `data.session.get(sessionID)?.location?.directory` names the
   directory the sidebar entry belongs to.

Semantics matter here `[ran]`: **`context.location` is the TUI process's own location, not the open
session's.** In run 3 the TUI ran from `projectA` while the open session lived in
`/tmp/opencode/tui-rpc`; `context.location` was `projectA` (the RPC resolved there and returned
`locDir: ".../projectA"`), and the host's session footer showed the session's directory
(`/tmp/opencode/tui-rpc`). A sidebar that needs "the directory this entry is about" must use the
slot's `sessionID` → session record; a sidebar that needs "where this TUI is" uses
`context.location`.

For a null state, nothing is hidden: both values are always renderable (`LocationRef | undefined`
only means the type admits `undefined`; in all three runs it was set — see §6 for the untested
null case).

---

## 5. Q5 — cheapest mechanism for a live roster, and its costs

All numbers below are `[ran]` observations from `/tmp/opencode/tui-rpc/*.log`.

| Mechanism | Per-update cost | Latency | Failure/staleness profile |
| --- | --- | --- | --- |
| **A. RPC on render** | One `POST /api/rpc/:rpcID/:method` per call: **2–4 ms** warm (run 1: 3 ms, 2 ms, 2 ms; run 2: 4 ms, 2 ms, 2 ms); run 3: 11 ms. **122 ms** for the first call into a location that has never been activated (location services + plugin `setup` must run first; observed `setup … projectB` at 13:39:44.932 → response 13:39:44.980). | Round-trip only. | No push: a rendered value is a snapshot. Called from a reactive render without being wrapped in a resource/memo, it re-fires on every dependency change. |
| **B. Polling** | Same call cost × (1 / interval). 60 s interval ≈ 1,440 requests/day per TUI; each is a few ms of server CPU and no DB churn. | Staleness ≤ interval + round trip. | Simplest to implement; immune to missed events and to reconnect semantics; prior art: `opencode-code-plan-usage/src/tui/sidebar.tsx` — `POLL_MS = 60_000` plus an on-demand refresh (header click / palette command). |
| **C. Event push** | Server: one `emit` per change (the server log shows emits continuing every 3 s in the run-2 probe with what looked like no backpressure; events are filtered client-side — the client's `events.subscribe` filters the shared stream on `type === "rpc.<id>.<name>"`). TUI: no per-event request; delivery rides the already-open event stream. | Same-second: emit logged 13:39:38.142 → `client.events.on` logged **13:39:38.143** (~1 ms); the raw `data.on` variant logged 13:39:38.153 (~11 ms). | **Live-only**: no replay, so a TUI that starts later, reconnects, or hot-reloads a plugin must take a fresh RPC snapshot (the docs say so explicitly). |

Two implementation notes for whichever mechanism is chosen:

* **Pass an explicit `location`.** The route description is *"Dispatch a method to the currently
  registered RPC at the requested location"*, and the local prior art always passes
  `location: context.location ?? context.data.location.default()` with an `AbortSignal.timeout(...)`.
  The TUI can also omit it (server-side fallback to header/cwd per
  `plugin-instance-scoping.md` §1.5) — untested here (§6).
* **Dispatch is per location.** Run 2 registered the same definition at two locations (projectA,
  then projectB in the same server process, pid 24871), then called projectA *after* projectB had
  registered: the projectA call was answered by projectA's instance
  (`rpc roster called pid=24871 loc=…/projectA` at 13:39:54.861) — so the TUI reaches the handler
  belonging to the location it asks for; there is no "last writer wins" bleed. A roster kept in
  `ctx.storage` is shared across locations anyway
  (`plugin-instance-scoping.md` §4), so any loaded instance can answer.
* **Roster data itself needs a writer.** The event stream is global within a server process
  (run 2: the TUI received `rpc.tui-probe.tick` events from **both** locations — tags
  `…/projectA` and `…/projectB` interleaved), so N plugin instances may emit N streams; a single
  subscription sees all of them.

Cheapest *correct* live updates = **C with an initial A snapshot** (one call per TUI start, then
push). Cheapest to implement = **B** (one `setInterval`, no event bookkeeping). Both are within
milliseconds of server cost on this host.

---

## 6. Unverified / open questions

1. **`context.location === undefined`.** The type admits it, but all three runs had it set. When
   (if ever) it is `undefined` — e.g. uninitialised TUI, no project — is untested; the documented
   fallback is `data.location.default()`.
2. **Location omitted on an RPC call.** Docs/typings make `location` optional at the call site
   (`RpcCallOptions extends RequestOptions`); the server-side fallback chain
   (`?location[directory]` → `x-opencode-directory` → server cwd) is from prior research, not
   re-tested on 2.0.29.
3. **Concurrent DB read (path C).** The key format was read **after** the isolated server was
   killed; a live concurrent read against a running server was not attempted, and the developer's
   live 38 GB DB was deliberately never opened.
4. **Sidebar render frequency.** How often the host re-invokes a `sidebar.content` render (per
   session? per state change?) was not measured; only that a claim renders with live data.
5. **Event-stream reconnect behaviour.** "Live only, no replay" is documented and consistent with
   observations (a subscriber that starts later sees only later events — `plugin-instance-scoping.md`
   §3.1), but a forced TUI↔server reconnect was not exercised.
6. **`workspaceID` locations (git worktrees).** All test locations were plain directories;
   `LocationRef.workspaceID` never appeared. Whether `context.location`/session locations carry a
   workspace there is untested.
7. **2.0.29 server-plugin target rules.** Only a *config-array* target was tested; whether
   auto-discovered `<config>/plugins/*.ts` files (the path the earlier 2.0.27 experiment used) are
   still accepted by 2.0.29 was not re-tested. The TUI loader accepted a directory target in all
   runs; a TUI **file** target was not tested (a local note in
   `~/.config/opencode/tui-plugins/titlebar-spinner/tui.ts:6-9` claims v2.0.22 skipped file
   targets).
8. **`ui.router.register` / `ui.panel.open` at runtime.** Read from typings and the binary's slot
   machinery; only `ui.slot` was exercised on screen.
9. **Event `emit` backpressure/ordering.** Emits are fire-and-forget into the local bus in my
   probe; ordering/backpressure under load was not characterised (the 4096-event subscriber
   capacity error string exists in the binary — `EventFeed.SubscriberOverflow`,
   `Event subscriber exceeded its 4096-event capacity`).

---

## 7. Cleanup, disclosure, and artifacts

**Processes.** Four TUI runs (`--standalone`; the first had a config mistake — a file target — and still served as the failure-contract evidence) and one foreground `serve` were used, each under
isolated `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME` =
`/tmp/opencode/tui-rpc/xdg/…`; the `serve` instance bound `127.0.0.1:49711` with an
auto-generated password (printed in `/tmp/opencode/tui-rpc/server3.log`). All started processes
were stopped: `ss -ltn` shows port 49711 closed and only the developer's pre-existing service
(pid 10713, port 49374, started 20:09) and TUI (pid 10694) remain — same pids, untouched. The
developer's live service, state dir, and `service.json` were never read, signalled, or written; the
live 38 GB DB was never opened. One early command ran **without** isolation:
`opencode plugin list` (read-only listing of the live CLI plugins) and `opencode --help` /
`opencode --version`; none of them mutate anything.

**Scratch** (kept, ≈small): `/tmp/opencode/tui-rpc/` containing
`plug/server.ts`, `plug-tui/tui.ts` (run 2) and `plug-tui/tui.tsx` (run 3),
`xdg/…` (isolated config/data/state/cache incl. the isolated `opencode.db`),
`server-plugin.log`, `tui-plugin.log`, `tui-plugin3.log`,
`tui.typescript`, `tui2.typescript`, `tui3.typescript` (full pty captures),
`server3.log`, `session.json`/`session.id`, `script*.stdout`.

**Harness side effect:** truncated command outputs were saved by the OpenCode shell tool under
`~/.local/share/opencode/shell/global/sh_*.out` (normal harness behaviour, not part of this study).

**Repo:** this file is the only addition to
`/home/devcxl/Projects/OpenCodePlugins/opencode-session-peers`; `docs/research/README.md` was not
edited (it does not yet list this note).

## Appendix — how to re-run

```bash
# isolated instance (never touches the live service)
mkdir -p /tmp/opencode/tui-rpc/xdg/{config/opencode,data,state,cache} /tmp/opencode/tui-rpc/{plug,plug-tui,projectA}
# server plugin  -> xdg/config/opencode/opencode.json : { "plugins": ["/tmp/opencode/tui-rpc/plug"] }
# TUI plugin     -> xdg/config/opencode/cli.json      : { "plugins": ["/tmp/opencode/tui-rpc/plug-tui"] }
#   plug/server.ts   registers RPC id "tui-probe" (plain JSON Schemas), reads/writes ctx.storage
#   plug-tui/tui.tsx imports nothing but node:fs and uses context.client.rpc(definition)
cd /tmp/opencode/tui-rpc/projectA
XDG_CONFIG_HOME=/tmp/opencode/tui-rpc/xdg/config XDG_DATA_HOME=/tmp/opencode/tui-rpc/xdg/data \
XDG_STATE_HOME=/tmp/opencode/tui-rpc/xdg/state XDG_CACHE_HOME=/tmp/opencode/tui-rpc/xdg/cache \
  timeout --signal=TERM --kill-after=8 40 script -qec "/usr/bin/opencode --standalone" /tmp/opencode/tui-rpc/tui.typescript
cat /tmp/opencode/tui-rpc/tui-plugin.log /tmp/opencode/tui-rpc/server-plugin.log
```

Expected: the TUI plugin's log shows `typeof context.client.rpc: function` and an RPC result
containing the server plugin's `ctx.storage` JSON, produced by the server process's pid; the
server plugin's log shows `setup`/`rpc registered`/`rpc roster called` at the TUI's location.
