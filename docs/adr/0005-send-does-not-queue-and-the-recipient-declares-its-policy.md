# A send is not queued, and the recipient declares the inbound policy the sender enforces

Status: accepted

Context: `pi-intercom` ran a broker that owned a mailbox, so a `send` to a peer that had gone away waited
there and could be redelivered to a session that later reappeared with the same name and directory. Its
receiving extension also decided locally whether an inbound message was allowed to start a turn
(`inboundTrigger: always | replies | never`). Neither is available here: there is no broker, and delivery
is a single host call made by the *sending* instance, which leaves the receiving side no hook to enforce
anything.

Measured on opencode 2.0.29 (`docs/research/cross-process-prompt.md`): an in-process
`ctx.session.prompt` does reach a session that another server process created. So the only target a
`send` can miss is a session id that no longer exists.

Decision:

1. **A `send` is not queued.** A refused target is reported undelivered, immediately, with the host's own
   error. A queue would delay a terminal failure to its TTL and could lose the message silently if the
   sending instance unloads first, in exchange for pruning and a claim protocol so two instances cannot
   deliver the same message twice.
2. **Inbound policy travels with the roster record.** Each session publishes its configured trigger; the
   sending instance reads the target's declaration and honours it — `never` refuses, `replies` admits
   only an exchange (an ask, or an answer to one), `always` delivers. A declaration that cannot be read
   is treated as refusing.

Considered options: keeping a sender-side queue keyed by session id (rejected: the id never returns, so
it delays the same terminal failure); a queue keyed by title and directory as the original did
(rejected: titles are auto-generated and change, so the redelivery would be a guess); enforcing the
trigger on the receiving side (impossible — no hook); dropping the trigger from the configuration
(rejected: it is the only lever a session has over what may start a turn in it).

Consequences: a peer deleted mid-flight loses the message and the caller is told
(`retryable: false`); every roster record carries one more field; a refusal can name the peer's policy
because that policy is already visible to peers in scope — the same visibility ADR-0004 draws; and the
queue-pruning work the development plan held open is not needed.
