# A tool result whose metadata holds `undefined` is never delivered (opencode v2.0.29)

Research date: 2026-10-15 (host timezone +08:00; log timestamps are UTC).
Host binary: `/usr/bin/opencode` = **opencode v2.0.29**, reported by `/usr/bin/opencode --version`;
211,064,288 bytes, mtime 2026-10-15 00:56:14 +08:00, md5 `6653617a3eb61ea49192fbd7325d4d3a`.
The other research notes in this directory are pinned to **v2.0.27** (210,367,968 bytes); the binary was
replaced on this machine the night before this experiment, which is why the numbers differ. Everything
below was run against the 2.0.29 binary quoted above.

Method: one fully isolated opencode instance (own `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` and
`XDG_CONFIG_HOME`, its own database, port 49733) with the plugin under development
(`/home/devcxl/Projects/OpenCodePlugins/.worktrees/peers/t4-roster`) installed from the isolated config's
`plugins` array, one real session in each of two directories, and throwaway probe plugins beside it in the
isolated config directory. A free model (`opencode/cat-jam-free`) ran the turns. Everything below is
**[ran]**.

## The finding

**A tool result whose `metadata` contains an `undefined` value anywhere is never delivered.** The tool
body executes; the call then stays `running` for the rest of the turn and the model receives no result at
all — no error text, nothing to read. The transcript records it as `aborted` once the turn moves on
(`Tool execution interrupted: <tool>`), and the model itself reports "Tool result missing".

## How it was observed

**1. The occurrence.** A `peers list` tool call in a live session never came back, while `peers status` in
the same turn returned normally. Server-side debug logging (temporary, reverted) showed our code finished
in a millisecond:

```
[dbg] list: start 1792020014205
[dbg] publish: start 1792020014205
[dbg] publish: got session 1792020014205
[dbg] publish: stored 1792020014206
[dbg] live: scanning 1792020014206
[dbg] live: scanned 1 1792020014206
[dbg] list: roster read 1792020014206
```

The abort text in the session transcript, for the same call:

```json
{"type":"error","message":"Tool execution interrupted: peers","status":"aborted"}
```

**2. The host calls inside a tool call are healthy.** A probe tool invoked in the same instance ran
`get`, `set`, `scan` and `session.get` from inside `execute`:

```
get(probe/tool) ok in 0ms: undefined
set(probe/tool) ok in 1ms: undefined
scan(probe/) ok in 0ms: {"entries":[{"key":"probe/tool","value":{"at":1792019948229}}]}
scan(v1/peers/) ok in 0ms: {"entries":[]}
session.get(caller) ok in 0ms: {"id":"ses_ec34dabcfffeuDzf0nC90dJBLs", ...}
```

(`scan(v1/peers/)` was empty because storage is namespaced per plugin id, not because scanning failed.)

**3. The controlled pair.** A probe plugin registered three tools that differ only in their metadata —
`{ present: 1, absent: undefined, nested: { deep: undefined } }`, `{ present: 1, absent: null }` and
`{ present: 1 }` — and the model was asked to call all three. From the transcript:

```
TOOL probe_meta_undefined status= running   content= null                             meta= {}
TOOL probe_meta_null      status= completed content= [{"type":"text", ...}]           meta= {"present": 1, "absent": null, "truncated": false}
TOOL probe_meta_plain     status= completed content= [{"type":"text", ...}]           meta= {"present": 1, "truncated": false}
```

**4. The fix upstream of the host.** Building the details object without the absent keys (rather than
setting them to `undefined`) made the same call deliver on the same host, from two directories:

```
**Current session:**
• Peers list request (ses_ec34) — /tmp/opencode/t4-roster/iso/projA (cat-jam-free · busy) [self]

**Other sessions:**
• Peers list request (ses_ec34dabc) — /tmp/opencode/t4-roster/iso/projA (cat-jam-free · idle)
```

## What is safe

* `null` **is** fine: `probe_meta_null` was delivered with `"absent": null` in its metadata.
* An absent key is fine, and is what the plugin now writes.
* `ctx.storage.set` is **not** affected: a value with an `undefined` property is stored as JSON, with that
  key left out of the stored object. The roster records written from this plugin (which carry
  `parentID: undefined` for top-level sessions) were stored and read back intact.
* `content` is unaffected, because it is a string; only `metadata` was exercised.

## Consequence for plugin authors

Never place `undefined` in tool metadata. Build details conditionally, or strip it on the way out; this
plugin does the latter once, in `src/host/tools.ts`, so no action has to remember, and `test/fake-host.ts`
refuses such a result so a regression fails CI instead of hanging a real turn (see issue #4).

## What was **not** measured

* **Why** the host drops the result: the mechanism was not traced. Only the trigger and the outcome.
* An `undefined` **array element** on its own. The sanitiser treats it as JSON does (`null`), and no
  measurement says otherwise.
* Whether other host surfaces that carry plugin-authored metadata (hooks, RPC) behave the same way.

## Appendix — artifacts

Under `/tmp/opencode/t4-roster/` (scratch, isolated instance since torn down):

| Path | Contents |
| --- | --- |
| `evidence/peers-list-A.txt`, `evidence/peers-list-B.txt` | the `peers` tool call and result from each session |
| `evidence/peer-records-after-shutdown.txt` | plugin-storage rows after the instance was SIGTERMed |
| `evidence/isolated-server.log` | the isolated instance's full server log |
| `iso/` | the isolated config, its two probe directories, and the throwaway config-dir plugins (data/state/cache removed) |
