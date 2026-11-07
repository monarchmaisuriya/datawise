# Changelog

All notable changes are recorded here. Versions follow [Semantic Versioning](https://semver.org): while the version is below 1.0.0, a minor release may include breaking changes.

## [Unreleased]

## [0.5.0] - 2026-11-07

### Added

- Settings: text size for tables and the SQL editor, value preview length, digit grouping in numbers, binary shown as hex, and reading a table again when you return to Paseo.
- Column widths: drag a header's edge on a wide screen, or use the Columns dialog on a phone. Widths are kept with the table's view. A double press on the edge goes back to automatic.
- The table footer shows when the page was read.

### Changed

- Datawise no longer reads tables, lists and structure again each time you return to Paseo on web or desktop. They are read when you open them, refresh, or change something here. The setting above brings the old behaviour back.
- Tables receive the first 1,024 characters of each value by default, instead of up to 16 KiB. Opening a row shows the whole value. Keys are always whole, except a Redis list value, which the row form reads whole before a change. Copy page as Markdown carries the shorter values, marked as cut.
- Tables draw only the rows and columns near the view. A 200-column table with 100 rows drew about 20,000 cells when opened, and now draws about 600.
- An approved agent request refreshes open tables when it finishes.
- `views.json` gains an optional field. An older Datawise saving any view drops column widths for every table.

### Fixed

- A binary value longer than the cut showed as a piece of JSON text. It now shows its size, or the first bytes in hex.
- A key value longer than 16 KiB arrived cut. On a Redis set, renaming such a member removed nothing and added the new member, with no error. On other engines, changing that row failed. Keys now always arrive whole.

## [0.4.0] - 2026-11-06

### Changed

- A calmer interface throughout. The green accent now marks only the main action of a view, buttons have no borders, and the grid has no vertical lines. No feature was removed, and nothing changed on the server or in saved files.
- Connection form: essentials first, with a picker for the database type. Security (encryption and SSH), Agents, and Color and group are sections that show their current value while closed. Test and Save stay in view. Environment, write mode and password storage stay in the first view.
- Data tab: the toolbar fits one row. Count, Import, Export and Copy as Markdown moved to the More menu. Row checkboxes appear after pressing Select or Edit cells.
- Query tab: the time and row limits moved to a Limits dialog. The note about how statements run shows only when the text runs past one line or one statement. Close is on the open tab.
- Production, Read-only and Not encrypted are now small labels beside the title, not full-width rows. Production still shows on every tab.
- Icon-only buttons now have plain names for screen readers.

### Fixed

- Choosing the database type a connection already has no longer clears its port.
- The object list no longer says nothing was found while it is still waiting for the database list.
- A connection switched from a session-only password to an engine with no password no longer asks for a password.

## [0.3.0] - 2026-11-06

### Added

- Agents can read rows, on a connection you open to them and label development or staging. PostgreSQL, MySQL, SQLite, SQL Server and Oracle only. Reads run in a read-only transaction that is always rolled back, at most 200 rows and 256 KiB per call.
- Agents can propose inserts, updates and deletes. Nothing is written until you approve the exact change in the new Agent requests view, in every agent mode. Off by default.
- A record of what agents read and asked to change, with no values, and a count on the Datawise sidebar row when requests are waiting.

### Fixed

- Every dialog crashed the whole app at phone width, with "Datawise UI used outside its provider". This has been there since 0.1.0.

### Changed

- `datawise_describe` now refuses system schemas and databases, and a database other than the one a connection names.
- Sorting a table now also orders by its key, so paging with a sort cannot skip or repeat rows.
- A failed connection close after a write no longer reports the write as failed.
- `connections.json` gains an optional field. An older Datawise saving that file drops it and falls back to names only.

## [0.2.0] - 2026-11-06

### Added

- Preferences: page size, query limits, density, how NULL is shown, history, drafts, export folder and format, and idle close.
- Connection labels: environment, color and group. A production connection cannot use No prompts and shows a banner.
- Saved views for each table: hidden columns, column order, sort, current and named filters. The screen returns to where you left it after a reload.
- A SQL editor on desktop and web with highlighting, Cmd or Ctrl+Enter, and completion of table and column names. Phones keep the plain box.
- Named query tabs with saved drafts, and running exactly the selected text.
- Foreign key jumps from a row to the row it points at, including composite keys.
- Pending edits on PostgreSQL, MySQL, SQLite, SQL Server and Oracle: reviewed, then committed together or not at all, with each value compared before writing.
- File panels: run a `.sql` file on a connection, and add a SQLite file as a connection.
- Attach a table's structure to a prompt, and Copy as Markdown for results and pages.
- An opt-in `datawise_describe` agent tool, names and types only, refused on production and on engines without a catalog.

### Fixed

- MySQL: Verified encryption accepted a certificate for the wrong host name. It now checks the name, and refuses an IP address it cannot check.
- Oracle: dates reached the grid as JavaScript date text, losing microseconds, and could not be written back. Table reads are now exact, and the query box shows them to the millisecond.
- SQLite: a read-only connection now opens read-only for grid reads, so it works on a file in a read-only folder, and routine closes no longer leave `-wal` and `-shm` files behind.
- SQL Server: `IF ... BEGIN ... END` is one statement instead of being split inside the block.

### Changed

- `connections.json` gains optional fields. An older Datawise saving that file drops them.

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
