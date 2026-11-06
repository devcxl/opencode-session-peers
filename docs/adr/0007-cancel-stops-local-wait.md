# Cancel requests a stop to a local ask wait

Status: accepted

`session.prompt` admission does not prove that a recipient has read a message,
and this plugin does not have a proven way to remove a particular admitted
message from the recipient's inbox. Deleting an ask record cannot undo that
admission; it also made the question impossible to answer while leaving the
asker's wait running.

The tool keeps cancellation signals for waits owned by its own plugin instance.
`cancel` signals an active wait from the same session and reports a request; the
`ask` result reports whether it actually stopped. Once stopped, the question
record remains as an ended wait so a later reply can be routed as an ordinary
message. Neither action asserts that the question was withdrawn or that the
recipient stopped work. A stale storage record is not proof of a local waiter.

This is deliberately not a cross-process cancellation protocol. A blocked
session may be unable to make another tool call, and the host's interrupt is a
separate operation. A reply racing cancellation or expiry can still be written
to a reply slot after the asker has stopped: storage exposes no documented
atomic transition to settle that race. The result does not claim that a late
reply is guaranteed in that case. `test/ask-concurrency.test.ts` forces this
interleaving and also shows simultaneous asks passing the read-before-write
guards; those tests describe limitations, not a mutual-exclusion guarantee.
