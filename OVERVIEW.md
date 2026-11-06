Datawise is a database client inside Paseo. Connect to a database, browse its structure, read and edit rows, run queries, and move data in and out, from a sidebar screen or a workspace tab, on desktop and on a phone.

## Supported databases

PostgreSQL, MySQL, SQLite, SQL Server, Oracle, ClickHouse, MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB and Neo4j. Products that speak one of these protocols usually work too, including MariaDB, OpenSearch, CockroachDB, Valkey and ScyllaDB. MariaDB and OpenSearch are tested; the others are not.

## What it does

- **Connections:** paste a URL or fill in a form, test before saving, with TLS and SSH tunnels. An SSH host key is trusted on first use and checked afterwards.
- **Browsing:** databases, schemas and objects, with columns, indexes, foreign keys and definitions.
- **Data:** page, sort and filter rows, then insert, edit and delete. Editing needs a primary key or a non-null unique index; without one, rows are read-only and the reason is shown.
- **Queries:** each engine's own language, several statements at a time, with a time limit, stop, history and saved queries.
- **Import:** CSV, TSV, JSON and NDJSON, pasted or from a file on the daemon machine, with column mapping.
- **Export:** CSV, TSV, JSON, NDJSON and SQL inserts, to a file on the daemon machine or the clipboard. An existing file is never replaced.

## Protecting data

Each connection has a write mode. **Ask first** is the default: every change shows what it will do and waits. **Read-only** refuses writes. **No prompts** runs them directly. Deleting or emptying an object always needs its name typed.

Read-only is strong but not absolute. Datawise refuses anything it cannot prove is a read and, on most engines, also opens a read-only session. Even so, a function called from a `SELECT` can reach outside what either check sees, such as `dblink_exec` on PostgreSQL. In Ask first mode, such a function runs without a prompt. For a production database, the only full guarantee is a database user without write rights.

## Where data and passwords go

The plugin runs on the daemon machine and connects from there. Nothing is sent anywhere else. Query results are not given to agents.

Connections, query history and saved queries are stored in `plugin-data/datawise/connections.json` in the Paseo home folder, readable only by your user. Passwords are in that file in plain text, the same protection `.pgpass` has, so **any process running as your user can read them, including agents you run in Paseo**. A connection can keep its database password for the session only, in memory, and ask again after Paseo restarts. SSH secrets and API keys are always stored in the file. History holds the text of queries you ran, which can contain values; it can be cleared.

Anyone with the daemon's manage permission can use saved connections, without seeing their passwords.

## Limits

- Two people editing the same value: the last write wins. Redis list edits are the exception, and are refused if the entry moved.
- Numbers too long for JavaScript stay exact in SQL databases. In MongoDB, typing a new one stores text unless written as `{"$numberLong":"..."}`.
- Testing an edited connection with its password left blank sends the saved password to the host in the form.
- Statements in a run share a session only for that run. `BEGIN` in one run does not carry to the next, and an open transaction is rolled back when the run ends.
- In the query box on SQL Server, decimals and dates pass through the driver and can lose precision. The data grid reads them exactly.
- Redis Cluster and Cassandra multi-node routing are not followed: Datawise talks to the one host you give it.
- Import and export paths are on the daemon machine. A phone can paste and copy, but cannot pick a local file.
- Snowflake, BigQuery, Databricks and Db2 are not supported.
- SQLite needs Node 22.5 or later on the daemon, which the Paseo desktop app includes. A SQLite file must already exist.

Requires Paseo 0.15 or later.
