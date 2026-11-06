Datawise is a database client inside Paseo. Connect to a database, browse its structure, read and edit rows, run queries, and move data in and out, from a sidebar screen or a workspace tab, on desktop and on a phone.

## Supported databases

PostgreSQL, MySQL, SQLite, SQL Server, Oracle, ClickHouse, MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB and Neo4j. Products that speak one of these protocols usually work too, including MariaDB, OpenSearch, CockroachDB, Valkey and ScyllaDB. MariaDB and OpenSearch are tested; the others are not.

## What it does

- **Connections:** paste a URL or fill in a form, test before saving, with TLS and SSH tunnels. An SSH host key is trusted on first use and checked afterwards. Group them, color them, and label them as development, staging or production.
- **Browsing:** databases, schemas and objects, with columns, indexes, foreign keys and definitions.
- **Data:** page, sort and filter rows, then insert, edit and delete. Editing needs a primary key or a non-null unique index; without one, rows are read-only and the reason is shown. Each table remembers its hidden columns, column order, sort and saved filters. From a row, follow a foreign key to the row it points at.
- **Pending edits:** on PostgreSQL, MySQL, SQLite, SQL Server and Oracle, change cells and mark rows for delete, review the statements, then commit them together or not at all. A row changed by someone else since you edited it cancels the whole commit and is named.
- **Queries:** each engine's own language, several statements at a time, with a time limit, stop, history and saved queries. Named tabs per connection keep their drafts. Run the whole text or exactly what is selected. On desktop and web the editor has highlighting and Cmd or Ctrl+Enter, and on SQL databases completion of table and column names. Copy results or a page as a Markdown table.
- **Files:** open a `.sql` file in a workspace to run it on a connection, and a SQLite file to add it as a connection. Editing stays in Paseo's own editor.
- **Agents, only if you choose:** attach a table's structure to a prompt, and let agents read table and column names on connections you pick.
- **Preferences:** defaults for page size, query limits, density, how NULL is shown, history, drafts, export and idle close. The screen returns to where you left it.
- **Import:** CSV, TSV, JSON and NDJSON, pasted or from a file on the daemon machine, with column mapping.
- **Export:** CSV, TSV, JSON, NDJSON and SQL inserts, to a file on the daemon machine or the clipboard. An existing file is never replaced.

## Protecting data

Each connection has a write mode. **Ask first** is the default: every change shows what it will do and waits. **Read-only** refuses writes. **No prompts** runs them directly. Deleting or emptying an object always needs its name typed.

A connection labelled production cannot use No prompts, shows a banner on every tab, and cannot be shared with agents. The server enforces this. The label is yours to set: Datawise does not guess it from a host name, so an unlabelled production database has no such protection.

Read-only is strong but not absolute. Datawise refuses anything it cannot prove is a read and, on most engines, also opens a read-only session. Even so, a function called from a `SELECT` can reach outside what either check sees, such as `dblink_exec` on PostgreSQL. In Ask first mode, such a function runs without a prompt. For a production database, the only full guarantee is a database user without write rights.

## Setup

Installing needs `npm` on the daemon machine's path, which fetches the database drivers from the npm registry, about 130 MB. Nothing is downloaded after that. Add a connection with your own host and credentials; there is no account to create.

## Where data and passwords go

The plugin runs on the daemon machine and connects from there, to the hosts you give it. Nothing else is contacted, and query results and rows are not given to agents.

**Agent access is off by default, and it is names only.** Turning on "Table and column names" for a connection adds a `datawise_describe` tool for every agent on the daemon, because Paseo offers no reliable way to limit it to one agent. It returns table names, column names, types, nullability, keys and foreign key targets. It never returns rows, defaults, definitions or the values of an enum, and it is refused on production connections and on engines whose structure comes from the data itself: MongoDB, Redis, Elasticsearch, DynamoDB and Neo4j. Names can hold text someone else wrote, so the tool tells agents to treat them as data. Turning this on or off, or reloading Datawise while it is on, makes open agent sessions reopen before their next prompt. Paseo only passes plugin tools to agents while its "Enable Paseo tools" host setting is on, so with that off, agents get no tool even on a shared connection.

**Attaching a table's structure** adds the same names to your prompt, which go to your agent's provider and stay in that chat. The search looks only at connections already open, leaves out production, and never opens a connection. Rows reach a chat only if you copy them with Copy as Markdown and paste them.

It reads Paseo's `config.json` once, only to find its own folder, because its drivers load from there. SQLite connections each run in a child process, so that a slow query can be stopped.

Connections, query history and saved queries are stored in `plugin-data/datawise/connections.json` in the Paseo home folder, readable only by your user. Passwords are in that file in plain text, the same protection `.pgpass` has, so **any process running as your user can read them, including agents you run in Paseo**. A connection can keep its database password for the session only, in memory, and ask again after Paseo restarts. SSH secrets and API keys are always stored in the file. History holds the text of queries you ran, which can contain values; it can be cleared.

Saved views and query tabs are in `views.json` and `workspace.json` in the same folder, also readable only by your user. Saved filter values and query drafts can hold real data; turn off "Save query drafts" to keep draft text off the disk. Your preferences are a Paseo settings document, which is removed if you remove the plugin. Views, tabs and connections stay.

Anyone with the daemon's manage permission can use saved connections, without seeing their passwords.

## Limits

- Two people editing the same value: the last write wins. Redis list edits are the exception, and are refused if the entry moved. Pending edits compare each value before writing, which leaves a brief window between that read and the write.
- Pending edits last until you commit, discard or reload. They do not survive a reload, and leaving the connection asks first. A key column cannot be changed with pending edits; use the row form. MySQL tables without transactions, such as MyISAM, are refused.
- Verified encryption is tested against real servers on PostgreSQL, MySQL, Redis and MongoDB, including through an SSH tunnel. It is not yet tested on SQL Server, Oracle, ClickHouse, Elasticsearch, Cassandra or Neo4j. Verified encryption on MySQL needs a host name, not an IP address.
- Numbers too long for JavaScript stay exact in SQL databases. In MongoDB, typing a new one stores text unless written as `{"$numberLong":"..."}`.
- Testing an edited connection with its password left blank sends the saved password to the host in the form.
- Statements in a run share a session only for that run. `BEGIN` in one run does not carry to the next, and an open transaction is rolled back when the run ends.
- In the query box on SQL Server, decimals and dates pass through the driver and can lose precision. On Oracle, dates there stop at the millisecond. The data grid reads them exactly on both.
- The `.sql` panel runs on the connection's default database. A SQLite database in write-ahead logging mode gets `-wal` and `-shm` files beside it when opened, even read-only; the panel says so first.
- Phones keep a plain text box for queries, without highlighting or completion.
- Redis Cluster and Cassandra multi-node routing are not followed: Datawise talks to the one host you give it.
- Import and export paths are on the daemon machine. A phone can paste and copy, but cannot pick a local file.
- Snowflake, BigQuery, Databricks and Db2 are not supported.
- SQLite needs Node 22.5 or later on the daemon, which the Paseo desktop app includes. A SQLite file must already exist.

Requires Paseo 0.15.1 or later.
