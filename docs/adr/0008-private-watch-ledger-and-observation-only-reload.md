# Keep watch authority in a private ledger; reload only observes

Status: accepted

The watchdog needs atomic task identity, idempotent enrollment and durable cumulative correction
accounting. Shared `ctx.storage` remains the roster and ask/reply rendezvous in ADR-0001, but its
read/write API cannot enforce the watchdog's transactional invariants. As approved in
[spec #58](https://github.com/devcxl/opencode-session-peers/issues/58), use a plugin-owned
Bun SQLite ledger and a separate identity-only anchor, never the host's private database or a
storage mirror of quota and authority. This extends ADR-0001 without adding a broker or changing
existing messaging transport.

Opening validates the fixed canonical non-symlink path, identity, versions, permissions and
supported SQLite build. Missing or mismatched established state fails closed rather than
recreating task history or quota. This adds a local persistence dependency: an unsupported
ledger disables watch operations without disabling ordinary Peers communication. File permissions
do not authenticate other processes running as the same OS user.

A new activation may read old tasks but does not inherit the previous Watch Executor's authority.
An owner string, heartbeat or SQLite lock proves neither a unique host nor that old calls have
settled. The #59 slice therefore remains observation-only after reload, with correction,
recovery and transfer unavailable; later tickets must provide the required receipts and
Quiescence Records before enabling controlled transfer. No force-takeover or quota-reset path is
provided, and no database transaction can retract an already accepted message or prove host
execution exactly once.
