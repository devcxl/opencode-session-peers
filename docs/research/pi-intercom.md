# pi-intercom — Reimplementation Spec (facts only)

**Subject:** [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom) — "Inter-session communication extension for pi coding agent" (MIT, 535★, 98 forks as of 2026-10-14).
**Version read:** `v0.17.0`, tag commit `14731a4873b500e19d000bf131142e430e4b7928` (`chore(release): v0.17.0`, 2026-10-10). Cloned to `/tmp/opencode/pi-intercom` at that commit; default branch is `main` (`gh api repos/nicobailon/pi-intercom`).
**Method:** read the repo at that commit; all line references below are to files at that commit.

This document is descriptive. It does not propose a design for opencode.

---

## 1. Overview

### 1.1 What the package is

- An npm package named `pi-intercom`, version `0.17.0`, type `module`, main `index.ts` (`package.json:2-6`). It is a **pi package** for the pi coding agent: `package.json:37-44` declares
  ```json
  "pi": { "extensions": ["./index.ts"], "skills": ["./skills"] }
  ```
- A `bin` entry `pi-intercom` → `cli.mjs` (`package.json:7-9`), which is a 6-line tsx shim that imports `runMain` from `cli.ts` (`cli.mjs:1-6`).
- Peer dependencies on the host: `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox` (`package.json:45-50`). Runtime dependency: `tsx ^4.20.0` (`package.json:51-53`).
- The README calls it "Direct 1:1 messaging between pi sessions on the same machine" (`README.md:7`) and distinguishes it from `pi-messenger` ("a shared chat room for multi-agent swarms", `README.md:21`, table at `README.md:664-674`).

### 1.2 Architecture (components and control flow)

```
pi session (extension index.ts)                     pi session (extension index.ts)
   └─ IntercomClient (broker/client.ts)  ──IPC──►  IntercomBroker (broker/broker.ts)  ──IPC──►  IntercomClient
                                                     (single, auto-spawned process)
```

- **Broker** (`broker/broker.ts`, 1888 lines + classes): a standalone Node process that owns the session registry, routing, mailboxes, delivery records, asks, and extension-bus state. It is auto-spawned by the first client that needs it and exits 5 s after the last session disconnects (`broker/broker.ts:440-450`; README.md:631, 660).
- **Client** (`broker/client.ts`, class `IntercomClient extends EventEmitter`): used by the extension *and* by the CLI (`broker/client.ts:76`; `cli.ts:23,330`).
- **Extension entry** (`index.ts`, 3324 lines): registers tools/commands/shortcuts, manages inbound delivery into the host agent, handover generation, cross-machine relay, extension channels/outbox, UI overlays.
- **CLI** (`cli.ts`): a headless client that registers as a normal session (`cli.ts:10-11`, `cli.ts:143-154`).
- **Skill** (`skills/pi-intercom/SKILL.md`, 477 lines): model-facing usage documentation bundled with the package.

### 1.3 Host APIs this repo couples to (facts, for scope estimation)

The extension is written against the pi extension API (these are the only host integration points):

| Host facility | Used at |
|---|---|
| `defineTool` + `StringEnum` + `Type` (typebox) tool registration | `index.ts:1-4, 2191, 2463` |
| Lifecycle events `session_start`, `session_shutdown`, `turn_start`, `turn_end`, `agent_start`, `agent_end`, `tool_execution_start/end`, `tool_result`, `model_select` | `index.ts:2058-2174` |
| `pi.sendMessage(..., {deliverAs:"steer"})` — inject a custom message, optionally as a steering message | `index.ts:1298-1306` |
| `pi.sendUserMessage(text, {deliverAs:"steer"})` — idle wake prompt | `index.ts:1312` |
| `pi.appendEntry(customType, data)` — append a history entry | `index.ts:1543, 1826, 2309, 2395, 2857, 3285` |
| `pi.registerCommand`, `pi.registerShortcut`, `pi.registerMessageRenderer` | `index.ts:2168, 3295-3322` |
| `pi.events.on/emit` — in-process extension event bus | `index.ts:2028-2057` |
| `ctx.ui.custom/confirm/input/editor/notify`, `ctx.hasUI`, `ctx.isIdle()`, `ctx.hasPendingMessages()`, `ctx.cwd`, `ctx.model`, `ctx.modelRegistry.complete`, `ctx.sessionManager.*`, `ctx.getContextUsage()` | `index.ts:2969-3293`, `handover.ts:38-77` |
| `buildSessionContext`, `convertToLlm`, `serializeConversation`, `BorderedLoader`, `Theme`, `KeybindingsManager` (pi-tui) | `handover.ts:4-9`, `ui/*.ts` |

---

## 2. User-visible behavior

### 2.1 Human surfaces (TUI)

| Surface | Trigger | Behavior |
|---|---|---|
| Session list overlay | `Alt+M` or `/intercom` | Shows "Current session" + "Other sessions" picker; ↑/↓ navigate, Enter = compose a message, `h` = hand over to highlighted session, Escape = close (`index.ts:3295-3298, 3320-3323`; `ui/session-list.ts:86-113, 122, 130-179`) |
| Compose overlay | after selecting a session | Free-text single-line-ish input; Enter sends via `client.send(target.id, {text})`, Escape closes; shows delivery errors inline (`ui/compose.ts:45-103`; `index.ts:3279-3282`) |
| Message renderer | inbound/outbound transcript rows | `customType: "intercom_message"`; framed box "From: <name> (<cwd>)", body, "To reply: …", attachment names, "Via extension: …", collapsed preview with `Ctrl+O expands` (`index.ts:2168-2172`; `ui/inline-message.ts:37-124`) |
| Handover picker | `/handover` with no args, or `h` in session list | Lists peers (most recent first), `+ New session in a project path…`, `Fetch sessions from other machines` (SSH, on demand); Tab between list and next-task field (`index.ts:3095-3167`; README.md:263) |
| `/alias <name>` / `/alias menu` | command | Sets the **Pi session name** (`pi.setSessionName`), which is also the intercom display name; pushes presence immediately (`index.ts:2999-3050`) |
| `/intercom-id` | command | Inserts the snippet `Use pi-intercom: intercom({ action: "send", to: "<sessionId>", message: "..." })` into the editor (`index.ts:2978-2997`; `index.ts:583-585`) |
| `/intercom-pool [name|default]` | command | Shows/switches the broker routing scope pool by reconnecting (`index.ts:3052-3093`) |
| `/handover <target\|path> [next task]` | command | Generates a model-written handover, opens it in an editor for review, then sends (`index.ts:3095-3219`) |

### 2.2 Naming / addressing visible to users

- Session name = `pi.getSessionName()` if set, else a runtime-only fallback alias `subagent-chat-<first 18 chars of session id>` with `runtimeFallbackAlias: true` (`index.ts:549-563`).
- The intercom **session ID** is, in priority order: a value claimed by an in-process extension via the `intercom:session-identity` event, else `$PI_INTERCOM_STABLE_ID`, else `config.stableId`, else the pi session id (`index.ts:1928-1937, 564-566`; `extension-api.ts:9-20`).
- Listing rows are formatted as:
  `• <name> (<id-prefix>) — <cwd> (<model> · <ctx%> · tmux <pane>) · <Herdr location> [<tags>]`
  where tags are `self`, `same cwd`, and status (`index.ts:601-609`). The displayed id is a shortest-unique prefix, minimum 8 chars (`index.ts:479-499`).
- Status is derived from lifecycle events: `idle` | `thinking` | `tool:<name>`, optionally suffixed with `config.status` (`index.ts:873-877`).

### 2.3 Message reception behavior

- Incoming broker messages are deduped per `(fromId, messageId)` with a 1-hour / 1000-entry LRU (`index.ts:48-49, 714-731`).
- The receiver emits receipts in order: `receiver_received` on accept, `acknowledged` on accept/dedup/answered, `injected` when handed to the host, plus `queued` when held, and terminal `cancelled` / `superseded` / `expired` (`index.ts:1371-1412, 689-713, 744-755, 1314`).
- Body given to the model: `**From <name>** (<cwd>)` + reply instruction + `_<delivery metadata>_` + body (+ formatted attachments) (`index.ts:1301, 1295-1296, 630-644, 187-197`).
- Reply hint (config `replyHint`, default true): for an `expectsReply` message → `intercom({ action: "reply", message: "..." })`; for cross-machine → a `send` to `name@machine` (`index.ts:1399-1403`).
- **Idle recipient** → message injected and a turn triggered (default `inboundTrigger: "always"`); the extension also sends the wake prompt `"New intercom message above."` when the host skips `before_agent_start` for triggered custom messages (`index.ts:1298-1313`; comment at `index.ts:1307-1308`).
- **Busy interactive recipient** → injected as a steering message (`deliverAs: "steer"`), i.e. delivered at the next safe model boundary without aborting the run (`index.ts:1322-1344`; README.md:146).
- **Busy non-UI recipient** → no injection; if the message is not a reply, the extension auto-sends back a text saying the agent is running non-interactively and cannot respond (`index.ts:1323-1339`).
- `busyDelivery: "human-first"` → held inbound messages wait outside host queues; one FIFO peer is released per assistant turn when no human message is pending, or at idle (`index.ts:1345-1370, 2092-2104`; README.md:146, 465).
- `inboundTrigger: "replies"` only triggers on messages with `replyTo`; `"never"` never triggers; a config parse error fails closed to `"never"` (`index.ts:1270-1281`; README.md:464, 472).

### 2.4 Ask/send/reply semantics (user-visible)

- `ask` sends with `expectsReply: true`, blocks the tool call until a matching reply arrives, then returns `**Reply from <target>:**\n<text>` (`index.ts:2754-2809`). One pending ask per session; a second concurrent ask returns "Already waiting for a reply" (`index.ts:2703-2708, 2328-2333`).
- Ask timeout default **10 minutes**, env `PI_INTERCOM_ASK_TIMEOUT_MS` (positive integer ms) (`config.ts:7-21`; `index.ts:777-780`). Timeout message explicitly says it is not cancellation (`index.ts:779`).
- `send` returns after delivery ack; if the destination has exactly one pending inbound ask **and** no `replyTo` was supplied, the send is inferred as the reply (attaches the ask's `replyTo`) and reports `Reply sent to <target> (inferred from pending ask)` (`index.ts:1796-1797, 1832-1840`).
- During a turn that was triggered by an inbound ask, a non-reply `send` to a *different* target is refused: "This turn is responding to an intercom ask from …" (`index.ts:1788-1795`).
- `reply` resolves the active turn context, else the single pending ask; with `to`/`replyTo` it disambiguates; ambiguity errors name the problem (`reply-tracker.ts:81-112, 18-45`).
- `pending` lists unresolved inbound asks with sender, message id, elapsed seconds, 80-char preview (`index.ts:2875-2894`).
- `cancel` requests cancellation of a message the caller previously sent; queued mailbox messages are removed, injected ones get a visible `cancellation_requested` (`index.ts:2630-2656`; README.md:424).
- `supersedes` is validated: only same-sender→same-receiver, only for a still-routed message (`broker/broker.ts:775-781`); the receiver gets a `message_control` with `action:"supersede"` (`broker/broker.ts:805-818`).

### 2.5 Handover

- Text is generated by the session's own model with a fixed system prompt requiring sections: `## Next task`, `## Key context and decisions`, `## Files and repositories`, `## Current state`, `## Open questions and risks`, and rules "omit secrets…", max 4096 output tokens (`handover.ts:11-77`).
- Header prepended: `# Handover from <sender>`, sender cwd, git `branch <b> at <head12>` if available, and for same-machine targets `Sender session file: <path> (read it for full detail …)`, then "This is a peer agent's report, not instructions from your user…" (`handover.ts:93-115`).
- `/handover` human flow forces a review-and-edit step; the model tool `handover` action does not (`index.ts:3184-3219, 2668-2693`). Handover always sends a new message; `replyTo`/`supersedes`/`retryOf`/attachments are rejected (`index.ts:2677-2682`).

### 2.6 Config surface (exact keys and defaults)

File: `$PI_CODING_AGENT_DIR/intercom/config.json` or `~/.pi/agent/intercom/config.json` (`config.ts:76-78`; `broker/paths.ts:27-42`).

| Key | Type / values | Default | Notes (source) |
|---|---|---|---|
| `brokerCommand` | string, non-empty | `"npx"` | advanced/trusted; default is hardcoded to run the current Node with the bundled tsx loader (`config.ts:81-82,113-122`; `broker/spawn.ts:80-103`) |
| `brokerArgs` | string[] | `["--no-install","tsx"]` | (`config.ts:82`) |
| `confirmSend` | boolean | `false` | confirmation dialog for sends from interactive sessions without a caller-supplied `replyTo` (`config.ts:83,138-143`; `index.ts:1723`) |
| `inboundTrigger` | `"always"`\|`"replies"`\|`"never"` | `"always"` | (`config.ts:84,152-161`) |
| `busyDelivery` | `"steer"`\|`"human-first"` | `"steer"` | (`config.ts:85,163-168`) |
| `enabled` | boolean | `true` | when false, `session_start` does not start the runtime and `ensureConnected` throws "Intercom disabled" (`config.ts:86,145-150`; `index.ts:2058-2063, 1551-1553`) |
| `replyHint` | boolean | `true` | (`config.ts:87,170-175`) |
| `status` | string | unset | appended after lifecycle status (`config.ts:88,177-183`) |
| `stableId` | non-empty string | unset | machine-global, so only one session per machine can use it (README.md:641) |
| `crossMachine.machineName` | non-empty string | lowercased short hostname | (`config.ts:88-91,201-206`; `cross-machine-envelope.ts:34-36`) |
| `crossMachine.remoteCommand` | non-empty string | `"pi-intercom"` | command run over SSH (`config.ts:90,207-212`) |

Other environment variables: `PI_INTERCOM_SCOPE_ID` (broker routing pool, trimmed, empty = unscoped, `config.ts:8,23-32`), `PI_INTERCOM_STABLE_ID`, `PI_INTERCOM_SESSION_ID` (published for children, `index.ts:53-54,1038-1047`), `PI_INTERCOM_ASK_TIMEOUT_MS`, `PI_INTERCOM_TCP` / `PI_INTERCOM_TRANSPORT=tcp` (Windows TCP escape hatch, `broker/paths.ts:44-59`), `PI_INTERCOM_RECEIPT_TIMEOUT_MS` (broker start, `broker/broker.ts:49`), `PI_INTERCOM_LIVENESS_INTERVAL_MS` / `_TIMEOUT_MS` (client, `broker/client.ts:45-53`), `PI_INTERCOM_LIVENESS_SWEEP_MS` (broker, `broker/broker.ts:52`), `PI_INTERCOM_NAME_POLL_MS` (default 1000, `index.ts:55,645-654`), `PI_CODING_AGENT_DIR` (`broker/paths.ts:32-38`), `HERDR_BIN_PATH` (`index.ts:3140`).

---

## 3. Tool surface (exact schemas)

Two model-facing tools are registered. `contact_supervisor` is conditional.

### 3.1 `intercom` — always registered

Registration: `index.ts:2463-2967`. Schema built with typebox `Type.Object` (`index.ts:2489-2526`). Exact fields:

```
action:            StringEnum("list" | "list-cwd" | "send" | "ask" | "handover" | "reply" | "pending" | "status" | "cancel")   // required
to:                Type.Optional(Type.String())
message:           Type.Optional(Type.String())
attachments:       Type.Optional(Type.Array(Type.Object({
                     type:     StringEnum("file" | "snippet" | "context"),   // required
                     name:     Type.String(),                                // required
                     content:  Type.String(),                                // required
                     language: Type.Optional(Type.String()),
                   })))
replyTo:           Type.Optional(Type.String())
messageId:         Type.Optional(Type.String())
supersedes:        Type.Optional(Type.String())
retryOf:           Type.Optional(Type.String())
cwd:               Type.Optional(Type.String())
openProjectPaneIfMissing: Type.Optional(Type.Boolean())
focus:             Type.Optional(Type.Boolean())
```

Parameter descriptions, verbatim (`index.ts:2490-2525`):

- `action`: `"Action: 'list', 'list-cwd', 'send', 'ask', 'handover', 'reply', 'pending', 'status', or 'cancel'. 'handover' summarizes this session with the current model and sends it to the target, which acts on it; 'message' is the optional next task."`
- `to`: `"Target session: name, full session ID, or the short id shown in parentheses by 'list' (a leading ID prefix resolves). For send/ask/handover with cwd, omit to target the sole live session in that cwd or the newly opened project-pane session. For 'reply', disambiguates the pending ask."`
- `message`: `"Message to send (for 'send', 'ask', or 'reply' action). For 'handover', the optional next task for the receiver."`
- `replyTo`: `"Message ID to reply to (for threading or responding to an 'ask')"`
- `messageId`: `"Message ID for actions that operate on an existing message, such as 'cancel'."`
- `supersedes`: `"Previous message ID this send/ask explicitly supersedes. Only works for the same sender and receiver."`
- `retryOf`: `"Previous message ID this send/ask is a user-authored retry of. Retries always send a new message ID."`
- `cwd`: `"Working directory filter for 'list-cwd'. For send/ask/handover, scopes target lookup to that directory; omit 'to' to target the sole live peer there. Absolute, or relative to the current session's cwd; '.' means the current cwd."`
- `openProjectPaneIfMissing`: `"For send/ask/handover with cwd, open a visible Herdr project pane and launch Pi there when no matching live session is connected."`
- `focus`: `"For openProjectPaneIfMissing, focus the new Herdr pane. Defaults to true."`

Tool-level `description` (`index.ts:2466-2485`) begins "Send a message to another pi session running on this machine. …" and includes a usage block listing each action. `promptSnippet`: `"Use to coordinate with other local pi sessions: list peers, send updates, ask for help, or check intercom connectivity."` (`index.ts:2486-2487`).

Per-action behavior and exact result text (all in `execute`, `index.ts:2528-2921`):

| action | Validation / behavior | Tool text result | `details` |
|---|---|---|---|
| `list` | `client.listSessions()`; splits self vs others | `**Current session:**\n<row>\n\n**Other sessions:**\n<rows>` or `No other sessions connected.` | `{ roster: { peers, total } }` (`:2544-2574`) |
| `list-cwd` | filter to `sameCwd(session.cwd, filterCwd)`; `cwd` resolved against session cwd, `.` = current | `**Other sessions (cwd: <dir>):**` + rows, or `No other sessions in this directory.` plus a hint if own cwd has peers | `{ roster: { peers, total, cwd } }` (`:2576-2628`) |
| `cancel` | requires `messageId`; `client.cancelMessage` | `Cancellation requested for <id>` / `Cancellation for <id> was not delivered: <reason>` (details `delivered:false`) | `{messageId, delivered}` (`:2630-2656`) |
| `send` | requires `to` or `cwd`, plus `message`; delegates to `deliverMessage` | `Message sent to <target>` or `Reply sent to <target> (inferred from pending ask)` or `Opened Herdr project pane <id> for <root> and sent message to <target>` | `{messageId, delivered, delivery, retryable, outcomeKnown, code?, reason?, replyTo?, openedProjectPane?, paneId?, projectRoot?}` (`:2658-2668, 1835-1847`) |
| `ask` | requires `to`/`cwd` + `message`; one waiter at a time; target must be connected | `**Reply from <target>:**\n<text>` (+ attachments appended) | `{}` or `{openedProjectPane…}` (`:2695-2809`) |
| `handover` | requires `to`/`cwd`; rejects `replyTo`/`supersedes`/`retryOf`/attachments; generates summary | same as `send` | same as `send` (`:2668-2693`) |
| `reply` | requires `message`; resolves via ReplyTracker | `Reply sent to <target>` | `{…deliveryDetails, replyTo}` (`:2826-2873`) |
| `pending` | `replyTracker.listPending()` | `- <name> · <messageId> · <n>s ago · <preview80>` per line, or `No unresolved inbound asks.` | `{}` (`:2875-2894`) |
| `status` | `listSessions` count | `**Intercom status:**\nConnected: Yes\nSession ID: <id>[\nPool: <pool>]\nActive sessions: <n>` | `{}` (`:2896-2914`) |

Notes / discrepancies:

- `attachments` are accepted on `send`, `ask`, and `reply` only; `deliverMessage` passes them to `client.send` (`index.ts:1813-1819`).
- **The tool's `messageId` parameter is only consumed by `action:"cancel"`** (`index.ts:2541, 2631-2638`). `ask` generates its own `randomUUID()` question id (`index.ts:2760`), and `send` never passes `messageId` (`index.ts:2665-2667` → `DeliveryRequest` has no such field, `index.ts:84-96`). The README claims "Optional explicit message ID for send/ask, or required message ID for cancel" (`README.md:387`) — that does not match this revision's code.
- The intercom tool is registered unconditionally; when `enabled:false` every action that needs the client fails with `Intercom not connected: Intercom disabled` (`index.ts:1551-1553, 2529-2537`).
- Tool results that should be marked as errors: a `tool_result` hook marks the result as error when `details.error === true` or `details.delivered === false` (`index.ts:2174-2186`).

### 3.2 `contact_supervisor` — conditional, subagent-only

Registration condition (`index.ts:2188-2191`):

```
childOrchestratorMetadata != null  AND  process.env.PI_SUBAGENT_SUPERVISOR_CHANNEL_DIR is absent/blank
```

`childOrchestratorMetadata` is read from env (`index.ts:198-217`): requires `PI_SUBAGENT_ORCHESTRATOR_TARGET`, `PI_SUBAGENT_RUN_ID`, `PI_SUBAGENT_CHILD_AGENT`, `PI_SUBAGENT_CHILD_INDEX`; optional `PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` / `PI_INTERCOM_SESSION_ID` and `PI_SUBAGENT_INTERCOM_SESSION_NAME` (`index.ts:51-60,198-217`). Env var names are constants at `index.ts:51-60`.

Schema (`index.ts:2202-2222`):

```
reason:    StringEnum("need_decision" | "progress_update" | "interview_request")   // required
message:   Type.Optional(Type.String())
interview: Type.Optional(Type.Object({
             title:       Type.Optional(Type.String()),
             description: Type.Optional(Type.String()),
             questions:   Type.Array(Type.Object({
               id:       Type.String(),                                                   // required
               type:     StringEnum("single"|"multi"|"text"|"image"|"info"),               // required
               question: Type.String(),                                                   // required
               options:  Type.Optional(Type.Array(Type.Any())),
               context:  Type.Optional(Type.String()),
             })),                                                                          // required array
           }))
```

`description` (verbatim, `index.ts:2194`): "Subagent-only tool for contacting the supervisor agent that delegated this task. Use need_decision when blocked, uncertain, needing approval, or facing a product/API/scope decision before continuing; this waits for the supervisor's reply. Use interview_request when multiple structured questions need supervisor answers; this also waits for a reply. Use progress_update only for meaningful progress or unexpected discoveries that change the plan. Do not use for routine completion handoffs."

Behavior:

- `progress_update`: validates `message` is a string, sends formatted text (`Subagent progress update.` + `Run: …`, `Agent: …`, `Child index: …`, optional `Child intercom target: …`, blank line, message — `index.ts:218-233`), returns `Progress update sent to supervisor <target>`.
- `need_decision` / `interview_request`: creates a `randomUUID()` question id, registers a reply waiter, sends with `expectsReply: true`, and blocks; the result is `**Reply from supervisor:**\n<text>` (`index.ts:2335-2409`).
- Interview request rendering is a deterministic markdown list with `[id] (type) question`, optional `Context:` and `Options:`, then a `Supervisor reply instructions` block containing a concrete JSON example `{ "responses": [{ "id": …, "value": … }] }` (`index.ts:344-388`).
- Interview validation rejects: non-object, empty/absent `questions`, blank/duplicate ids, invalid `type`, blank `question`, non-string `context`, `options` not an array, empty option labels, and `options` on non-`single`/`multi` types; `single`/`multi` require non-empty `options` (`index.ts:235-325`).
- Structured reply parsing accepts plain JSON or a fenced ```` ```json ```` block; it validates that each response id matches a non-`info` question, has no duplicates, that `value` matches the option label set for `single`/`multi` (array of strings for `multi`), and that `value` is a string otherwise; success → `details.structuredReply`, failure → `details.structuredReplyParseError` (`index.ts:390-470, 2394-2408`).
- If the supervisor is not connected, a blocking reason fails with "Supervisor "<target>" is not currently connected. Blocking requests are not queued; use a progress update or retry after the supervisor reconnects." (`index.ts:2277-2282`). The target is resolved by id first, then by name (`index.ts:1635-1643`).
- `renderResult` shows `Waiting for supervisor...` while partial and marks `✗` on error (`index.ts:2441-2458`).

### 3.3 Non-model programmatic surfaces (part of the extension contract)

(I) **Extension outbox** — same-process extensions ask the session to send a user-visible message with consent:

- `pi.events.emit("intercom:outbox-request", { version: 1, requestId, extensionId, extensionName, to, message })`; result event `intercom:outbox-result` with `{ version:1, requestId, status: "sent"|"rejected"|"blocked"|"failed", code?, extensionId?, extensionName?, messageId?, detail? }` (`extension-api.ts:3-6,22-58`).
- Error codes: `user_cancelled | confirmation_unavailable | session_unavailable | session_ended | invalid_request | duplicate_request | target_not_found | target_ambiguous | self_target | delivery_failed` (`extension-api.ts:24-34`).
- Duplicate `requestId` in one runtime is rejected; with `confirmSend` and no UI the request is `blocked` (`confirmation_unavailable`); otherwise a confirm dialog names extension, id, target, and message (`index.ts:1154-1158, 1169-1172, 1209-1228`).
- Delivered messages carry `provenance: { type:"extension_outbox", extensionId, extensionName, requestId }` (`index.ts:1235-1244`), rendered as "Via extension: <name>" (`ui/inline-message.ts:116-119`). Provenance is not put in the body text (README.md:558).

(II) **Extension channels / bus** — namespace-scoped pub/sub plus owner election and revisioned state:

- Feature strings: `extension-bus-v1`, `exact-send-v1` (`types.ts:1-2`), advertised by the broker on `registered` (`broker/broker.ts:588-592`).
- Message sizes: `MAX_EXTENSION_MESSAGE_BYTES = 16 KiB`, `MAX_EXTENSION_STATE_BYTES = 64 KiB`, `MAX_EXTENSIONS_PER_SESSION = 32` (`broker/broker.ts:39-41`); namespace regex `^[a-z0-9][a-z0-9._/-]{0,63}$` (`broker/broker.ts:1499-1501`; mirrored in `index.ts:942`).
- Client-side channel API: `snapshot()`, `publish(payload, {audience:"owner"|"capable", ownerOnly})`, `commitState(payload, expectedRevision)`, `listSessions()` (`extension-api.ts:80-98`; `index.ts:885-934`).
- State is compare-and-swap on `expectedRevision`, persisted per namespace with a backup file (`broker/extension-state.ts:110-192`).

---

## 4. Transport & discovery mechanism

### 4.1 Local IPC

- **One broker per machine per agent dir.** Listen target on POSIX: `<intercomDir>/broker.sock` (Unix domain socket); on Windows: named pipe `\\.\pipe\pi-intercom-<sanitized-agent-dir>` (`broker/paths.ts:65-74`).
- **Windows TCP escape hatch** (only when `PI_INTERCOM_TRANSPORT=tcp` or legacy `PI_INTERCOM_TCP=1|true`): broker binds `127.0.0.1:0` and writes `broker.port.json` containing `{transport:"tcp", host:"127.0.0.1", port, stateId}` where `stateId` is a broker-boot `randomUUID()`; clients must present that `stateId` before `health` and `register` succeed (`broker/paths.ts:81-105, 7-9,11-16`; `broker/broker.ts:32,463-484`).
- **Wire format:** 4-byte big-endian length + UTF-8 JSON payload; a single frame is capped at **1 MiB** (`MAX_FRAME_BYTES = 1024*1024`), exceeding it destroys the connection (`broker/framing.ts:3,9-16,68-71`). Frame reassembly handles partial reads (`broker/framing.ts:23-115`).
- Protocol name/version: `"pi-intercom"`, version `1` (`broker/paths.ts:8-9`).
- **Health handshake:** `{type:"health", requestId, stateId?}` → `{type:"health_ok", requestId, protocol:"pi-intercom", version:1}`; used by the spawner to detect a live broker with a 1 s timeout (`broker/spawn.ts:69-78,226-272`; `broker/broker.ts:466-480`).
- Per-connection rate limit: token bucket capacity 240, refill 120 tokens/s; exceeded → `{type:"error", error:"Intercom broker rate limit exceeded"}` then destroy (`broker/broker.ts:36-37,424-438,366-371`).
- Registration window: an unregistered socket is destroyed after `REGISTRATION_TIMEOUT_MS = 1000` ms; at most `MAX_UNREGISTERED_CONNECTIONS = 32` such sockets, oldest evicted (`broker/broker.ts:35,338-359,410-422`).

### 4.2 Message protocol (exact shapes)

Client→broker (`types.ts:152-176`):

```
{ type:"register", session: SessionRegistration, sessionId?, stateId?, scopeId? }
{ type:"unregister" }
{ type:"extension_capabilities_update", extensions: ExtensionCapability[] }
{ type:"list", requestId }
{ type:"send", to: string, message: Message, targetId?: string, targetEpoch?: string }
{ type:"message_receipt", receipt: MessageReceipt }
{ type:"cancel_message", messageId }
{ type:"cancel_ask", messageId }
{ type:"presence", name?, runtimeFallbackAlias?, status?, model?,
  contextPct?: number|null, contextTokens?: number|null, contextWindow?: number|null }
{ type:"extension_publish", namespace, audience:"owner"|"capable", ownerEpoch?, ownerOnly?, payload }
{ type:"extension_state_commit", namespace, ownerEpoch, expectedRevision, payload }
{ type:"health", requestId, stateId? }        // added by broker handler, not in the union
```

Broker→client (`types.ts:178-211`): `registered`, `sessions`, `message`, `presence_update`, `session_joined`, `session_left`, `error`, `delivered`, `delivery_failed`, `message_receipt`, `message_control`, `extension_owner`, `extension_message`, `extension_state`, `extension_state_result`, plus `health_ok` (broker-only).

`Message` (`types.ts:84-102`):

```
{ id: string, timestamp: number,
  senderSequence?: number, brokerReceivedAt?, brokerDeliveredAt?, receiverReceivedAt?, injectedAt?: number,
  supersedes?: string, retryOf?: string, replyTo?: string, expectsReply?: boolean,
  provenance?: { type:"extension_outbox", extensionId, extensionName, requestId },
  crossMachine?: { type:"ssh-relay", version:1, origin:{name,sessionId,machine}, trust:"ssh-asserted" },
  content: { text: string, attachments?: [{ type:"file"|"snippet"|"context", name, content, language? }] } }
```

`SessionRegistration` / `SessionInfo` (`types.ts:32-67,142-150`): `cwd`, `model`, `pid`, `startedAt`, `lastActivity` required; optional `name`, `runtimeFallbackAlias`, `status`, `tmuxPane`, `herdrPaneId`, and registration-only `extensions`, `herdrSessionPath`, `acknowledgesReceipts`, `livenessIntervalMs`. Broker adds `id`, `endpointEpoch` (fresh `randomUUID()` per registration, `broker/broker.ts:548-562`), `trustedLocal`, and on `list` responses `herdrLocation`.

Delivery result (`types.ts:6-13`, used inside `delivered`/`delivery_failed`): `delivery: "socket_delivered"|"queued"|"failed"|"unknown"`, `code?`, `retryable: boolean`, `outcomeKnown: boolean`.

### 4.3 Session discovery / peer addressing

- Peers discover each other **only** through the broker's `list` request → `sessions` response; there is no file-based registry, no mDNS, no scanning (`broker/broker.ts:676-709`; README.md:670). The `list` handler filters to the requester's `scopeId` and resolves Herdr location from one live `herdr api snapshot` (3 s timeout), falling back to `unavailable`/`not_hosted` markers (`broker/broker.ts:685-707`; `herdr-location.ts:36-60`).
- Broker-side target resolution order (`broker/broker.ts:1415-1430`): exact session id (`scopedSessionKey`) → case-insensitive exact `name` (all matches) → id **prefix** (`id.startsWith(to)`). 0 matches → `E_TARGET_NOT_FOUND`; >1 → `E_AMBIGUOUS_TARGET` with "Use the session ID instead." (`broker/broker.ts:829-832, 886`).
- Client-side pre-resolution for the *exact send* feature repeats the same order and then sends `targetId` + `targetEpoch` (endpointEpoch) so the broker refuses stale bindings with `E_TARGET_REBOUND` (retryable) — the client re-resolves and retries once (`broker/client.ts:689-709`; `broker/broker.ts:743-762`). Sends that carry `replyTo` never use exact-send (`broker/client.ts:689`).
- The CLI and the extension add cwd-scoped resolution helpers: `cwd` alone targets the sole live peer in that directory; `to`+`cwd` requires the match to live there (`index.ts:1644-1687`; `project-agent.ts` `resolveTargetInCwd`).
- `PI_INTERCOM_SCOPE_ID` (pool) is an exact-match partition: sessions only see/route within their own scope value (`broker/broker.ts:185-210,1480-1486`; README.md:486).

### 4.4 Delivery semantics (ordering, sync/async, receipts)

`send` path in the broker (`broker/broker.ts:711-888`):

1. Validate sender is registered and `to`/message shape; else `E_INVALID_MESSAGE`/`E_SENDER_NOT_FOUND` (`:718-726`).
2. If exact target given: both `targetId` and `targetEpoch` required (`E_INVALID_TARGET`), replay guard, target lookup (`E_TARGET_NOT_FOUND`), epoch check (`E_TARGET_REBOUND`, retryable) (`:733-762`).
3. Resolve target (`:764`).
4. Single live target:
   - `replyTo` must match an ask edge, else `E_REPLY_TARGET` (`:766-769`, and `:782-785`).
   - `supersedes` must match a receipt route from this sender to this receiver, else `E_SUPERSEDE_TARGET` (`:775-781`).
   - `expectsReply` with a reverse ask edge → `E_MUTUAL_ASK` ("Mutual ask refused") (`:786-791`).
   - Ask edge + `pending-asks/<id>.json` are recorded (`:792-798`).
   - `message_control` supersede is sent to the receiver; the old delivery record is marked failed `E_DELIVERY_SUPERSEDED` (`:805-818`).
   - The message is written to the target socket with `brokerReceivedAt`/`brokerDeliveredAt` stamped (`:800-825`).
   - Delivery ack: if the receiver did **not** register `acknowledgesReceipts:true`, the sender immediately gets `{type:"delivered", messageId, delivery:"socket_delivered", retryable:false, outcomeKnown:true}` (`:1139-1141,1155-1160`). If it did, the broker records state `unknown` and waits for a proof receipt (`receiver_received|acknowledged|queued|injected`) up to `RECEIPT_TIMEOUT_MS` (default **5000 ms**, env-overridable, hard-capped at <10000 to stay under the client's 10 s send timeout), then either confirms `socket_delivered` or sends `delivery_failed` with `delivery:"unknown"`, `retryable:true`, `outcomeKnown:false`, code `E_RECEIPT_TIMEOUT` (`:48-50,1153-1212`).
5. Single **disconnected** target: `expectsReply` → `E_TARGET_DISCONNECTED` ("blocking asks are not queued"); otherwise mail is queued in the in-memory mailbox (unless a unique live session shares the same explicit name+cwd identity, in which case it is delivered live) and the sender gets `{delivered, delivery:"queued"}` (`:834-879, 1115-1137, 1450-1478`).
6. Otherwise `E_TARGET_NOT_FOUND` (`:886`).

- **`send` is not durable:** the sender receives its ack when the broker has written the frame (or after receiver confirmation, per above); there is no store-and-forward beyond the in-memory mailbox and no persistence across broker restarts (`broker/broker.ts:1115-1137`; README.md:243).
- **`ask` has no broker-side special mode** — the broker only routes messages; the client waits for a matching reply (`README.md:662`). Waiter matching: `from` matches by name (case-insensitive) or id AND `replyTo === waiter.replyTo` (`index.ts:1384-1394`). The `expectsReply` flag and the ask edge are what let the broker validate replies and detect mutual asks.
- **Replay guard:** per (sender id, message id) a fingerprint over `{targetId, text, attachments, replyTo, expectsReply, supersedes, retryOf, provenance, crossMachine}` is stored; a repeat of the same id with the same fingerprint replays the stored outcome, with a different fingerprint → `E_MESSAGE_ID_REUSE`; an `unknown`-state retry is allowed (and re-armed if a receipt is still pending) (`broker/protocol.ts:163-176`; `broker/broker.ts:1218-1247`). Records are capped at 4096 and pruned after 1 h (`broker/broker.ts:46-47,1249-1270`).
- **Liveness:** client heartbeats a lightweight `list` every `PI_INTERCOM_LIVENESS_INTERVAL_MS` (default 30 000 ms; probe timeout default 5 000 ms, clamped to interval) and destroys its socket if it fails (`broker/client.ts:45-53,112-154`). The client reports `livenessIntervalMs` at register (`broker/client.ts:303`) and the broker sweeps every `PI_INTERCOM_LIVENESS_SWEEP_MS` (default 10 000 ms), dropping sessions silent for 3 intervals (`LIVENESS_MISSED_INTERVALS = 3`) (`broker/broker.ts:51-52,310-330`). TCP transport also enables OS keepalive at 30 s (`broker/broker.ts:53,332-336`).
- **Presence:** `presence` updates mutate `SessionInfo` and are broadcast coalesced (at most once per 1000 ms unless changed) to the same scope (`broker/broker.ts:38,981-1065`). Name is polled client-side at `PI_INTERCOM_NAME_POLL_MS` (default 1000) to catch renames (`index.ts:645-654,1022-1037`).
- **Client-side timeouts:** connect 10 000 ms (`broker/client.ts:191-201`), `send`/`cancelMessage` 10 000 ms (`:672-677,728-733`), `listSessions` 5 000 ms (`:621-626`), `disconnect` 2 000 ms after `unregister` (`:564-594`).
- **Reconnect:** on `disconnected`, the extension schedules reconnects with backoff `[1000, 2000, 5000, 10000, 30000]` ms (`index.ts:869-872,1522-1537`).

### 4.5 Broker lifecycle

- Auto-spawn: `spawnBrokerIfNeeded` → health-check; if not running, acquire `<intercomDir>/broker.spawn.lock` (`wx` create, contents `pid\ncreatedAt`, stale if owner pid is dead or the lock is >10 s old), spawn detached with `cwd = intercomDir`, `env.PI_CODING_AGENT_DIR` set, `NODE_NO_WARNINGS=1`, `windowsHide:true`, then poll the health handshake every 100 ms for up to 5000 ms (`broker/spawn.ts:130-200,274-346,105-124`).
- Default launch is hardened: `node --import <resolved tsx loader> broker/broker.ts` rather than `npx` (`broker/spawn.ts:80-103,37-53`). A custom `brokerCommand` is spawned directly without a shell (`README.md:461`).
- The broker refuses to start when `broker.pid` names a live process (`broker/runtime-claim.ts:3-21`) and unlinks a stale socket on startup (`broker/broker.ts:261-275`).
- Shutdown: 5 s after the last session unregisters/disconnects (`broker/broker.ts:440-450`); on shutdown it ends all sockets, clears in-memory state, unlinks socket/port/pid files, closes the server, `process.exit(0)` (`broker/broker.ts:1856-1885`). Note: **mailbox, ask edges, and disconnected-session memory are dropped at shutdown** — they are process memory only.
- Max sessions per broker: `MAX_SESSIONS = 128`; over that, `{type:"error", error:"Too many registered intercom sessions"}` then socket destroy (`broker/broker.ts:33,525-529`).

### 4.6 Cross-machine (SSH relay) — v1

- Target syntax `name@machine` or `full-session-uuid@machine`; parsing rejects extra `@`, empty parts, whitespace (`cross-machine-discovery.ts:78-84`).
- Discovery uses the local `herdr` CLI (or `$HERDR_BIN_PATH`): `herdr machine list --json` → saved machines `{label, target, enabled}`; then `herdr agent list --json` (per the selected machine) filtered to `row.agent === "pi"`, deriving the agent session id from the session-file path `_<uuid>.jsonl`; unnamed panes are addressed by session id (`cross-machine-discovery.ts:49-76,86-140`). Discovery timeout 5000 ms (`cross-machine-discovery.ts:3`).
- Delivery: `ssh <machine.target> "<remoteCommand> relay --envelope-stdin --json"` with the JSON envelope on stdin; delivery timeout 15 000 ms (`cross-machine-transport.ts:5,72-110`). The remote `pi-intercom relay` command parses the envelope and sends it locally as a normal message with `crossMachine` provenance (`cli.ts:181-184,215-230,70-75`).
- Envelope: exactly fields `version|target|text|origin|trust`, `version:1`, `trust:"ssh-asserted"`, origin fields exactly `machine|name|sessionId`; limits: total 1 MiB, target 1 KiB, text **256 KiB**, each origin field 1 KiB (`cross-machine-envelope.ts:5-32,56-84`).
- The delivered body is prefixed `[Unverified cross-machine origin]\n` and the message carries `crossMachine` provenance (`cross-machine-envelope.ts:90-92`; `cli.ts:219-224`).
- Not supported in v1 over cross-machine: `ask`, `replyTo`, attachments, supersede, retry, cwd/project-pane routing, lifecycle actions (`index.ts:144-161`; README.md:601). Inbound cross-machine messages get a "send a new message to `name@machine`" hint instead of a reply hint (`index.ts:1399-1400`).
- Env-driven local usage: `ssh remote 'pi-intercom ask --to worker --text "…"'` works because the CLI runs on the machine owning the broker (README.md:593-597).

### 4.7 CLI (human/script surface, same client library)

`cli.ts` usage string: `usage: pi-intercom <list|send|ask> [--to <name|session-id>] [--text <message>] [--timeout-ms <n>] [--name <session-name>] [--json]` (`cli.ts:36-37`). `relay --envelope-stdin [--json]` is a fourth, hidden command (`cli.ts:42,65-75,109-112`).

- `list`: text rows `name\t<id[:8]>\tmodel\tstatus\tcwd`, or `--json` `{ok:true, sessions:[{name,id,model,status,cwd}]}` (`cli.ts:156-164,202-213`).
- `send`: `delivered to <to> (<id>)` / JSON `{ok:true, delivered:true, id}` (`cli.ts:232-255`).
- `ask`: sends with `expectsReply:true` and waits for a reply whose `replyTo` equals its own message id (handles the reply-races-the-send-id case with an early-reply map); default timeout `120_000` ms (`cli.ts:39,257-312`).
- Exit codes: `0` ok, `1` usage/connection/delivery failure, `2` ask timeout; `--json` failures print `{ok:false, error, reason?}` (`cli.ts:13,169-176,301-306`).
- The CLI registers as an ordinary session named `--name` (default `pi-intercom-cli`), model `"pi-intercom-cli"`, status `"idle"`, does **not** promise receipts, and disconnects on exit (`cli.ts:143-154,315-317`; README.md:573).

---

## 5. Storage & state

### 5.1 Files on disk

Base dir: `$PI_CODING_AGENT_DIR/intercom` if set (relative values resolved against cwd, `broker/paths.ts:27-38`), else `~/.pi/agent/intercom` (`broker/paths.ts:40-42`). Directory mode `0o700`; runtime files `0o600` (`broker/paths.ts:5-6,118-135`).

| Path | Contents | Written by |
|---|---|---|
| `broker.sock` (POSIX) / `\\.\pipe\pi-intercom-<sanitized dir>` (Win) | listen endpoint | broker (`broker/paths.ts:65-74`) |
| `broker.pid` | broker PID as decimal text | broker on listen, unlinked on shutdown (`broker/broker.ts:29,295-296,1878-1882`) |
| `broker.port.json` | `{transport:"tcp",host:"127.0.0.1",port,stateId}` only when Windows TCP transport is explicitly enabled | broker (`broker/paths.ts:61-63`; `broker/broker.ts:30,286-293`) |
| `broker.spawn.lock` | `<pid>\n<createdAtMs>` while spawning | clients (`broker/spawn.ts:24,274-335`) |
| `config.json` | the config table above | user (`config.ts:76-78`) |
| `pending-asks/<messageId>.json` (scoped pools: `<sha256(scopeId)>-<urlencoded messageId>.json`) | `{askId, messageId, asker:{sessionId,name}, target:{sessionId,name}, question, createdAt, expiresAt}` — written for every `expectsReply` send, pruned on reply/cancel/timeout (`broker/broker.ts:31,204-241,1353-1397`) |
| `extension-state/<sha256(namespace)>.json` (+ `.bak`, plus `.tmp.<pid>.<uuid>` during writes) | `{formatVersion:1, namespace, revision, updatedAt, payloadSha256, payload}` written with `fsync` + rename; ≤64 KiB (`broker/extension-state.ts:16-25,110-192`) |

There is **no message log, inbox, or transcript file** — the README states this explicitly ("No dedicated intercom log — Messages are kept in Pi session history, but there is no separate intercom transcript or inbox", `README.md:707`).

### 5.2 In-memory broker state (lost on broker restart)

| Store | Type / key | Limits & retention |
|---|---|---|
| `sessions` | Map keyed `JSON.stringify([scopeId ?? null, sessionId])` (`broker/broker.ts:189-195,244`) | ≤128 (`:33`) |
| `disconnectedSessions` | last-known `SessionInfo` for recently gone sessions (`:247,1082-1089`) | retained 24 h (`:43`) |
| `mailboxMessages` | array of `{from,fromKey,fromScopeId?,target,targetKey,targetScopeId?,message,queuedAt}` (`:151-160,1115-1137`) | ≤256 messages, retained 24 h; overflow evicts oldest with `E_DELIVERY_EVICTED`; expiry marks `E_DELIVERY_EXPIRED` (`:44-45,1100-1137`) |
| `deliveryRecords` | per `(fromSessionId,messageId)` `{fingerprint,state,reason?,code?,retryable,createdAt}` (`:97-104,1249-1264`) | ≤4096, retained 1 h (`:46-47`) |
| `askEdges` | `messageId → {from,to,scopeId?,createdAt}` (`:121-126,793-798`) | pruned at `askTimeoutMs` (`:1334-1342`) |
| `messageReceiptRoutes` | `messageId → {from,to,createdAt}` (`:138-142,819`) | retained 1 h (`:42,1399-1405`) |
| `pendingReceipts` | `key → {senderSocket,fromKey,messageId,targetSocket,scopeId?,replyTo?,timer}` (`:86-95`) | `RECEIPT_TIMEOUT_MS` (default 5 s) |
| `namespaces/namespaceOwners` (`:106-113,257,1513-1601`) and `ExtensionStateManager.states` cache | owner election per `(scopeId, namespace)` with an epoch regenerated on owner change (`README.md:525`) |

### 5.3 Session-history state (host-side)

`pi.appendEntry` custom entry types written by the extension (`grep 'appendEntry("'`):

| customType | payload | source |
|---|---|---|
| `intercom_sent` | `{to, message:{text, attachments?, replyTo?, supersedes?, retryOf?, reason?}, messageId, timestamp, crossMachine?, extension?, subagent?}` | `index.ts:1826-1831, 2309-2315, 2378-2388, 2857-2862, 3285-3290, 1253-1259` |
| `intercom_received` | `{from, message:{text,attachments?}, messageId, timestamp, subagent?}` | `index.ts:2395-2401, 2800-2805` |
| `intercom_session_held` | `{sessionId, holder, error, timestamp}` | `index.ts:1543-1548` |
| `intercom_outbox_result` | outbox result + `{to?, message?{text}, timestamp}` | `index.ts:1085-1092` |
| `intercom_control_error` / `intercom_result_error` (subagent relay failures) | `{to,message,error,timestamp}` | `index.ts:1899-1906, 2042-2056` |

### 5.4 Client-side extension state

`seenInboundMessages` LRU 1000 entries / 1 h (`index.ts:48-49,706-731`); `latestOutboundReceipts` map (unbounded per runtime, updated on each `message_receipt`; `index.ts:707,1465-1471`); `heldInboundMessages` FIFO with a 100 ms flush interval (`index.ts:687-688,1363-1370`); `ReplyTracker` pending asks + pending turn contexts, pruned at `askTimeoutMs` (`reply-tracker.ts:47-52,148-159`).

---

## 6. Failure modes

### 6.1 Broker-side delivery failures (codes are returned in `delivery_failed.code`)

| Code | Trigger | Retryable |
|---|---|---|
| `E_INVALID_MESSAGE` | `to` not a string or message fails `isMessage` (`broker/broker.ts:718-721`) | false |
| `E_SENDER_NOT_FOUND` | sender socket not the current registration (`:722-726`) | false |
| `E_INVALID_TARGET` | `targetId` given without `targetEpoch` or either empty (`:733-742`) | false |
| `E_TARGET_NOT_FOUND` | no live or disconnected session matches (`:751-754, 886`) | false |
| `E_TARGET_REBOUND` | exact target's `endpointEpoch` changed (`:756-760`) | **true** (client auto-retries once) |
| `E_AMBIGUOUS_TARGET` | >1 live (or >1 disconnected for mail) match the name (`:829-832, 881-884`) | false |
| `E_REPLY_TARGET` | `replyTo` doesn't match a pending ask edge from this sender to this target (`:766-769, 782-785, 836-839, 850-853`) | false |
| `E_SUPERSEDE_TARGET` | `supersedes` route missing/not same sender→receiver, or target disconnected (`:775-781, 846-849`) | false |
| `E_MUTUAL_ASK` | target already has an open ask to this sender ("Mutual ask refused") (`:786-791`) | false |
| `E_TARGET_DISCONNECTED` | `ask`-style `expectsReply` send to a disconnected target ("blocking asks are not queued") (`:854-857`) | false |
| `E_RECEIPT_TIMEOUT` | receiver promised receipts and did not confirm within `RECEIPT_TIMEOUT_MS` → `{delivery:"unknown", retryable:true, outcomeKnown:false}` (`:1164-1166, 1193-1203`) | true |
| `E_RECEIVER_DISCONNECTED` | target or sender socket closed while a receipt was pending (`:1205-1212`) | true |
| `E_MESSAGE_ID_REUSE` | same message id, different authored content (fingerprint mismatch) (`:1218-1226`) | false |
| `E_DELIVERY_SUPERSEDED` / `E_DELIVERY_CANCELLED` / `E_DELIVERY_EXPIRED` / `E_DELIVERY_EVICTED` | old message superseded, sender cancelled, mailbox TTL expiry, mailbox capacity eviction (`:817, 927, 960, 1109, 1125`) | false |
| `E_SESSION_HELD` (registration error, not delivery) | a different live process holds the requested session id → `{type:"error", code:"E_SESSION_HELD", error:"Intercom session … is held by live process <pid> in <cwd>", holder:{pid,cwd,name?}}` then `socket.end()` (`types.ts:4`; `broker/broker.ts:530-542`) | n/a |
| `E_DELIVERY_FAILED` | fallback when replaying a stored failed record without a code (`:1244`) | as stored |
| broker `error` frame | `"Too many registered intercom sessions"`, `"Intercom broker rate limit exceeded"`, protocol/validation errors (which destroy the socket) (`:526, 368, 458-488, 1077-1078`) | n/a |

Client mapping of these frames (`broker/client.ts:387-419`): `delivered` → `{delivered:true, delivery:"socket_delivered"|"queued", retryable, outcomeKnown}`; `delivery_failed` → `{delivered:false, reason, delivery:"failed"|"unknown", retryable, outcomeKnown, code?}`. Timeouts surface as plain `Error("Send timeout"|"List sessions timeout"|"Cancel timeout"|"Connection timeout")` (`broker/client.ts:675,624,731,199`).

### 6.2 User/agent-visible failure text

- Target missing on `send`: text `Message to "<target>" was not delivered: Session not found` (or for unknown-outcome cases, "could not be confirmed: … The message may still arrive, so sending it again could duplicate it."), `details.delivered=false` (`index.ts:163-181`).
- Target missing on `ask`: "Session "<to>" is not currently connected. Blocking asks are not queued; use send for a non-blocking mailbox delivery or retry after the session reconnects." (`index.ts:2731-2737`).
- Self-target: `"Cannot message the current session"` (`index.ts:1782-1787, 2748-2753, 2836-2841, 2290-2295`).
- Multiple same-name peers: `Multiple sessions named "<x>" are connected. Address one by the id shown in parentheses by "list" (<prefixes>).` (`index.ts:1617-1621`); ambiguous id prefix: `Multiple sessions match ID prefix "<x>". Use a longer session ID prefix.` (`:1630-1632`).
- Ask timeout: `No reply from "<from>" for message <id> within 10 minutes. Last known delivery state: <state>. This waiter timeout is not cancellation; the delivered message may still be queued or actionable in the recipient session.` (`index.ts:777-780`).
- Session held: "Intercom is offline: session id <id> is held by process <pid> in <cwd>. Close that session and run /reload, or give this session its own PI_INTERCOM_STABLE_ID." + `intercom_session_held` entry; background reconnects stop (`index.ts:1538-1549, 680-681, 1522-1525`).
- Broker unreachable at startup: connect failure is retried in the background; CLI prints "cannot reach the local intercom broker: <err> — is a pi session with pi-intercom loaded currently running on this machine?" (`cli.ts:196-199`).
- Protocol violations destroy the connection: unknown message types, invalid register/session fields, register-before-register ordering, invalid receipt/control shapes (`broker/broker.ts:458-488, 1077-1078`; `broker/framing.ts:34-52,68-71`).
- Oversized frame (>1 MiB) → reader error → socket destroyed ("Intercom frame length N exceeds maximum M bytes") (`broker/framing.ts:68-71`; broker reader error handler `broker/broker.ts:382-384`).

### 6.3 Failure behavior of note

- **Nothing is queued for a blocking ask.** Disconnected target = immediate failure. Only non-blocking `send` uses the mailbox.
- **Mailbox redelivery identity** requires the same session id OR (same explicit name AND same cwd), and never remaps to the sender; runtime fallback aliases (`runtimeFallbackAlias:true`) are excluded from name-based reconnection (`broker/broker.ts:1281-1332, 1456-1478`).
- **Timeout ≠ cancellation**: an ask timeout can leave a still-queued message that the receiver may later act on (`index.ts:779`; README.md:245).
- **Dedupe:** duplicate inbound message ids are acknowledged but injected at most once per receiving session (`index.ts:1378-1381`; README.md:245).

---

## 7. Security model

Facts as implemented / documented:

1. **Local-only by design.** POSIX: Unix domain socket in a `0700` directory with a `0600` socket file; Windows: named pipe (`broker/paths.ts:5-6,65-74,118-135`; README.md:658). No network listener unless the Windows TCP escape hatch is explicitly enabled.
2. **TCP escape hatch authentication.** When enabled, the broker binds `127.0.0.1:0`, writes the port plus a random `stateId` secret to `broker.port.json`, and requires `stateId` on `health` and `register`; health replies do not echo the secret, so a random localhost process cannot discover it through the protocol (`broker/broker.ts:32,463-484`; `broker/paths.ts:81-105`; README.md:658).
3. **Trust metadata is broker-owned.** `trustedLocal` is set by the broker (`typeof LISTEN_TARGET === "string" && process.platform !== "win32"`, i.e. only for the Unix-socket transport) and `peerUid` is reserved/unset because it is not implemented for the current transports; client-supplied cwd/model/pid/status are treated as display metadata, and `pid` is used only to test whether the id holder is still running (`broker/broker.ts:561,530-542`; README.md:643).
4. **Session id exclusivity.** One live process holds a session id per scope; a second one is refused with `E_SESSION_HELD` (pid liveness probe via `process.kill(pid, 0)`, EPERM tolerated) (`broker/broker.ts:173-183,530-542`).
5. **Send confirmation (human-in-the-loop).** `confirmSend:true` shows a confirm dialog for ordinary sends, cross-machine sends, project-pane sends, and inferred replies from interactive sessions; a caller-supplied `replyTo` skips it (`index.ts:1723-1745, 1798-1809`; README.md:463).
6. **Inbound auto-trigger policy.** `inboundTrigger: always|replies|never` bounds whether a peer message can start a model turn; invalid config fails closed to `never` (`index.ts:1270-1281`; README.md:464,472).
7. **Same-turn reply authority.** During a turn triggered by an inbound ask, a non-reply send to another target is refused, to prevent a guessed cwd/hierarchy from becoming an accidental reply target (`index.ts:1788-1795`; README.md:237).
8. **Extension outbox consent.** Third-party extensions can only request sends; `confirmSend` applies, there is no fire-and-forget, duplicates are rejected, and extensions cannot choose the sender, scope, or resolved target id (`index.ts:1154-1172, 1194-1228`; README.md:558).
9. **Cross-machine identity is explicitly unverified.** Envelopes are marked `trust:"ssh-asserted"`, rendered as `from worker@laptop · unverified cross-machine`, and the README states "anyone with SSH access that can invoke the relay can claim it" (`cross-machine-envelope.ts:5-11,86-92`; `index.ts:1399-1400,1292-1294`; `ui/inline-message.ts:40-46`; README.md:601). Relay parsing enforces exact field sets and byte caps (`cross-machine-envelope.ts:56-84`).
10. **Channel scoping (`PI_INTERCOM_SCOPE_ID` / pools)** partitions visibility and routing; scoped and unscoped sessions cannot cross the boundary (`broker/broker.ts:185-210,685-686,1480-1486`; README.md:486).
11. **Resource limits as DoS guards:** 128 sessions, 32 unregistered connections, 1 s registration timeout, token-bucket rate limit (240 burst / 120 per second), 1 MiB frame cap, 256 mailbox messages, 4096 delivery records, 32 extension namespaces per session, 16 KiB extension messages, 64 KiB extension state (`broker/broker.ts:33-52,410-438`; `broker/framing.ts:3`).
12. **Trusted local configuration.** `brokerCommand`/`brokerArgs` are documented as "trusted local configuration: anyone who can edit this config can choose the executable used for future broker auto-spawns" (`README.md:475`).
13. **Secrets in handover:** the handover system prompt instructs the model to omit secrets/tokens/credentials and the README tells users to review; it is not a mechanical filter (`handover.ts:34`; README.md:278).
14. **No authentication of peers beyond local transport + session-id ownership.** There is no token, ACL, or per-peer permission system: any process that can connect to the socket can register and message any session in its scope.

---

## 8. Open questions / not determinable from this repo

1. **Exact maximum message size in practice.** The only hard cap found is the 1 MiB frame (`broker/framing.ts:3`), which covers the serialized `send` envelope, not just `message.content.text`. No per-text limit exists in the tool schema or broker validation. Whether the pi host truncates tool arguments before they reach the extension is host behavior, not in this repo.
2. **Host semantics of `deliverAs:"steer"` and triggered `sendMessage`** (queueing, ordering relative to human input, exactly when `before_agent_start` is skipped) are pi-host behaviors referenced only by comment (`index.ts:1307-1308`) and README prose; not verifiable from this repo.
3. **`pi-subagents` integration contract** (which env vars pi-subagents sets, what it does with `details.structuredReply`, and the `nativeSupervisorChannelAvailable` path) is depended upon (`index.ts:51-60, 2188-2190, 2402-2408`) but pi-subagents is a separate repo; the `intercom:outbox-request` / `intercom:session-identity` producers are external.
4. **Herdr coupling.** `herdrLocation` and project-pane opening depend on an external `herdr` CLI (`herdr api snapshot`, `herdr machine list`, `herdr agent list`) whose JSON schema is only partially inferred by parsing code (`herdr-location.ts`, `cross-machine-discovery.ts:49-76`, `project-agent.ts`). The exact `herdr` version requirements are not stated in this repo.
5. **README/code discrepancies** (documented above, not resolved by the repo):
   - README says `messageId` is usable for `send`/`ask` (`README.md:387`) but the code paths ignore it outside `cancel` (`index.ts:2541, 2631-2638, 2665-2667, 2760`).
   - README's `send` doc says the tool returns `Message sent to research` (`README.md:104`) — actual code text is `Message sent to <targetDisplay>` (`index.ts:1840`), which matches; but README `README.md:383` describes `to` semantics for `list-cwd` that the `list-cwd` handler excludes self from, etc. (cosmetic).
6. **Windows behavior can't be verified** on this machine: named-pipe naming (`sanitizePipeSegment`) and the TCP path are read but untested; `trustedLocal` is explicitly forced false on Windows (`broker/broker.ts:561`).
7. **`PI_INTERCOM_ASK_TIMEOUT_MS` is read by every process at import/first-use** (`config.ts:10-21`; extension caches it at `index.ts:658`; broker at `broker/broker.ts:256`), so changing it requires restarting those processes. Not stated in the README as a requirement.
8. **Concurrency guarantees across host sessions**: the broker is single-threaded Node; the report above describes state transitions but the repo contains no formal concurrency model, and the in-memory stores mean behavior across broker restarts (mailbox loss, ask-edge loss, delivery-record loss) is by-design but not otherwise documented beyond README.md:243.
9. **What the `list` action returns for `contextPct`/`tmuxPane`** depends on host APIs (`getContextUsage()`, `$TMUX_PANE`) being present/absent; no fallback behavior is specified beyond omission (`index.ts:993-1010,571-574`).
10. **Security posture of `confirmSend` for programmatic (non-UI) sessions**: it simply does not apply (no dialog is possible); sends happen without confirmation (`index.ts:1723` requires `ctx.hasUI`). The outbox explicitly fails closed instead (`index.ts:1169-1172`). This asymmetry is in code but not called out in the README.
