# The supervisor channel relies on non-blocking children and fails fast when the parent is parked

Status: accepted

Context: `pi-intercom` gives subagent children a blocking supervisor channel (`contact_supervisor`)
whose entire value is that the child waits for the parent to decide. Measured on opencode 2.0.27
(`docs/research/subagent-lifecycle.md`, `docs/research/subagent-background-mode.md`): a **foreground**
subagent parks the parent's turn in `Job.block` with no timeout; a child's `delivery:"steer"` message is
admitted in ~2 ms but delivered only at the millisecond the subagent tool returns, and a child that then
waits for the parent deadlocks (`STILL_BLOCKED_AFTER_15000ms`). With `background: true` the tool returns
in ~34 ms, the parent stays drainable, and a child's message woke the parent and was answered while the
child was still running.

Decision: do not add a separate supervisor tool. A child reaches its parent through the same `peers`
tool; before such an ask, detect whether the parent is parked on the caller (its running tool call is
the `subagent` call for this session) and, if so, fail fast with actionable guidance instead of stalling
for the ask timeout. Ship model-facing documentation stating that a parent which wants to be asked must
spawn the child with `background: true`.

Consequences: no structured-interview action in v1; the parked-detection reads the parent's message
context and must be re-verified against host upgrades; a child whose parent used the default foreground
spawn receives an immediate explanatory failure instead of a ten-minute timeout.
