# Security

## The trust boundary: one machine, one operating-system user

This plugin lets opencode sessions talk to each other inside **one operating-system user's own
opencode state**. Two sessions that can message each other are two sessions of the same user, on the
same machine:

- the rendezvous between sessions is opencode's plugin storage — roster records, questions and
  answers living in the user's own opencode database, keyed by this plugin's id;
- delivery is an in-process `session.prompt` call made by that user's own opencode server (ADR-0001);
- there is no daemon, no socket, no custom wire protocol and no network service.

What follows from that:

- **No credential is read.** The plugin never opens `~/.local/state/opencode/service.json` (the
  host's password file), `auth.json`, or any other credential store, and it holds no credential of
  its own. It calls only the host APIs it runs inside: session lookup and prompting, plugin storage,
  the event stream, tool registration and skill registration.
- **Nothing leaves the machine.** The plugin makes no network requests.
- **No peer authentication exists.** A peer is not proven to be anything. A session is addressable
  because the host says it exists and because a record for it is in the user's own plugin storage;
  there is no token, handshake or allowlist behind that.

## What a same-user process can still do

The boundary is the operating-system user, not the plugin. Any process running as the same user that
can reach the rendezvous can:

- register itself as a peer by writing a roster record, and then be listed and messaged like a
  session;
- read, write or delete ask and reply records, which means it can read a question in flight or answer
  one;
- call the host API directly and prompt any session, which is exactly what this plugin does.

This plugin cannot prevent any of that, and does not try to. It has no secret to keep and no identity
to check; the storage it uses belongs to the user it runs as.

Tool results and warnings are the only things this plugin reports outwards. Warnings name sessions by
id and the operation that failed; they never carry message content.

## Deliberate refusals

These are decisions, not omissions. See `docs/adr/0004-same-os-user-trust-boundary.md`:

- **No cross-machine messaging.** The SSH relay of the behaviour this plugin ports is not
  implemented. A relay would need authentication this plugin does not have.
- **No per-peer allowlist.** Considered and deferred until a real need appears (ADR-0004). The
  configuration offers a `scope`, which partitions visibility into disjoint rosters; a partition is
  not an authorisation, and any session in the same scope may message any other.
- **No cross-user isolation.** Two operating-system users are two separate opencode states; nothing
  is attempted across that line.
- **No human-facing confirmation.** There is no UI, no approval prompt and no queue for a human to
  review. A refusal is reported to the calling model, which is the only actor this plugin talks to.

## Reporting

Report security issues at <https://github.com/devcxl/opencode-session-peers/issues>. Do not put
credentials, tokens or other private data in a report.

## Scope of this document

It describes the plugin in this repository at the version in `package.json` (0.1.0). It is not a claim
about opencode itself or about any other plugin sharing the same server.
