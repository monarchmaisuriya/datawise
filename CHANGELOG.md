# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org): while the version is below 1.0.0, a minor release may include breaking changes.

## [Unreleased]

## [0.1.1] - 2026-11-06

### Changed

- No change in behavior. Adds screenshots for the plugin listing, corrects the update example in the README, and states in the overview what the plugin reads to find its own files and what installing it needs.

## [0.1.0] - 2026-11-06

First release.

### Added

- Connections to PostgreSQL, MySQL, SQLite, SQL Server, Oracle, ClickHouse, MongoDB, Redis, Elasticsearch, Cassandra, DynamoDB and Neo4j, from a URL or a form, with TLS and SSH tunnels.
- Browsing of databases, schemas and objects, with columns, indexes, foreign keys and definitions.
- Rows: page, sort, filter, insert, edit and delete. Editing needs a primary key or a non-null unique index.
- A query box in each engine's own language, with several statements at a time, a time limit, stop, explain, history and saved queries.
- Import of CSV, TSV, JSON and NDJSON, pasted or from a file on the daemon machine, with column mapping.
- Export to CSV, TSV, JSON, NDJSON and SQL inserts, to a new file on the daemon machine or the clipboard.
- Write modes for each connection: Ask first (the default), Read-only and No prompts.
- A database password can be kept for the session only, in memory.
