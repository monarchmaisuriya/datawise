# Datawise: lighter by default, then the settings people ask for

- Date: 2026-11-07 10:10
- Status: done, released as v0.5.0; approved by M with the recommended answers: option C, no reread on return with the read time shown, a 1,024-character preview, no startup SQL
- Repos: datawise   Folders: `client/`, `server/`, `shared/`
- Files: `client/app.tsx`, `client/grid.tsx`, `client/data-tab.tsx`, `client/sql-editor.tsx`, `client/web.ts`, `client/settings-screen.tsx`, `index.client.tsx`, `shared/preferences.ts`, `shared/contracts.ts`, `server/plugin.ts`, `server/cells.ts`, `server/adapters/*` (read paths only), docs
- Subagents: independent reviewers only
- Research: `docs/2026-11-07-1000_speed-and-settings_research.md`

## Context and problem

M asked for optimisations and more customisation. The research found that the server is fast, but the app does work nobody asked for. It rereads data when you return to Paseo, draws every column of every visible row, and receives up to 16 KiB of each value to show one line of it. The settings people ask for most are text size, column widths and value display.

## Goals / Non-goals

**Goals**

- v0.5.0: key values are never cut; no reread unless the person asks or the data changed here; lighter grid drawing; grid values capped at a preview length.
- v0.6.0: text size; column widths you can drag and that are kept per table; number grouping and binary display.

**Non-goals**

- Keyset paging, keymaps, vim mode, running the current statement by default, OS theme, a separate metadata connection, a smaller phone bundle. Reasons are in the research.
- Startup SQL per connection, unless M chooses it (question 4).
- Any change to safety prompts, write paths, agent tools or export.

## What is true today

- Each plugin gets its own data cache built with default options. [verified: `paseo/packages/app/src/plugins/registry.ts:102`] In those defaults, data is stale at once and is refetched when the window regains focus. [verified: `@tanstack/query-core` `utils.js:34`, `queryObserver.js:491-494`] Datawise sets no defaults of its own. [verified: grep for `setDefaultOptions`, `refetchOnWindowFocus` in `client/`]
- Any column can be cut, key columns included. [verified: `server/cells.ts:66-80`] The client builds a row's key from the value it received. [verified: `client/data-tab.tsx:19-21`] On a Redis set, renaming a member longer than 16 KiB removes nothing and adds the new member, with no error. [verified: `server/adapters/redis.ts:298-306`, `:404-409`] On SQL engines the write matches no row and fails. [verified: `server/adapters/sql-base.ts:427`]
- Approving an agent request refreshes only the request list, not an open table. [verified: `client/agent-requests.tsx:91`]
- Rereading on return happens on web and desktop only. [verified: `@tanstack/query-core` `focusManager.js:17`]
- `Grid` draws every column for each row it draws, with no fixed row height, and sets only `initialNumToRender`, so the list keeps about 10 screens of rows either side. [verified: `client/grid.tsx:46-64`, `:124`] A 1,000-row page of 20 columns kept about 4,500 text cells in the page; the default page is 100 rows. [verified: DOM count; `shared/preferences.ts:19`]
- Each grid value can be up to 16 KiB. [verified: `server/cells.ts:3`] The grid shows one line, at most 320 px wide. [verified: `client/grid.tsx:10`, `numberOfLines={1}`]
- A cut value is never edited or copied as a row from the cut text: the row form reads the whole row first. [verified: `client/row-form.tsx:29`; `client/data-tab.tsx`, `pressCell`] Export reads its own stream. [verified: `server/plugin.ts:528`] Agent reads pass their own limit. [verified: `server/adapters/sql-base.ts:284-290`]
- The server reads preferences and reacts to changes. [verified: `server/plugin.ts:92-95`, idle close]
- Saved views are a Zod object, so an older version drops fields it does not know when it saves. [verified: `shared/contracts.ts:212`] All views live in one file that is rewritten whole, and a file that fails to parse is set aside and starts empty. [verified: `server/side-file.ts:36-44`, `:50-60`]
- Settings apply to the whole host, on every device. [verified: `paseo/public-docs/plugins/reference.md:1390`]

```
Open a page     -> server cuts any value at 16 KiB, keys too               <-- Part 0: keys are never cut
Return to Paseo -> data cache: stale -> reread rows, lists, structure     <-- Part 1 stops this (web, desktop)
Draw the page   -> every column x about 10 screens of rows                  <-- Part 2: smaller row window, then columns if needed
Open a page     -> values up to 16 KiB                                      <-- Part 3: up to the preview length
```

## Options considered

| | A: speed only | B: settings only | C: speed in v0.5.0, settings in v0.6.0 |
| --- | --- | --- | --- |
| How it works | Parts 1-3 | Parts 4-6 | All, in two releases |
| Tradeoffs | Nothing new to set | Measured costs stay | Two releases to test |
| Fails when | Columns misalign | Settings add clutter back | Same, one at a time |
| Completeness | 6/10 | 5/10 | 9/10 |

RECOMMENDATION: C because the costs are measured and cheap to remove, and column widths need the grid work anyway.

## Decision

Option C, pending M's pick. Each change sits where the cost is decided: Datawise's own cache policy in its providers, drawing in `Grid`, value size on the server, which already owns cutting. Part 0 comes first because Part 3 would make an existing defect common.

### Part 0: a key is never cut (v0.5.0, also a fix on its own)

- `finishRows` takes the key column positions and never cuts them. Every adapter's read passes them. A key too large for the response limit fails the read with a plain message instead.
- The client refuses to build a key from a cell marked cut, as a second guard, with the message "This row's key is too long to change from here."
- Tests: a Redis set member and a PostgreSQL text key longer than the preview arrive whole, and renaming the Redis member removes the old one.

## Design

### Part 1: Datawise owns its data freshness (v0.5.0)

- `DatawiseProviders` sets the plugin's own cache defaults once: `refetchOnWindowFocus: false`. Opening a table, saving, committing and Refresh still read fresh data, as today. [verified: `refresh()` and `invalidateQueries` in `client/data-tab.tsx`]
- The data footer shows when the page was read, such as "Read 10:42". So old data is visible as old.
- New preference **Reread when you return to Paseo**, off by default (question 2). On, it restores today's behaviour.
- Approving an agent request that finishes refreshes open tables, because the window no longer does that on return.
- The preview length is part of the page's cache key, so changing it reads again.
- Phones never reread on return today, so nothing changes there.

### Part 2: lighter grid drawing (v0.5.0)

- **First, measure.** Count drawn cells and time scrolling for 100- and 1,000-row pages of 20 and 200 columns, before and after setting a smaller row window (`windowSize`) and `maxToRenderPerBatch`. This is a two-line change.
- **Then, only if 200-column tables still draw far more than they show:** draw the columns in view plus one screen width either side, with spacers keeping the full width. Header and rows already share one horizontal scroll view, so they stay aligned. [verified: `client/grid.tsx:101-103`] `scrollEventThrottle` is set, because iOS otherwise reports scrolling once. Rows only re-render when the range moves by a whole column.
- No fixed row height. OS text scaling and compact layout make a fixed height clip text, so `getItemLayout` is left out.
- Selection, sorting, cut markers, edited cells and press targets are indexed by column position, which does not change.

### Part 3: send a preview, not the whole value (v0.5.0)

- New preference **Value preview length**: 256, 1,024, 4,096 or 16,384 characters. The default is 1,024 (question 3). The server reads it when it reads a page for the grid and passes it into each adapter's `read`. The default in `finishRows` stays 16 KiB, because query results use it too. Keys are never cut (Part 0).
- Contracts do not change. A cut value already carries a marker and opens the whole row when pressed.
- Query results, export and agent reads keep their own limits.
- **Copy page as Markdown** carries the preview, marked as cut, as it already does for 16 KiB values. The changelog says so.

### Part 4: text size (v0.6.0)

- New preference **Text size**: Small, Medium (today) or Large. It sets grid and editor text; rows size to their text. It applies on every device, because settings are per host. The setting says so.

### Part 5: column widths (v0.6.0)

- On web and desktop, a handle on each header's right edge resizes the column by dragging. On phones, where plugins get no gesture library and the scroll view takes the drag [unverified: native, per Paseo's module list], the Columns dialog has Narrower, Wider and Automatic for each column.
- Widths are kept in the table's saved view, as an optional `columnWidths` map. Values are clamped to 60-800 px when read, never rejected, because a rejected value would set the whole views file aside.
- All views share one file, so an older version saving any view drops widths for every table. The changelog says so.

### Part 6: value display (v0.6.0; can be cut)

- **Group digits in numbers:** off by default. It applies to number columns only, never to text that looks like a number, and never to keys.
- **Show binary as:** size (today) or the first 16 bytes in hex.
- Dates are left alone: their text depends on each engine and session time zone, and reformatting could make a value look like something it is not.

### Parity

| Item | Today | After | Status | Why it matters |
| --- | --- | --- | --- | --- |
| Data on return to Paseo | Reread | Kept, with the read time shown; setting restores rereading | changed | Question 2 |
| Key values | Cut above 16 KiB | Never cut | changed | Fixes a silent wrong rename on Redis sets |
| Open table after approving an agent request | Reread on return | Reread when the request finishes | changed | Shows the approved change |
| Grid values | Up to 16 KiB | Up to the preview length | changed | Question 3; full value one press away |
| Copy page as Markdown | Values up to 16 KiB | Values up to the preview length, marked | changed | Named in the changelog |
| Rows and columns drawn | About 10 screens of rows, all columns | Fewer rows; visible columns only if needed | changed | Invisible to the person if aligned |
| Edit, sort, select, cut markers | As is | As is | same | |
| Export, query results, agent reads | As is | As is | same | |

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | How noticed |
| --- | --- | --- | --- | --- |
| Header and rows drift apart while scrolling | Low | Values read under the wrong column | They share one scroll view; column ranges are built only if measurement calls for them | Browser check on web; native unverified |
| Blank columns during a fast swipe | Medium | Brief flicker | One screen of columns drawn either side | Browser check |
| Someone trusts an old page | Medium | Acts on stale data | Read time in the footer; writes still compare values before changing them | Browser check |
| A long value looks complete | Low | Misread | The cut marker stays; the row form shows the whole value | Browser check |
| A key too large for one response | Low | That page fails to load | Plain message; filter to find the row | Test |
| A setting on the phone surprises on the desktop | Medium | Annoyance | The setting says it applies everywhere | Settings page text |
| Drag handles fight horizontal scrolling | Medium on web | Hard to scroll | Handle at the header edge only; phones use buttons | Browser check |

## Acceptance criteria

- Given a key longer than the preview, when the page is read, then the key arrives whole.
- Given a Redis set member longer than the preview, when it is renamed, then the old member is gone and the new one exists.
- Given a table open on web or desktop, when the window loses and regains focus, then no read happens, and the footer shows the read time.
- Given the reread setting on, on web or desktop, when the window regains focus, then the page is read again.
- Given an approved agent request that finished, when its table is open, then the grid shows the new values.
- Given a changed preview length, when the table is open, then the page is read again.
- Given 100- and 1,000-row pages of 20 and 200 columns, when measured before and after Part 2, then drawn cells drop, and the numbers are recorded in this plan.
- Given horizontal scrolling, when it stops at any position, then each header sits over its column.
- Given a 10,000-character value and the default preview, when the page is read, then the grid value has 1,024 characters and a cut marker, and opening the row shows all 10,000.
- Given export, a query result or an agent read, when values are long, then their limits are unchanged.
- Given Large text, or 200% OS text size, when a page is drawn, then no text is clipped vertically.
- Given a saved width outside 60-800 px, when views are read, then it is clamped and no other view is lost.
- Given a dragged column width, when the table is opened again, then the width is the same; after a double press, it is automatic.
- Given number grouping on, when a key or text column holds digits, then it is shown as stored.

## Rollout and rollback

- v0.5.0 with Parts 1-3, then v0.6.0 with Parts 4-6. Each release needs M's go.
- Rollback: reinstall the previous tag. New preferences are ignored by older versions; `columnWidths` is dropped by an older version saving a view.

## Parts

### Part 0: keys are never cut

- [x] Server and client guards, tests. Done: both key criteria pass; Redis and PostgreSQL pass. The full regression runs once, after the last part.

### Part 1: data freshness

- [x] Cache defaults, read time, reread setting, refresh after approval, preview in the cache key. Done: focus criteria pass on web; approval refresh not run end to end.

### Part 2: lighter grid drawing

- [x] Measure, tune the row window, then column ranges only if needed. Done: numbers below.

### Part 3: value preview

- [x] Preference, server cut, tests. Done: preview criterion passes on PostgreSQL.

### Part 4: text size

- [x] Preference, grid and editor. Done: Large checked in the web app; 200% OS text size not run.

### Part 5: column widths

- [x] Handle on web, buttons on phones, clamped saved widths. Done: drag, keep after reload, double press reset, phone buttons and clamping all pass.

### Part 6: value display

- [x] Number grouping, binary display. Done: unit tests pass; keys and text are excluded by type.

## Standardized review

An independent reviewer checked the research and plan against source. No refuter subagents ran, so the review is partial. Verdict: do not sign off until three blocking findings are fixed. All are applied above.

| Finding | Severity | Outcome |
| --- | --- | --- |
| Sidebar change could hide a request from another device, and the polling claim was wrong (15 s, not 5 s) | blocking | Item dropped; research corrected |
| A cut key builds a wrong key; on a Redis set a rename silently adds instead of renaming. Exists today above 16 KiB | blocking | New Part 0, first |
| Approving an agent request does not refresh an open table | blocking | Part 1 refreshes it |
| Column virtualisation not justified at the default 100 rows; row window untuned | must-verify | Part 2 measures and tunes first |
| iOS scroll events, re-renders, fixed row height with OS text scaling | must-verify | `scrollEventThrottle`; no fixed height |
| Dragging inside a horizontal scroll view on phones; no gesture library for plugins | must-verify | Buttons on phones |
| One views file: older versions drop all widths; an out-of-range width would set the file aside | note | Clamp on read; changelog note |
| Preview limit must be passed into each adapter, not the shared default | note | Applied |
| Preview length missing from the cache key | note | Applied |
| Rereading on return is web and desktop only | note | Stated in criteria |

Could not break: Copy as Markdown marks cut values; foreign-key jump and Duplicate use the whole row; selection compares only whole values; agent reads and export keep their limits.

## Code review

An independent reviewer read the diff. No refuter subagents ran.

| Finding | Severity | Outcome |
| --- | --- | --- |
| A binary value over about 750 bytes was cut into JSON text | blocking | Cut as bytes, with its whole size; tested |
| Redis declared a string or list value as a key, so 5 MB strings were sent whole | blocking | Only identities are kept whole; the row form rebuilds a cut list value from the whole row and refuses if it changed; tested |
| Drag handles on tablets, where the scroll view takes the drag | must-verify | Handles need a mouse (web, wide); every touch layout gets the Columns dialog buttons |
| A stale scroll position after columns shrink | must-verify | Clamped |
| Changelog said "a page"; read time had no date; opening a finished request refreshed tables; cell count claim | note | All corrected |

## Standardized review (code)

- **Bottom line:** ship after fixing 1 must-verify; all findings fixed before release.
- **Scope:** the whole diff, focused depth (one hop of callers and callees). One independent refuter checked the must-verify finding; notes were not refuted.

| Finding | Severity | Outcome |
| --- | --- | --- |
| The rule that rebuilds a cut Redis key, the only check against a list entry that changed after the page was read, had no test | must-verify (refuter: stands) | Moved to `shared/row-key.ts`, with tests that fail when the rule is broken |
| A binary value's size was computed in three places | note | One owner, `bytesSize` in `shared/contracts.ts` |
| The Columns dialog measured widths from different rows than the grid | note | Both measure the drawn rows, pending edits included |
| A comment named a person instead of the reason | note | Reworded |
| The overview's list of preferences was out of date | note | Updated |
| `positionsOf` ignores a key name it cannot find | note | Kept: an empty MongoDB page has no `_id` column, so throwing would break it; long-key checks cover PostgreSQL and Redis |

## Changes made

- Measurements for Part 2, text cells in the page, web app at 1300 x 850:

  | Page | Before | Smaller row window | Plus visible columns only |
  | --- | --- | --- | --- |
  | 20 columns, 100 rows | 2,170 | 691 | 598 |
  | 20 columns, 1,000 rows | 4,685 | 686 | 593 |
  | 200 columns, 100 rows | 20,350 | 6,271 | 598 |
  | 200 columns, 1,000 rows | 36,425 | 6,266 | 593 |

  After scrolling down, 124 rows of 200 columns still drew 25,160 cells with the row window alone, so column ranges were built. Timings were not taken, because the browser pane was hidden.
- Part 1: Datawise sets its own read policy; the footer shows the read time; a setting restores reading on return; an approved agent request refreshes open tables; the preview length is in the page's cache key. Six simulated returns caused no reads; Refresh did; with the setting on, three returns caused three reads.
- Part 2: smaller row window, and only the columns near the view are drawn. Headers stay over their columns after scrolling sideways.
- Part 3: the server passes the preview length into each adapter's page read. Agent reads, query results and export keep their limits.
- Parts 4-6: text size for tables and the editor; widths by dragging on wide screens and by buttons on phones, kept in the table's view and clamped when read; digit grouping and a hex preview for binary.
- Released as v0.5.0 after a code review, a standardized review and a full 12-engine regression.
- Part 0: `finishRows` keeps key columns whole, passed by every adapter's page read and by agent reads; the client refuses a key from a cut cell. With the guard switched off, the new Redis and PostgreSQL checks failed as predicted (16,384-character key); with it on, both pass.

## Open questions

See Questions for M in the briefing.
