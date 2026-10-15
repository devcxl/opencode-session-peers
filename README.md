# opencode-session-peers

An [opencode](https://opencode.ai) v2 plugin that lets the sessions running on one machine talk to
each other: list the other sessions, send a message, ask a question and wait for the answer, hand
over context to another session.

- One model-facing tool, `peers`, with an action enum.
- Same machine, same operating-system user: peers meet through opencode's own plugin storage and
  messages are delivered with the host's own session prompt call. There is no daemon, no socket and
  no network service.
- No user interface: everything the plugin reports, it reports to the calling model as a tool result.
- Not implemented, deliberately: cross-machine messaging, broadcast, message revocation, a standalone
  CLI. See [`SECURITY.md`](./SECURITY.md) for the trust boundary and
  [`docs/adr/`](./docs/adr) for the decisions and the alternatives that were rejected.

Version 0.1.0, in this repository. It is not published to npm yet; the install section below covers
both cases.

## Install

opencode loads a plugin from a local directory or from a package it installs itself. Only an
opencode v2 server is needed: the plugin is TypeScript source with no build step and no runtime
dependencies. It is developed and measured against opencode 2.0.29; `docs/research/README.md`
records the pinned versions and the host drift behind each measurement.

The directory form below is what works today, before the first npm release:

```bash
# 1. build the tarball from a checkout
git clone https://github.com/devcxl/opencode-session-peers
cd opencode-session-peers
npm pack --pack-destination /tmp

# 2. install it into a directory of your choice, e.g. ~/opencode-plugins
mkdir -p "$HOME/opencode-plugins"
cd "$HOME/opencode-plugins"
npm install /tmp/devcxl-opencode-session-peers-0.1.0.tgz
```

The plugin now lives at `$HOME/opencode-plugins/node_modules/@devcxl/opencode-session-peers`. Add
that absolute path to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/you/opencode-plugins/node_modules/@devcxl/opencode-session-peers",
      "options": { "scope": "default" }
    }
  ]
}
```

Then restart the opencode server. The `peers` tool is available to every session the server serves;
sessions that declare the same `scope` see each other.

Alternatives:

- **A checkout, without npm.** `{ "package": "/absolute/path/to/opencode-session-peers" }` works the
  same way: the host loads `<dir>/index.ts` directly.
- **Per project.** Declare the plugin in a project's `.opencode/opencode.json` to load it for that
  project's sessions only; the repository's own harness installs the plugin as a project plugin
  using the directory form above.
- **Once 0.1.0 is on npm**, the package name can be declared instead:
  `{ "package": "@devcxl/opencode-session-peers" }`. opencode fetches a package-form plugin from the
  npm registry itself; with the name unpublished, the host's own npm run fails with `404 Not Found`
  from `registry.npmjs.org`, which is the path a published name would take. That form could not be
  verified end to end here, because the package is not published yet.

## Configure

Options are the second half of the `plugins` entry. Every option has a default, so an empty object is
valid. A value with the wrong type is replaced by the safe default and reported once at load in the
server log; `trigger` fails closed to `"never"`.

| Option | Default | What it does |
| --- | --- | --- |
| `enabled` | `true` | `false` publishes nothing and refuses every action with "disabled by configuration". |
| `scope` | `"default"` | Visibility partition. Only sessions with the same scope see each other. |
| `trigger` | `"always"` | What this session accepts from peers: `always`, `replies` (questions and answers only), `never`. Published on this session's roster record and honoured by the sender. |
| `busyDelivery` | `"steer"` | How a message reaches a recipient that is mid-turn: `steer` injects it at the next safe boundary, `queue` waits until the recipient is idle. An idle recipient always starts a new turn. |
| `replyHint` | `true` | Append the `To reply: peers({ action: "reply", ... })` line to inbound messages. A question always carries it. |
| `askTimeoutMs` | `600000` | How long an `ask` waits for its answer (10 minutes) before it stops waiting. |
| `rosterTtlMs` | `90000` | How long a peer record may go without a heartbeat before other instances stop listing it. The heartbeat runs at a third of this. |

## The `peers` tool

| Action | What it does |
| --- | --- |
| `list` | Every live peer in this session's scope, this session first. Run it before addressing a peer. |
| `list-cwd` | Only the peers working in this session's directory. |
| `send` | Deliver a message to one peer and report whether it was delivered. Does not wait for anything else. |
| `ask` | Put a question to one peer and wait inside the call until it is answered, the ask timeout passes, or the turn is interrupted. |
| `reply` | Answer a question another peer is waiting on. |
| `pending` | The questions waiting for this session's answer, each with the question id to name in `replyTo`. |
| `cancel` | Withdraw a question this session asked (`replyTo` names it; omit it to withdraw the one whose wait is still running). |
| `handover` | Summarise this session with this session's own model and send the summary to one peer, which continues the work. |
| `status` | This session's id, its scope, and whether the host is answering. |

`to` accepts a full session id, the short id `list` shows in parentheses, or a session title. An
address that matches more than one peer is refused, never guessed. A message carries text and
optional inline attachments (`file`, `snippet`, `context`); `handover` refuses attachments and a
reply reference, because its body is written by the model and it starts a new exchange.

Behaviour worth knowing before you rely on it:

- **A `send` is not queued.** If the target session is gone, the message is reported undelivered
  immediately, with the host's own error (ADR-0005).
- **A timeout is not a cancellation.** After an `ask` times out, the question stays in the recipient's
  hands; an answer that arrives later is delivered as an ordinary message instead of being dropped.
- **One question at a time.** A session with an outstanding question cannot start another, two
  sessions cannot ask each other simultaneously, and while a session holds an unanswered question a
  `send` to anyone but the asker is refused.
- **Peers expire.** A session whose host stopped running disappears from `list` after `rosterTtlMs`.
- **A peer appears once its host has noticed it.** An instance can only learn that a session exists from an
  event about it — being created counts — or from one call that reads the roster by that session itself:
  `list`, `list-cwd`, `send`, `ask`, `reply` or `handover`. (`status`, `pending` and `cancel` do not publish
  the caller, so a session that only checks its own status stays invisible to everyone else.) A session
  that has been idle since its location's instance started is therefore simply not on the roster yet, even
  though the tool is available inside it; the fix is one turn. This is why an empty `list` usually means
  "nobody has done anything yet", not "nothing is running".

## Subagents

A subagent session reaches the session that spawned it through the same tool. One caveat comes from
the host, not this plugin: a parent that spawned its child in the foreground is parked inside the
`subagent` call and cannot read its inbox until that call returns. An `ask` to such a parent is
refused at once with guidance instead of waiting out the timeout, and a `send` is delivered but read
only when the call returns. **A parent that wants to be asked must spawn the child with
`background: true`.** The plugin registers a skill with this text, so a parent sees it while deciding
how to spawn (ADR-0002).

## How it works

Each plugin instance publishes the sessions it serves to opencode's plugin storage — shared per
plugin id across every location and durable across restarts — with a heartbeat, and reads the whole
registry back. Delivery is one `ctx.session.prompt` call, so a session in another project directory
or another server process on the same machine is reached the same way. Questions and answers route
through the same storage, which is what lets the instance that serves the answering session be a
different one from the blocked asker. [`docs/research/`](./docs/research) holds the version-pinned
measurements this rests on, and [`CONTEXT.md`](./CONTEXT.md) the vocabulary.

## Security

The trust boundary is the operating-system user, not the plugin: no credential is read, no traffic
leaves the machine, and no peer authentication exists. Any same-user process that can reach the
rendezvous can register as a peer and read or write messages. [`SECURITY.md`](./SECURITY.md) states
the boundary, what a same-user process can still do, and the refusals that are deliberate.

## Development

```bash
bun install
bun test          # unit and seam tests
bun run typecheck
bun run harness   # boot a throwaway opencode instance and check the plugin loads
bun run harness --help
```

The harness owns its own XDG directories, database and port, hashes the developer's
`~/.local/state/opencode/service.json` before and after the run, and never touches the live service.
[`docs/development-plan.md`](./docs/development-plan.md) describes the module boundaries and the
milestones; [`CONTEXT.md`](./CONTEXT.md) and [`docs/adr/`](./docs/adr) record the vocabulary and the
decisions.

The behaviour being ported is [`nicobailon/pi-intercom`](https://github.com/nicobailon/pi-intercom)
v0.17.0 (MIT), re-expressed on opencode's plugin API rather than on a broker daemon. This project is
not affiliated with it.

## License

MIT
