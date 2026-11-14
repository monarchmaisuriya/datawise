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
- **Agents, only if you choose:** attach a table's structure to a prompt, and open a connection to agents at one of three levels: names and types, reading rows and running read queries, or proposing changes you approve in Datawise. Any agent can ask Datawise to open a connection, table or query in a workspace tab.
- **Preferences:** defaults for page size, query limits, density, text size, value preview length, how NULL, numbers and binary values are shown, history, drafts, export, idle close, and whether to read again when you return to Paseo. The screen returns to where you left it.
- **Import:** CSV, TSV, JSON and NDJSON, pasted or from a file on the daemon machine, with column mapping.
- **Export:** CSV, TSV, JSON, NDJSON and SQL inserts, to a file on the daemon machine or the clipboard. An existing file is never replaced.

## Protecting data

Each connection has a write mode. **Ask first** is the default: every change shows what it will do and waits. **Read-only** refuses writes. **No prompts** runs them directly. Deleting or emptying an object always needs its name typed.

A connection labelled production cannot use No prompts, shows a Production label on every tab, and cannot be shared with agents. An agent can only ask to open it in a tab, and nothing opens until you say yes there. The server enforces this. The label is yours to set: Datawise does not guess it from a host name, so an unlabelled production database has no such protection.

Read-only is strong but not absolute. Datawise refuses anything it cannot prove is a read and, on most engines, also opens a read-only session. Even so, a function called from a `SELECT` can reach outside what either check sees, such as `dblink_exec` on PostgreSQL. In Ask first mode, such a function runs without a prompt. For a production database, the only full guarantee is a database user without write rights.

## Setup

Installing needs `npm` on the daemon machine's path, which fetches the database drivers from the npm registry, about 130 MB. Nothing is downloaded after that. Add a connection with your own host and credentials; there is no account to create.

## Where data and passwords go

The plugin runs on the daemon machine and connects from there, to the hosts you give it. Nothing else is contacted. Agents get nothing unless you open a connection to them.

**Agent access is off by default, and each level is your choice, per connection.** Datawise's tools are offered to every agent on the daemon, because Paseo offers no reliable way to limit them to one agent; a tool asked about a connection not shared at its level answers the same as for a name that does not exist. Paseo only passes plugin tools to agents while its "Enable Paseo tools" host setting is on. A connection labelled production is always refused, except for opening a tab, which asks you first.

- **Open in a tab:** `datawise_open` needs no sharing. It asks every open Paseo window to show a connection in the agent's workspace tab, optionally at a table, or with query text in a query tab. It never contacts the database, never runs the text, and returns no names or data. For a production connection no window moves: "Open a production connection?" waits in that workspace's Datawise tab for 30 minutes, and nothing opens unless you say yes. Moving away from pending edits asks first, as it does when you move yourself. With no Paseo window open, the tab opens there the next time Datawise is opened in that workspace, without the query text, and a production request is dropped. One request per agent every 5 seconds.
- **Names and types:** `datawise_describe` returns table names, column names, types, nullability, keys and foreign key targets, on all 12 engines. It never returns rows, defaults, definitions or the values of an enum. On MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB and Neo4j, names come from your data: collection, key, index or label names, and field names seen in recent records. Names can hold text someone else wrote, so the tool tells agents to treat them as data.
- **Read rows and run reads:** on a connection labelled development or staging, on all 12 engines. These run without asking you. Row data goes to the agent's provider and stays in that chat, including any sensitive columns on that connection, and there is no per-table or per-column limit. At most 200 rows and 256 KiB per call, with long values cut and binary values shown as a size. These limits are per call: an agent can keep reading.
  - `datawise_read` reads a table. System schemas and databases are refused, including MongoDB's `admin`, `local` and `config` and its `system.*` collections, and so is any database other than the one the connection names.
  - `datawise_query` runs statements in the connection's own language, `datawise_count` counts a table's rows, and `datawise_explain` shows the plan of one read, where the engine has one. Each stops after 25 seconds. An agent can make 60 of these calls and reads a minute. A query can read anything the database user can, including other databases and system tables, and on some servers files or other hosts through functions such as `pg_read_file`, `LOAD_FILE` or ClickHouse's `url()`. A database user with only the rights you mean to share is the way to limit it.
  - Two checks guard a query. First, Datawise runs it only if every statement classes as a read on that engine; anything else is refused with a pointer to proposing it instead. Second, where the engine has one, the session itself is read-only (PostgreSQL, MySQL, SQLite, Oracle, ClickHouse, Neo4j) or rolled back (SQL Server). MongoDB, Redis, Elasticsearch, Cassandra and DynamoDB have only the first check. A function that writes from inside a read, such as `dblink_exec` on PostgreSQL or an Oracle autonomous transaction, can pass both.
  - `datawise_history` lists up to 50 recent and 50 saved queries of the connection, only those that class as reads, so a statement that changes data or users, such as `CREATE USER ... PASSWORD`, is never returned. A read can still hold a secret you typed, such as a password in a `dblink` connection string.
- **Propose changes:** nothing is written until you approve it in **Agent requests**, whatever the agent's permission mode or the connection's write mode, even on No prompts. A request expires after 30 minutes, when the connection is saved, or when Paseo restarts.
  - `datawise_propose_write` proposes inserts, updates and deletes of up to 100 rows, on PostgreSQL, MySQL, SQLite, SQL Server and Oracle. You see every change in full. Datawise reads each row itself, so what you see is the row as it is. If a value being changed, or any value of a row being deleted, differs when you approve, everything rolls back.
  - `datawise_propose_query` proposes up to 50 statements in the connection's own language, on all 12 engines. You see each statement exactly as it will run. They run one by one, not as one transaction: if one fails, those before it stay applied and the request says how many ran. Even one statement can apply partly, such as a block that commits inside it, or any statement on MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB and Neo4j, so a failure is never reported to the agent as "nothing was written". The agent gets the count, not the database's error.
  - `datawise_write_status` tells the agent what became of a request.

**Approval guards these tools, not your machine.** An agent with a shell runs as your user. It can read `connections.json`, connect to the database directly, or call Datawise's own approve action, and Datawise cannot tell that from you pressing Approve. Text in a row could even tell it to. So reading rows, on an agent with a shell, can lead to writes. A database user without write rights is the only full guarantee.

Datawise keeps a record of what agents read and asked to change in `agent-activity.json`, in the same private folder, without any values. See it under **Agents** on the connection list.

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
- Paseo may also ask before each agent tool call, depending on the agent's permission mode. That is separate from approving a change in Datawise.
- Redis Cluster and Cassandra multi-node routing are not followed: Datawise talks to the one host you give it.
- Import and export paths are on the daemon machine. A phone can paste and copy, but cannot pick a local file.
- Snowflake, BigQuery, Databricks and Db2 are not supported.
- SQLite needs Node 22.5 or later on the daemon, which the Paseo desktop app includes. A SQLite file must already exist.

Requires Paseo 0.16.0-beta.2 or later.
