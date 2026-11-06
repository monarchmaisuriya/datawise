# Datawise: multi-database client plugin for Paseo

- Date: 2026-11-06 12:15
- Status: done, awaiting M
- Repos: `datawise` (new)   Folders: `/Users/monarchmaisuriya/Experiment/datawise`   Files: all new
- Subagents: independent plan and code reviewers only
- Research: `docs/2026-11-06-1206_datawise-db-client_research.md`

## Context and problem

M works in Paseo but must leave it to look at a database. Paseo's registry has one database plugin, for SQLite only. M asked for `datawise`: a database client with basic CRUD, import and export, and other basic to intermediate features, for PostgreSQL, MySQL, Redis, MongoDB and the other widely used databases.

## Goals / Non-goals

**Goals**

- One screen and one workspace tab that connect to 12 engine families through one contract.
- Connection manager with TLS, SSH tunnel and a per-connection write-safety mode.
- Browse databases, schemas and objects. See columns, indexes, foreign keys and definitions.
- Read data with paging, sort and filter. Insert, edit and delete rows.
- Query editor in each engine's own language, with multi-statement scripts, cancel, timeout, history and saved queries.
- Import CSV, TSV, JSON, NDJSON. Export CSV, JSON, NDJSON, SQL `INSERT`s. Background jobs with progress and cancel.
- Works on desktop and compact layouts, in every Paseo theme.

**Non-goals**

- Agent access to databases (tools, MCP, attachments). A real follow-up, because it needs its own safety design.
- Snowflake, Databricks, BigQuery, Db2: no local test server or native driver only.
- ER diagrams, schema diff, autocomplete, syntax highlighting, visual query builder, native dump and restore tools.
- Git commits, publishing, and installing into M's real daemon. M does those, or asks.

## What is true today

- No `datawise` code exists. [verified: `ls /Users/monarchmaisuriya/Experiment`]
- Paseo daemon and CLI are 0.15.1; npm SDK is 0.15.2. [verified: `paseo --version`; `npm view @getpaseo/plugin version`] Pin SDK 0.15.1 so the types match the running daemon.
- Plugins are enabled on M's daemon. [verified: `~/.paseo/config.json`, `pluginsEnabled` True]
- Server bundle: esbuild, `bundle: true`, CommonJS, `platform: node`, target node20, only the SDK and zod external. [verified: `paseo/packages/server/src/server/plugins/compiler-build.ts:352-378`]
- Plugin process runs Electron 44 / Node 24.20 and `node:sqlite` loads. [verified: `ELECTRON_RUN_AS_NODE=1 Paseo -e ...`]
- Plugin RPC runs inside the daemon's plugin session, so any client that can reach the daemon can call it. Settings RPCs use `daemon.manage`. [verified: Plugin reference, Persisted values] Plugin-level auth does not exist. [inferred: the reference documents no per-plugin auth]
- Data folder comes from `resolvePaseoHome`. [verified: `contextualise/server/paseo-home.ts:7-14`]
- Docker has 8 GB and 15 CPUs on arm64. [verified: `docker info`] M's `owly_ai-*` containers are running and must not be touched. [verified: `docker ps`]

## Options considered

| Option | How it works | Tradeoffs | Failure conditions | Completeness |
| --- | --- | --- | --- | --- |
| A: one plugin, adapter per engine | One typed `Adapter` interface; drivers in the plugin subprocess, loaded lazily | Large single server bundle | A driver will not bundle: drop that driver alone | 9/10 |
| B: core plus one plugin per engine | Separate plugins | Plugins cannot share code, so the core is copied | Contract change touches every repo | 7/10 |
| C: shell out to CLIs | Spawn `psql`, `mongosh` | Parsing output per version | CLI missing; password on argv | 4/10 |

RECOMMENDATION: A because the platform has no shared-code mechanism and a typed adapter keeps engine differences out of the client.

## Decision

Build Option A. All connection details, safety decisions and dialect knowledge live in `server/`. The client renders what the contract returns and never builds a query. M asked for the whole chain in one request, so the implementation runs after this plan is reviewed and fixed. Anything irreversible outside the new folder still waits for M.

Rejected: Option B and C as above. Also rejected: settings documents for connections, because Paseo says they are not a credential vault.

## Design

### Layout

```
datawise/
  paseo-plugin.json  OVERVIEW.md  README.md  package.json  tsconfig*.json
  index.client.tsx   index.server.ts
  shared/   contracts.ts (Zod RPCs)  engines.ts (catalog: fields, ports, capabilities, templates)
            connection-url.ts (URL -> form fields)
  server/   plugin.ts  store.ts  pool.ts  tunnel.ts  safety.ts  sql-script.ts  cells.ts
            jobs.ts  formats.ts  http.ts  errors.ts
            adapters/ types.ts  index.ts  sql-base.ts  postgres.ts  mysql.ts  sqlite.ts  mssql.ts
                      oracle.ts  clickhouse.ts  mongodb.ts  redis.ts  elasticsearch.ts
                      cassandra.ts  dynamodb.ts  neo4j.ts
  client/   app + feature screens + small kit
  test/     compose.yaml
  scripts/  conformance.ts (one suite, run per engine, bundled like the daemon does)
```

### Target flow

```
Client surface
  | useRpc(contract)
  v
server/plugin.ts           validates input (Zod), scrubs secrets from every error
  v
server/safety.ts           read-only -> refuse; confirm -> return preview; open -> run   <-- owns "may this write?"
  v
server/pool.ts             one adapter per connection, idle close, optional SSH tunnel
  v
server/adapters/<engine>   dialect, identifiers quoted, values always bound
  v
driver -> database
```

### Engines and drivers

| Family | Driver | Hierarchy | Query language | Server-enforced read-only |
| --- | --- | --- | --- | --- |
| PostgreSQL | `pg` | database > schema > table | SQL | `BEGIN READ ONLY` plus classifier |
| MySQL, MariaDB | `mysql2` | database > table | SQL | `START TRANSACTION READ ONLY` plus classifier |
| SQLite | `node:sqlite` in a worker thread | file > table | SQL | `readOnly` open |
| SQL Server | `mssql` | database > schema > table | T-SQL | transaction always rolled back, plus classifier |
| Oracle | `oracledb` Thin | schema > table | SQL | `SET TRANSACTION READ ONLY` plus classifier |
| ClickHouse | own HTTP | database > table | SQL | `readonly=1` |
| MongoDB | `mongodb`, `@mongodb-js/shell-bson-parser` | database > collection | `db.c.find({})`, no `eval` | method allowlist; `$out` and `$merge` refused |
| Redis | `ioredis` | db index > key | commands | `COMMAND` flags from the server, unknown refused |
| Elasticsearch, OpenSearch | own HTTP | index | `GET /i/_search` console form | method and path allowlist |
| Cassandra, Scylla | `cassandra-driver` | keyspace > table | CQL | classifier allows `SELECT`, `DESCRIBE`, `USE` only |
| DynamoDB | `@aws-sdk/client-dynamodb` | table | PartiQL, plus JSON `CreateTable`, `DeleteTable` | `SELECT` only; JSON refused |
| Neo4j | `neo4j-driver` | database > label | Cypher | session `READ` mode |

`Revises: "drivers load through await import() and stay in the bundle" -> "drivers are never bundled; they load at runtime with createRequire from the plugin's own node_modules", because review ran the real compiler: ssh2 fails compile or load, mssql breaks under Paseo's eager interop rewrite, the parser breaks, and the compile takes 24 to 27 s.`

`server/drivers.ts` finds the plugin folder from `<paseo home>/config.json` (the entry whose `paseo-plugin.json` id is `datawise`) and requires the driver from there. [verified: all 13 packages loaded under Electron's Node this way] The config shape is not a public contract, so a change fails loudly with one clear error, and only at first connect.

### Adapter contract

```ts
interface Adapter {
  ping(): Promise<{ serverVersion: string }>;
  listDatabases(): Promise<string[]>;
  listSchemas(database?: string): Promise<string[]>;
  listObjects(scope: Scope, opts: { pattern?: string; cursor?: string }): Promise<ObjectPage>;
  describe(ref: ObjectRef): Promise<ObjectDetails>;     // columns, keys, indexes, FKs, definition, notes
  read(ref: ObjectRef, q: ReadQuery): Promise<RowPage>; // limit, cursor, sort, filters
  count(ref: ObjectRef, filters: Filter[]): Promise<number>;
  readRow(ref: ObjectRef, key: RowKey): Promise<RowPage>;
  planWrite(ref: ObjectRef, op: WriteOp): Promise<WritePlan>; // { preview, run() -> affected }
  planDestroy(ref: ObjectRef, action: "drop" | "truncate"): Promise<WritePlan>;
  classify(text: string): Promise<Statement[]>;         // split and mark read | write | unknown
  run(stmts: Statement[], ctx: RunContext): Promise<QueryResult[]>;
  stream(ref: ObjectRef | QuerySource, onBatch): Promise<void>; // used by export
  insertMany(ref: ObjectRef, rows: Row[], tx: boolean): Promise<number>; // used by import
  close(): Promise<void>;
}
```

Capabilities live in `shared/engines.ts`, one row per engine: which filter operators, whether sort, truncate, drop, transactions and `EXPLAIN` exist, the create-object template text, and form fields. The client reads this table and never branches on engine name. `sql-base.ts` implements `read`, `count`, `readRow`, `planWrite` and `planDestroy` once, for the five dialect-driven SQL engines; ClickHouse reuses read and count and only allows insert.

### Safety

- Each connection stores `safety`: `read-only`, `confirm` or `open`. **Default `confirm`.** A missing value means `confirm`. An invalid stored value fails the store load instead of silently picking a mode.
- `read-only`: writes and unknown statements are refused in `safety.ts`. On engines that have it, the session is also put in read-only mode, using a protocol that takes one statement per request, so the text cannot end the read-only transaction itself. SQLite adds an authorizer that denies everything but reads.
- `Revises: "a misclassified statement is still refused" -> "the second layer narrows the risk but is not a guarantee", because review wrote through BEGIN READ ONLY with SET TRANSACTION and COMMIT on PGlite, and Oracle DDL, dblink_exec and similar routes exist.` The only guarantee is a database role without write rights, and OVERVIEW says so.
- `confirm`: without `confirmed: true`, the RPC returns `{ status: "confirm", preview }` and does nothing. The client shows it, the user accepts, the client resends.
- `open`: runs directly.
- `drop` and `truncate` always need a confirm name equal to the object name, checked on the server, in every mode except `read-only`, which refuses.
- The classifier fails closed. A statement it cannot prove is a read is `unknown`, which counts as a write. Token scan runs on all statements because T-SQL allows `SELECT 1 DROP TABLE x` with no separator. Quoted identifiers and strings are excluded from the scan.
- Row updates and deletes need a key: primary key or a non-null unique index. No key means the row is read-only with a stated reason. `affected` must be 1 for a single-row write, otherwise the error says so. The writes that cannot be undone are shown first through `preview`.

### Limits and edge values

| Setting | Default | 0 / empty / missing |
| --- | --- | --- |
| Query timeout | 60 s | range 1 s to 1 h; 0 is rejected by Zod, there is no "forever". Queries run as polled jobs, because every plugin RPC has a 30 s daemon deadline with no cancel [verified: `runtime.ts:41,721-733`]. A synchronous call that kept writing past it would report failure and then commit |
| Synchronous read RPC | 25 s | stays under the daemon's 30 s; on expiry the statement is cancelled and the error says so |
| Row limit, query result | 1,000 | range 1 to 100,000; 0 rejected |
| Page size, grid | 100 | range 1 to 1,000 |
| Cell size in the grid | 16 KiB | larger cell is cut, marked, and not editable until the full row is fetched |
| Response size | 32 MiB | exceeding stops reading and sets `truncated` |
| Idle connection close | 10 min | fixed |
| Export overwrite | never | `wx` file flag; existing path is an error |

Truncated cells cannot be edited from the cut text, so a write can never store the cut value.

### Cells

Rows cross the RPC as JSON-safe values. Drivers are configured for exact values: PostgreSQL date and time types stay as text (review proved a timezone shift otherwise), MySQL dates and big numbers stay as text, Oracle numbers and dates are fetched as text with a fixed format, SQLite reads as bigint, MongoDB keeps `Long` and writes unsafe ones as `$numberLong`, and SQL Server decimals and dates are cast to text in the grid's own `SELECT`. Bytes use an unmistakable tag, `{ "$datawise.bytes": "<base64>" }`, so a real JSON value cannot be mistaken for bytes. A float key column disables editing with a stated reason. An update sends changed columns only. Last write wins: there is no concurrent-edit check, and OVERVIEW says so.

### Secrets

- Stored in `<paseo home>/plugin-data/datawise/connections.json`, folder 0700, file 0600, written atomically.
- `Revises: "same baseline as .pgpass" -> "0600 does not stop agents", because Paseo agents run as the same OS user and can read the file.` So a connection can also keep its password for this session only, in memory, and ask again after a restart. OVERVIEW states the limit.
- The client receives `hasPassword: true`, never the value. On save: missing means keep, `null` means clear, a string means replace.
- `errors.ts` replaces every known secret value in messages before they are logged or returned, including through the URL form of a password.
- History stores query text and never results. It holds at most 200 entries per connection and can be cleared. Query text can contain secrets, so it is 0600 too.

### Transport

- `tls`: `off`, `require` (encrypted, no certificate check), `verify` (full check). The form defaults to `off` for loopback hosts and `verify` otherwise. A non-loopback `off` connection shows "Not encrypted" on its row.
- SSH tunnel uses `ssh2`, password or private key. Host key is pinned on first use, stored as a SHA-256 fingerprint and shown in the test result. A changed key is refused until the user clears it. The driver connects to a local forwarded port; TLS still checks against the original host name.
- HTTP adapters lock requests to the connection's origin. A query path that would change origin (`//evil`, absolute URL) is refused, so credentials cannot be sent elsewhere.

### Import and export

- Queries, writes, counts, imports and exports all run as one kind of job, and the client polls status. A polled job survives a client reconnect; a subscription handler stops when the client disconnects. [verified: Plugin reference, Handler lifetime] Jobs live in memory and die with the plugin, so a status call after a reload says the job is gone and to check the database before running it again.
- Export writes to `<path>.partial`, then links it to the final name and removes the partial, so an existing file is never overwritten and a failed export leaves no file that looks complete.
- Import source is a daemon-side absolute path or pasted text. Preview returns the first 20 records and columns. The user maps columns. Rows insert in batches of 500, inside one transaction on engines that have them; otherwise the job reports how many rows landed before a failure. Import honours `safety`: refused on `read-only`, and `confirm` asks once.
- Export source is a table with its current filter and sort, or a query. Destination is a daemon-side absolute path, default `~/Downloads/datawise/<name>-<timestamp>.<ext>`. "Copy" returns up to 5 MB as text.
- No browser download or phone file picker, because the plugin API has none. [verified: searched the reference for picker and download terms] A phone user can still paste and copy.

### Client

- `addScreen` plus `addSidebarHeaderItem`, `addWorkspacePanel`, and `addCommandCenterItem`, all rendering one `DatawiseApp`.
- Wide layout: left rail with connections and object tree, right pane with tabs Data, Structure, Query. Compact layout: one level at a time, with a back row.
- Grid: horizontal `ScrollView` around a vertical `FlatList`, widths from content, 80 to 320 units. Tap a row to open it in a host `Modal` with fields, Set NULL, Copy, Save, Delete. Selection and bulk delete.
- Colors from `theme.colors`, sizes from `layout.compact`, no DOM.

### Auth

Every RPC requires the daemon's `daemon.manage` permission. [verified: `operation-permissions.ts:147`] The plugin adds no second login, because anyone holding that permission can already run agents as that user. [inferred: Plugin reference, Hosts and trust] OVERVIEW.md says plainly that connections are usable by anyone with access to the daemon.

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | How noticed |
| --- | --- | --- | --- | --- |
| A driver breaks under esbuild or Electron | medium | one engine lost | Conformance runs from the bundle under Electron | Conformance fails for that engine |
| Bundle so large that plugin start is slow | medium | slower reload | Lazy evaluation; measure | Part 8 records bundle size and load time |
| Classifier calls a write a read | low | data change on a `read-only` connection | Fail closed plus server-enforced mode where it exists. SQL Server uses rollback; Cassandra and DynamoDB rely on the allowlist alone | Conformance attempts real writes under `read-only` |
| Function with side effects inside `SELECT` | medium | change on `confirm` without prompt, because it classifies as read | Accepted for `confirm`; `read-only` still enforced by the server on PG, MySQL, Oracle, ClickHouse, SQLite, Neo4j. OVERVIEW states the limit | Stated limit |
| Password or query text leaks to logs | low | credential exposure | No logging of statements; `errors.ts` scrubs; conformance asserts the password is absent from a forced auth failure | Test |
| Credential file readable | low | credential exposure | 0600 and 0700, verified by a test | Test |
| Huge result exhausts memory | medium | plugin crash | Row, cell and response limits; `stream` for export | Conformance reads a table over the page limit |
| `node:sqlite` blocks the subprocess | high without isolation | every RPC stalls | A child process per connection. `Revises: "worker thread" -> "child process", because worker.terminate() did not stop a recursive query after 8 s and SIGKILL ended it in 304 ms [verified by review]` | Conformance cancels a long query |
| A driver's stray `error` event kills the plugin process | low | every job lost | Listeners on every client, plus a logged, scrubbed process-level handler | Conformance forces a connection loss |
| Redis command wrongly treated as a read | low | data change | Allow only `readonly`-flagged commands, refuse `admin`, resolve subcommands, explicit never-read list for scripts [verified: `EVAL` has no `write` flag] | Conformance sends `EVAL` and `FLUSHALL` on a read-only connection |
| Node discovery bypasses the SSH tunnel | medium | connection fails or leaves the tunnel | Direct modes: Mongo `directConnection`, Neo4j `bolt://`, Cassandra address translator. No Redis Cluster support; `MOVED` errors surface | Conformance through a tunnel |
| SQL Server image fails on arm64 | medium | that engine untested | Rosetta; if it fails, ship marked untested and tell M | Part 8 |
| Mutating M's running containers, or starving them of memory | medium | M's dev data or services | Own compose project `datawise-test`, own ports, a memory limit per container, one heavy engine at a time | `docker ps` before and after |
| Directory install shares M's real daemon | low | test agent side effects | Throwaway daemon via `--home`; never M's daemon | Plugin absent from `paseo plugin ls` |

## Acceptance criteria

- Given each of the 12 engines running locally, when conformance runs from the daemon-style bundle under Electron's Node, then ping, list, describe, read with page, sort and filter, insert, update, delete, query, read-only refusal, import, export, and cancel (where the engine supports it) all pass.
- Given a `read-only` connection, when any write is attempted through the grid, the query box, export of a query, or import, then it is refused and the data is unchanged, proven by reading it back. The attack list per engine includes `COMMIT`, `SET`, multi-statement text, `EVAL`, `$merge`, and `VACUUM INTO`.
- Given `TZ=Asia/Kolkata` and values above 2^53, when a row keyed by a timestamp or a big integer is read and edited, then the exact row changes and the other values stay byte-for-byte equal.
- Given a query running past 30 s, when it finishes, then the client shows its real result, and cancelling it stops it on the server.
- Given a `confirm` connection, when a write is sent without confirmation, then a preview returns and the data is unchanged.
- Given a table without a key, when the grid opens a row, then edit and delete are disabled with the reason.
- Given a saved password, when `connections.list` is called, then the response does not contain the password, and the file on disk is mode 0600.
- Given wrong credentials, when connecting, then the returned error does not contain the password.
- Given a job writing to an existing path, when export starts, then it fails and the file is unchanged.
- Given the plugin installed on a throwaway daemon, when viewed in a browser in wide and compact sizes and in light and dark themes, then a user can connect, browse, edit a row, run a query, and export.
- Given `paseo plugin ls` on that daemon, then `datawise` is `running` with no error.

## Rollout and rollback

Local only. Nothing is committed, published or installed on M's daemon. Abort condition: any test touching a container outside the `datawise-test` project. Rollback: delete the folder; `docker compose -p datawise-test down -v`; stop the throwaway daemon.

## Parts

### Part 0: Test bed first

- [ ] `test/compose.yaml` with memory limits and an SSH server; `scripts/conformance.ts` run under Electron's Node. Done: PostgreSQL passes ping before other adapters are written further.

### Part 1: Scaffold and contracts

- [ ] `paseo plugin init`, then shape the project like `contextualise`. Done: `npm run typecheck` passes.
- [ ] `shared/contracts.ts`, `shared/engines.ts`, `shared/connection-url.ts`. Done: unit tests parse a URL for each engine.

### Part 2: Server core

- [ ] `store.ts`, `errors.ts`, `cells.ts`, `sql-script.ts`, `safety.ts`. Done: unit tests cover modes, 0600, scrubbing, classifier fail-closed, statement splitting per dialect.
- [ ] `pool.ts`, `tunnel.ts`, `http.ts`. Done: conformance connects through a real SSH tunnel.

### Part 3: SQL adapters

- [ ] `sql-base.ts`, PostgreSQL, MySQL, SQLite, SQL Server, Oracle, ClickHouse. Done: conformance passes for each.

### Part 4: Non-SQL adapters

- [ ] MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB, Neo4j. Done: conformance passes for each.

### Part 5: Jobs and RPC wiring

- [ ] `formats.ts`, `jobs.ts`, `plugin.ts`, `index.server.ts`. Done: import and export round-trip per engine in conformance.

### Part 6: Client

- [ ] Connections, tree, grid, row form, structure, query, import, export. Done: `rg` DOM audit clean; typecheck passes; a user flow works in the browser.

### Part 7: Docs

- [ ] `OVERVIEW.md`, `README.md`. Done: states data locations, limits, who can use connections; contains no install commands in the overview.

### Part 8: End-to-end verification

- [ ] Run conformance for all engines under `ELECTRON_RUN_AS_NODE`, with `TZ=Asia/Kolkata`. Done: results table per engine.
- [ ] Throwaway daemon with web UI, which exercises the real compile and load path; drive it in the built-in browser. Done: screenshots in wide, compact, light, dark.

### Part 9: Code review and fixes

- [ ] Independent review of the code; fix blocking findings. Done: findings recorded here; conformance re-run green.

## Standardized review

### At a glance

- **Bottom line:** present after fixing 7 blocking. All 7 and the 3 must-verify items are now fixed in this plan.
- **Where we are:** plan reviewed by an independent agent; partial, because no database servers ran during review (PostgreSQL checks ran on PGlite 18.6).
- **Need from M:** one decision, under Open questions.
- **Why:** the first draft relied on three false premises: drivers survive bundling, a read-only transaction is a guarantee, and RPCs can run long.
- **Intended outcome:** a plan another engineer can build without data loss.
- **Findings:** 7 blocking, 3 must-verify, all applied.

### Findings and what changed

| # | Severity | Finding | Fixed by |
| --- | --- | --- | --- |
| 1 | blocking | Read-only transactions can be escaped; export had no gate | One statement per request; SQLite authorizer; classifier and gate on every path; stated limit |
| 2 | blocking | `EVAL`, `FCALL` and others have no Redis `write` flag | Allow-list on `readonly`, refuse `admin`, subcommands, never-read list |
| 3 | blocking | `ssh2`, `mssql`, parser fail under the real compiler | Drivers load at runtime from `node_modules`; compile stays small |
| 4 | blocking | `worker.terminate()` cannot stop a SQLite query | One child process per connection, SIGKILL on cancel |
| 5 | blocking | 30 s RPC deadline can report failure while a write commits | Every query and write is a polled job |
| 6 | blocking | Wrong-row and precision loss on round-trip | Exact-value driver settings, unmistakable bytes tag, float keys disabled, changed columns only, rollback on mismatch, upsert guards |
| 7 | blocking | Session state leaks into later grid writes | Own connection per run; qualified names in the grid; Redis session commands refused |
| 8 | must-verify | 0600 does not stop agents running as the same user | Session-only passwords; OVERVIEW limit; M decides the default |
| 9 | must-verify | Import shape, batch limits, job loss, partial files, tunnel bypass | `importInto` unit of work; per-engine batches; `.partial` then link; direct modes |
| 10 | must-verify | Verification came after the parts that needed it | Part 0 builds the test bed first |

### Scope and limits

- **Reviewed:** this plan, the research file, the Paseo plugin reference, `compiler-build.ts`, `runtime.ts`, driver sources.
- **Checks not run:** no real database servers; those run in Part 8.
- **Could not break:** PostgreSQL refused `SELECT INTO`, CTE `DELETE`, `nextval` and `lo_create` in a read-only transaction. The Mongo parser rejected `process.exit(1)`.
- **Confidence:** high on the platform facts, which were executed. Medium on read-only for Neo4j, Cassandra, DynamoDB and ClickHouse until Part 8.

### In plain terms

The first draft would have failed to load, and could have reported a failed write that actually committed. Both are fixed in the design. What remains is proving each engine against a real server.

## Changes made

- Part 0: `test/compose.yaml` with memory limits and an SSH server; `scripts/conformance.ts` runs real handlers on Electron's Node.
- Part 1: scaffold, `shared/contracts.ts`, `shared/engines.ts`, `shared/connection-url.ts`.
- Part 2: `store`, `errors`, `cells`, `sql-script`, `safety`, `pool`, `tunnel`, `http`, `drivers`.
- Part 3: PostgreSQL, MySQL, SQLite, SQL Server, Oracle, ClickHouse over `sql-base`.
- Part 4: MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB, Neo4j.
- Part 5: `formats`, `jobs`, `plugin`.
- Part 6: client screens.
- Part 7: `OVERVIEW.md`, `README.md`.
- Part 8: every engine passed conformance under `TZ=Asia/Kolkata` on Electron 44; real compile on a throwaway daemon; wide, phone, light and dark checked in the browser; a 35 s write through the real daemon reported its true result.

## Code review

Independent review of the finished code found 12 findings. All are fixed except the last line of finding 12, which is left as a stated limit. Regression tests are in `server/safety.test.ts`, `server/values.test.ts` and the per-engine extras in `scripts/conformance.ts`.

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| 1 | blocking | `POST /_bulk?filter_path=/_search` classified as a read on Elasticsearch | Classify the path only; refuse `..` and encoded paths |
| 2 | blocking | A URL in a Cypher string hid a `DELETE` from the classifier | One scanner for strings and comments |
| 3 | blocking | Redis: blanked list entries, wrong entry after a shift, swallowed `MULTI` errors | Atomic script checks position and value; every `EXEC` slot checked; score validated first |
| 4 | must-verify | Explain prefixed whole scripts, so a second statement really ran | Server takes `explain`, requires one statement |
| 5 | must-verify | Lexer gaps: `E''`, `$é$`, MySQL `1--1`, SQLite `[a'b]`, T-SQL `DENY` | Per-dialect rules; Mongo decides from the parsed pipeline |
| 6 | must-verify | A request past its deadline could still start a job, so a retry doubled a write | `stillWanted` check right before the job starts |
| 7 | must-verify | Value round trips: long numbers, JSON, DynamoDB types, Neo4j integers, cleared numbers, nested merges | Exact text for JSON; print-back rule; type kept on edit; script update |
| 8 | must-verify | SQL Server: lost seconds and money digits, sort by text, trigger counts | Explicit `CONVERT` styles; order by the base column; outer statement's count |
| 9 | must-verify | SQL export could be broken out of on MySQL with a backslash | Per-engine literal rules |
| 10 | must-verify | Selection by position; filter unusable after a failure; size cut skipped rows | Selection by key; columns kept; next page starts at the first row left out |
| 11 | must-verify | Dead SQLite child and a cached failed Redis lookup stayed broken | Replaced on next request; failure not cached |
| 12 | note | Session-only covers the database password only; Test sends a stored secret to a typed host | First stated in the UI and OVERVIEW. Second left as a stated limit: only a holder of `daemon.manage` can do it, who can already read the file through an agent |

Partial: findings were fixed and re-tested rather than sent to a second refuter, because each fix has a test that would fail without it.

## Open questions

One, not blocking: should passwords default to the file or to this session only? Agents on the same machine can read the file, so it matters for production credentials. Built default: the file, with session-only one tap away per connection. The engine list can also change after M sees the result.
