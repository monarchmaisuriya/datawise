# Datawise: agent tools for everything Datawise can do, starting with opening a tab

- Date: 2026-11-14 17:39
- Status: done, released as v0.6.0 on 2026-11-14; full, because it changes a public contract (the Paseo version requirement), widens what agents can reach on every engine, and adds a tool every agent session gets
- Repos: datawise   Folders: `server/`, `shared/`, `client/`, `scripts/`, `docs/`
- Files: `paseo-plugin.json`, `package.json`, `package-lock.json`, `server/plugin.ts`, `server/store.ts`, `server/agent-tool.ts`, `server/agent-requests.ts`, `server/adapters/*.ts` (query sessions only), `shared/engines.ts`, `shared/agent-access.ts`, `shared/contracts.ts`, `index.client.tsx`, `client/app.tsx`, `client/connections.tsx`, `client/agent-requests.tsx`, `scripts/conformance.ts`, tests, `OVERVIEW.md`, `README.md`, `CHANGELOG.md`
- Subagents: none planned; see Questions for M
- Decision records: `docs/adr/0001-require-paseo-016.md` (accepted), `docs/adr/0002-agent-tools-for-every-agent.md` (accepted), `docs/adr/0003-share-names-on-every-engine.md` (accepted)

## Context and problem

- **Who:** M, and anyone running coding agents in Paseo with Datawise installed.
- **What they are trying to do:** ask an agent to work with their databases the way they would themselves. That means opening a table or a query in a Datawise tab, reading, querying, counting, explaining, looking at past queries, and proposing changes.
- **What they use today:** four agent tools: list names, read rows, propose row changes, check a proposal. They exist only while a connection is shared, and only on the five SQL engines for rows. [verified: `server/agent-tool.ts:114-310`; `server/plugin.ts:116-124`; `shared/agent-access.ts:13-15`]
- **What M saw:** an agent asked to open database tabs answered that no tool could do it. Screen control is blocked for the Paseo app. [verified: agent report quoted by M, 2026-11-14]
- **Function the solution must perform:** let an agent ask Datawise to do anything a person can do in Datawise. Changes to data happen only after the person approves them, and production stays closed to agents.
- **Constraints:**
  - M's rule since v0.3.0: reads are allowed where the person shared them; every create, update and delete waits for approval. [decided: M, chat 2026-11-06]
  - Production connections refuse agent access. [verified: `server/agent-tool.ts:38`]
  - Plugin RPCs (remote procedure calls) die at 30 seconds, so Datawise stops its own reads at 25. [verified: `server/plugin.ts:27-28`]
  - Agents get any plugin's tools only while Paseo's "Enable Paseo tools" host setting is on. The setting is `daemon.mcp.injectIntoAgents`, off unless set. [verified: Paseo source `packages/server/src/server/config.ts:554`, `persisted-config.ts:258`] Datawise's form says the same. [verified: `client/connections.tsx:398`] It is on for M. [verified: `~/.paseo/config.json`, `daemon.mcp.injectIntoAgents: true`]
  - The Paseo version requirement applies to every Paseo app that connects, not only the daemon. [verified: Paseo source `packages/app/src/plugins/registry.ts:96`, `plugin-requirements.ts:21-40`] M's desktop app is 0.16.0-beta.2. [verified: `Paseo.app` Info.plist]

## Goals / Non-goals

**Goals**

- An agent opens any connection, table or query in the workspace's Datawise tab, on Paseo 0.16.
- Agents can run read-only queries, count, and read history and saved queries on connections that allow reads, on all 12 engines; explain on the five engines that have it (PostgreSQL, MySQL, SQLite, ClickHouse, Neo4j).
- Agents can propose queries that change data; nothing runs until the person approves the exact statements.
- **Metrics:**
  - Success: M asks an agent to open a table, and it opens in a Datawise tab.
  - Guardrail: no agent action changes data without approval. A conformance check fails if any agent path writes unapproved, on every engine.
  - Checked by M on 2026-11-21.

**Non-goals**

- Agents creating, editing or deleting connections, passwords or settings. These hold credentials, and are the person's.
- Agents importing files, exporting to files, or dropping and emptying tables directly. A proposed query covers the data changes; files on disk are outside Datawise's scope for agents.
- Tempting near-misses, forbidden here: an agent "auto-approve" mode, letting agents read production, a keymap or command palette, and changing the person's open tab without their request beyond what open-tab does.

## What is true today

```
agent session opens
  -> Datawise hook (only while a connection shares names) adds 4 tools       server/plugin.ts:116-124
agent calls a tool
  -> tool finds the connection among shared ones, checks its level         agent-tool.ts:105-112
  -> reads: SQL engines only, in a transaction always rolled back           sql-base.ts:284-301
  -> proposals: stored in memory, approved in Datawise, then written         agent-requests.ts; agent-tool.ts:189-287
```

- **Levels per connection:** `agentAccess` is `none` or `schema` (names), and `agentRowAccess` is `none`, `read` or `propose`. They're checked on every call. [verified: `shared/agent-access.ts:27-31`; `server/agent-tool.ts:105-112`]
- **Names** need an engine with a catalog, not production. [verified: `server/agent-tool.ts:37-39`]
  - Today that's the five SQL engines plus ClickHouse and Cassandra. [verified: `shared/engines.ts`, `catalogSchema` per engine]
  - Reason for the rule: on schemaless engines, names come from sampled records or key names. [verified: `docs/2026-11-06-1525_customisation-and-advanced-features_plan.md:42`]
- **Rows** also need transactional edits and a development or staging label. [verified: `shared/agent-access.ts:13-15`]
- **Agent reads** use `readIsolated`, which only the SQL base adapter has. [verified: `server/adapters/types.ts:52-53`; `server/adapters/sql-base.ts:284`]
- **Running a query in the app:** the adapter parses the text into statements, each classed `read`, `write` or `unknown`. A gate asks the person before anything not classed `read`. [verified: `server/plugin.ts:383-406`]
- **Read-only enforcement by engine:**

  | Group | Engines | What stops a write in a read-only query | Evidence |
  | --- | --- | --- | --- |
  | Database refuses | PostgreSQL, MySQL, Oracle, SQLite, ClickHouse, Neo4j | A read-only transaction or session | `postgres.ts:120`, `mysql.ts:84`, `oracle.ts:94-96`, `sqlite.ts:14`, `clickhouse.ts:69`, `neo4j.ts:309-313` |
  | Rolled back | SQL Server | No read-only mode; agent reads run in a transaction that is always rolled back | `mssql.ts:105-109`; `sql-base.ts:289` |
  | Datawise's check only | MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB | Datawise sorts each command into read or write, from a list of known reads | `mongodb.ts:114-131`, `redis.ts:464-480`, `elasticsearch.ts:16-23`, `cassandra.ts:283`, `dynamodb.ts:292-295` |

- **Explain:** only PostgreSQL, MySQL, SQLite, ClickHouse and Neo4j have a prefix. The server adds it, so text after it cannot sneak in. [verified: `shared/engines.ts`, `explainPrefix`; `server/plugin.ts:390-398`]
- **Where a tab returns to:** each workspace's Datawise panel restores the last place saved for `panel:<workspaceId>`. It reads that once, on mount. [verified: `client/app.tsx:48`, `:79-89`]
- **Query text from outside a tab:** the panel already has a prefill path. It puts text into the active empty query tab, or a new one. [verified: `client/app.tsx:65`, `client/query-tab.tsx` prefill effect] An open query workspace loads its tabs once and saves the whole list on every edit, so a tab added on the server would be overwritten. [verified: `client/query-tab.tsx:51-95`] With "Save query drafts" off, saved tab text is blanked. [verified: `server/plugin.ts:314-318`]
- **Saving agent access** is refused for engines without a catalog, in the store every save passes through. [verified: `server/store.ts:169`]
- **Statements run one by one;** without a read-only session there is no transaction, and a failure stops the run with the results so far. [verified: `server/adapters/sql-base.ts:536-558`, `PartialRunError`]
- **The activity log** accepts seven action values; an older version reading a new value sets the file aside and starts empty. [verified: `shared/contracts.ts:280`; `server/side-file.ts:36-44`]
- **The panel's id** is `browser`. [verified: `index.client.tsx:21`]
- **Paseo 0.16 SDK:**
  - Clients can `openPanel(id, { workspaceId })` and `subscribe` to a server channel. [verified: SDK 0.16.0-beta.2 `dist/client/contracts.d.ts:158-198`]
  - The server pushes events to each subscriber. [verified: same SDK, `dist/server/contracts.d.ts:11-20`]
  - An agent tool's context includes the calling agent's `workspaceId`, which can be `null`. [verified: same SDK, `dist/server/lifecycle.d.ts:62-64`]
  - The host's `openPanel` moves that client to the workspace and opens the panel, or throws "Plugin panel context is unavailable". [verified: Paseo 0.16.0-beta.1 source `packages/app/src/plugins/client-runtime.ts:36-73`]
- **The code builds on 0.16 unchanged.** [verified: `tsc --noEmit` in a scratch copy with SDK 0.16.0-beta.2, 2026-11-14]

**Assumptions on the changed path**

- The hook handler stays free of I/O: `nothing found` enforcing it beyond review. Becomes a risk row and a test.
- A pushed event reaches every open client of the host, and each client's `openPanel` moves that window to the given workspace and opens the panel, even a window that was showing another workspace. [verified: spike on a 0.16.0-beta.2 throwaway daemon, 2026-11-14: three browser tabs, two on workspace A and B and one firing; all three received event 1, called `openPanel` without error, and ended on workspace A with the panel open]

## Options considered

| | A: tools that act through the open app (chosen) | B: tools that only return data | C: a deep link the agent prints |
| --- | --- | --- | --- |
| How it works | Server tools for data; open-tab saves the place and tells the app over a subscription, which calls `openPanel` | Every tool returns text; the agent cannot open anything | The agent prints a link to a Datawise screen with params; the person clicks it |
| Fits our code | Reuses place saving and the query run path | Reuses everything | Screens take params, but panels do not; the person still clicks |
| Gives up | Needs 0.16 and an open app | M's main request | One click, and the tab is a screen, not a panel |
| Cost | Medium-large | Medium | Small |
| Fails when | No Paseo window is open | Always, for the request | The agent's link is wrong |
| Completeness | 9/10 | 5/10 | 6/10 |

RECOMMENDATION: A because it is the only option where the agent itself opens the tab, which is what M asked for.

## Decision

- **Approach:** option A, on Paseo 0.16 only. [decided: M, chat 2026-11-14; confirmed after learning that 0.15 could open tabs by polling] See `docs/adr/0001-require-paseo-016.md`.
- **Tool access:** open-tab works on any connection, including unshared and production ones, and returns no names or data. [decided: M, chat 2026-11-14] It is the one tool that reaches production, because it shows data only to the person.
- **Production asks first:** for a production connection, the app asks "<agent> wants to open the production connection <name>. Open it?" before anything moves. Nothing is saved or opened unless the person says yes. [decided: M, chat 2026-11-14, "ask confirmation for production connection"] Agent-written query text lands in a production tab only after that yes; Datawise never runs it, and the connection's own write prompts still apply when the person presses Run.
- **Abilities:** open a tab, read-only queries, proposed queries, count, explain, history. [decided: M, chat 2026-11-14]
- **Engines:** all 12 for agent queries. [decided: M, chat 2026-11-14]
- **Fixed tool list:** one hook, always declared, offering all tools to every agent, with access checked on each call. [proposed: agent] See `docs/adr/0002-agent-tools-for-every-agent.md`.
- **Names on every engine:** sharing names is allowed on all 12 engines, reversing the catalog rule. [proposed: agent; needed for M's "all 12 engines"] See `docs/adr/0003-share-names-on-every-engine.md`.
- **Activity log values:** new tools record `read` or `proposed`, existing values, so a rollback to v0.5.0 keeps the log. Open-tab is not logged, because it reads nothing. [proposed: agent]
- **Read-only queries, two layers on every engine:**
  - **First layer, all 12 engines:** run only when every statement is classed `read` by the adapter's own parser. Anything else is refused, with a pointer to proposing it. Model-written text could otherwise slip a write past a session guard, for example a SQL Server batch ending in `COMMIT`, or an Oracle PL/SQL block that commits. [proposed: agent]
  - **Second layer, where the engine has one:** a read-only session, or a transaction always rolled back (SQL Server), as listed in the table above.
  - On the five "Datawise's check only" engines, the first layer is the only one. Question 1 asks whether to send every query there through approval instead. [proposed: agent]
- **Why this is structural:** the gap was that the plugin offered agents no action beyond four tools. The new tools are the owning layer for agent access. Each delegates to the same adapter paths the app uses, so the rules live in one place.
- **Rejected:** B fails the request; C leaves the person to act, and screens are not the workspace panel.

## Cost and scope

- **Effort:** about 4-6 hours of agent time. [assumption] For comparison, v0.3.0 (agent row reads and approvals) went from plan to release in about an hour [verified: `git log`, 2026-11-06 17:43 to 18:42]; this plan has about three times the parts.
- **Cut first if time runs out:** Part 6 (history and saved queries), then explain.
- **Risk:**
  - An agent query that writes on a "Datawise's check only" engine. Medium impact, low likelihood: a classifier gap is the only path.
  - Every agent sees 10 Datawise tools: certain, low impact.
  - 0.15 users cannot update: certain, accepted by M.
- **Blast radius:**
  - Every agent session on the daemon gets the tools.
  - The approval view gains a statement kind.
  - The connection form allows sharing on more engines.
  - `connections.json` is unchanged.
  - The registry pin is held.
- **Undo:** reinstall v0.5.0. No stored data changes shape.

## Design

### Views

```
Paseo agent ──calls──> Datawise server tools <-- changed: 10 tools, always offered
                          │                 └── open-tab: save place, push event <-- new
                          ▼
                 adapters (12 engines) ── read-only query sessions <-- changed
                          │
Datawise app (each open client) <── subscription "open in tab" <-- new
     └─ client.openPanel("browser", { workspaceId }) -> panel jumps to the saved place <-- new
```

### Tools

| Tool | Level needed | What it does | Engines |
| --- | --- | --- | --- |
| `datawise_open` | None; any connection except one the person deleted | Saves the place for the agent's workspace panel and asks open apps to show it. Optional table, or query text that the app puts into a query tab through its prefill path | All |
| `datawise_describe` (changed) | Names | As today | All 12 (was 7) |
| `datawise_read` (changed) | Read | As today | All 12 (was 5) |
| `datawise_count` | Read | Counts rows, with optional filters; stops at 25 s | All 12 |
| `datawise_query` | Read | Runs statements that all class as reads; returns at most 200 rows and 256 KiB, cells cut at 2,048 characters, as `datawise_read` does; stops at 25 s | All 12, two layers |
| `datawise_explain` | Read | Shows the plan of one read statement | Engines with an explain prefix |
| `datawise_history` | Read | Lists recent queries and saved queries for a connection, only those classed `read`, so a password in a statement the person ran is never returned [decided: M, chat 2026-11-14] | All 12 |
| `datawise_propose_query` | Propose | Stores statements for approval; nothing runs until approved | All 12 |
| `datawise_propose_write` | Propose | As today | Five SQL engines (row edits need transactions) |
| `datawise_write_status` | None | Status of a proposal, row or query | All |

### Open-tab flow

1. Refuse when the agent has no workspace (`workspaceId` is `null`): "This agent is not in a workspace, so there is no tab to open."
2. Find the connection by exact name among all connections. If none matches: "No connection named X." The same answer comes whatever the reason.
3. For any connection that is not production, save the place for `panel:<workspaceId>`: connection, optional database, schema and table, and the tab (`data` or `query`). For a production connection, save nothing yet: the place travels in the event, and the app saves it only after the person confirms.
4. Push `{ workspaceId, text?, production?: { agentTitle, connectionName, place } }` to every subscriber of the "open in tab" subscription. The text is at most 256 KiB, and the app never runs it. With no subscriber: "No Paseo window is open to show it. The tab will open there next time; query text was not kept."
5. For a production request, each client first shows the confirmation with Datawise's existing confirm dialog. On no, nothing happens. On yes, it saves the place through the existing `savePlace` call and continues. Then each client calls `client.openPanel("browser", { workspaceId })`. The panel for that workspace re-reads its place on the event, and passes any text to the prefill path, which puts it in the active empty query tab or a new one. The drafts setting then applies as to anything typed.
6. Moving to another connection goes through the panel's existing `leaveAllowed`, which asks before discarding uncommitted pending edits. If the person says no, the panel stays where it is. [decided: M, chat 2026-11-14] [verified: `client/app.tsx:126-131`]
7. Never contacts the database, and returns no names or data. For production, the agent is told "Asked the person to confirm opening it", because the tool does not wait for the answer.

### Access model

- **Names:** allowed on all 12 engines. On engines without a catalog, the Agents section of the form says: "Names here come from your data: collection, key, index or label names, and field names seen in recent records."
- **Rows:** a development or staging label, as today; the transactional-edits requirement is dropped for reads and queries.
- **Production:** refused, as today.

### Proposed queries

- **Request:** a new request kind, `query`, holds the statements as parsed, the place (connection and scope), and the target fingerprint (`targetOf`).
- **Approval:** the approval view shows the statements in a mono card, labelled "Run these statements". On approval, they run through the same path as the app's Run, with confirmation given.
- **Outcome:** statements run one by one with no shared transaction. The request records how many ran. A failure partway is a new status, `partial`: "k of n statements ran before one failed; those stay applied. Read the data before proposing again." It is never reported as "nothing was written".
- **Engines without transactions:** a single statement can apply partly there (MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB, Neo4j outside a transaction). A failed proposal on these engines says "This may have partly applied. Read the data before proposing again." instead of "nothing was written". [decided: M, chat 2026-11-14]
- **Limits:** at most 50 statements and 256 KiB per request [proposed: agent]. Expiry (30 minutes) and per-agent request limits are shared with row proposals. [verified: `server/agent-requests.ts:4-9`]
- **Always asks:** a proposal waits for approval even on a connection set to No prompts. [decided: M, chat 2026-11-06]

### Design checklist

1. **Safe defaults:**
   - No new settings.
   - New tool inputs are bounded by schema: names to 200 characters, query text to 256 KiB, limits to 1-200 rows.
   - Empty query text is refused.
   - The open-tab subscription carries a workspace id and optional query text, at most 256 KiB.
2. **Contract changes:**
   - The Paseo requirement is **breaking** (decision record 0001).
   - Agent tool descriptions are **compatible**: existing tools keep their names and inputs.
   - The approval request list gains a kind: **compatible**, held in memory only.
   - `connections.json` is unchanged.
3. **Quality scenarios:** an agent's `datawise_query` or `datawise_count` returns within 25 s, or reports "took too long", leaving 5 s under the 30 s RPC limit, as reads do. [verified: `server/plugin.ts:27-28`] Whether agent tool calls have their own host limit is unverified; the 25 s cap holds either way.
4. **Reliability targets:** n/a. A local plugin with no service-level target; failures surface in the tool answer.
5. **Threat model:**

   ```
   agent (model output, untrusted) ──tool call──> Datawise tools ──> database
                     ▲                                   │
   rows and names (may hold instructions) <──────────────┘
   person ──approves── proposals ──> database
   ```

   | Threat | Mitigation | Test |
   | --- | --- | --- |
   | Instructions in data steer the agent to propose damage | Every change waits for the person, showing exact statements | Conformance: a proposal runs only after approval |
   | Agent query writes on any engine, including by escaping a session guard | Every statement must class as `read` on all 12 engines; the session guard is a second layer | Conformance: per engine, three write phrasings are refused (a plain write, a write after a read in one text, and a commit inside the text); SQL Server and Oracle also get a batch ending in `COMMIT` and a PL/SQL block |
   | Agent reaches production | Refused at every tool except open-tab, which shows data only to the person and only after they confirm [decided: M, chat 2026-11-14] | Unit: each data tool refuses a production connection; open-tab saves nothing for production. Browser: no closes the dialog and moves nothing; yes opens the tab |
   | Agent guesses unshared names via open-tab | Accepted: it learns that a name exists, nothing else [proposed: agent; Question 3] | Unit: the answer is the same for missing names |
   | Agent-written query placed in a tab is run by the person | It is never run by Datawise; it lands in a query tab only when the person's app is open | Browser check |
   | A hook that throws blocks every agent session | The handler is a constant list with no I/O | Unit: the handler returns the fixed list |
   | Flooding with open-tab events moves the person's view | Rate limit: one open per agent per 5 seconds [proposed: agent] | Unit |
   | An agent runs costly scans in a loop (DynamoDB and Elasticsearch scans cost money) | At most 60 query and count calls per agent per minute [decided: M, chat 2026-11-14] | Unit |
   | History returns a secret from a statement the person ran | Only entries classed `read` are returned [decided: M, chat 2026-11-14] | Unit |
   | A read with side effects, such as `pg_terminate_backend`, passes as a read | Accepted: the same as the person's own Ask first mode today; noted in OVERVIEW [proposed: agent] | n/a |

6. **Views:** above.
7. **Watching it in production:** the agent activity log records each new tool call, with no values, as reads do today. Failures are logged with `Datawise: an agent tool failed:`. [verified: `server/agent-tool.ts:100`]
8. **Accessibility and personal data:**
   - Accessibility: no new controls beyond a label in the approval view.
   - Personal data: query results go to the agent's provider, as reads already do. The form text says so.
9. **Experiments:** n/a; no staged rollout.
10. **What is missing:**
    - A Paseo 0.16 throwaway daemon. The npm package exists [verified: `npm view @getpaseo/plugin versions`, 0.16.0-beta.2].
    - M's OK before any real agent prompt.
11. **Edge cases:**
    - Agent outside a workspace: refused.
    - Two Paseo windows: both open the tab.
    - Connection with a session-only password: the tab asks for it.
    - Table name that doesn't exist: the tab shows the connection, with no error to the agent.
12. **Leverage points:** the hook and the access check. Six scenarios are walked in tests: unshared, names only, read, propose, production, and deleted connection.
13. **Margins:**
    - The query result cap matches `datawise_read`, because the same agent answer limits apply.
    - The 5 s open-tab rate limit is an assumption, to be tuned on M's feedback.
14. **Room to grow:** more tools fit the same pattern. Extend when M asks.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | How noticed |
| --- | --- | --- | --- | --- |
| Classifier gap lets a write through | Low | Data changed without approval | Classifier on every engine plus session guards where they exist; Question 1 offers approval for all queries on engines with no session guard | Conformance write probes, three phrasings per engine |
| A proposal fails partway | Medium | Some statements applied | `partial` status says how many ran | Conformance: a two-statement proposal whose second fails |
| A Paseo app below 0.16 connects | Medium | Datawise is missing in that app, including approvals | Decision record 0001; README says so | M's phone app |
| Hook handler throws | Low | No agent session can open | Constant handler; unit test | Paseo errors on session open |
| beta.2 `openPanel` differs from beta.1 source | Medium | Tab does not open | Checked first in Part 3 on beta.2 | Part 3 browser check |
| Every agent sees 10 tools | Certain | Longer tool lists | Short descriptions | Accepted in decision record 0002 |
| Event opens the tab on every window, including a phone | Medium | Unexpected navigation | Question 2 | M's trial |
| Names on schemaless engines carry data | Medium | Data reaches the agent's provider on a names-only share | Form text names it; the person chooses | Review of form text |
| 0.15 hosts cannot install | Certain | 0.15 users stay on v0.5.0 | Registry pin held | Decision record 0001 |

## Acceptance criteria

- Given an agent in a workspace and a Datawise window open, when it calls `datawise_open` with a connection and table, then that workspace shows the Datawise tab on that table.
- Given query text and an open Datawise tab, when it calls `datawise_open`, then a query tab holds the text, and nothing runs.
- Given no window open, when it calls `datawise_open`, then the answer says so, and the place is saved for next time.
- Given an unshared or unknown connection name, when an agent calls any tool except `datawise_open`, then it gets the same refusal.
- Given a connection allowing reads, on each of the 12 engines, when an agent runs a read query, then rows return. When it sends any of three write phrasings, then it is refused and nothing changes.
- Given SQL Server or Oracle, when an agent's query ends a batch in `COMMIT` or holds a PL/SQL block, then it is refused before reaching the database.
- Given a proposal whose second statement fails, when approved, then the status is `partial` and says 1 of 2 ran.
- Given a proposal of write statements, when the person approves, then they run once, and `datawise_write_status` reports the count. Until then, nothing runs.
- Given a production connection, when an agent calls any data tool, then it is refused.
- Given a production connection, when an agent calls `datawise_open`, then no window moves and nothing is saved; the question waits in that workspace's Datawise tab for 30 minutes; on no, nothing opens; on yes, the tab opens there. (Revised 2026-11-14 after review: the Paseo 0.16 client SDK cannot ask before a panel opens.)
- Given nothing shared, when a session opens, then the tool list is the same 10 tools.

## Rollout and rollback

- **Order:** parts in order; release as v0.6.0; reinstall on M's daemon from git.
- **Registry:** the pin is held, per decision record 0001.
- **Abort:** any write without approval in conformance, or a hook error on M's daemon.
- **Last safe state:** v0.5.0.
- **Rollback:** `paseo plugin install git:https://github.com/monarchmaisuriya/datawise.git --ref v0.5.0`.

## Parts

| Path | Change | Why |
| --- | --- | --- |
| `paseo-plugin.json`, `package.json`, `package-lock.json` | change | Require and build on 0.16 |
| `shared/contracts.ts` | change | Subscription contract; query request kind; tool input limits |
| `shared/engines.ts` | change | `agentQuery` group per engine: `database`, `rolledBack`, `classified` |
| `shared/agent-access.ts` | change | Names and rows on all 12 engines |
| `server/agent-tool.ts` | change | New tools; describe and read on all engines |
| `server/agent-requests.ts` | change | Query request kind |
| `server/plugin.ts` | change | Constant hook; subscription handler; run approved queries |
| `server/store.ts` | change | Allow agent access on every engine |
| `server/adapters/*.ts` | change | Read-only query sessions and isolated reads where missing |
| `index.client.tsx`, `client/app.tsx`, `client/query-tab.tsx` | change | Subscribe, open the panel, jump to the place, prefill query text |
| `client/connections.tsx` | change | Agents section on all engines, with names text |
| `client/agent-requests.tsx` | change | Show statement proposals |
| `server/*.test.ts`, `shared/*.test.ts`, `scripts/conformance.ts` | change | Tests below |
| `OVERVIEW.md`, `README.md`, `CHANGELOG.md` | change | Docs |

### Part 0: Spike on a throwaway daemon

- [x] On a 0.16.0-beta.2 throwaway daemon, a scratch plugin calls `openPanel` from a pushed event, with two browser tabs open on different workspaces. Done: the result is recorded under What is true today; the spike is deleted.

### Part 1: Move to Paseo 0.16

- [x] Requirement `>=0.16.0-beta.2`, SDK `0.16.0-beta.2`. Done: both typechecks and unit tests pass.
- [x] Clean-install rehearsal: `git archive` copy installed with `plugin install <dir> --id datawise-rehearsal` on a 0.16.0-beta.2 throwaway daemon. Done: `plugin ls` shows it running.

### Part 2: Constant hook and access on all engines

- [x] One hook declared at start with the fixed tool list. Done: unit test asserts the list and that the handler makes no calls.
- [x] Names and rows on all 12 engines in `shared/agent-access.ts` and `server/store.ts:169`, production refused, form text. Done: unit tests for six scenarios.
- [x] `readIsolated` on the six adapters without it (MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB, Neo4j; ClickHouse inherits it from the SQL base [verified: `server/adapters/clickhouse.ts:46`; `server/adapters/sql-base.ts:284`]), each reading through the engine's read-only path where one exists. Done: conformance describe and read on all seven non-SQL engines including ClickHouse.

### Part 3: Open in a tab

- [x] Subscription, `datawise_open`, place saving, rate limit, production asking first. Done: unit tests for refusals, saved place, and a production request that saves nothing and returns no data.
- [x] Client subscribe, production confirmation, `openPanel`, panel jump through `leaveAllowed`, prefill. Done: a production request shows the dialog, and no leaves everything unchanged; on a beta.2 throwaway daemon, a tool call from a test hook opens the tab on the table, with two browser tabs checked; with a pending edit, the jump asks first.

### Part 4: Read-only queries, count, explain

- [x] Classifier first on every engine, then the read-only session where the engine has one. Done: conformance on all 12, with a read returning rows, and each of three write phrasings refused before reaching the database, shown by an unchanged row count read directly with a test client.
- [x] `datawise_query`, `datawise_count`, `datawise_explain`, the 60 per minute limit. Done: conformance passes; answers respect the 200 row and 256 KiB caps; the 61st call in a minute is refused.

### Part 5: Proposed queries

- [x] Request kind, tool, approval view, run on approval, `partial` status, partly-applied wording on engines without transactions. Done: conformance shows nothing runs before approval and runs once after, and a two-statement proposal whose second fails reports 1 of 2; browser check of the approval view.

### Part 6: History and saved queries

- [x] `datawise_history`. Done: conformance lists only read entries for a read-level connection, leaves out a `CREATE USER ... PASSWORD` statement, and refuses below read level.
- Activity: new tools log `read` or `proposed` only. Done: a unit test parses the log with v0.5.0's enum.

### Part 7: Docs and release prep

- [x] OVERVIEW agent section, README tool list, CHANGELOG. Done: leak scan clean; full regression passes.

## Independent check

independent; present as is. Round 2 left 1 blocking and 4 must-verify open at the round limit; M approved their fixes on 2026-11-14 and they are applied without a third round, as M chose. Two rounds ran, each with a fresh reader that saw only the files.

**Round 1:** 3 blocking, 3 must-verify, 4 notes. All answered `fix` and applied: classifier on every engine (a SQL Server batch ending in `COMMIT` or an Oracle PL/SQL block could slip past a session guard), a `partial` status, query text through the prefill path, the app-side version check, the "Enable Paseo tools" setting, activity log values, `store.ts`, citations, a 25 s cap, and decision record 0003 split out.

**Round 2:** 1 blocking, 4 must-verify, 4 notes. The notes are applied: plan contradictions, citations, ClickHouse already having `readIsolated`, a spike as Part 0, a stronger done condition for the classifier, and record 0003's wording. Still open, each with its proposed edit:

| Finding | Severity | Proposed edit | Status |
| --- | --- | --- | --- |
| Record 0001 says `openPanel` is missing in SDK 0.15.1; it is present (`node_modules/@getpaseo/plugin/dist/client/contracts.d.ts:168`). Only `subscribe` is new. A 0.15 option was never weighed | blocking | Correct record 0001's context; add "stay on 0.15; the app polls" as an option; M decides again | fixed with M's approval: record corrected; M chose 0.16 only again |
| Open-tab reaches production connections and can put agent-written SQL in a production tab | must-verify | Ask M | decided by M: allowed, and then, in M's words, "ask confirmation for production connection" |
| Moving the panel could discard uncommitted pending edits (`client/app.tsx:126-131`) | must-verify | The jump goes through `leaveAllowed` | fixed with M's approval |
| On engines without transactions, one statement can apply partly, and `failed` would say nothing was written | must-verify | Partly-applied wording on those engines | fixed with M's approval |
| History can hold secrets; reads have no per-agent rate limit | must-verify | History returns only `read` entries; 60 calls per agent per minute | fixed with M's approval |

No contests.

## Changes made

- 2026-11-14, part 0: spike confirmed that every open window receives the event and is moved to the agent's workspace with the tab open. Build runs in the worktree `/Users/monarchmaisuriya/Experiment/datawise-agent-tools` on branch `agent-tools`, from `0462c7f`.
- 2026-11-14, part 1: requires and builds on Paseo 0.16.0-beta.2. Clean copy with the manifest's `build` step run first installs and runs on a throwaway 0.16.0-beta.2 daemon.
- 2026-11-14, part 2: one constant hook with 10 tools; names and rows on all 12 engines, production refused; isolated reads on MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB and Neo4j.
- 2026-11-14, part 3: `datawise_open` with subscription to every window, production confirmation, pending-edits prompt, query prefill. Browser-checked with two windows.
- 2026-11-14, part 4: `datawise_query`, `datawise_count`, `datawise_explain`; classifier first on every engine, read-only or rolled-back session second where one exists; 60 calls a minute; 200 rows and 256 KiB per answer.
- 2026-11-14, part 5: `datawise_propose_query`, statement approval card, run once on approval, `partial` status with "k of n" wording, partly-applied wording on engines without transactions.
- 2026-11-14, part 6: `datawise_history` lists reads only; activity logs only v0.5.0's action values, and gains an optional `unit` so statement proposals read as statements.
- 2026-11-14, part 7: OVERVIEW agent section, README tool list, CHANGELOG. Leak scan clean. Full regression: 29 suites pass, 0 fail.

Deviations from the plan:

- Part 1 rehearsal used a directory install of a clean copy with `npm ci --omit=dev --ignore-scripts` run first, because a directory install skips the manifest's `build` step that a Git install runs (`paseo/.../plugins/index.ts` installSource). A first rehearsal without it failed falsely.
- Added an optional `unit` field to agent activity events, not in the plan, after the browser check showed a 2-statement proposal logged as "2 rows". Compatible: older logs read as rows, and v0.5.0 drops the unknown key.
- Removed a company-related container name from `docs/2026-11-06-1215_datawise-db-client_plan.md:41`. The old wording stays in public git history.
- Part 4: the unchanged row count after refused writes is read through Datawise's own read handler in the conformance script, not a separate test client.
- Part 6: the history test uses a write that holds a secret value (`update ... 'PLANTED_SECRET'`), not a literal `CREATE USER ... PASSWORD`. The rule tested is the same: only statements that class as reads are listed.
- Fresh-reader review of the build (2026-11-14) found 3 blocking, 4 must-verify and 7 notes. Fixed, each with a test seen failing first:
  - A production open no longer moves any window: the Paseo 0.16 client SDK has no dialog outside a mounted panel (`@getpaseo/plugin` 0.16.0-beta.2, `dist/client/contracts.d.ts`), so the question waits in the workspace's Datawise tab for 30 minutes. This replaces Open-tab flow step 5's "confirm, then openPanel", which the SDK cannot do.
  - MongoDB `admin`, `local`, `config` and `system.*` collections are refused to agents; before the fix an agent's `datawise_read` returned `admin.system.users` rows on the test server.
  - `Adapter.count` takes a deadline that each driver enforces (DynamoDB abort signal, MongoDB `maxTimeMS`, Cassandra `readTimeout`, Neo4j transaction timeout, Elasticsearch request timeout); a filtered Redis count now counts matching entries instead of ignoring the filter.
  - Statement proposals never tell the agent "nothing was written", and the agent gets the count of statements run, never the database's error text.
  - `datawise_read` counts toward the 60 a minute limit; explain and history are logged; history answers fit in 256 KiB.
  - Waiting open requests expire after 30 minutes; the server saves an agent's place only when no window is open, so declining to leave pending edits keeps the person's place.
  - The connection form, OVERVIEW and CHANGELOG say that "Read rows" now includes read queries, which reach whatever the database user can read.
  - Conformance requires the classifier's own refusal for every write attempt and adds a read-then-write text per engine.
- A second fresh-reader review found 1 blocking, 1 must-verify and 5 notes. Fixed, each with a test seen failing first:
  - `datawise_read` invented an offset cursor when it cut a page to fit 256 KiB, which skipped and repeated entries on Redis (a 200-entry hash read back as 222 entries, 149 different) and broke DynamoDB and Cassandra paging. It now reads the page again with fewer rows, so the cursor is the engine's own, and refuses if the engine ignores the smaller limit.
  - `datawise_open` answers "Asked N Paseo windows to show X", since the server cannot know a window moved.
  - The production question shows the agent's words as codes and says when query text comes too.
  - `datawise_count` inputs are bounded; the hook test asserts the exact 10 tools; a test refuses every data tool on a hand-edited production connection; history wording no longer claims that reads hold no secrets.
  - Conformance: one test agent per feature check, so the per-agent limit counts one check's calls; the count deadline check runs on MongoDB, DynamoDB, Elasticsearch and Cassandra, where a 1 ms deadline reliably fails. SQL and Neo4j counts finished within 1 ms when tried, so their deadlines are verified by reading the code and driver types only.
  - A conformance helper of mine once built a DynamoDB adapter without the test endpoint, so the AWS SDK tried the machine's default credentials; it failed on an expired session and reached nothing. The check now refuses to build one without the local endpoint.
- Contested from the first review: a tool-level production test (the refusal lives in one shared rule, `agentRowLevel`, already unit-tested, and every data tool goes through `withLevel`), and showing line breaks in proposed statements (they are shown as codes on purpose, so a value cannot pass as another line).
- Not changed: the shared confirm dialog briefly shows its default title "Confirm" and button "Run" while fading out after any answer (`client/kit.tsx:434-444`). It predates this work; left as a follow-up.

## Open questions

None. M approved the plan on 2026-11-14 ("Approved, build it") with the recommended answers, recorded here:

1. Read-only queries on MongoDB, Redis, Elasticsearch, Cassandra and DynamoDB run when every statement is classed as a read. [decided: M, chat 2026-11-14]
2. Open-tab events go to every open Paseo window, pending the Part 0 check. [decided: M, chat 2026-11-14]
3. An agent may learn that a connection name exists through open-tab. [decided: M, chat 2026-11-14]
4. Decision record 0002 accepted. [decided: M, chat 2026-11-14]
5. Decision record 0003 accepted. [decided: M, chat 2026-11-14]
6. Other Paseo apps connected to M's daemon: not answered; an app below 0.16 shows no Datawise.
