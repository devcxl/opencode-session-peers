# One first automatic correction, behind a controlled grant and verified runtime

Status: proposed (repaired-host protocol passed; final implementation review pending)

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
- A permit does not close the correction attempt automatically. A real report
  from the current target after the receipt is required: progress with a new
  result reference recovers; completed with a new result reference records
  business completion while the attempt stays receipted; a new active waiting
  report closes the round as a normal wait. Pause/end alone, activity only, an
  old reference, a non-target reporter, or an overdue/cleared wait do not close
  it. A correct receipt without a permit records seen/refused without starting
  business. Evidence-based recovery is not resume, ownership recovery or
  transfer; a displayed safety pause is not a resume control.
- Automatic sending requires a static verified runtime tuple. Only
  `2.3.0-watchdog-location.1/linux/x64` is accepted after the real repaired-host
  protocol passed; stock `2.3.0` failed and remains unsupported. No config,
  environment variable or model input can bypass this gate. New candidate tuples
  belong only in isolated verification builds until their real protocol passes.
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
