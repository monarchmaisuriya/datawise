# Datawise: declutter the UI

- Date: 2026-11-06 19:00
- Status: done; M asked for research, plan, implementation, fixes, release and reinstall in one request
- Repos: `datawise`   Folders: `client/`
- Files: `client/kit.tsx`, `client/connections.tsx`, `client/data-tab.tsx`, `client/grid.tsx`, `client/query-tab.tsx`, `client/row-form.tsx`, `client/tree.tsx`, `client/app.tsx`, `OVERVIEW.md`, `CHANGELOG.md`, `README.md`, `package.json`
- Subagents: independent reviewers only
- Research: `docs/2026-11-06-1855_ui-declutter_research.md`

## Context and problem

M finds the UI too messy and cluttered. Research found no visual ranking: every control has equal weight, a border, and often the same green.

## Goals / Non-goals

**Goals**

- One accent action per view. Selected states become neutral.
- The connection form shows essentials first, with the rest in labelled sections that show their current value. Test and Save are always visible.
- The data toolbar fits one row at normal widths. Rare actions move to a More menu.
- The query pane loses its permanent paragraph, and rare controls move to a menu.
- Warnings become small labels beside the title instead of stacked rows.

**Non-goals**

- Removing any feature, or any server, contract or safety change. Every action stays reachable, at most one level away.
- Anchored dropdowns. The host offers none, and hand-rolled ones break on Android. Menus use the host's dialog at its natural height.
- A wizard or new pages. Saved views and connection files do not change.

## What is true today

See the research file's table, each row verified against `client/`.

## Options considered

See the research file. RECOMMENDATION: option B because the causes are missing hierarchy and one overused color.

## Decision

Build one small design language in `client/kit.tsx`, then apply it to each screen. Client only.

## Design

### Shared pieces in `client/kit.tsx`

| Piece | Change | Why |
| --- | --- | --- |
| `Btn` | `ghost` has no border. A new `title` names icon-only buttons | Fewer lines; screen readers stop saying "Settings2" |
| `Chip` | Selected is a neutral fill, not green | Green means the main action only |
| `Segmented` | New: joined choices for one-of-many | Replaces rows of chips for write mode, encryption and tabs |
| `Section` | New: a labelled row that opens, showing its current value when closed | Hidden settings still show their state |
| `Pill` | New: small status label | Replaces stacked warning rows |
| `MoreMenu` | New: a labelled list in the host's dialog at natural height | Overflow for rare actions |
| `Select` | Opens at natural height, not 85% | A small choice gets a small box |
| `Grid` | No vertical cell lines | The data carries the screen |

### Connection form

```
Name
Database type (one Select, was 12 chips)
Host and port, or the file path
User, password (Remember as a small toggle)
Database
Password storage (Segmented, its disclosure)  <-- safety stays visible
Environment (Segmented)                       <-- safety stays visible
When writing (Segmented, its caveat in full)  <-- safety stays visible
> Security          Encryption verified · Direct  <-- changed
> Agents            Names and rows (warning)      <-- changed
> Color and group   Red · Team                    <-- changed
[Delete]             [Test] [Save]            <-- pinned, always visible
```

- **Safety is never tucked away silently.** When writing stays in the first view. A closed section shows its value. "Encryption: Off" to a remote host shows in the warning color. Production keeps removing No Prompts and agent access.
- **Agent wording stays whole** once its section is open. It is a consent statement, so it is not shortened.

### Data tab

```
Before: Refresh Filter Columns +Row Edit Count Import Export Copy     (wraps)
After:  Filter Columns            +Row Edit ↻ ⋯(Count Import Export Copy)
```

- **Row checkboxes show after pressing Select or Edit cells.** Select is on every engine that can delete rows, so a direct bulk delete stays one press further. Leaving either mode clears the selection, so no hidden selection can act later.
- **Count** shows in the footer when run.
- **Selecting rows** puts Delete in the toolbar only then.

### Query pane

```
Query 1  Report ×  +
[editor]
Run  Explain                      History  Saved  ⋯(Save, Export, Limits)
```

- The two-line paragraph moves into the Limits dialog. The sentence about how statements run also shows whenever the text runs past one line or one statement, because some engines separate statements by line, and because it changes what `BEGIN; ...; ROLLBACK` does.
- Limits are a visible button that shows their values, and the dialog uses segmented choices, so a change is one extra press and one choice.
- Selection status stays, because it says what will run.

### Rail

Database and schema share a row, and stack when either name is too long to tell apart. Find table has its own row. Query, New table and Refresh sit on one quiet row.

### Header

Title, then pills: Production (red), Read-only, Not encrypted. Then Data, Structure, SQL as a `Segmented`. The color bar stays. Agent requests stay as a slim row, because they need action.

### Row form

NULL moves onto the field's label row. Save and Close are pinned.

### Parity

| Item | Today | After | Status | Why it matters |
| --- | --- | --- | --- | --- |
| Refresh, Filter, Columns, Row | Toolbar | Toolbar | same | Common |
| Count, Import, Export, Copy as Markdown | Toolbar | More menu | changed | One click further |
| Bulk delete | Checkbox always | Checkbox after Select or Edit cells | changed | One click further; selection clears on leaving |
| Row form, Duplicate, foreign key jump | Row press | Row press | same | |
| Query limits | Two pickers | Limits button showing values, then one choice | changed | Same number of presses |
| How statements run | Always shown | Shown for several statements and in Limits | changed | Still shown when it matters |
| Password storage disclosure | First view | First view | same | Consent wording |
| Production warning | Full row with the name | Red pill on every tab; carries the name on a phone, where the rail is hidden | changed | Still on every tab |
| Not encrypted warning | Full row with the consequence | Pill; the consequence is in Security and read by screen readers | changed | Still always shown |
| Write mode, confirmation prompts | As is | As is | same | Safety unchanged |
| All server behavior | As is | As is | same | No server change |

## Risks and mitigations

| Risk | Likelihood | Impact | Mitigation | How noticed |
| --- | --- | --- | --- | --- |
| A setting is overlooked in a closed section | Medium | Wrong encryption or label | Closed sections show their value; remote and unencrypted shows in the warning color | Browser check |
| Production is less noticeable as a pill | Low | Change made on the wrong database | Red pill on every tab, color bar, Production in the list; write prompts unchanged | Browser check |
| Someone cannot find Export or bulk delete | Medium | Annoyance | One labelled click away; changelog says where | M's trial; not user tested |
| A form field fails on save while its section is closed | Low | Confusion | Errors show above the pinned buttons | Browser check |
| Dialog with its own scroll breaks at phone width | Low | Unusable form | Checked at phone width, opening every dialog | Browser check |
| Light theme contrast | Low | Hard to read | Theme tokens only; checked in light | Browser check |

## Acceptance criteria

- Given the connection form, when it opens, then Test and Save are visible without scrolling, at wide and phone width.
- Given a closed section, when reading the form, then its current value shows.
- Given a remote host with encryption off, when reading the form, then the closed section shows it in the warning color.
- Given any screen, when counting, then at most one solid accent control shows, apart from a chosen confirmation dialog.
- Given a window with a 1000 px content area or a 375 px phone, when a table is open, then the data toolbar fits one row, including while rows are selected.
- Given Edit cells or Select turned off, when rows were ticked, then the selection is gone and no Delete button shows.
- Given row access for agents, when the Agents section is closed, then its value says so in the warning color.
- Given any feature in the parity table, when looking, then it is reachable in at most one extra click.
- Given a production connection, when any tab is open, then the Production label shows.
- Given an icon-only button, when read by a screen reader, then it has a plain name.
- Given a phone width, when each dialog opens, then it completes its action, including a dialog opened from the More menu.

## Rollout and rollback

Version 0.4.0, then reinstall from git, as M asked. No data or contract change, so reinstalling v0.3.0 restores the old UI exactly.

## Parts

### Part 1: Shared pieces

- [x] `Btn`, `Chip`, `Segmented`, `Section`, `Pill`, `MoreMenu`, `Select`, `Grid`. Done: typecheck passes.

### Part 2: Screens

- [x] Connection form, data tab, query pane, rail, header, row form. Done: browser check at wide and phone width, light and dark.

### Part 3: Release

- [x] Docs, independent review, regression, version, release, reinstall. Done: running from git at v0.4.0.

## Standardized review

An independent reviewer read this plan and the code without running anything. Verdict: fix before building. All findings were applied above or decided here.

| Finding | Severity | Outcome |
| --- | --- | --- |
| Gating checkboxes on Edit would remove direct bulk delete, and leaving Edit kept a hidden selection | blocking | Select on every engine; selection clears on toggle |
| Production name lost on phones; Not encrypted lost its consequence; caveats could be shortened; password disclosure and Agents summary unprotected | blocking | All kept; see Parity and the form design |
| A lazy list inside a scrolling dialog, and the host forcing 85% height | must-verify | Short lists are drawn in full; long ones stay lazy |
| Pinned footer forces 85% height on desktop; long errors squeeze the body | must-verify | Accepted the height for the connection and row forms; a long message takes room from the scrolling body |
| "Fresh session" note dropped | must-verify | Shown when the text holds several statements |
| Phone header can clip pills | must-verify | Pills get their own row on phones |
| Menu closing while a dialog opens on a phone | must-verify | Checked in the browser at phone width; native phones not run |
| Similar long names look the same side by side | must-verify | Stacks when a name is long |
| Limits three levels deep | note | Visible button, then segmented choices |
| Clutter the plan missed | note | Filter, Export, Import, Structure and list rows are done; agent activity left as it is |
| Two accents with the agent banner | note | Review button is no longer filled |

Could not break: nested dialogs, footer above the keyboard, the editor's fixed height.

A second independent reviewer read the code diff.

| Finding | Severity | Outcome |
| --- | --- | --- |
| Rows clip in a narrow desktop pane, because compact follows the window and not the pane | blocking | Header, data toolbar and query actions wrap; pills no longer shrink beside a long title |
| A second scroller in phone sheets could fight the sheet's gestures | must-verify | Removed; the message is a plain view |
| The statements note missed line-separated engines | note | Also shows past one line |
| The empty message vanished with zero databases or schemas | note | Gated on those lists having settled |
| Web readers ignore `accessibilityState` | note | `aria-*` props added |
| Session-only flag saved for an engine with no password | note | Saved as remembered for those engines |

Could not break: `build()` for all 12 engines, the encryption rule against the server's, agent summary against what is saved, selection across paging and toggles, tab close.

## Changes made

- Part 1: shared pieces in `client/kit.tsx`, with icon-only buttons required by type to carry a name.
- Part 2: all screens, checked at wide and phone widths in light and dark.
- Also fixed: choosing the current database type no longer clears the port. Found while testing.
- Part 3: released as v0.4.0. The regression also showed the Oracle agent read check failing on timing, because Oracle refuses a read-only transaction just after a table changes (ORA-01466). The check now waits for that to pass.

## Open questions

None. The list of frequent actions is my judgment, with no usage data.
