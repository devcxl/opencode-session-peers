# Research notes

Version-pinned investigations this project's design rests on. Each file states the versions it was
written against; when a note and the installed host disagree, the note is what is stale — re-verify
before relying on it.

| Note | Covers | Pinned to |
| --- | --- | --- |
| `pi-intercom.md` | The behaviour being ported: `nicobailon/pi-intercom` v0.17.0, its tools, transport, failure modes, security model | pi-intercom `v0.17.0` (`14731a4`) |
| `opencode-v2-plugin-api.md` | The plugin module contract, the context shape, tool registration, the session domain, what is not exposed | host `2.0.27`, `@opencode/plugin` `2.0.16` |
| `opencode-multiprocess-topology.md` | One shared background service per user, cross-process prompting, the shared database, event scoping | host `2.0.27` |
| `plugin-instance-scoping.md` | A plugin instance is created per project directory; cross-location session calls; plugin storage is shared and durable | host `2.0.27` |
| `subagent-lifecycle.md` | The built-in subagent tool parks the parent with no timeout; a child's message to a parked parent is deferred; waiting on it deadlocks | host `2.0.27` |
| `subagent-background-mode.md` | `background: true` keeps the parent answerable; plugin-created children; the HTTP route to unblock a parked call | host `2.0.27` |
| `tool-result-metadata-undefined.md` | A tool result whose `metadata` contains `undefined` is dropped and the calling turn hangs | host `2.0.29` |
| `tui-surface-data-path.md` | How a TUI surface reaches a server plugin's state — plugin RPC over HTTP plus event push — and what the TUI can render, including a real `sidebar.content` slot; measured by rendering one | host `2.0.29`, `@opencode/plugin` `2.0.16` |
| `ask-reply-handshake.md` | A tool call can block for seconds inside a turn; an answer written by another instance's `reply` reaches the blocked call through storage | host `2.0.29` |
| `parked-parent-signal.md` | A running `subagent` call names no child (input and progress metadata both empty) — the parking is the observable signal; the skill surface registers and reaches the model | host `2.0.29` |

## Host drift

The installed binary at `/usr/bin/opencode` was **replaced overnight on 2026-10-15** while this project
was mid-implementation: `opencode v2.0.27` (210,367,968 bytes) became **`opencode v2.0.29`**
(211,064,288 bytes, md5 `6653617a3eb61ea49192fbd7325d4d3a`, mtime 2026-10-15 00:56 +0800).

Consequences, to be treated as open until measured:

- Every note pinned to `2.0.27` describes a binary that is no longer installed. Facts they assert may
  have changed; the plugin contract (`{ id, setup }`), tool registration with `codemode: false` and
  `ctx.session.prompt` were re-confirmed on `2.0.29` in passing, but nothing else was.
- The `@opencode/plugin` typings in `~/.config/opencode/node_modules/` are a separate axis: the
  installed copy stays at **2.0.16** and is what typechecks this repository. Runtime behaviour comes
  from the binary; types come from there.
