# Stage-one host verification: OpenCode 2.2.5

Date: 2026-11-06. Host: `/usr/bin/opencode` reports `opencode v2.2.5`;
the project type dependency is `@opencode/plugin` 2.0.16. These are distinct
versions and the earlier 2.0.27/2.0.29 notes are not proof for this host.

## Observed

- The baseline `bun test` passed 302 tests and `bun run typecheck` passed.
- `bun run harness --stub --scratch <isolated-directory>` passed 21 checks on
  2.2.5. One server served two project locations; send, unanswered ask timeout
  and answered ask were exercised using the local stub provider. This is not a
  two-process ask/reply test.
- `bun scripts/harness/cross-process.ts <isolated-directory>` started two
  servers sharing an isolated database and used a test-only tool hook to log
  process ID, session ID and action, without logging message contents. The ask
  ran in pid 4155521 and the reply ran in pid 4155540; the ask returned the
  reply. Process IDs are evidence from that run, not stable identifiers.
- A repeat also stopped the second server after the reply, verified that its
  endpoint no longer answered, and verified that the first server still answered.
  It did not send another peer message or restart the stopped process.
- An earlier automatic reply attempt ran both tools in the first server despite
  two servers being active. Merely starting two processes or creating a session
  through each one is therefore not evidence of a cross-process handshake.
- The isolated harnesses stopped their test servers and stub; the standard
  harness reported the live service registry byte-identical before and after.

## Version-pinned source review

The 2.2.5 source has a `get(sessionID)` before prompt preparation and admission,
and returns the admission record after waking execution:
[`session.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/session/session.ts).
The plugin storage namespace and adapter are in
[`plugin/host.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/plugin/host.ts);
the backing [`kv.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/kv.ts)
uses a single-key upsert, not a compare-and-set. A scan across multiple pages is
not a transaction. The source indicates that prompt hooks run in the target's
location context before admission, but whether and how to use a hook for inbound
policy was not tested by this change.

## Limits

The cross-process run explicitly prompted the second server to reply. It did not
measure automatic reply process placement, busy-delivery timing, real-host
parallel cancellation, failure after admission, storage atomicity, or recovery
from process death. Those remain unverified on this host. Current
[OpenCode server plugin documentation](https://opencode.ai/v2/docs/build/plugins/server)
lists storage get/set/remove/scan and returns an inbox user record from prompt;
its current contents are not a substitute for version-pinned host source.

The plugin conservatively treats any `session.prompt` exception as an unknown
outcome until the exact failure semantics are verified against the running
version. It does not infer non-admission from an error string.
