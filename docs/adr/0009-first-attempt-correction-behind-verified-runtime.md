# One first automatic correction, behind a controlled grant and verified runtime

Status: proposed (implementation closed; real host candidate verification pending)

The watchdog now has a real side-effect path, but it must not become an
unbounded wakeup mechanism. This ADR records the chosen boundary for #61.

## Decision

- The ledger keeps a permanent cap of three attempts per watched task. The
  executor in this build may use only the first ordinal; later attempts belong
  to a separate policy decision. Attempts are permanent and never refunded.
- One per-task serial executor runs: gate, durable reserve, separated recheck,
  one claim, closing check, one `queue` call, monotonic outcome. No database
  transaction is held across the prompt. Recheck failure aborts an unclaimed
  reservation without sending; unknown or rejected delivery is never replayed.
- A correction grant is not a model tool action. It is prepared and confirmed
  through a private controlled-surface RPC, bound to the task initiator, the
  current activation, generation, challenge, terms digest and an explicit
  `single-host-same-location` deployment declaration. The declaration is not
  proof that no other service exists. The same-OS-user boundary is not human
  authentication.
- Each reservation generates an opaque correlation. Only a successful claim
  receives it; the normal panel snapshot never exposes it. The target must
  submit a receipt with its real tool-context session, task, attempt and
  correlation. The first valid receipt issues one continue permit; duplicates
  issue none. A receipt is not recovery.
- Recovery requires new progress and a matching new result reference after the
  receipt; a reused old reference is refused. Waiting/completion remain normal
  target reports. Evidence-based recovery is not resume, ownership recovery or
  transfer; a displayed safety pause is not a resume control.
- Automatic sending requires a static verified runtime tuple. The production
  tuple is empty; no config, environment variable or model input can enable it.
  A candidate tuple may be added only in an isolated verification build, and
  only after the real host protocol passes may it be accepted here.
- Closing is synchronous before any await: mutation, receipt and grant entries
  close first, the observer stops scheduling, tracked executor work settles,
  and the ledger closes last. A late outcome may be recorded monotonically; no
  new queue or permit follows.
- Reload is observation-only. A new activation does not inherit the old owner's
  authority, shows a safety pause, and records an old receipt as seen without a
  permit. No quiescence proof or takeover is invented.

## Consequences

- A normal install remains alert-only even though the executor code exists.
  The capability payload reports first-attempt only when the task gate is ready
  on a verified runtime; manual correction remains unsupported.
- The host queue admission is not a read receipt, the final check and enqueue
  are not atomic, and an already admitted message cannot be retracted. The
  plugin does not claim exactly-once execution.
- The OS user can still read or modify the private ledger; file permissions and
  the identity anchor are not authentication.
- Tests distinguish real host evidence from FakeHost/ledger evidence. A fake
  positive does not add a runtime tuple.
