# Trust boundary is the operating-system user; no credentials are read

Status: accepted

Context: `pi-intercom` trusts its local transport plus session-id exclusivity, has no peer
authentication, and marks its cross-machine relay explicitly unverified (`trust:"ssh-asserted"`). This
package is meant to be published, while the host keeps a password file
(`~/.local/state/opencode/service.json`) that would grant access to every session on the machine.

Decision: the trust boundary is the user's own opencode state — same machine, same operating-system
user. We do not read the service password, do not read opencode's internal tables, and provide no peer
authentication. Visibility between peers is partitioned by a configured scope; there is no broadcast
action.

Considered options: reading `service.json` for a machine-wide session list (rejected in ADR-0001), and a
per-peer allowlist (deferred until a real need appears).

Consequences: any same-user process that can reach the rendezvous can register as a peer and send or
read messages; cross-user isolation is not attempted; the plugin must not log session content or
credentials beyond what a tool result returns. A future release adding cross-machine support must
revisit this ADR.
