# Datawise: why the UI feels cluttered, and what to do

- Date: 2026-11-06 18:55
- Status: handed to plan

## Question

The UI is too messy and cluttered. What causes that, and what do established tools do instead?

## What is true today

Measured from `client/` at v0.3.0, and read in the running app.

| Where | What is there | Why it reads as clutter | Evidence |
| --- | --- | --- | --- |
| Connection form | One scroll with up to 25 controls: 12 engine chips, URL, name, host, port, user, password, remember, database, write mode, environment, color, group, agents, encryption, SSH | Everything has equal weight. Rare choices sit between common ones. Save and Test are at the very bottom, out of view | [verified: `client/connections.tsx`] |
| Connection form | A paragraph under nearly every control | Reading load before any choice is made | [verified: `SAFETY_TEXT`, `TLS_TEXT`, `ROW_ACCESS_TEXT`] |
| Data toolbar | 10 bordered buttons, wrapping onto two rows at normal widths | No hierarchy, and rare actions (Count, Copy as Markdown) sit beside common ones | [verified: `client/data-tab.tsx`] |
| Grid | A checkbox on every row all the time, and vertical lines on every cell | Selection is rare, but costs a column always | [verified: `client/grid.tsx`] |
| Query pane | Up to 9 controls, then a two-line paragraph on every view | The paragraph repeats forever | [verified: `client/query-tab.tsx`] |
| Accent color | The same solid green on primary buttons, every selected chip, tabs and toggles | Green stops meaning "the main action". A screen can show five solid green shapes | [verified: `Chip` and `Btn` in `client/kit.tsx`] |
| Borders | Every button, chip, card and input has one | Lines everywhere compete with the data | [verified: `client/kit.tsx`] |
| Pickers | `Select` opens a modal forced to 85% height, even for 4 choices | A large empty box for a small choice | [verified: `paseo/packages/app/src/plugins/react-native/modal.tsx`, `scrollable={false}`] |
| Row form | A NULL chip on its own line under each field | Doubles the height of the form | [verified: `client/row-form.tsx`] |
| Warnings | Production, not encrypted and agent requests are separate full-width rows, stacked | Three rows can appear before any data | [verified: `client/app.tsx`] |

Icon-only buttons also read their icon's name to screen readers, such as "Settings2". [verified: `Btn` uses `label ?? icon`]

## What others do

- **Engine first.** TablePlus picks the driver in a separate step, then shows a form for that driver. Name, color, tag and safe mode are at the top, then host, port, user, password and database, with SSH and SSL in their own parts. [TablePlus docs](https://tableplus.com/docs/gui-tools/manage-connections)
- **Environment tags are normal.** TablePlus offers local, testing, development, staging and production, and a status color for the window. [TablePlus docs](https://tableplus.com/docs/gui-tools/manage-connections) Datawise's labels are in line with that.
- **Show the frequent, tuck away the rest.** Put what people often need in the first view, keep it short, and keep the secondary place visible and clearly labelled. [NN/g](https://www.nngroup.com/articles/progressive-disclosure/)
- **Two levels at most.** Beyond two levels, usability is typically low. Simplify first. [NN/g](https://www.nngroup.com/articles/progressive-disclosure/)
- **Do not hide what matters for safety.** One guide warns against hiding compliance or safety-critical fields. [Queensland Government](https://www.forgov.qld.gov.au/communication-and-publishing/website-standards-guidelines-and-templates/consistent-user-experience-standard/module-4-online-forms/module-4-checkpoint-21-progressive-disclosure), via a search summary, not read in full. [unverified: full page not read]

No usage data exists for Datawise, so which actions are frequent is my judgment from the task of browsing a table. It has not been tested with users.

## Options

| | A: paint only | B: one design language plus restructuring | C: separate pages and a wizard |
| --- | --- | --- | --- |
| How it works | Softer colors and fewer borders | Accent for one action, grouped sections, overflow menu, pinned actions | Multi-step connection setup, separate settings pages |
| Fits the cause | Partly; the form stays long | Yes | Yes, but adds navigation |
| Cost | Small | Medium, client only | Large |
| Risk to behavior | None | Low, no server or contract change | Medium |
| Completeness | 4/10 | 9/10 | 7/10 |

RECOMMENDATION: B because the causes are missing hierarchy and one overused color, and it fixes both without new navigation or server changes.

## In plain terms

The app has no visual ranking: everything is the same size, has a border, and is often the same green. The fix is to rank things: one green action per view, common controls first, the rest one labelled click away.
