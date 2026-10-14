# Use opencode's in-process primitives as the transport, not a broker process

Status: accepted

Context: `pi-intercom` — the feature being ported — routes messages through a machine-wide broker
daemon: an auto-spawned process owning a Unix socket, a length-prefixed JSON protocol, liveness sweeps,
a spawn lock, rate limits and frame caps. In opencode v2 a plugin runs **in the same process as the
server** and receives an in-process client: `ctx.session.prompt({ sessionID, text, delivery })` reaches
any session id it knows, including one in a different project directory or in another server process
(measured in `docs/research/plugin-instance-scoping.md`), and `ctx.storage` is shared per plugin id
across locations and survives restarts.

Decision: no daemon, no sockets, no custom wire protocol. Message delivery is `ctx.session.prompt`;
the rendezvous between plugin instances — peer roster and ask/reply routing — is `ctx.storage`.

Considered options:

- **A faithful broker daemon.** Rejected: it re-creates process lifecycle, liveness, spawn locking and
  rate-limiting machinery the host already provides, in exchange for no capability we need.
- **HTTP to the local service**, using the password in `~/.local/state/opencode/service.json`.
  Rejected: it buys nothing (only plugin-equipped sessions can answer us anyway) while adding a
  credential read and a dependency on an undocumented file — see ADR-0004.
- **Reading opencode's SQLite tables directly.** Rejected: couples us to internal schema for no gain
  over `ctx.storage`.

Consequences: no liveness protocol, spawn lock, frame cap or rate limiter to own; delivery timing is
bounded by the host's inbox semantics (`steer` vs `queue`); a cross-process ask/reply needs a
storage-backed hop, so the asker polls storage while an ask is outstanding; cross-machine messaging is
out of scope — the original's SSH relay is not ported.
