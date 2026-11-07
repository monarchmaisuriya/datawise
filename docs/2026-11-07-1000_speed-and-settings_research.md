# Datawise: where it is slow, and which settings people want

- Date: 2026-11-07 10:00
- Status: handed to plan
- Mode: explore options
- Repos: datawise   Folders: `client/`, `server/`, `shared/`
- Question / problem: what would make Datawise lighter and faster, and which settings would people use, without repeating v0.2.0?

## Options: cut the work the app does without being asked, then add the display settings people ask for most

- **Bottom line:** the server is already fast. The cost is in the app: it rereads data when you return to Paseo, draws every column of every visible row, and receives up to 16 KiB of each cell value to show one line. Fix those first, then add text size, column widths and a few display settings.
- **Where we are:** framing done; code measured; 22 outside sources read by a research agent. The plan is `docs/2026-11-07-1010_speed-and-settings_plan.md`.
- **Need from M:** pick an option, and answer the questions in the plan.

### The problem, framed

- **What:** find work Datawise does that nobody asked for, and settings people expect from a database client.
- **Why:** M asked for optimisations and customisation. The tool should feel quick on a phone and on large tables.
- **Who:** anyone browsing data in Datawise; agents are unaffected.
- **Whom:** M first, then registry users.
- **When:** no deadline.
- **Where:** the client grid and data cache, the server's page reads, and the preferences page.
- **Which:** React Native screens on web, desktop and phones, through Paseo's plugin SDK 0.15.1.
- **How:** measure, compare with established clients, then change the layer that owns each cost.
- **How much:** client changes mostly; one server parameter. No change to saved files that an older version cannot read.

### What was measured

| What | Result | Evidence |
| --- | --- | --- |
| Server page read, 200,000-row table, 20 columns | 1.3 ms for 100 rows, 3.3 ms for 1,000 rows, 17.7 ms at row 190,000 | [verified: timing run against the test PostgreSQL, median of 7] |
| Database time at row 190,000 | 33 ms with OFFSET, 0.04 ms reading from a key | [verified: `EXPLAIN ANALYZE`] |
| Size of a 1,000-row page, 20 short text columns | 445 KiB of JSON | [verified: same run] |
| Text cells drawn for a 1,000-row page | about 4,500, with all 20 columns for each drawn row. The default page is 100 rows, and the list keeps its default window of about 10 screens either side | [verified: DOM count in the web app; `shared/preferences.ts:19`; `client/grid.tsx:124` sets only `initialNumToRender`] |
| Most a single cell can carry to the grid | 16 KiB (`CELL_LIMIT`), shown on one line at most 320 px wide | [verified: `server/cells.ts:3`, `client/grid.tsx:10`] |
| Rereading on return | each plugin gets a data cache with default options, where data is stale at once and refetched when the window regains focus | [verified: `paseo/packages/app/src/plugins/registry.ts:102`; `@tanstack/query-core` `utils.js:34`, `queryObserver.js:491-494`] |
| Agent request checks | every 15 seconds in the sidebar, and every 5 seconds inside the app; each reads an in-memory list, so the cost is small | [verified: `index.client.tsx:13`, `client/agent-requests.tsx:9`, `server/agent-requests.ts:79`] |
| Client bundle | about 590 KB before the host's zod; CodeMirror is about 430 KB of it and is unused on phones. The host compiles one file with no code splitting | [verified: esbuild metafile; `paseo/.../plugins/compiler-build.ts`, `format: "cjs"`] |

Timings in the web app were taken in a hidden browser pane, so they are left out. DOM counts do not depend on that.

### What other clients do

- **Draw only what is visible, across columns too.** Beekeeper Studio's grid renders columns virtually. [secondary: source, `apps/studio/src/common/tabulator.ts:49`]
- **Cap each value, load the whole one on request.** DataGrip has "Maximum number of bytes loaded per value" [primary: [DataGrip data views](https://www.jetbrains.com/help/datagrip/settings-tools-database-data-views.html)]; pgAdmin has "Max column data display length" [primary: [pgAdmin preferences](https://www.pgadmin.org/docs/pgadmin4/latest/preferences.html)].
- **Fetch in pages, count on request.** DBeaver fetches 200 rows and counts only when asked [primary: [DBeaver navigation](https://dbeaver.com/docs/dbeaver/Navigation/), [data editor](https://dbeaver.com/docs/dbeaver/Data-Editor/)]. Beekeeper pages at 100 [primary: [Beekeeper configuration](https://docs.beekeeperstudio.io/user_guide/configuration/)]. Datawise already does both. [verified]
- **Text size and zoom are wanted.** DBeaver issue #17817 (zoom) has 49 reactions; Beekeeper #3362 (editor font) has 5; TablePlus has font and size settings [primary: [TablePlus fonts](https://docs.tableplus.com/preferences/fonts-and-colors)]. [tertiary for demand]
- **Column widths are kept.** Beekeeper sets default, minimum and maximum widths [primary: Beekeeper configuration].
- **Display formats.** DataGrip and DBeaver offer date and number formats [primary: [DBeaver formats](https://dbeaver.com/docs/dbeaver/Data-View-and-Format/)]. Beekeeper shows binary as hex [primary: Beekeeper configuration].
- **Session setup per connection.** DataGrip has a startup script; DBeaver has bootstrap queries, and a failing one blocks the connection [primary: [DataGrip data sources](https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html), [DBeaver initialization](https://dbeaver.com/docs/dbeaver/Configure-Connection-Initialization-Settings/)]. Beekeeper #245 asks for a default schema, 8 reactions. [tertiary]
- **Keymaps.** Wanted (DBeaver #37897, 32; Beekeeper #734, 8), but the Paseo SDK has no shortcut contribution: Command Center items take only id, title, icon and keywords. [verified: `@getpaseo/plugin/dist/client/contracts.d.ts:257-262`]
- **Settings are per host, not per device.** [verified: `paseo/public-docs/plugins/reference.md:1390`] A text size chosen on a phone also applies on the desktop.

### What must be true

- **Hard constraints:** no feature removed; safety prompts unchanged; saved files stay readable by v0.4.0; plugin RPCs finish within 30 s [verified: `paseo/.../plugins/runtime.ts:41`].
- **Conventions:** theme tokens only; React Native primitives; every preference default matches today unless M agrees otherwise.
- **Open checks:**
  - Column virtualisation must keep the header and rows aligned while scrolling, on web and native. [unverified: needs a prototype on both]
  - A cut value must still be whole wherever it is edited or copied as a row. [verified for edit: `client/data-tab.tsx` sends a cut cell to the row form, which reads the whole row; `client/row-form.tsx:29`] Export does not use the grid read. [verified: `server/plugin.ts:528`] Copy page as Markdown would carry the shorter value, marked. [verified: `client/data-tab.tsx`, `toMarkdownTable` gets `cutCells`]
  - Agent reads use their own cell limit, so a grid cap does not change them. [verified: `server/adapters/sql-base.ts:284-290`]
  - **Found during review: a key value can be cut today.** `finishRows` cuts any column, key columns included [verified: `server/cells.ts:66-80`], and the client builds a row's key from what it received [verified: `client/data-tab.tsx:19-21`]. On SQL engines a cut key matches no row and the write fails. On a Redis set, renaming a member longer than 16 KiB removes nothing and adds the new member, with no error [verified: `server/adapters/redis.ts:298-306`, `:404-409`]. A shorter preview would make this common, so it must be fixed first.
  - Rereading on return happens on web and desktop only: the cache listens for the page becoming visible, and Paseo sets up no focus source on phones. [verified: `@tanstack/query-core` `focusManager.js:17`]

### Options

| | A: speed only | B: settings only | C: speed, then settings (recommended) |
| --- | --- | --- | --- |
| How it works | Datawise's own cache policy; lighter grid drawing; smaller grid values, with keys never cut | Text size, column widths, value display, per-connection session setup | A as v0.5.0, then the most-asked settings from B as v0.6.0 |
| Codebase fit | Each change sits in the layer that owns the cost: `client/app.tsx` providers, `client/grid.tsx`, `server/cells.ts` | Mostly `shared/preferences.ts`, `client/grid.tsx`, saved views | Same |
| Cost and blast radius | Medium; grid is the riskiest part | Medium; session setup touches every connection | Larger overall, split in two releases |
| Fails when | Virtual columns misalign | Settings add clutter back, which v0.4.0 removed | Same risks, one at a time |
| Evidence | Measured here | Issue reactions and other clients' docs | Both |
| Completeness | 6/10: nothing new to customise | 5/10: the measured costs stay | 9/10 |

### Flow of the recommended option

```
Return to Paseo -> cache sees stale data -> rereads rows, lists, structure   <-- changed: no reread unless asked (web and desktop)
Open a page     -> server sends up to 16 KiB per cell                         <-- changed: preview length, default 1 KiB
Draw the page   -> every column of every visible row                         <-- changed: only visible columns
Scroll sideways -> same                                                      <-- changed: columns come and go
```

### Recommendation

RECOMMENDATION: C because the measured costs are in the app and are cheap to remove, and the settings people ask for most build on the same grid work. Column virtualisation is built only if tuning the row window does not bring wide tables down; that is measured first.

Left out, with reasons:

- **Keyset paging:** 33 ms at row 190,000 is not felt, and people find rows with filters, not by paging that deep. It changes the cursor for SQL engines. Worth revisiting for tables with tens of millions of rows.
- **Keymaps and vim mode:** no SDK support for shortcuts outside an editor. The editor already has Cmd or Ctrl+Enter.
- **Run current statement by default:** rejected in v0.2.0 because it can run something other than what the user sees.
- **Theme that follows the OS:** Paseo owns themes; Datawise already uses theme tokens.
- **Separate metadata connection, reconnect, cancel:** PostgreSQL uses a pool of 3, queries run in their own session, a lost connection is rebuilt, and cancel exists. [verified: `server/adapters/postgres.ts:86`, `server/pool.ts`, `server/adapters/mysql.ts:87-89`]
- **Smaller bundle for phones:** the host builds one file without splitting, so CodeMirror cannot be left out of phone builds by Datawise alone.
- **Startup SQL per connection:** runs on every session, including read-only ones and agent reads. A question for M, not a default.

### Sources

- [DataGrip: data views settings](https://www.jetbrains.com/help/datagrip/settings-tools-database-data-views.html)
- [DataGrip: data sources and drivers](https://www.jetbrains.com/help/datagrip/data-sources-and-drivers-dialog.html)
- [DBeaver: navigation](https://dbeaver.com/docs/dbeaver/Navigation/)
- [DBeaver: data editor](https://dbeaver.com/docs/dbeaver/Data-Editor/)
- [DBeaver: data view and format](https://dbeaver.com/docs/dbeaver/Data-View-and-Format/)
- [DBeaver: connection initialization](https://dbeaver.com/docs/dbeaver/Configure-Connection-Initialization-Settings/)
- [Beekeeper Studio: configuration](https://docs.beekeeperstudio.io/user_guide/configuration/)
- [Beekeeper Studio: tabulator.ts](https://github.com/beekeeper-studio/beekeeper-studio/blob/master/apps/studio/src/common/tabulator.ts)
- [pgAdmin: preferences](https://www.pgadmin.org/docs/pgadmin4/latest/preferences.html)
- [TablePlus: fonts and colors](https://docs.tableplus.com/preferences/fonts-and-colors)
- [TablePlus: safe mode](https://docs.tableplus.com/gui-tools/code-review-and-safemode/safe-mode)
- [DBeaver issue #17817: zoom](https://github.com/dbeaver/dbeaver/issues/17817)
- [DBeaver issue #37897: vi mode](https://github.com/dbeaver/dbeaver/issues/37897)
- [Beekeeper issue #245: default schema](https://github.com/beekeeper-studio/beekeeper-studio/issues/245)
- [Beekeeper issue #3362: editor font](https://github.com/beekeeper-studio/beekeeper-studio/issues/3362)
- [Beekeeper issue #734: keybindings](https://github.com/beekeeper-studio/beekeeper-studio/issues/734)
- TanStack Query core, installed `@tanstack/query-core` 5.106.1, `utils.js` and `queryObserver.js`

## Standardized review

An independent reviewer checked both files against source; no refuter subagents ran, so this review is partial. Findings and outcomes are in the plan's review section. In this file: the sidebar polling claim was wrong and is corrected; the key-cutting defect and the phone-focus limit were added.
