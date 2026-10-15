# A blocked tool call, and the ask/reply handshake across two plugin instances (opencode v2.0.29)

Research date: 2026-10-15 (host timezone +08:00; log timestamps are UTC).
Host binary: `/usr/bin/opencode` = **opencode v2.0.29**, 211,064,288 bytes, md5
`6653617a3eb61ea49192fbd7325d4d3a` — the same binary as
`tool-result-metadata-undefined.md`, the other note pinned to 2.0.29.

Method: one fully isolated opencode instance (own `XDG_DATA_HOME`, `XDG_STATE_HOME`,
`XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, its own database, its own free port, its own
`OPENCODE_SERVER_PASSWORD`), the plugin under development
(`/home/devcxl/Projects/OpenCodePlugins/.worktrees/peers/t6-ask`) installed from each
project's `.opencode/opencode.json`, and one real session in each of two directories
(`projA` → "Sender A", `projB` → "Receiver B"). To get a model served, the developer's
local provider plugin (`half-cabbage-provider.ts`) and `auth.json` were copied into the
isolated dirs for the run and deleted at teardown. Everything below is **[ran]**.

## 1. A tool call blocks, and the host keeps it running

`Sender A` was told to call `peers({ action: "ask", to: "<Receiver B>", message: "…" })`.
The transcript carries the call as a normal tool part, and while the answer was pending
its state was `running`; the turn stayed alive for the whole wait:

```
# captured 2,082 ms after the prompt, from /api/session/<A>/context
"name": "peers",
"state": { "status": "running", "input": { "action": "ask", "to": "ses_ec2f0e531ffeCZRnJwM1fFgqF7", … } }

# the same part, once the answer arrived (times in epoch ms)
"time": { "created": 1792025766134, "ran": 1792025766563, "completed": 1792025771580 }
```

Roughly **5.0 s** between `ran` and `completed`, spent inside the tool call, and `Sender A`'s
run ended `succeeded`. The host did not time the call out, did not abort the turn, and the
call's result arrived in the same turn that issued it.

## 2. The answer reached the blocked call from the other instance

Two directories are two plugin instances in one server process. `Receiver B`'s turn was
started by the question (`queue`, both sessions idle); its model called `peers pending`,
then `peers reply` naming the question id it found there, and *that* call wrote the answer
where the other instance's blocked call was polling:

```
# Sender A's peers("ask") tool result, as the host recorded it
"content": [{ "type": "text", "text": "**Reply from Receiver B:**\nT6-LIVE-ANSWER" }],
"metadata": { "answered": true,
              "askID": "12c4f35e-b2fb-4bda-ace9-a08cc4a4588b",
              "sessionID": "ses_ec2f0e531ffeCZRnJwM1fFgqF7",
              "title": "Receiver B", "directory": "/tmp/opencode/t6-ask/live/projB",
              "self": false, "model": "deepseek-v4.1-flash", "status": "idle" }

# Receiver B's two tool calls, same askID
peers({"action":"pending"}) -> "**Pending asks:**\n- Sender A · 12c4f35e-… · 2s ago · T6-LIVE-ASK: …"
peers({"action":"reply","replyTo":"12c4f35e-…","message":"T6-LIVE-ANSWER"}) -> "Reply sent to Sender A"
```

The plugin's storage held the question while the asker was blocked, and only the roster
records afterwards — the ask was consumed, not left behind:

```
# during the blocked call: the question, plus both roster records (both sessions busy)
session-peers:v1/asks/12c4f35e-…  {"askID":"12c4f35e-…","askerSessionID":"ses_ec2f0e539ff…","askerInstanceID":"31d24eb4-…",
                                   "askerTitle":"Sender A","targetSessionID":"ses_ec2f0e531ff…","question":"T6-LIVE-ASK: …",
                                   "createdAt":1792025766570,"expiresAt":1792026366570}
session-peers:v1/peers/ses_ec2f0e531ff…  {…"status":"busy"…"instanceID":"54cd6c07-…"}
session-peers:v1/peers/ses_ec2f0e539ff…  {…"status":"busy"…"instanceID":"31d24eb4-…"}

# after the handshake: no ask row, both roster records idle
session-peers:v1/peers/ses_ec2f0e531ff…  {…"status":"idle"…}
session-peers:v1/peers/ses_ec2f0e539ff…  {…"status":"idle"…}
```

Two different `instanceID`s asked and answered: the route between them is storage alone, so
no in-memory short circuit is needed (and none exists) for a same-location ask either.

## 3. The tool is reachable directly, but this model needed two tries

`peers` is registered with `options: { codemode: false }`, so the host exposes it to the
model as a direct tool — and the model called it directly. It got there the hard way,
though: it first tried `execute` + `tools.peers` (the Code Mode catalog, which does not
contain `peers`), then `search`, and only then called the tool. Three steps, ~2 s, no harm
to the handshake; recorded because the model-facing surface is part of this plugin's
contract (ADR-0003) and the tool description is what a future prompt should lean on.

## What was **not** measured

* Interrupting a turn that is blocked inside `ask` through the host's own surface (the
  abort path is covered at seam 2, where `test/fake-host.ts` hands the tool call an
  `AbortController` signal).
* The 10-minute timeout end to end (covered at seam 2 with a 60 ms configuration).
* A second **server process**: both instances here live in one `opencode serve`. The
  cross-process route for a prompt is measured in `cross-process-prompt.md`, and storage is
  machine-wide by ADR-0001, but the two together were not run.
* The parked-parent check, the handover, and scope partitioning — later tickets.

## Appendix — artifacts

Under `/tmp/opencode/t6-ask/` (scratch, instance torn down; `service.json` md5 unchanged):

| Path | Contents |
| --- | --- |
| `live-run.log` | the whole run: instance pid/url, model availability, session ids, the blocked-state capture, the waits, the teardown |
| `evidence/A-context-blocked.json` | Sender A's transcript while the `peers` call was `running` |
| `evidence/A-peers-calls.json`, `evidence/B-peers-calls.json` | the `peers` tool calls of both sessions, with timing, input, result and metadata |
| `evidence/kv-during-blocked.txt`, `evidence/kv-after-handshake.txt` | the plugin's storage rows while blocked and afterwards (read from the isolated SQLite) |
| `evidence/A-context-final.json`, `evidence/B-context-final.json` | the full transcripts as read back through the instance API |
| `live/` | the isolated config (its own provider plugin and `auth.json` removed), data, state, cache, and the two project directories |
