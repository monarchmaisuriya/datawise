# Datawise: an agent tool for every action in the app

- Date: 2026-11-14 21:33
- Status: done (parts 1 to 5), released as v0.7.0; full, because it adds agent tools that create and change connections, tables and files, and it extends the approval and connection-save contracts
- Repos: datawise   Folders: `server/`, `shared/`, `client/`, `scripts/`, `docs/`
- Files: `server/agent-tool.ts`, `server/agent-actions.ts` (new), `server/agent-requests.ts`, `server/plugin.ts`, `server/pool.ts`, `server/jobs.ts`, `server/store.ts`, `shared/contracts.ts`, `shared/connection-destination.ts` (new), `client/agent-requests.tsx`, `client/connections.tsx`, `client/app.tsx`, `client/query-tab.tsx`, `client/data-tab.tsx`, `client/agent-push.ts` (new), `client/proposal-note.ts` (new), `index.client.tsx`, `server/agent-tools.test.ts`, `server/agent-hook.test.ts`, `shared/client-logic.test.ts`, `OVERVIEW.md`, `README.md`, `CHANGELOG.md`
- Subagents: none

## Context and problem

Datawise is a database client plugin for Paseo. People ask the agents working in Paseo to do database work for them. On 2026-11-14 a person asked an agent to "create connections, save and then open", and the agent answered that both ways it had were blocked: no Datawise tool creates a connection, and screen control of the Paseo app is refused. The person had to do it by hand.

M's requirement, in M's words: "ALL ACTIONS SHOULD BE POSSIBLE VIA THE AGENT" [decided: M, chat 2026-11-14]. The function the solution must perform: for every action a person can take in Datawise, an agent can take it too, through a tool, under the same rules that protect the person's data, except the actions M ruled out below.

Constraints, decided by M in chat on 2026-11-14:

1. **Changes that touch a database, a connection or a file wait for the person's approval** in Datawise's Agent requests. Changes to app-only state (saved queries, query tabs, table views, history) run at once. [decided: M, chat 2026-11-14]
2. **Secrets never pass through an agent.** An agent proposes a connection without its password, key or API key; the person types the secret when approving. [decided: M, chat 2026-11-14]
3. **An agent can never change its own guards:** a connection's environment label, agent access level, agent row access, or write mode; approving or rejecting requests; clearing the agent activity log. [decided: M, chat 2026-11-14]
4. **Agents cannot delete connections.** Deleting a connection also erases its agent activity entries, so it stays the person's, in the app. [decided: M, chat 2026-11-14]
5. **Disconnect waits for approval and is refused while a job runs** on that connection. [decided: M, chat 2026-11-14]
6. **Tab and view changes go to open windows,** which apply them as the person's own change would, so neither undoes the other. [decided: M, chat 2026-11-14]
7. After this plan's independent check, build, review, fix, release and reinstall run without a sign-off stop. [decided: M, chat 2026-11-14]
8. **Connection tests work on any non-production connection**, shared or not, with safeguards: refused while a session-only password has not been entered, and stopped after one failure until the person tests or saves that connection. [decided: M, chat 2026-11-14]
9. **Deleting a saved query waits for approval**, so an agent cannot delete one and save another under its name. [decided: M, chat 2026-11-14]

Production connections stay refused to agents for everything except `datawise_open`, which already asks the person first (v0.6.0).

## Goals / Non-goals

**Goals**

- Every Datawise server action (43 RPCs and one subscription in `shared/contracts.ts`) is either reachable by an agent tool, or on the "Never for agents" list with its reason. A unit test keeps it so.
- An agent can create a connection, have it saved after the person types the secret, and open it, in one conversation.
- Every change an agent makes to a database, connection or file runs, after approval, through the handler the app itself calls, so the app's rules apply to both paths.
- **Metrics:** success: M asks an agent to create a connection, save it and open it, and the only manual steps are typing the secret and pressing Save. Guardrail: no agent tool changes a database, connection, file, guard or the activity log without the person's approval; one unit or conformance check per change tool. Checked by M on 2026-11-21.

**Non-goals**

- No new app features. Each tool maps to an action the app already has.
- No secrets, guard fields, approvals or connection deletes for agents.
- Tempting near-misses, not done here: a general "call any RPC" tool, batch approvals, editing plugin preferences (a client-side settings document the server cannot write), and per-column sharing.

## What is true today

```
agent tool call ──> server/agent-tool.ts (10 tools)
                      ├─ reads: describe, read, count, query, explain, history
                      ├─ datawise_open ──> subscription "agent.opens" ──> every window
                      └─ propose_write / propose_query ──> AgentRequests (in memory)
                                                             │ person presses Approve
                                                             ▼
                              plugin.ts decideAgentRequest ──> adapter.run / planBatch
```

- The agent tools are a fixed list of 10, offered to every agent session by one hook [verified: `server/plugin.ts:135`; `server/agent-tool.ts:591`].
- Tools find a connection by exact name, first match. `shared()` keeps connections shared at names level or above and not production; `withLevel` takes `"read"` or `"propose"` [verified: `server/agent-tool.ts:75-77`, `:161-168`].
- Proposals are held in memory, expire after 30 minutes, at most 5 pending per agent and 20 per connection; a request needs `connectionId`, `ref` and `target` [verified: `server/agent-requests.ts:5-8`, `:13-41`, `:66-75`].
- On approval the server takes the request once, re-checks `agentRowLevel === "propose"` and the target, then `gate(... confirmed: true)` and runs statements, inserts or edits [verified: `server/plugin.ts:247-290`].
- `connections.save` expires every pending request of that connection, then disconnects it [verified: `server/plugin.ts:163-168`].
- Saving keeps every saved secret whose field is left out, whatever else changed [verified: `server/store.ts:172-183`].
- `connections.delete` also deletes the connection's activity entries, history, saved queries, views and tabs [verified: `server/plugin.ts:173-189`].
- `pool.disconnect` closes the connection even while it is busy; only the idle closer checks `busy` [verified: `server/pool.ts:45-49`, `:93-104`].
- `connections.test` returns the driver's error text with secrets removed [verified: `server/plugin.ts:191-202`].
- Dropping or emptying a table needs the exact name typed, then runs with the connection's write mode [verified: `server/plugin.ts:384-394`].
- `export.start` expands `~`, refuses an existing file, creates parent folders and writes anywhere [verified: `server/plugin.ts:570-581`]. `export.default-path` resolves the export folder [verified: `server/plugin.ts:610-618`].
- `import.preview` with a path and `sqlite.inspect` read files on the daemon machine [verified: `server/plugin.ts:338`, `:465-466`].
- The connection form applies `prefill` only to a new connection, and `ConnectionPrefill` is name, engine, file and safety [verified: `client/connections.tsx:142`, `:158`].
- Query tabs and table views are loaded once by the open window and saved whole on the next change [verified: `client/query-tab.tsx:51-95`; `client/data-tab.tsx:50`, `:132`].
- Handlers rely on Paseo having parsed their input; `guard` only removes secrets from errors; `data.destroy`, `import.start` and `export.*` have no production check of their own [verified: `server/errors.ts:30-38`; `server/plugin.ts:384-394`, `:484-500`, `:570-581`].
- A new value in the activity log's `action` enum makes an older Datawise refuse the whole file; an added optional field does not [verified: comment at `shared/contracts.ts:29-30`; v0.6.1 added `unit` this way].

App actions and agents today:

| Group | App actions (RPC names) | Agent today |
| --- | --- | --- |
| Connections | `connections.list`, `.save`, `.delete`, `.test`, `.disconnect`, `.unlock`, `.clear-ssh-fingerprint`, `sqlite.inspect` | list only |
| Structure | `schema.databases`, `schema.schemas`, `schema.objects`, `schema.describe`, `attachments.structure` | tables and columns |
| Rows | `data.read`, `data.count`, `data.read-row`, `data.write`, `data.write-batch` | read, count, propose |
| Objects | `data.destroy` | none |
| Queries | `query.run`, `history.list`, `history.clear`, `saved.list`, `saved.save`, `saved.delete` | reads, proposals, history list |
| Files | `import.preview`, `import.start`, `export.start`, `export.text`, `export.default-path` | none |
| App state | `views.get`, `views.save`, `workspace.tabs.get`, `.save`, `workspace.place.get`, `.save` | open a place or query tab |
| Requests and log | `agent-requests.list`, `.get`, `.decide`, `agent-activity.list`, `.clear` | own request status |
| Jobs | `jobs.status`, `jobs.cancel` | none |

## Threat model

```
 untrusted: agent input (may be steered by text inside rows it read)
        │
        ▼
 [B1] tool input schema ── no guard fields, no secrets, bounded sizes
        │
        ├─ at once: reads, app-only state ──> [B2] level check, production refused
        │
        └─ proposal ──> request (in memory) ──> [B3] approval card shows the full effect
                                                     │ person Approves or Saves the form
                                                     ▼
                                    [B4] re-check level, target, production, busy
                                                     │
                                                     ▼
                                    app handler ──> database, connection store, file
```

| Threat | Boundary | Control |
| --- | --- | --- |
| Agent sets a guard field or a secret | B1 | Tool inputs are allowlists without them; zod strips unknown keys; unit test sends them |
| Agent repoints a saved connection so its password goes elsewhere | B3, B4 | A proposal that changes any target field clears the saved secrets and resets sharing to none at save; the form lists every changed field, old and new |
| Agent writes a startup file through export | B1, B4 | Export takes a file name only, placed in the export folder with the format's extension; the card shows the full path |
| Agent reads files on the daemon machine | B1 | No path-reading tool; import takes inline text; SQLite proposals carry a path only the person's Save opens |
| Agent cuts off the person's running job | B4 | Disconnect needs approval and is refused while the connection is busy |
| Agent overwrites a saved query the person runs later | B1, B3 | Agents create saved queries only, never replace one; an existing name is refused; deleting one needs approval |
| Agent's new host collects a password the person types | B3 | The form marks every agent-proposed value, and the host above all, as proposed by the agent; accepted risk, since the person reads the host before typing |
| The form's Test sends the saved password to an agent's new host | B3 | A form opened from a request that changes a target field sends `null` for every untyped secret on Test and Save; `connections.test` takes `agentRequestId` and clears them on the server too |
| Agent reads secrets typed into drafts or filters | B2 | Tabs list names and ids only; views return columns and sort only; history keeps its read-only filter |
| Agent erases its own record | B1 | No activity clear, no connection delete; at-once changes are logged |
| Agent locks a database account by failed sign-ins | B2 | One test per connection every 10 seconds; refused while a session-only password is missing; stopped after one failure until the person tests or saves the connection |
| A stale request runs after things changed | B4 | Input parsed again, level, target and production checked again at approval |

## Options considered

| | A. One tool per action, approval through the app's handlers | B. One tool per action, each with its own approval code | C. One "call any RPC" tool |
| --- | --- | --- | --- |
| How it works | Each change tool stores `{ action, input }` parsed by that action's contract; approval calls the handler the app calls | Each tool gets its own request kind and runner | The agent names any RPC and input |
| Fits our code | Reuses every handler and its checks; one new request kind | Copies the rules of drop, import, export, save | Least code |
| Gives up | Approval errors are the app's errors | Nothing, at much more code | Per-action rules |
| Cost | Medium | High | Low code, high risk |
| Fails when | A handler's contract changes: the stored input no longer parses, and approval refuses it | Copies drift from the app | It calls `agent-requests.decide` or sets a guard |
| Completeness | 9/10 | 8/10 | 3/10 |

RECOMMENDATION: A, because each change runs through the one handler that owns its rules, so the agent path and the app path cannot drift.

## Decision

Option A [proposed: agent; M chose to go straight through, chat 2026-11-14].

- Reads and app-only state run at once. Every change to a database, a connection or a file is a proposed action that runs after approval through the app's own handler, with the checks below added where the handler has none (production, busy, target).
- Connection create and change are approved by the person saving the connection form, which the approval opens filled in. The server's save completes the request in the same step, so nothing can expire or duplicate it between the two.
- Tab and view changes are saved by the server and pushed to open windows, which apply them to their own copy.

Rejected: B, because copied rules drift from the app's; C, because one tool that can call anything cannot keep guards, secrets and approvals out of reach.

Consequences, all compatible additions: an optional `agentRequestId` on `connections.save` and `connections.test`; an optional `confirmName` on `agent-requests.decide`; a `field` request item; a `connectionProposal` on the request detail; optional `kind`, `change` fields on the activity event; new event kinds on `agent.opens`. A window that has not reloaded the new client may show an error for the new request kinds and can still reject them [unverified: whether Paseo reloads open windows on update; settled by the browser check after the update].

## Cost and scope

- **Effort:** two to three long sessions. v0.6.0 took about two sessions for 6 new tools plus two review rounds; this adds about 14 tools, a registry, the form approval and the window push. Assumption.
- **Cut first if time runs out:** table views, then query tab rename and close; a cut tool stays on the coverage map as pending, never on the never-list.
- **Risk:** a change tool that runs without approval; a guard reachable by an agent. One check per tool.
- **Blast radius:** every agent session on the daemon, the Agent requests view, the connection form, the query and data tabs, `connections.save`.
- **Undo:** `paseo plugin update datawise --ref v0.6.1`. Approved side effects stay: dropped tables, imported rows, saved connections.

## Design

### Tools

"Level" is the connection's agent sharing level. "Any" means any connection the person has, shared or not, except production. Every tool refuses production with the unknown-name answer.

| Tool | App action | Level | Runs |
| --- | --- | --- | --- |
| `datawise_describe` (changed) | adds `schema.databases`, `schema.schemas` | names | at once |
| `datawise_read_row` | `data.read-row` | rows | at once; same caps as `datawise_read` |
| `datawise_test_connection` | `connections.test` with the saved settings | any | at once; answers "Connected" or "Could not connect; the person can see why in Datawise"; one per connection every 10 s; refused while a session-only password is missing; after a failure, refused until the person tests or saves the connection |
| `datawise_propose_connection` | `connections.save`, new | none | approval in the connection form |
| `datawise_propose_connection_change` | `connections.save`, existing | any | approval in the connection form |
| `datawise_propose_disconnect` | `connections.disconnect` | any | approval; refused while busy |
| `datawise_propose_reset_ssh_key` | `connections.clear-ssh-fingerprint` | any | approval |
| `datawise_propose_destroy` | `data.destroy` (drop or empty) | proposals | approval; the person types the table name on the card, as in the app |
| `datawise_propose_import` | `import.start`, inline text up to 1 MiB | proposals | approval; the card shows the first 20 rows as `import.preview` parses them |
| `datawise_propose_export` | `export.start`, file name only | rows | approval; the card shows the full path |
| `datawise_export_text` | `export.text` | rows | at once; scope and table through `resolveScope` and `resolveObject` (system databases refused); cells capped at 2,048 characters; marked as row data; stops after 25 s; refused above 256 KiB with "Export fewer rows" |
| `datawise_save_query` | `saved.save`, new only | names | at once; an existing name is refused |
| `datawise_propose_delete_saved_query` | `saved.delete`, by exact name; two saved queries with that name are refused | names | approval |
| `datawise_clear_history` | `history.clear` | names | at once |
| `datawise_query_tabs` | `workspace.tabs.get` / `.save` | names | at once; list names and ids, rename, close; the window applies a close only when its own text is empty or equals a saved query |
| `datawise_table_view` | `views.get` / `views.save` | names | at once; get and set hidden columns, column order and sort, never filter values |

Existing tools and the RPCs they stand for, for the coverage test: `datawise_describe` (`connections.list`, `schema.objects`, `schema.describe`, `attachments.structure`), `datawise_read` (`data.read`), `datawise_count` (`data.count`), `datawise_query` and `datawise_explain` (`query.run` reads), `datawise_history` (`history.list`, `saved.list`), `datawise_propose_write` (`data.write`, `data.write-batch`), `datawise_propose_query` (`query.run` writes), `datawise_open` (`workspace.place.get`, `.save`, and the `agent.opens` subscription), `datawise_write_status` (`agent-requests.get` for its own requests), `datawise_propose_import` (`import.preview` and `import.start`, inline text only).

Never for agents, listed in OVERVIEW with these reasons:

- `connections.delete` [decided: M, chat 2026-11-14]: it also erases the connection's agent activity entries [decided: M, chat 2026-11-14].
- `connections.unlock` [proposed: agent, from M's secrets rule]: it takes a password. `datawise_open` on a locked connection makes the app ask the person.
- `agent-requests.decide`, `agent-activity.clear` [decided: M, chat 2026-11-14]; `agent-requests.list`, `agent-activity.list` [proposed: agent]: approvals and the audit log are the person's.
- `sqlite.inspect`: it reads a file on the daemon machine [proposed: agent]. The import tool's input accepts text only, never a path.
- `jobs.status`, `jobs.cancel`, `export.default-path` [proposed: agent]: no agent tool starts a job it would follow or cancel; the export tool resolves the path itself.

### Request shapes

| Action | Stored on the request | Re-checked at approval | Card headline | Logged |
| --- | --- | --- | --- | --- |
| New connection | `kind: "connection"`, `connectionId: ""`, `connectionName`, `environment: "none"`, `target: ""`, `connectionProposal` | Name still unused | "<agent> wants to add a connection" | proposed, then done or rejected |
| Connection change | `kind: "connection"`, `connectionId`, `target`, `connectionProposal` with only the changed keys | Not production; target unchanged since the proposal | "<agent> wants to change <name>" | same |
| Disconnect | `kind: "action"`, `action: "connections.disconnect"`, `input: { id }` | Not production; not busy | "<agent> wants to disconnect <name>" | same |
| SSH key reset | `kind: "action"`, `action: "connections.clear-ssh-fingerprint"`, `input: { id }` | Not production; target unchanged | "<agent> wants to forget the SSH host key of <name>", with "The next connection trusts the key it is shown" | same |
| Drop or empty | `kind: "action"`, `action: "data.destroy"`, `input: { ref, action }` | Level is proposals; target unchanged; the person's typed `confirmName`, passed unchanged to the handler, which checks it; never filled from `ref.name` | "<agent> wants to delete <table>" or "... remove all rows of <table>", danger style | same |
| Import | `kind: "action"`, `action: "import.start"`, `input: { ref, source: { text }, options }`, `mayBePartial` = not `transactionalImport` | Level is proposals; target unchanged | "<agent> wants to import N rows into <table>", with the column mapping, the total row count and the first 20 rows (an accepted limit: not every row is shown) | same |
| Delete a saved query | `kind: "action"`, `action: "saved.delete"`, `input: { id }`, the query's name and text on the card | Query still exists with that text | "<agent> wants to delete the saved query <name>" | same |
| Export | `kind: "action"`, `action: "export.start"`, `input: { source, format, path }` with the resolved path | Level is rows or above; target unchanged | "<agent> wants to export to <path>" | same |

- **Prefill transport:** `connectionProposal` is a typed object with only these keys: `name`, `engine`, `host`, `port`, `user`, `database`, `file`, `serviceName`, `localDataCenter`, `region`, `endpoint`, `accessKeyId`, `authSource`, `tls`, `caCertificate`, `group`, `color`, `ssh` (host, port, user only). Not `safety`, `environment`, `agentAccess`, `agentRowAccess`, `rememberPassword` or any secret.
- **Approve on a connection request** without the form is refused: "Approve this by saving the connection in the form." Reject works as for any request.
- **Runner:** an approved action calls its handler through the registry, then waits for the job the handler started through a new `Jobs.wait(id)`, and maps the job to the request: done with `affected` or `rows` as the count, failed or cancelled with the job's message for the person only. A failed import with `mayBePartial` tells the agent it may have partly applied. Handlers that return without a job (disconnect, SSH reset, saved delete) are done when they return.
- **Typed name:** `agent-requests.decide` gains an optional `confirmName`, passed unchanged to `data.destroy`. A missing or wrong name is refused by the handler and nothing is dropped.
- **Busy:** `pool.isBusy(id)` is checked outside `pool.use`, right before the disconnect, because `pool.use` itself counts as busy.
- **Names:** `withLevel` gains `"names"`, which is `shared()`; "any" is every connection except production, by exact name.
- **Registry:** `contributeServer` records each guarded handler and its contract in `server/agent-actions.ts`. At-once app-state tools and approved actions call handlers through it, after parsing input with the contract.
- **Limits:** proposals share the 5 per agent limit; a new-connection request counts against the agent only. At-once tools count toward the 60 a minute limit.
- **Activity:** at-once changes are logged with `action: "done"` and a new optional `change` text ("cleared history", "saved query Monthly", "renamed tab"). Older Datawise ignores the field.

### Connection approval

```
agent ──> datawise_propose_connection{_change}  ──> request kind "connection"   <-- new
person ──> Agent requests ──> "Review in form" ──> ConnectionForm(prefill = proposal)   <-- changed
person types secret, may set label, access, write mode ──> Save
        │ connections.save { ...input, agentRequestId }   <-- new optional field
        ▼
server: request still pending and a connection request?  ── no ──> refuse, nothing saved
        │ yes
        ├─ change request and a target field changed: secrets not given are cleared; agentAccess,
        │  agentRowAccess reset to none
        ├─ save, expire the connection's other requests, disconnect
        └─ mark this request done, log "done"
```

- The form applies a prefill on top of an existing connection too, and marks each changed field with its old value.
- Target fields: `engine`, `host`, `port`, `user`, `database`, `file`, `serviceName`, `region`, `endpoint`, `tls`, `caCertificate`, `ssh` (the fields of `agentTarget` plus endpoint, region and TLS).
- A connection's name must be unused by any other connection, checked at proposal and at every save that carries `agentRequestId`, including a rename.
- `agentRequestId` is removed from the input before the store saves it, so it never reaches `connections.json`.
- Test in that form: when the request changes a target field, the form sends `null` for every secret the person has not typed, and `connections.test` takes `agentRequestId` and clears untyped secrets on the server as save does.
- Every value the agent proposed is marked in the form as proposed by the agent, with the host shown first.

### Tabs and views

- `datawise_query_tabs` and `datawise_table_view` change the stored state through the registry (`workspace.tabs.save`, `views.save`), then push `{ kind: "tabs", connectionId, renamed: [{ id, name }], closed: [id] }` or `{ kind: "view", ref, view }` on `agent.opens` to every window.
- `agent.opens` events become a union with `kind`; the existing open event gets `kind: "open"` as its default, so an event without `kind` still parses as an open. A window older than this release ignores events it cannot parse [unverified: check that the v0.6.1 client's subscription drops an event that fails to parse instead of closing; settled by a unit test of the old schema against the new events].
- An open query workspace for that connection applies renames and closes to its own state and keeps each remaining tab's local text; an open data tab for that table replaces its view. Its next save then carries the agent's change.
- The window re-checks its own text before applying a close and keeps the tab when the text is non-empty and matches no saved query; the stored close is then undone by the window's next save. With no window open, the server refuses the close for stored text that is non-empty and matches no saved query: "This tab holds text that is saved nowhere else."

### Design checklist

1. Need: M's request above. 2. Auth: levels per tool, production refused, re-checked at approval. 3. Input bounds: names 1 to 120 characters as the app (`shared/contracts.ts:46`), inline import 1 MiB, export file name 1 to 120 characters without separators. 4. Secrets: none in inputs or answers; target changes clear them. 5. Errors: generic answers to agents. 6. Rate: limits above. 7. Logging: every tool call that touches a connection. 8. Concurrency: requests taken once; connection completion inside the save. 9. Restart: requests in memory, dropped. 10. Production: refused. 11. Threat model: above.

Empty and invalid input: parsed by zod first. Timeouts: at-once tools keep 25 s; approved jobs keep the app's limits. Partial failure: the job's message goes to the person; counts and status to the agent. Recovery: an unsaved form leaves the request pending until it expires.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | Noticed by |
| --- | --- | --- | --- | --- |
| A change tool runs without approval | low | high | Change tools only add requests | Unit test per tool: nothing changes before approval |
| A guard field or secret is reachable | low | high | Allowlist inputs and prefill | Unit test sends them |
| Repointing leaks a saved password | medium | high | Clear secrets and sharing on target change | Unit test |
| Export writes outside the folder | low | high | File name only, resolved server-side | Unit test with `../` and `/` |
| Approval runs a stale input | medium | medium | Parse and re-check at approval | Unit test |
| A window and an agent race on tabs or views | medium | low | Push applied by the window | Browser check |
| An old window meets new request kinds | low | low | Paseo reloads clients on update; reject still works | Manual check |

## Acceptance criteria

- Given no connection named Dev, when an agent proposes one and the person saves the prefilled form, then the connection is saved with the secret the person typed, the request is done, and environment and agent access are what the person chose (None by default).
- Given a change proposal that moves a connection's host, when the person saves without typing a password, then the saved password is gone and sharing is None.
- Given any change tool, when nobody approves, then no database, connection or file changes.
- Given an approved drop, import, export, disconnect or SSH reset, when it finishes, then `datawise_write_status` reports done with counts or failed without database text.
- Given a busy connection, when a disconnect is approved, then it is refused and the job keeps running.
- Given an export proposal with `../x` or `/tmp/x`, when made, then it is refused.
- Given a host-change proposal, when the person presses Test in the form without typing a password, then the saved password is not sent.
- Given an approved drop with no or a wrong typed name, when it runs, then it is refused and the table still exists.
- Given a failed import on an engine without transactional imports, when the agent asks its status, then it is told the import may have partly applied.
- Given drafts off and a tab with text on screen, when an agent closes it, then the tab stays.
- Given a saved query, when an agent asks to delete it, then nothing is deleted until the person approves.
- Given a production connection, when an agent calls any new tool, then it is refused with the unknown-name answer.
- Given an open query workspace, when an agent renames a tab, then the window shows the new name and the person's typing in other tabs is kept.
- Given the RPC list, when compared with the tools and the never-list, then every RPC is in exactly one (unit test).

## Rollout and rollback

- Ships as v0.7.0 (new tools; compatible contract additions). Last known safe state: v0.6.1.
- Abort if any unit or conformance check fails. Undo: `paseo plugin update datawise --ref v0.6.1`.
- Registry: repoint the open pin PR if still open, else open a new one.

## Parts

| Path | Change | Why |
| --- | --- | --- |
| `server/agent-actions.ts` | create | Handler registry, proposed-action runner, coverage map |
| `server/plugin.ts`, `server/pool.ts`, `server/store.ts` | change | Record handlers; approval runner; busy check; save with `agentRequestId` |
| `server/agent-requests.ts`, `shared/contracts.ts` | change | `connection` and `action` kinds, `field` items, `connectionProposal`, `agentRequestId`, activity `change`, push kinds |
| `server/agent-tool.ts` | change | New tools |
| `client/agent-requests.tsx`, `client/connections.tsx`, `client/app.tsx` | change | Cards, "Review in form", prefill on existing connections |
| `client/query-tab.tsx`, `client/data-tab.tsx`, `client/agent-open.ts`, `index.client.tsx` | change | Apply pushed tab and view changes |
| tests, `scripts/conformance.ts` | change | Checks below |
| `OVERVIEW.md`, `README.md`, `CHANGELOG.md` | change | Docs |

### Part 1: Contracts, registry and proposed actions

- [x] Contract additions above; registry; `Jobs.wait`; `action` request kind and runner with re-checks. Done: unit test adds a disconnect request directly, sees nothing change, approves, sees it disconnected; a busy connection refuses; a stale input refuses.
- [x] Coverage test with the map above, listing tools not built yet as pending. Done: it fails when an RPC is added to the contract and not mapped.

### Part 2: Connection tools and form approval

- [x] Proposal tools, test, SSH reset; save with `agentRequestId`; secret and sharing reset on target change. Done: unit tests for allowlists, no save before approval, target change clears secrets, production refused, duplicate name refused.
- [x] Card "Review in form"; prefill on existing connections with old values shown. Done: browser check on a throwaway daemon: propose new, save with password, request done, open it; propose a host change, save, password cleared.

### Part 3: Data and file tools

- [x] `datawise_read_row`, describe databases and schemas, drop, import, export, export text. Done: conformance on SQLite and PostgreSQL: nothing changes before approval, the change lands after; unit tests for the export path rules and the 256 KiB refusal.

### Part 4: App-state tools and window push

- [x] Saved queries, history clear, query tabs, table views, push and apply. Done: unit tests for each; browser check of a rename with the workspace open while typing in another tab.

### Part 5: Docs, regression, release

- [x] OVERVIEW tool list and never-list, README table, CHANGELOG. Done: leak scan clean; full 12-engine regression passes; v0.7.0 released and installed.

## Independent check

independent; present after fixing 5 blocking, 2 must-verify open, then fixed with M's approval (chat 2026-11-14).

- The first check found 7 blocking, 5 must-verify and 8 notes, all answered `fix`: request expiry on save, password redirect by repointing, disconnect killing jobs, drafts and filters reachable at names level, connection delete erasing the activity log (now never for agents, by M), unrestricted export paths, undecided request shapes, saved-query overwrite, driver text from tests, window races on tabs and views, unlogged changes, unsurfaced decisions, the RPC count, coverage gaps, card headlines, effort.
- The second check found 5 blocking, 2 must-verify and 8 notes. At the two-round limit, M chose to apply the fixes and build: Test in the review form leaking the saved password; delete-then-create replacing a saved query (deletes now need approval, by M); tab close losing unsaved text; job status and partial imports in the runner; the typed table name for drops; the any-level test tool (kept with safeguards, by M); and the unverified old-window claim, now tagged.
- Contested: none. Declined: none.

## Changes made

- 2026-11-14, part 1: handler registry, `action` and `connection` request kinds, `Jobs.wait`, `pool.isBusy`, approval runner with re-checks, coverage map and test. `datawise_propose_disconnect` was built here as the runner's test vehicle (planned for part 2). The `agent.opens` union moves to part 4, where the push uses it.
- 2026-11-14, part 2: proposal tools for new and changed connections, SSH key reset, connection test with its safeguards; `connections.save` and `.test` complete and check agent requests; secrets and sharing cleared when a change moves the connection; Review in form with a note listing proposed and current values. Browser check deferred to part 4's session.
- 2026-11-14, part 3: read one row, databases and schemas in describe, drop and empty with the person's typed name, import from text, export to a named file in the export folder, export as text. Checked by unit tests on SQLite. Deviation: no engine-specific conformance copies were added; the handlers are the app's own and conformance-tested on every engine, and the full regression passed.
- 2026-11-14, part 4: saved queries, history clear, query tabs and table views, with renames, closes and view changes pushed to open windows on `agent.opens`, which became a union of tab, view and open events. Deviation: an open event is the one without `kind`, instead of `kind: "open"` by default; a window on the old schema closes its subscription on a new event and reopens it 5 seconds later (Paseo SDK `rpc.ts:121-125`), a gap that ends when Paseo loads the new client. Browser checks: a proposed connection reviewed in the form, saved with a typed password, then opened; a host change whose Test sent no password ("client password must be a string"); a tab renamed while the person typed in another, with the typing kept.
- 2026-11-14, review of the build (fresh reader): 1 blocking, 3 must-verify, 8 notes. Fixed with tests seen failing first: at-once tools now count toward the 60 a minute limit and agent saves stop at 200 per connection; Test in the review form never sends the saved password (fake PostgreSQL server test with a positive control); new-connection proposals count per agent only; a connection-change save re-checks production; the request completes before the disconnect; done messages and the activity log use each request's headline; one shared list of the fields that decide where secrets go (`shared/connection-destination.ts`); proposal fields are bounded and import text is bounded in bytes; listing tabs and reading a view are logged. Changed in the plan: `datawise_export_text` does not cut values, since cutting inside CSV or JSON text would corrupt it; its whole answer stays capped at 256 KiB. The form shows the proposal as one note listing each value and the one it replaces, rather than a mark on each field. Accepted: proposing a connection name already used, including a production one, answers that the name is taken, as `datawise_open` already reveals that a name exists (decided for v0.6.0).
- 2026-11-14, final regression: the 1 ms count-deadline check raced on MongoDB and Cassandra (a tiny count returned within 1 ms), after passing in two earlier runs. It now runs only on DynamoDB and Elasticsearch, whose deadline aborts the client's own request; MongoDB and Cassandra join SQL and Neo4j as checked by reading the code and driver types [decided: M, chat 2026-11-14].

## Open questions

None. The tool list, request shapes and Option A are proposed by the agent; M chose to go straight through after the independent check [decided: M, chat 2026-11-14].
