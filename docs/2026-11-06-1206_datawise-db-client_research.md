# Datawise: a multi-database client plugin for Paseo

- Date: 2026-11-06 12:06
- Status: handed to plan
- Mode: explore options
- Repos: none yet (`datawise` is new)   Folders: `/Users/monarchmaisuriya/Experiment/datawise`
- Question / problem: What is the right shape for a Paseo plugin that browses, edits, imports and exports data across the widely used databases, given how Paseo plugins are built and run?

## Options: one server-side adapter per engine behind a single typed RPC contract, with one React Native data screen

- **Bottom line:** build one plugin with one adapter per engine family, all behind one contract. Drivers run in the plugin's daemon subprocess. The client never holds a credential and never builds a query. Ship the 12 engine families that can be tested here against a real server.
- **Where we are:** framing done; 16 sources read; next step is the plan. M asked for the whole chain in one request, so the options below were decided by the recommendation and M can overrule them.
- **Need from M:** nothing to continue. Two defaults are worth a look: the engine list and password storage.

### The problem, framed

| 6W2H | Answer |
| --- | --- |
| What | A database client inside Paseo: connect, browse, read, edit, query, import, export |
| Why | M works in Paseo all day and today must leave it for a separate database tool |
| Who | M and anyone using Paseo; the data at risk belongs to whoever owns the database |
| Whom | The person at the keyboard. Agents are out of scope for the first version |
| When | Now. No deadline stated |
| Where | A sidebar screen and a workspace tab, on the daemon machine |
| Which | Paseo plugin SDK 0.15, Zod RPC contracts, React Native primitives, npm drivers |
| How | The client calls RPCs, the plugin subprocess runs the drivers, results come back as JSON |
| How much | Large: 12 engines. Blast radius is limited to a new folder, until M points it at a real database |

Refocused problem: give one data screen a uniform model, and keep every engine's differences behind an adapter, so adding an engine never changes the client.

### What must be true

**Hard constraints**

- Client code uses only React Native primitives and can import only host modules; no `node:` imports. [verified: Paseo plugin reference, Runtime modules, Cross-platform rules]
- Server code bundles everything except the SDK and zod into one CommonJS file with esbuild, target node20. [verified: `paseo/packages/server/src/server/plugins/compiler-build.ts:352-378`] So a driver's native binary (`.node`) cannot be relied on, and any driver must survive being bundled.
- Plugin installs from git run with `npm ci --omit=dev --ignore-scripts` in M's other plugins, so no native build step runs. [verified: `contextualise/paseo-plugin.json`] The desktop daemon's plugin process runs on Electron 44, Node 24.20. [verified: ran `ELECTRON_RUN_AS_NODE=1 /Applications/Paseo.app/Contents/MacOS/Paseo`, printed `v24.20.0 44.2.0`]
- `node:sqlite` works in that runtime and reports SQLite 3.53.4. [verified: same command] It is synchronous, and Node marks it "release candidate". [verified: Node sqlite docs] A long query would freeze every other RPC unless it runs in a worker thread. [inferred: from the synchronous API and a single plugin process]
- Paseo settings documents are "ordinary host-side JSON, not a credential vault". [verified: Plugin reference, Persisted values] The plugin API offers no data folder; M's plugins resolve it from `@getpaseo/server/daemon-control`. [verified: `contextualise/server/paseo-home.ts`]
- `import.meta.url` is undefined in plugin server code. [verified: M's saved runtime notes, 2026-10-25] [unverified for 0.15: the bundle check in the plan will settle it]
- RPC values larger than 100 MiB less framing fail, and nested bytes fail validation. [verified: Plugin reference, Bytes] So rows must be JSON-safe and paged.

**Conventions**

- Layout `client/`, `server/`, `shared/`; `OVERVIEW.md`; separate client and server tsconfigs; vitest. [verified: `contextualise/package.json`, `tsconfig.*.json`]
- No git commit or publish without M asking. [verified: M's global rules]

**Assumptions turned into checks**

| Assumption | Check | Status |
| --- | --- | --- |
| Every chosen driver survives the esbuild bundle and runs on Electron's Node | Ran the real compiler | [disproved: `ssh2`, `mssql` and the Mongo parser break under it, so drivers load at runtime from `node_modules` instead; all 13 load under Electron] |
| SQL Server runs on this arm64 Mac | Its image is amd64 only, so it needs Rosetta | [verified: conformance passed on the image under emulation] |
| The bundled web UI lets the built-in browser see the plugin | Paseo documents `features.webUi.enabled` serving the app from the daemon's own origin | [verified: ran on a throwaway daemon] |

### Found

- **No competing plugin.** The registry lists 483 plugins and one database plugin, `seriousm/sqlite-studio`, SQLite only, 5 installs. [verified: `plugins.paseo.sh/index.json`, 2026-11-06]
- **What "widely used" means.** DB-Engines' November 2026 order starts Oracle, MySQL, SQL Server, PostgreSQL, MongoDB, Snowflake, Databricks, Redis, Db2, Cassandra, SQLite, Elasticsearch, MariaDB, then Splunk, Azure SQL, Hive, Access, DynamoDB, BigQuery, Neo4j. [verified: DB-Engines ranking; tier: primary for the ranking, which measures popularity signals rather than usage] My text extraction skipped some rows, including where ClickHouse sits, so exact ranks below 24 are approximate.
- **Pure-JS drivers exist for almost all of them.** `pg`, `mysql2`, `ioredis`, `mongodb`, `mssql`/`tedious`, `oracledb` in Thin mode (no Oracle Client libraries needed), `cassandra-driver`, `neo4j-driver` and the AWS SDK. [verified: node-oracledb docs for Thin mode; npm metadata for the rest] Whether each one bundles is the unverified check above.
- **Read-only can be enforced by the server on several engines, not only by inspecting text:**
  - PostgreSQL rejects writes inside a read-only transaction, though Postgres notes this "does not prevent all writes to disk". [verified: PostgreSQL SET TRANSACTION docs]
  - ClickHouse `readonly=1` refuses writes; `readonly=2` does not by itself stop writing. [verified: ClickHouse permissions docs]
  - Redis `COMMAND` reports a `write` flag per command, so the running server says what writes. [verified: Redis COMMAND docs]
  - Neo4j and MySQL have read access modes. [unverified: MySQL page text did not match my extract; conformance will attempt a real write and require a refusal]
- **Passwords.** PostgreSQL's own `.pgpass` is a plain file that is ignored unless mode 0600. [verified: libpq docs] A plain 0600 file is therefore the accepted baseline. OS keychains are stronger but need either a native module or a `security` shell call on each platform.
- **Mongo shell syntax without `eval`.** MongoDB's parser, now `@mongodb-js/shell-bson-parser`, parses `{ a: ObjectId("...") }` from an AST. [verified: `ejson-shell-parser` README says it moved] Using it means the query box never evaluates text as code.
- **Elasticsearch and OpenSearch.** A plain HTTP client is smaller and serves both. [inferred: both speak REST; I could not retrieve a primary source on the official client's product check, so this is not used as the reason]

### Options

| | A: one plugin, adapters per engine family | B: core plugin plus one plugin per engine | C: shell out to native CLIs (`psql`, `mysql`, `mongosh`) |
| --- | --- | --- | --- |
| How it works | One bundle. Each adapter implements one TypeScript interface and is loaded lazily | Plugins cannot import each other, so each would copy the core | Spawn the CLI and parse its output |
| Fit with Paseo | Uses the documented `server/`, `shared/`, `client/` split | Against the platform: "plugins cannot import each other" [verified: comment in `contextualise/server/secrets.ts`] | `mysql`, `redis-cli`, `mongosh` are not installed here [verified: `which`] |
| Cost and blast radius | Largest single bundle; all code in one repo | Many repos, each copy drifts | Least driver code, most parsing code, per engine and per version |
| When it fails | A driver that will not bundle; the fix is to drop that driver alone | Any change to the shared contract touches every repo | Output format changes; passwords on argv; no typed rows |
| Evidence | esbuild config, driver list | contextualise comment | `which` output |
| Completeness | 9/10 | 7/10 | 4/10 |

### Flow of the recommended option

```
 Paseo app (any client)                      Plugin subprocess on the daemon
 ----------------------                      -------------------------------
 Screen / workspace tab                      handlers
   | useRpc(contract)  -- JSON over IPC -->    | safety gate (read-only, confirm)   <-- owns "may this write?"
   |                                           | connection pool + SSH tunnel
   |                                           | adapter for this engine            <-- owns dialect
   |  <-- rows as JSON-safe cells, no secrets  v
                                             driver -> database
```

### Recommendation

RECOMMENDATION: Option A because the platform has no way to share code between plugins, and a typed adapter interface keeps engine differences out of the client.

Engine scope, by the rule "must be testable here against a real server":

| Ships | Reaches also (same protocol, not separately tested unless noted) |
| --- | --- |
| PostgreSQL | CockroachDB, TimescaleDB, Supabase, Neon, YugabyteDB, Redshift |
| MySQL | MariaDB, TiDB, PlanetScale, Aurora MySQL |
| SQLite | any local `.sqlite` or `.db` file |
| SQL Server | Azure SQL |
| Oracle | Oracle Autonomous (needs wallet, not tested) |
| ClickHouse | none |
| MongoDB | DocumentDB |
| Redis | Valkey, Dragonfly, KeyDB |
| Elasticsearch | OpenSearch |
| Cassandra | ScyllaDB |
| DynamoDB | DynamoDB Local |
| Neo4j | none |

Left out, each with the reason: Snowflake, Databricks and BigQuery have no free local server to test against. Db2's Node driver needs a native library. Splunk, Hive and Access are not typical targets for a row-editing client.

### Sources

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference) (primary)
- [Paseo plugin publishing](https://paseo.sh/docs/plugins/publishing) (primary)
- [Paseo self-hosted web UI](https://paseo.sh/docs/web-ui) (primary)
- [Paseo plugin registry index](https://plugins.paseo.sh/index.json) (primary)
- [SQLite Studio plugin](https://github.com/SeriousM/paseo-sqlite-studio) (primary, package metadata only)
- [DB-Engines ranking, November 2026](https://db-engines.com/en/ranking) (primary for its own ranking)
- [PostgreSQL SET TRANSACTION](https://www.postgresql.org/docs/current/sql-set-transaction.html) (primary)
- [PostgreSQL password file](https://www.postgresql.org/docs/current/libpq-pgpass.html) (primary)
- [ClickHouse permissions for queries](https://clickhouse.com/docs/operations/settings/permissions-for-queries) (primary)
- [Redis COMMAND](https://redis.io/docs/latest/commands/command/) (primary)
- [node-oracledb initialization, Thin and Thick modes](https://node-oracledb.readthedocs.io/en/latest/user_guide/initialization.html) (primary)
- [Node.js node:sqlite](https://nodejs.org/api/sqlite.html) (primary)
- [ejson-shell-parser, moved to shell-bson-parser](https://github.com/mongodb-js/ejson-shell-parser) (primary)
- `paseo/packages/server/src/server/plugins/compiler-build.ts` (primary, source code)
- `contextualise/server/paseo-home.ts`, `contextualise/paseo-plugin.json` (M's own plugins)
- M's saved Paseo runtime notes (first-hand, dated 2026-10-25 to 2026-11-03)

## Standardized review

**Bottom line:** present as is. The recommendation follows from verified platform limits. Three facts stay unverified and each has a named check in the plan. Partial review: the must-verify items had no independent refuter because they are settled by running them in Part 8, [unverified: no independent refutation].

| Criterion | Result |
| --- | --- |
| Question answered | Yes: shape, engines, and storage baseline |
| Primary sources | 13 of 16 primary |
| Claims tagged | Yes; two tagged unverified instead of being used as reasons |
| Alternatives real | Yes: B and C each fail on a verified fact |
| Translated to our code | Yes: the layout follows `contextualise` |

**Findings**

- must-verify: driver bundling under Electron. Could remove an engine, not change the design. Settled in Part 8.
- must-verify: SQL Server under Rosetta. If the image will not start, SQL Server ships marked untested, or M decides to drop it.
- note: the DB-Engines extract was approximate below rank 24. It did not change the decision because the engine list rests on testability.
