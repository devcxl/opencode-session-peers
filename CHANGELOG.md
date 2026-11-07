# Changelog

## Unreleased

### Messaging reliability

- Busy delivery now uses the recipient's declared setting. Unknown status or an older roster record
  falls back to queueing; mixed versions may still use the old sender-side behaviour.
- `send` and handover success mean the host accepted the message, not that it was read. Host prompt
  errors report an unknown outcome rather than claiming the message was not admitted.
- `cancel` requests stopping an active wait in this plugin instance; it no longer deletes the question
  or claims to withdraw it. It does not stop work on the recipient's side.
- Concurrent ask guards are best-effort, not atomic. A reply racing a wait ending can remain unread.

### Skills

- The plugin registers a general `session-peers` skill beside the existing `session-peers-supervisor`
  one. It covers the coordination patterns behind the action enum, the delivery and ask/reply rules
  a session has to work around, the failure codes it should handle, and what the plugin deliberately
  does not do. It is loaded on demand, not added to the tool description.

### Session scopes

- A session can be moved out of the scope it was configured with: `/peers-scope <scope>` at the prompt
  puts the current session into that visibility partition, and `/peers-scope default` puts it back.
  The move is published on the session's roster row (so it survives a reload), and `list`, `send` and
  `ask` resolve in the new scope from then on.
- The roster dialog's `g` key shows the default scope while the session has a scope of its own, and
  `g` again returns to it. The preview only changes what the dialog reads.

### The roster dialog (TUI half)

- The roster is no longer rendered as a standing sidebar view. `/peers` at the prompt (or
  `Session peers` in the command palette) opens the host's dialog and shows the roster as a table:
  one column per fact (session, id, directory, status, marks), live while the dialog is open. The
  view keeps every promise of the sidebar it replaces: unknown status is `unknown` with its reason
  and never `idle`, an empty table names which of the three causes it is, ids are folded to their
  tail, and this session and same-directory peers are marked.
- A roster larger than one page is paged instead of spilling past the screen: a page holds at most
  eight peers (fewer on a short terminal), `←`/`→` and `PageUp`/`PageDown` flip pages, and a footer
  says which page is shown. A roster that shrinks under a deep page falls back to a page that exists.
- This session's own row is drawn in its own table above the peers' table (the two share their
  column widths), so it stays visibly apart while the rest turns over.
- The dialog opens at the host's widest size (116 columns, capped by the terminal) with two columns of
  padding, so absolute directory paths get more room before they wrap and the content is not flush
  against the dialog's edge.

## 0.1.0 — 2026-10-15

First release.

### The tool

One model-facing tool, `peers`, with an action enum (ADR-0003):

- `list` — every live peer in this session's scope, this session first.
- `list-cwd` — only the peers in this session's directory.
- `send` — deliver a message to one peer and report whether it was delivered. A send is not queued:
  a target that is gone is reported undelivered immediately (ADR-0005).
- `ask` — put a question to one peer and wait inside the call until it is answered or the configured
  timeout passes. A timeout is not a cancellation: the question stays answerable, and an answer that
  arrives later is delivered as an ordinary message.
- `reply` — answer a question another peer is waiting on.
- `pending` — the questions waiting for this session's answer.
- `cancel` — withdraw a question this session asked.
- `handover` — summarise this session with its own model, in fixed sections, and send the summary to
  one peer. Attachments and a reply reference are refused.
- `status` — this session's id, its scope, and whether the host is answering.

Messages carry text and optional inline attachments (`file`, `snippet`, `context`).

### Behaviour

- Peers are published to opencode's plugin storage, shared per plugin id across locations and durable
  across restarts, with a heartbeat and a configurable TTL.
- The recipient's declared inbound policy travels with its roster record and is honoured by the
  sender (`trigger`: `always`, `replies`, `never`).
- One ask at a time per session; mutual asks are refused; a session holding an unanswered ask may
  `send` only to the asker.
- The supervisor channel: a subagent reaches its parent through the same tool, and an ask to a parent
  parked inside a foreground `subagent` call fails fast with guidance instead of stalling (ADR-0002).
  A parent that wants to be asked must spawn the child with `background: true`; the plugin registers
  a skill with that text.
- `scope` partitions visibility: only sessions configured with the same scope see each other.

### Configuration

Plugin options and their defaults: `enabled` (`true`), `scope` (`"default"`), `trigger` (`"always"`),
`busyDelivery` (`"steer"`), `replyHint` (`true`), `askTimeoutMs` (`600000`), `rosterTtlMs`
(`90000`). An invalid value is replaced by a safe one and reported once at load; `trigger` fails
closed to `never`.

### Not included

No human-facing UI, no cross-machine messaging, no broadcast, and no message revocation
(`supersedes` / `retryOf`). `SECURITY.md` states the trust boundary these leave in place.
