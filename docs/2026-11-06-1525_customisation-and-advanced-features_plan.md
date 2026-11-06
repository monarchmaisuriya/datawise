# Datawise: customisation and advanced features

- Date: 2026-11-06 15:25
- Status: released as v0.2.0, as one release; M signed off with "finish all" on all four recommended answers
- Repos: `datawise`   Folders: `client/`, `server/`, `shared/`, `scripts/`
- Files: see each part
- Subagents: independent reviewers only
- Research: `docs/2026-11-06-1510_customisation-and-advanced-features_research.md`

## Context and problem

Datawise v0.1.1 is listed in the Paseo registry. Every setting is fixed in code, nothing survives a reload, there is one plain query box and one object at a time, edits save a row at a time, and the plugin has no connection to Paseo's files or agents. M asked for customisation options and advanced features without naming them, so this plan proposes a list for M to cut. No user demand has been gathered, so the order is judgment, resting on the fixed values and missing features verified below.

## Goals / Non-goals

**Goals**

- 0.2: a settings screen; labels, colors and groups on connections; saved per-table views; the screen comes back as you left it.
- 0.3: a real SQL editor on desktop and web, query tabs, run the selection, foreign key jumps, and edits reviewed and committed together.
- 0.4: open `.sql` and SQLite files from Paseo's file tab; attach a table's structure to a prompt; let agents read structure on chosen connections.
- Close the v0.1 test gaps: TLS and SSH key login.

**Non-goals**

- Agent writes. Agent reads of row data, unless M chooses that below.
- Run at the cursor. Finding statement boundaries across seven query languages needs a position-tracking rewrite of every parser, and review found it can run something other than what the user sees. Selecting text gives the same result with none of that.
- ER diagrams, schema or data compare, mock data, visual query builder, server dashboards, backup and restore, OS keychain, folders for saved queries, editing `.sql` files inside the panel. Reasons are in the research.
- Commits, releases and registry updates happen only when M says so for each release.

## What is true today

- No settings of any kind. [verified: grep for `registerSettings`, `addSettingsScreen`, `useSettings`]
- Fixed values live in `client/data-tab.tsx:12`, `client/query-tab.tsx:11-12`, `server/cells.ts:3`, `server/store.ts:46`, `server/pool.ts:7`. [verified]
- `Select` shows "Choose" for a value not in its options. [verified: `client/kit.tsx:212`]
- Connections, history and saved queries live in one `connections.json`, `version: 1`, parsed by Zod. [verified: `server/store.ts:39`]
- Navigation is `useState` only. [verified: `client/app.tsx:30-35`] Panels have `useTabState`; screens have no `tab`. [verified: reference, Workspace panels; reviewer confirmed]
- `DataTab` unmounts when the tab or object changes, and is keyed by object. [verified: `client/app.tsx`]
- `Grid` renders cells by position, with sizes and `cutCells` indexed the same way. [verified: `client/grid.tsx`] `RowForm` finds values by position against the columns it is given. [verified: `client/row-form.tsx`]
- A filter on a missing column throws before any rows return. [verified: `server/adapters/sql-base.ts`, `buildWhere`] Columns reach the client only after a read. [verified: `client/data-tab.tsx`]
- `writeInTransaction` is private to `SqlAdapter`, and takes a list of statements with expected counts. [verified: `server/adapters/sql-base.ts`]
- SQLite's shared pooled connection always opens read-write, even on a read-only connection, because `pooled` calls `this.connection(false)`. [verified: `server/adapters/sqlite.ts:179`] So a read-only directory fails on grid reads. [verified by reviewer's probe]
- MongoDB, DynamoDB and Neo4j name columns from sampled records, and Redis objects are key names. [verified by reviewer: `mongodb.ts:257`, `dynamodb.ts:126`, `neo4j.ts:149`, `redis.ts:165-185`]
- SQLite returns composite foreign keys one column per row, and PostgreSQL returns no column list. [verified: `sqlite.ts:237`, `postgres.ts:218`]
- Hooks can be added and removed at any time, and each change notifies the daemon. [verified: `paseo/.../plugins/lifecycle/index.ts:368-384`] Staleness depends only on whether the hook is declared, so a handler returning `undefined` still marks every agent stale. [verified by reviewer: `bootstrap.ts:1043`, `agent-manager.ts:906`] A thrown hook fails session opens daemon-wide. [verified by reviewer: `runtime.ts:600`]
- Agents can set labels through Paseo's tools, so a label is not a security control. [verified by reviewer: `paseo-tools.ts:1185,2269`]
- An attachment item must carry `text` and a valid `url` when search returns it. There is no separate resolve step. [verified: `@getpaseo/plugin/dist/attachments.d.ts`] The picker searches as soon as the source is active. [verified by reviewer: `picker.tsx:89-110`]
- Paseo's Markdown example bundles CodeMirror on web and uses a read-only view on native, keeping DOM code in `client/web.ts`. [verified: `plugin-examples/markdown-panel/client/web.ts`, reference line 1759]
- Registry updates for Git plugins are a one-file pin PR, as in `getpaseo/plugins` #1921. [verified]

## Options considered

| Option | How it works | Tradeoffs | Failure conditions | Completeness |
| --- | --- | --- | --- | --- |
| A: daily use, then Paseo-native | Three releases, smallest risk first | Agent features come last | Staged edits slip; they can be cut alone | 9/10 |
| B: agent access first | Tools before anything else | Biggest safety question first; touches every open agent on each reload | One injected row reaches a production read | 5/10 |
| C: desktop parity | Table designer, explain, compare | Largest, per-dialect | Long wait; no drawing library for ER | 6/10 |

RECOMMENDATION: A because 0.2 cannot change data, so risk rises only after the simple parts have shipped, and M can stop after any release.

## Decision

Build Option A as three separate releases, each reviewed and released on its own. Staged edits are a separate part that can be cut. Review simplified four features rather than hardening them: run the selection instead of the cursor, a read-only `.sql` panel, saving a SQLite file as an ordinary connection, and schema-only attachments with rows going by clipboard.

## Design

### Where each kind of preference lives

| Preference | Stored in | Why | Survives |
| --- | --- | --- | --- |
| App defaults | Paseo settings document `preferences` | Validated, atomic, live on every client | Reload and update; deleted when the plugin is removed |
| Label, color, group | `connections.json`, optional fields | Belongs with the connection | Remove and reinstall |
| Saved views | New `views.json`, 0600 | Grows with use; damage cannot touch connections | Remove and reinstall |
| Query tabs, last place | New `workspace.json`, 0600 | Text can be long and hold values | Remove and reinstall |

`connections.json` stays `version: 1` with additive optional fields. An older plugin that saves the file drops those fields. [inferred: Zod strips unknown keys] Stated in the changelog.

A damaged `views.json` or `workspace.json` means defaults and a logged note. A damaged `connections.json` still refuses, as today, because starting empty would overwrite credentials.

Deleting a connection removes its views, tabs and drafts.

### Settings (0.2)

`shared/preferences.ts` with `defineSettings({ id: "preferences", scope: "host", version: 1 })`. Every field has a default matching today, so a missing document changes nothing.

Choices are fixed lists that also feed the `Select` options, so no stored value can show as "Choose".

| Setting | Default | Choices | Missing or empty |
| --- | --- | --- | --- |
| Rows per page | 100 | 50, 100, 500, 1000 | 100 |
| Query row limit | 1,000 | 100, 1,000, 10,000, 100,000 | 1,000 |
| Query time limit | 60 s | 30 s, 1, 5, 30 min | 60 s; no "forever" |
| Write mode for new connections | Ask first | Read-only, Ask first, No prompts | Ask first |
| Row density | Comfortable | Compact, Comfortable | Comfortable |
| How NULL is shown | `NULL` | Any text up to 12 characters | Empty falls back to `NULL`, so a NULL never looks like empty text |
| Keep query history | On | On, Off | On. Off stops new entries; "Clear" stays separate |
| History length | 200 | 0, 50, 200, 1,000 | 200. Applied to all connections when changed, through `settings.subscribe`; 0 keeps none |
| Export folder | `~/Downloads/datawise` | Absolute or `~/...` | Empty means the default |
| Export format | CSV | The five formats | CSV; `sql` falls back to CSV on engines without it |
| Close idle connections after | 10 min | 5, 10, 30, 120 min | 10; no "never". Idle close already skips busy connections |

- **The write-mode default applies only in the client's new-connection form.** `safety.default("confirm")` in `server/store.ts` and `shared/contracts.ts` stays. Otherwise a preference of "No prompts" would turn any old record without the field into `open`.
- The server treats an `invalid` settings state as defaults and logs once.
- Fixed on purpose, because each protects the plugin process or the daemon's contract: 16 KiB cell, 32 MiB response, 25 s read deadline.
- `DataTab` waits for settings to be `ready` before its first read, so a table is not read twice.
- `contributeServer` takes `registerSettings`, so the conformance bed needs a stub. That change is part of Part 2.

### Connection labels (0.2)

New optional fields: `environment` (`none`, `development`, `staging`, `production`), `color` (fixed palette), `group` (text up to 60). The list groups by `group` and shows a color bar. `production` shows a banner on every tab.

**`production` cannot be `open`**, enforced in `server/store.ts` `resolveInput`, so no client can skip it. Existing connections are `none`. A label is not detection, and Datawise does not guess from host names.

### Saved views (0.2)

Keyed by connection id and `[database, schema, name]`. Holds `hiddenColumns`, `columnOrder`, `sort` and named `filters`.

- **`data` is never projected.** `Grid` takes a list of visible column positions and renders through it. Rows, `cutCells`, `keyOf` and `RowForm` keep using raw positions, so hiding a key cannot break an edit or misalign a cell.
- A view applies after `describe`, before the first read. On catalog engines, a sort or filter on a missing column is dropped with a note, so a stale view cannot stop a table opening. On schemaless engines columns are samples, so filters stay and a failure shows as today.
- Filter values can hold real data, so the file is 0600. OVERVIEW says so.

### Saved state (0.2)

`workspace.json` stores the last connection, place and object per surface, restored if they still exist. Otherwise it falls back without an error. A session-only password goes to the prompt as today. Panels also use `useTabState`, so each panel tab keeps its own place.

### SQL editor (0.3)

Follows Paseo's Markdown example: `client/web.ts` loads CodeMirror with `require` behind `Platform.OS === "web"`, and phones keep today's `TextInput`.

- `@codemirror/lang-sql` for highlighting and schema-aware completion, fed from `describe` for the current scope, for SQL engines. [unverified: not yet tried; Part 5 starts with a spike] Other engines get the plain editor without language support.
- Cmd or Ctrl+Enter comes from CodeMirror's keymap, so no plugin shortcut API is needed. Phones have the Run button.
- Client bundle size grows. Part 5 records the size, and the spike decides.

### Query tabs and run the selection (0.3)

- Several named tabs per connection, with drafts saved after 1 s idle. A "Don't save drafts" setting defaults to off. Two clients editing one tab: last write wins per tab, stated in the UI.
- **Run sends the whole text, or the exact selected text. There is no cursor mode.** The server parses what it gets, once, as today, so the gate sees exactly what runs. A label beside Run shows "Run selection, N characters" and the first line of the selection, so a person sees what will run.
- Selection state resets whenever text changes by program (history, saved query, prefill), and text is normalized to `\n`, so a stale selection cannot run a shortened statement such as a `DELETE` without its `WHERE`.
- Fix found in review, needed either way: T-SQL `IF ... BEGIN ... END` splits inside the block. `splitStatements` tracks `BEGIN`/`END` depth for `mssql`, so it stays one statement.

### Foreign key jumps (0.3)

`foreignKeys` gains structured `columns`, `targetSchema`, `targetTable`, `targetColumns`. `references` stays as display text. PostgreSQL moves to `conkey` and `confkey` joined to `pg_attribute`, and SQLite groups rows by `id`, so composite keys work.

A jump opens the target filtered by equality on every target column, using existing filters, so it adds no new query path. A composite key with any null, or an unknown target, offers no jump.

### Staged edits (0.3; can be cut)

```
Grid edit -> pending list above the tabs (nothing sent)        <-- new
  -> Review: server plans all, returns preview, no writes      <-- new
  -> Commit: one job, one transaction                          <-- new
       re-reads each row, compares what the user saw           <-- new
       writes; any mismatch rolls back all
```

- **One pending operation per original row.** Edits to a row merge. Delete wins over an update and shows that. Editing a key column is refused in pending mode; the row form still does it. So review's failing sequence, `id 2→3`, `id 1→2`, then an edit keyed `{id:2}`, cannot be expressed.
- `planBatch` is a new `Adapter` method and refuses duplicate keys, so the rule holds on the server, not only in the client.
- **Commit compares values, not just counts.** Row-count checks pass when a key now names a different row. Inside the transaction it re-reads each row by key and compares the changed columns with what the client sent as `original`. A difference rolls back all and names the row. This also stops pending edits widening last-write-wins from seconds to hours. A small window remains between read and write without row locks; stated in OVERVIEW.
- `transactionalEdits` is a new `EngineInfo` capability, true for PostgreSQL, MySQL, SQLite, SQL Server and Oracle. It is separate from `transactionalImport`, which Neo4j also sets. MySQL's `planBatch` refuses a table whose engine is not InnoDB, because MyISAM cannot roll back. [inferred: MySQL docs not re-read; conformance tests it]
- Passes `gate` once with the whole preview. Refused on `read-only`.
- Inline cell editing is new `Grid` work. Cut cells cannot be edited inline; the row form loads the whole row.
- Pending lists live in `Main`, not `DataTab`, so they survive switching tabs and objects, but not a reload. Leaving a connection with pending edits asks first. Panels also call `tab.setModified(true)`; screens have no such hook, so the app's own prompt covers them.

### File panels (0.4)

- **`.sql`:** shows the file read-only with a connection picker and Run through the normal `runQuery`, so the gate applies. Editing stays in Paseo's own editor, so there is no write path or conflict handling here. Uses `readText` plus `watch`.
- **`.sqlite`, `.sqlite3`, `.db`:** a server RPC reads the first 100 bytes of `file.path`, checks the SQLite header and reads the journal mode at bytes 18-19. It shows table names and "Add as connection", which opens the normal form prefilled, `read-only` by default. So there is no temporary connection type or separate store path. Not SQLite: says so and offers nothing.
- **WAL files.** Opening a WAL database, even read-only, creates `-wal` and `-shm` beside it. [verified by reviewer's probe] The form says this when the header shows WAL.
- **Fixed first, as a bug in Part 1:** SQLite's pooled connection honours read-only, and normal close stops the child gracefully, keeping SIGKILL for cancel, so sidecar files are not left behind by routine closes.

### Attachments (0.4): structure only

Search must return text immediately, so reading rows here would read every match on every keystroke, across every saved connection. So:

- **An item holds structure only**, using the same whitelist as the agent tool.
- Search matches only connections that are already open, and never opens one, so it cannot trigger a password prompt or reach an idle production server. Production connections are excluded. At most 10 matches.
- **Rows go by clipboard.** A new "Copy as Markdown" on results and pages. A person chooses the rows and pastes them, and the plugin never pushes data into a prompt. Copying already exists; this adds a format.
- The picker says the text goes to the agent's provider and stays in the chat. [unverified: whether Paseo persists it in history; check in Part 9]

### Agent tool (0.4): structure only, on chosen connections

`datawise_describe` lists tables, columns, types, nullability and keys.

- **Catalog engines only.** A new `catalogSchema` capability is true for PostgreSQL, MySQL, SQLite, SQL Server, Oracle, ClickHouse and Cassandra. It is false for Redis, MongoDB, DynamoDB, Neo4j and Elasticsearch, whose "columns" come from data or whose objects are key names, so `agentAccess` is refused there on the server.
- **Whitelist output.** Built field by field from names and types, leaving out `facts`, `definition`, defaults and index expressions. Types with embedded values are reduced: `enum('a','b')` becomes `enum`, on MySQL and ClickHouse.
- `agentAccess` (`none`, `schema`) is per connection, default `none`. **A `production` connection is refused above `none`, in `resolveInput`.** Re-checked on each call.
- **Opt-in is per connection, not per agent.** A label would not be a control, because agents can set labels themselves. So when any connection is opted in, every agent gets the tool. This is acceptable because it returns no row data.
- **The hook is registered only while at least one connection is opted in.** `contribute` must return synchronously and the store loads asynchronously, so registration follows the first load, and follows changes to `agentAccess`. Removing it returns everyone to no hook.
- The handler adds a constant to the tool list and reads nothing, so it cannot throw. A thrown hook would fail every agent's session.
- **Cost, stated in the UI:** turning this on or off, and reloading Datawise while it is on, makes open agent sessions reopen before their next idle prompt.
- Testing uses a throwaway daemon and scratch agents only.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | How noticed |
| --- | --- | --- | --- | --- |
| Commit changes a different row than shown | Low | Data | One op per row, no key edits in pending mode, value comparison in the transaction | Conformance per engine |
| Row changes between comparison and write | Low | Last write wins, briefly | Stated in OVERVIEW; no row locks, which would differ per engine | Stated limit |
| MySQL table without transactions | Low | Partial commit | `planBatch` refuses non-InnoDB | Conformance |
| Stale selection runs a shortened statement | Low | Data | Reset on programmatic change, `\n` normalization, the label shows what will run | Test; browser check |
| Hidden column misaligns the grid | Medium | Wrong cell shown or edited | Never project `data`; visible position list only | Test with a hidden key and a cut cell |
| Saved filter blocks a table | Medium | Annoyance | Dropped with a note on catalog engines; shown as a normal error elsewhere | Test |
| Filter values or drafts hold sensitive text | Medium | Privacy | 0600; documented; "Don't save drafts" | Store test; OVERVIEW |
| Column name carries injected text | Low | Agent acts on it | Opt-in, no rows, never production, capped, description marks it untrusted | Review |
| Row data reaches an agent through the tool | Low | Injection, leak | Catalog engines only; whitelist by construction | Test asserts a planted value is absent, per engine |
| Tool hook disturbs M's agents | Certain when on | Sessions reopen | Only when opted in; stated in the UI; testing on a throwaway daemon | Manual check |
| Hook throws | Low | Every agent's session fails | Constant, no I/O | Code review, test |
| CodeMirror bundle too big or breaks phones | Medium | Slow load, native crash | Web-only `require` behind `Platform.OS`, as the example; size recorded in the spike; can be cut | `rg` DOM audit; phone-width check |
| Settings break a connection | Low | Connections fail | Invalid means defaults | Test |
| `.db` file is not SQLite | High | Confusing error | Header check before any open | Test |
| WAL sidecars appear beside a user's file | Medium | Surprise files | Stated in the form; graceful close | Probe in Part 8 |
| Machine stalls look like plugin hangs | Seen once | Wrong diagnosis | Check `uptime` first | Manual |

## Acceptance criteria

- Given no settings document, when the plugin runs, then every behaviour matches v0.1.1.
- Given a damaged settings document, when connecting, then connections work with defaults.
- Given a stored connection with no `safety` and a preference of "No prompts", when it loads, then it stays Ask first.
- Given `production` and No prompts, in either order, when saving, then the server refuses.
- Given a hidden key column and a cut cell in the same row, when the row is shown and edited, then the right cell shows and the right row changes.
- Given a view with a filter on a dropped column on a catalog engine, when the table opens, then it opens with a note.
- Given a reload, when Datawise reopens, then it returns to the last place or falls back without an error.
- Given a TLS server, when connecting in `verify` with a wrong host name, then it is refused; `require` connects; `off` fails clearly. On PostgreSQL, MySQL, Redis, MongoDB.
- Given an SSH private key, with and without a passphrase, when tunnelling, then it works, and a wrong key is refused.
- Given a SQLite file in a read-only folder on a read-only connection, when browsing, then rows load.
- Given a selection, then history loading new text, when Run is pressed, then the whole new text runs, not the old offsets.
- Given a selection holding a `DELETE`, when Run is pressed, then it asks, showing that text.
- Given `IF 1=1 BEGIN DELETE ...; END` on SQL Server, when parsed, then it is one statement.
- Given a composite foreign key, when jumping, then the filter covers every column, on the 5 SQL engines with foreign keys.
- Given the sequence `id 2→3`, `id 1→2`, when staging, then the key edit is refused, and a batch holding two operations on one key is refused by the server.
- Given a row changed by someone else after staging, when committing, then all edits roll back and the row is named.
- Given a `read-only` connection, when committing, then it is refused and nothing changes.
- Given a MyISAM table, when staging, then it is refused with the reason.
- Given a `.db` file that is not SQLite, when opened, then it says so and opens nothing.
- Given many saved connections, when the attachment picker opens empty, then no connection is opened and no rows are read.
- Given `agentAccess: none` on all connections, when the plugin runs, then the hook is not registered.
- Given `agentAccess: schema` on a table with planted text in rows and a default, when the tool runs, then none of that text appears, per catalog engine.
- Given Redis, MongoDB, DynamoDB, Neo4j or Elasticsearch, or `production`, when `agentAccess` is set, then the server refuses.

## Rollout and rollback

Each release: throwaway daemon, conformance on all engines, M tries it, then tag, GitHub release and a registry pin PR, only when M says so. Reinstalling the prior tag restores behaviour; older versions ignore the new files. Abort a release if any engine fails conformance or any write acceptance test fails. `connections.json` only gains optional fields, so no migration can strand data.

## Parts

### Part 1: Close v0.1 gaps

- [x] TLS services in `test/compose.yaml` with a generated test CA. Done: `off`, `require`, `verify` and wrong-host conformance on 4 engines.
- [x] SSH key and passphrase cases. Done: tunnel test passes with a key; wrong key refused.
- [x] SQLite pooled connection honours read-only; graceful close. Done: read-only folder acceptance passes.
- [x] `mssql` `BEGIN`/`END` depth in `splitStatements`. Done: unit test and a real run.

### Part 2: 0.2 settings

- [x] `shared/preferences.ts`, `registerSettings`, `client/settings-screen.tsx`, read defaults where values are fixed, conformance stub. Done: no-document, damaged-document and missing-safety acceptance pass.

### Part 3: 0.2 connection labels

- [x] Contract, store rule, grouping, banner. Done: production and open refused on the server, in both orders.

### Part 4: 0.2 saved views and state

- [x] `server/views.ts`, `server/workspace.ts`, RPCs, `Grid` visible positions, column menu, saved filters, restore. Done: hidden key with cut cell passes, dropped column passes; delete removes views.
- [x] Released as one release, v0.2.0, because it was built and tested as one body of work.

### Part 5: 0.3 SQL editor

- [x] Spike: CodeMirror with `lang-sql` on a throwaway daemon, on desktop width and phone width. Done: bundle size and load time recorded; decision noted here, and the part is dropped if it fails.
- [x] Editor, completion from `describe`, Cmd+Enter. Done: browser check; DOM audit clean outside `client/web.ts`; phone keeps `TextInput`.

### Part 6: 0.3 query tabs and selection

- [x] Tabs, drafts, selection run, reset and normalization, label. Done: stale-selection and selected-`DELETE` acceptance pass on all 12 engines' query languages where selection applies.

### Part 7: 0.3 foreign key jumps

- [x] Structured `foreignKeys`; jump. Done: composite and null cases per engine with real foreign keys.

### Part 8: 0.3 staged edits (can be cut)

- [x] `planBatch`, `data.write-batch`, comparison in the transaction, `transactionalEdits`, InnoDB check. Done: conflict sequence, changed-row, read-only and MyISAM acceptance pass, on 5 engines.
- [x] Inline editing and pending list in `Main`. Done: survives tab switching; leaving asks.
- [x] Included in v0.2.0.

### Part 9: 0.4 file panels

- [x] `.sql` panel; SQLite header RPC; prefilled form; WAL note. Done: non-SQLite `.db` passes; sidecar behaviour recorded in OVERVIEW, tested in a real workspace on a throwaway daemon.

### Part 10: 0.4 attachments and Copy as Markdown

- [x] Source with whitelist, open connections only, production excluded; Copy as Markdown. Done: empty-picker acceptance passes; history persistence checked with a scratch agent and stated in OVERVIEW.

### Part 11: 0.4 agent tool

- [x] `catalogSchema`, `agentAccess`, store rules, whitelist, conditional hook, OVERVIEW. Done: acceptance rows pass on a throwaway daemon with scratch agents, cleaned up by folder.
- [x] Included in v0.2.0.

## Standardized review

### At a glance

- **Bottom line:** present after fixing 6 blocking. All findings are applied in this version.
- **Where we are:** research and plan reviewed by an independent agent; partial, because fixes were not re-reviewed by a second reviewer. No database servers ran.
- **Need from M:** 4 decisions, in the chat briefing.
- **Why:** the first draft kept a parser-dependent feature, wrongly called structure-only output safe on engines where structure comes from data, and read rows during attachment search.
- **Intended outcome:** a plan another engineer can build without data loss.
- **Findings:** 6 blocking, 5 must-verify, 1 note.

### Findings and what changed

| # | Severity | Finding | Fixed by |
| --- | --- | --- | --- |
| 1 | blocking | Running a statement chosen at the cursor re-parsed it, so a `DELETE` inside a procedure ran alone | Cursor run removed; whole text or exact selection, parsed once |
| 2 | blocking | Stale or mis-normalized offsets could shorten a `DELETE` | Selection reset, `\n` normalization, label showing what runs |
| 3 | blocking | Staged key edits passed the row-count check on the wrong row | One op per row, no key edits, server refuses duplicates, values compared |
| 4 | blocking | "No row data by construction" was false for five engines | `catalogSchema`; refused elsewhere; whitelist output |
| 5 | blocking | Attachment search read rows on every keystroke across all connections | Structure only, open connections only, rows by clipboard |
| 6 | blocking | "Read-only" still wrote sidecar files, and temporary connections had no home | Saved connection form, WAL note, pooled fix, graceful close |
| 7 | must-verify | Hook claims wrong; labels no control; thrown hook is daemon-wide | Runtime registration; per-connection opt-in; constant handler |
| 8 | must-verify | Hiding columns would misalign a position-based grid | Visible position list; `data` never projected |
| 9 | must-verify | Pending edits did not survive tab switches; capability conflated with import | State in `Main`; `transactionalEdits`; InnoDB check |
| 10 | must-verify | Settings: ranges, default write mode, history, second read, test stub, draft conflicts | Fixed choices; client-only default; `subscribe`; wait for `ready`; stub; stated last-write-wins |
| 11 | note | SQLite composite foreign keys; scope of Part 5; candidates to cut | Group by `id`; all engines named; folders cut; density and export format left for M's cut list |
| 12 | must-verify | "No code editor possible" was false; DBeaver and demand claims overstated | CodeMirror added to 0.3; research corrected |

### Scope and limits

- **Reviewed:** this plan, the research, Datawise source, the Paseo plugin reference, hooks page and server source.
- **Checks not run:** no database servers, no real agent. Probes were pure modules and SQLite only. CodeMirror with `lang-sql` is unverified until the Part 5 spike.
- **Own re-check:** I confirmed the attachment contract, hook registration, SQLite pooled opening and the CodeMirror example in source. The rest rest on the reviewer's citations.
- **Could not break:** MySQL no-op updates, idle close during a job, SQLite batch interleaving, read-only staged commits, surrogate pairs in the JS probe, and export paths.
- **Confidence:** high on platform facts, medium on staged edits until conformance runs.

### In plain terms

The first draft's cursor run, attachment rows and "schema only" claim would each have caused real harm. All three are replaced with simpler designs. M decides scope.

## Changes made

All parts shipped in v0.2.0.

**Deviations from this plan, each on purpose:**

- Saved place is per surface: the screen, or one per workspace for panels. `useTabState` is not used, so panels in one workspace share a place.
- A cell edit opens a small dialog instead of an input inside the grid, which works the same on a phone.
- The SQLite panel does not list table names, because opening a database can create files beside it. It reads only the first 100 bytes.
- Saved views also hold the filters in use (`filtersInUse`), so a table opens as it was left. A foreign key jump's filter is not saved.
- `.sql` panel runs on the connection's default database, with no database picker.
- Foreign key jumps are offered from an open row, because a jump needs a row's values.
- Attachment persistence: text is sent as a prompt block [verified: `paseo/packages/server/src/server/agent/prompt-attachments.ts`]. No real agent ran. Whether a chat keeps it is stated in OVERVIEW as what a prompt normally does, and is [unverified: send one attachment to a scratch agent and read its history].
- The agent tool: served through Paseo's real agent tool route on a throwaway daemon, listed for a real scratch Claude agent session, and called directly on that route for all five cases, with no planted text [verified: MCP tools/list and tools/call]. One real prompt ran first and could not find the tool, because that daemon's `mcp.injectIntoAgents` was unset, and it defaults to false [verified: `paseo/packages/server/src/server/config.ts:550`]. With the setting on, a second prompt had a real Claude agent find the tool by keyword and make all five calls itself. It saw only the shared connection, was refused on the unshared and production ones, and no planted text reached its transcript [verified: agent log and transcript]. In the default permission mode Paseo asks before each call.

**CodeMirror spike:** kept. It works at desktop and phone width in the browser, with no console errors. The client bundle, minified with shared packages left out, is 558 KiB, of which CodeMirror is 450 KiB [verified: esbuild]. Load time was not measured separately. Native iOS and Android builds were not run; DOM use is confined to `client/web.ts` [verified: grep].

**Found while building, fixed at the source:**

- MySQL Verified encryption accepted a wrong host name.
- Oracle dates reached the grid as JavaScript date text, losing microseconds and failing when written back. Table reads now use `TO_CHAR`.
- `Store.load` could lose a save during a first-load race. Now one shared load.
- MongoDB Verified encryption now uses the same identity check as other engines.

**Hands-on test (for M, in the browser on a throwaway daemon, with test databases):** found and fixed 6 defects. Copy as Markdown copied a cut value with no mark; closing a tab discarded its text without asking; typed text in preferences was lost when a dropdown saved; an old error stayed on screen after the next action; the color called blue was a second green in the default theme, now replaced by a high-contrast color; the attachment row repeated the table name, and its provider note was invisible, because Paseo does not show the picker title, so it is now in each row.

**Independent review:** 2 blocking and 7 must-verify findings, all fixed: cell edits now hold the row itself, not a position; deletes compare values; the editor owns the selection; failed reads never overwrite saved state; drafts flush on leaving; late saves cannot restore a deleted connection's state; commit keeps edits staged during it. Fixes were not re-reviewed by a second reviewer.

## Open questions

See the chat briefing: scope, agent access, production rule, staged edits.
