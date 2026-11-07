# A session's scope is mutable; configuration only chooses where it starts

Status: accepted

Context: the scope is the visibility partition: only sessions in the same scope see and reach each
other. It was fixed per location by the plugin's `scope` option, so every session an instance served
belonged to the same partition until the directory was reconfigured. A person working in several
groups at once had no way to put one session next to another group without changing the
configuration for every session at that location.

Decision: a session's scope is a property of the session, published on its roster row. The configured
`scope` is the default it starts in; `/peers-scope <scope>` moves the session into another
partition and `/peers-scope default` moves it back. The server registers the command for clients
that support server commands; the TUI retains a local entry with a confirmation toast. Both use the
same roster operation, also exposed through the `setScope` RPC, at the
location that serves the session, republishes the row, and announces the change. `list`, `send`,
`ask`, `status` and the dialog resolve in the caller's current scope. The move survives an instance
reload because it is read back from the row before the row is republished.

Considered options: keeping scope fixed and adding a view-only group label (rejected: two partitions
that look alike but behave differently); one instance per group (rejected: a directory would need
duplicate plugin entries, and the move would still be a configuration change).

Consequences: any session can join any scope and read or message its peers; the partition expresses
intent, not a security boundary (ADR-0004 already puts the trust boundary at the operating-system
user). A session that moves keeps its row's title, status and policy, so other sessions see the
move as a row changing scopes rather than an arrival. Rows record the scope the serving instance
last published; a session that moves between directories keeps its scope only if its row survives
the move, and a row reclaimed by the TTL before the successor adopts it falls back to the configured
scope.
