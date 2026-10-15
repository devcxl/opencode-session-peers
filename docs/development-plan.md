# Development plan

Status: awaiting approval. No implementation code exists yet; this document plus the ADRs are the
design. Vocabulary lives in `CONTEXT.md`; the facts it rests on live in `docs/research/`.

## What we are building

An opencode v2 plugin that lets sessions on the same machine message each other: list peers, send,
ask and block for a reply, hand over context — porting the behaviour of
[`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom) v0.17.0 onto opencode's plugin
API.

In scope: `list`, `list-cwd`, `send`, `ask`, `reply`, `pending`, `status`, `cancel`, `handover`;
attachments (`file` / `snippet` / `context`); scope partitioning; the subagent supervisor channel.

Out of scope, deliberately: cross-machine relay, any human-facing UI, broadcast, message revocation
(`supersedes` / `retryOf`), the extension bus / outbox, structured interviews, `herdr` / tmux /
project-pane integration, and a standalone CLI. The original ships a CLI, but the host already provides
that surface — `opencode session list`, `opencode run --session <id> "<text>"`, `opencode api` — using
its own credentials; a CLI of our own would have to reach into either `service.json` or the host's
internal store, which ADR-0001 and ADR-0004 reject.

## Module boundaries and dependency direction

```
index.ts                 package entry — Plugin.define({ id, setup }); wiring only
src/config.ts            plugin options: parse, validate, defaults; invalid config fails closed
src/domain/              pure rules; imports nothing outside itself
  types.ts               Message, PeerRecord, AskRecord, DeliveryOutcome
  addressing.ts          session id -> exact -> title -> id prefix; ambiguity fails closed
  policy.ts              inbound policy, admission rules (mutual ask, single pending ask, reply authority)
  errors.ts              codes and human-readable texts
  format.ts              roster rows, message bodies, reply hints
src/host/                the only place `ctx.*` appears
  session.ts             prompt / context / get / wait / rename adapters
  events.ts              event subscription and the live session index
  storage.ts             namespaced, versioned reads/writes over `ctx.storage`
  tools.ts               tool registration through `ctx.tool.transform`
src/peers/roster.ts      publish own sessions, read others, expire stale entries, scope filter
src/ask/handshake.ts     pending asks, reply routing, timeouts, late-reply degradation
src/actions/*.ts         one module per action; each returns result text plus details
src/handover/generate.ts model-written handover through `ctx.session.generate`
src/skill.ts             model-facing usage text
```

Scripts and humans reach this plugin through the host's own CLI (`opencode session list`,
`opencode run --session <id> "<text>"`, `opencode api`) rather than a CLI of our own; see the scope note
above.

Dependency rule: `actions -> (peers, ask, handover) -> host -> domain`, and `index -> config + the
rest`. `domain` never imports `host`. A unit test asserts that rule by scanning imports, so the
boundary cannot rot silently.

## Key mechanisms

1. **Delivery.** `ctx.session.prompt({ sessionID, text, delivery })`. The inbound policy maps onto the
   host's native modes: idle recipient -> `queue` (starts a turn), busy recipient -> `steer` (injected
   at the next safe boundary, no interruption). Defaults follow `pi-intercom`: trigger always, steer
   when busy. Because delivery is one call made by the sender, the recipient's trigger **travels with
   its roster record** and is enforced by the sender (ADR-0005). A send is not queued.
2. **Roster.** Each plugin instance publishes the sessions it serves to `ctx.storage` with a heartbeat,
   reads the whole registry, and filters by scope. Rows are formatted like the original's
   (`name (id-prefix) — cwd (model · status)`), with the shortest unique id prefix. Module-level state
   cannot be used: the plugin is instantiated once per location, with a fresh module instance.
3. **Ask / reply routing.** An ask publishes `ask/<askId>` (asker, target, question, expiry) and then
   prompts the target. The target's agent answers with `peers({action:"reply"})`; the instance serving
   the target writes `reply/<askId>`; the asker polls storage while an ask is outstanding and resolves
   its blocked tool call. Same-instance asks short-circuit in memory. Timeout is not cancellation: on
   timeout the tool returns the original's wording, and a late reply degrades into a normal inbound
   message. Admission rules from the original are kept: one pending ask per session, mutual asks
   refused, and inside a turn triggered by an inbound ask a non-reply message to a third session is
   refused.
4. **Parked detection.** Before asking a session that is the caller's own parent, inspect the parent's
   context: if its running tool call is the subagent call for this session, the parent cannot answer —
   fail fast with guidance (ADR-0002).
5. **Handover.** `ctx.session.generate` with the original's fixed sections, plus a header carrying
   sender, cwd and git branch.
6. **Configuration.** `inboundTrigger`, busy delivery, reply hint, scope id, ask timeout — all plugin
   options, defaults taken from the original. `confirmSend` is dropped: it needs a human surface, and
   this plugin deliberately has none.

## Milestones

Each milestone ends at a gate that must be observed, not assumed.

| # | Deliverable | Gate |
| --- | --- | --- |
| M1 | `domain/` + `config.ts` with unit tests, CI workflow, lockfile | `bun test` green locally and in CI; import-boundary test green |
| M2 | `host/` + roster; dev loading via this repo's `.opencode/opencode.json` | two sessions in two directories see each other in an isolated instance |
| M3 | `send` + inbound policy | a message sent from directory A arrives in directory B's session and lands mid-turn when busy |
| M4 | `ask` / `reply` + routing + timeout | cross-instance ask returns the reply; timeout wording matches; a late reply degrades to an ordinary message |
| M5 | `handover`, attachments, scope | handover sections present; scoped sessions cannot see across the boundary |
| M6 | supervisor channel + skill text | foreground-spawned child fails fast; `background: true` child gets a real reply |
| M7 | publish readiness | README / SECURITY / CHANGELOG written; `npm pack` contents reviewed; typecheck and tests green |

## Verification

- **Unit** — `bun test` over `domain/` (addressing, policy, formatting, error texts).
- **Integration** — a harness in `scripts/` that boots an *isolated* opencode instance (own
  `XDG_*` dirs and port), creates two sessions in two directories, drives them, and asserts on tool
  results. This is also the acceptance test for M2-M6.
- **Isolation** — never touch the developer's live service, its database, or `service.json`; the
  harness owns its own state and cleans up.

## Open questions to settle by measurement, not assumption

1. `ctx.storage` across *processes* (verified across locations and restarts; the shared database
   strongly implies it, but it is unmeasured) — and the exact API shape and value encoding.
2. End-to-end cross-location delivery including the reply hop.
3. Where `steer` actually lands when the recipient is mid-turn — the safe boundary in practice.
4. Reliability of parked detection: which message records expose a running tool call.
5. Reclamation of stale roster entries after a session or instance disappears.
6. ~~Where a `send` to a peer that has gone away waits.~~ Settled: it does not wait. An in-process prompt
   reaches a session another server process created (`docs/research/cross-process-prompt.md`), so the
   only miss left is a session id that no longer exists — see ADR-0005.

## Risks

- **Host-internal coupling.** `ctx.storage` is a documented plugin API but its backing encoding is
  internal; keep it behind `host/storage.ts` so a host upgrade touches one file.
- **Per-location instances.** Verified: each location gets its own module instance. Any machine-wide
  state must live in storage, never in a module singleton.
- **Global tool visibility.** Tools register per loaded location, so `peers` is visible to every session
  of that location; scope configuration is the only gate. This is a consequence of the host API, not a
  choice, and is recorded in ADR-0003.
- **Parked detection** rests on message-record shapes that a host upgrade may change; it degrades to a
  conservative fail-fast rather than to a stall.
