# A plugin's in-process `session.prompt` reaches a session created by another server process (opencode v2.0.29)

Research date: 2026-10-15 (host timezone +08:00; log timestamps are UTC).
Host binary: `/usr/bin/opencode` = **opencode v2.0.29**, 211,064,288 bytes, md5
`6653617a3eb61ea49192fbd7325d4d3a`.

This closes question 9.1 of `opencode-multiprocess-topology.md` ("`ctx.session.prompt` from a plugin to a
session whose turn is executed by a *different* server process was not directly exercised"). Everything
below is **[ran]**.

## Method

Three isolated servers shared one `XDG_DATA_HOME` (one database) and one `XDG_STATE_HOME`/`XDG_CACHE_HOME`,
each with its own `XDG_CONFIG_HOME` and port; two of them loaded the plugin under development
(`.worktrees/peers/t5-send`) from their `plugins` array:

| Server | Port | Config | Locations it served |
| --- | --- | --- | --- |
| 1 | 49737 | plugin | `projA`, `projB` |
| 2 | 49738 | **no** plugins | none — used only to delete a session out of band |
| 3 | 49739 | plugin | `projD` |

Session `A` (`Sender A`, `projA`) was created through server 1; session `D` (`Peer D`, `projD`) through
server 3, which published it into plugin storage. `A` then sent `D` a message with
`peers({action:"send", to:"Peer D", ...})`, so the delivery was a `ctx.session.prompt` issued by server
1's plugin instance for a session **server 3 created and first ran**.

## The finding

**It works.** A's tool result was `Message sent to Peer D`, with metadata
`{"delivered":true,"delivery":"queue","sessionID":"ses_ec3248e03ffe…","title":"Peer D","directory":"…/projD"}`,
and D's transcript — read back through server 3 — contained the body:

```
user: "**From Sender A** (/tmp/opencode/t5-send/projA)
To reply: peers({ action: "reply", message: "..." })

T5-CROSSPROC hello from projA on another server process."
idle: succeeded        (D's own turn: 149 output tokens, cost 0)
```

Two consequences beyond the delivery itself, both observed in the same run:

* **The roster rendezvous is cross-process.** `D`'s record (`v1/peers/ses_ec3248e03ffe…`) was written by
  server 3's instance — a distinct `instanceID`, `directory …/projD` — and read by server 1's instance,
  which resolved `"Peer D"` by title from it. Shared plugin storage is the only channel involved.
* **A session deleted through *another* process leaves its roster record behind.** `C` (`Gone Soon`,
  `projB`) was deleted through server 2; `GET /api/session/C` on server 1 returned **404** while `C`'s
  record — heartbeat-fresh, written by the `projB` instance — was still in storage, because
  `session.deleted` is a process-scoped event and the publisher never saw it. A send to `C` then failed
  closed with `Message to "Gone Soon" was not delivered: the host no longer runs that session.` This is
  the case the roster TTL exists for, and the case a `send` must report rather than swallow.

## What this does **not** say

* Which process drained the turn (the server logs did not record the run for either server). What is
  measured is that the message reached `D` and that `D`'s run completed with cost and tokens.
* Anything about two opencode installs on different machines, or different `XDG_DATA_HOME` directories:
  the shared database is the premise here, not a finding.
* Whether the HTTP/DB channels the topology note describes are needed for anything this plugin does.
  On this evidence, they are not: storage plus `session.prompt` covers the cross-process case.

## Cleanup

All three servers were SIGTERMed (ports 49737-49739 closed, no listeners left), their isolated
`data`/`state`/`cache` directories deleted, and the isolated sessions were confined to those databases.
`~/.local/state/opencode/service.json` was byte-identical before and after (`md5sum -c` → OK); the
developer's live service was never restarted or signalled. Scratch kept under `/tmp/opencode/t5-send/`:
`evidence/` (tool results and transcripts quoted above), `server*.log`, and the isolated configs.
