# Datawise: customisation and advanced features

- Date: 2026-11-06 15:10
- Status: presented
- Mode: explore options
- Repos: `datawise`   Folders: `client/`, `server/`, `shared/`
- Question / problem: Which customisation options and advanced features should Datawise add next, in what order, given what Paseo plugins can do and what established database clients offer?

## Options: add what people use every day first, then what only Paseo can do, and leave parity-only features for later

- **Bottom line:** ship in three releases: customisation and saved working state (0.2), faster editing and querying (0.3), then Paseo-native features including careful agent access (0.4). Skip features that only match paid desktop tools until someone asks for them.
- **Where we are:** framing done; 15 sources read; the plan is `2026-11-06-1525_customisation-and-advanced-features_plan.md`.
- **Need from M:** pick an option, and answer the agent-access question, which the evidence does not settle alone.

### The problem, framed

| 6W2H | Answer |
| --- | --- |
| What | Let people shape Datawise to how they work, and add features beyond basic CRUD |
| Why | Today every setting is fixed in code, nothing survives a reload, and heavier work means leaving for another tool |
| Who | Paseo users with Datawise installed. It has just been listed publicly, so no longer only M |
| Whom | The person at the keyboard first; agents only under the rules below |
| When | No deadline stated |
| Where | `client/`, `shared/contracts.ts`, `server/store.ts`, adapters |
| Which | `defineSettings`, `addSettingsScreen`, `addFilePanel`, `addAttachmentSource`, `defineAgentTool` |
| How | Host settings plus per-object saved views, then contract additions per feature |
| How much | Large overall; each release stands alone and can stop the sequence |

"Customisation options and advanced features" names no specific features, so this research proposes the list. M should cut it.

### What must be true

**Hard constraints**

- Client code is React Native primitives, and a `TextInput` cannot color part of its own text. [verified: Plugin reference, Cross-platform rules] DOM code is allowed in one web-only file: Paseo's Markdown example bundles CodeMirror there and shows read-only text on native. [verified: `plugin-examples/markdown-panel/client/web.ts`; reference, File panels] So a real editor is possible on desktop and web, and phones keep the plain box.
- `react-native-svg` is off limits, and a drawn diagram would need web-only code with no phone view. [verified: Plugin reference, Client runtime] ER diagrams would be costly, not impossible. [inferred: from the web-only pattern above]
- Every RPC has a 30 s limit, so slow work stays as polled jobs. [verified: `paseo/.../runtime.ts`; Datawise `server/jobs.ts`]
- Settings documents are host-scoped, shared by all clients of a daemon, and "not a credential vault". [verified: Plugin reference, Persisted values]
- Keyboard shortcuts have no plugin API. [verified: no shortcut API in the SDK's `client/*.d.ts`]

**What exists today**

- No settings: no `registerSettings`, `addSettingsScreen` or `useSettings` anywhere in the code. [verified: grep of `client`, `server`, `shared`, `index.*`]
- Staged edits, cursor-based running and attachments with rows each failed review as first designed. See the plan's review section.
- Fixed values: page sizes, query row limits, time limits (`client/data-tab.tsx:12`, `client/query-tab.tsx:11-12`), cell limit (`server/cells.ts:3`), history length (`server/store.ts:46`), idle close (`server/pool.ts:7`). [verified]
- All navigation is `useState` in `client/app.tsx:30-35`, so a reload returns to the connection list. [verified]
- One query box per connection, one object at a time. [verified: `client/query-tab.tsx`, `client/app.tsx`]
- PostgreSQL foreign keys return `columns: []` with the whole definition as text, so a jump to the related row has nothing to follow there. [verified: `server/adapters/postgres.ts:218`]
- Edits save one row at a time through a form. [verified: `client/row-form.tsx`]
- TLS and SSH key login have never run against a real server, as the `v0.1.0` release notes state. [verified: release notes]

**Assumptions turned into checks**

| Assumption | Check | Status |
| --- | --- | --- |
| CodeMirror with `@codemirror/lang-sql` works in a plugin and gives schema completion | Paseo's example proves CodeMirror itself, not `lang-sql` | [unverified: spike in Part 5 of the plan] |
| Agent tools work with the pinned SDK | `defineAgentTool` and `addHook` exist in SDK 0.15.1 | [verified: `server/agent-tools.d.ts:21`, `server/lifecycle.d.ts:177`] |
| An OS keychain would protect passwords from agents | Agents run as the same user and could call the same `security` command | [unverified: not tried; not relied on, keychain is not proposed] |

### Found

**What established clients offer**

This is a sample of features I could confirm, not a comparison. I did not check each product for each feature, so a product missing from a row may still have it.

| Feature | Confirmed in | Datawise today |
| --- | --- | --- |
| Review pending edits, then commit | [TablePlus](https://docs.tableplus.com/preferences/crash-and-security), [DataGrip](https://jetbrains.com/help/datagrip/table-editor.html) | No, each save is immediate |
| Manual transaction mode | [DataGrip](https://www.jetbrains.com/help/datagrip/data-editor-and-viewer.html) | No |
| Safety levels | [TablePlus, 3 levels](https://docs.tableplus.com/preferences/crash-and-security) | Yes, 3 modes |
| Query favorites, with folders | [TablePlus](https://www.tableplus.com/blog/2018/05/11-tips-to-boost-productivity-with-tableplus.html), [Beekeeper](https://www.beekeeperstudio.io/features) | Saved queries, no folders |
| Tabs saved between sessions, pinned items | [Beekeeper](https://www.beekeeperstudio.io/features) | No tabs, nothing saved |
| Create and alter tables without SQL | [Beekeeper](https://www.beekeeperstudio.io/features) | Template text only |
| Visual explain plan | [DataGrip](https://jetbrains.com/help/datagrip/query-execution-plan.html) | Text only |
| ER, schema and data compare, mock data | [DBeaver's Enterprise feature list](https://dbeaver.com/docs/dbeaver/Enterprise-Edition/), which does not say they are exclusive to it | No |

TablePlus details come partly from reviews and search summaries, because its full documentation file returned 404. **No user demand was gathered.** Saying what people hit "every day" is my judgment from the verified gaps above, not evidence of what Datawise's users want.

**What only Paseo can do**

- A file panel can open a matching file inside Paseo's file tab, with its absolute path on the host. [verified: Plugin reference, File panels] So `.sql` and `.sqlite` files could open in Datawise directly.
- An attachment source lets a person add a text snapshot to a prompt. [verified: Plugin reference, composer attachment source] This puts data in front of an agent only when a person chooses to.
- Agent tools attach per agent through `agent.open.before`. [verified: Paseo hooks docs] Declaring that hook has a real cost: starting, stopping or reloading the plugin marks open agent sessions stale, and each reopens before its next idle prompt. [verified: same page]

**Agent access is the risky one**

- A Postgres MCP server wrapped queries in a read-only transaction, and `COMMIT; DROP SCHEMA public CASCADE;` got through. The fix was one statement per request and a new connection each call. [verified: [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/)] Datawise already does both for query-box runs. [verified: `server/adapters/sql-base.ts` `run`]
- A separate advisory covered a server whose read-only check only tested that the text began with `SELECT`. [verified: [CVE-2025-59333](https://osv.dev/vulnerability/CVE-2025-59333), search summary]
- Read-only does not answer prompt injection. A support ticket holding instructions got an agent to read a private tokens table through Supabase's MCP. Simon Willison's framing: private data, untrusted content and a way out, all in one agent. [verified: [Simon Willison](https://simonwillison.net/b/8820); secondary, the original General Analysis post was not found]
- A Paseo coding agent normally has shell and network access, so the "way out" cannot be removed. [inferred: from how Paseo agents run] Row contents are therefore the dangerous input. Table and column names are written by whoever controls the schema, a much smaller risk.
- Prompt injection cannot be fully prevented, and the consensus is to keep production data away from agents. [verified: secondary sources above; tier: tertiary]

### Options

| | A: daily use first, then Paseo-native | B: agent access first | C: parity with desktop tools |
| --- | --- | --- | --- |
| How it works | 0.2 settings and saved state; 0.3 SQL editor, tabs, foreign keys, staged edits; 0.4 file panels, attachments, structure tool for agents | Agent tools first, then the rest | Table designer, explain tree, ER, compare, server dashboards |
| Fit with our code | Uses APIs already proven in `contextualise`; contract additions are additive | Hook makes every plugin reload touch M's open agents | Per-dialect DDL across 6 SQL engines, largest change |
| Cost and blast radius | Small to medium per release; each can stop the sequence | Small code, largest safety question | Largest; ER would be web-only with no phone view |
| When it fails | Staged edits are the hard part; they can be dropped from 0.3 without affecting the rest | One injected row reaching a production read | Long time to first release, with no stated need for most of it |
| Evidence | Verified gaps in our code; feature sample above | Datadog, Willison | Feature sample above |
| Completeness | 9/10 | 5/10 | 6/10 |

### Flow of the recommended option

```
0.2  Settings + connection labels + saved views + state survives a reload
      |   (nothing here can change data)
      v
0.3  SQL editor + query tabs + run selection + FK jumps + staged edits   <-- riskiest for data
      |
      v
0.4  File panels + attach structure + structure-only agent tool    <-- first agent contact
```

### Recommendation

RECOMMENDATION: Option A because 0.2 cannot change data, so risk rises only after the simple parts ship, and it delays agent contact until M has decided how far it goes.

Left out, each with a reason:

- **ER diagrams:** would be web-only, with no phone view, at real cost. The Structure tab can list relations as text instead.
- **Schema and data compare, mock data, visual query builder:** no one has asked for them, and each is large.
- **Run at the cursor:** review showed that it re-parses and can run something other than what the user sees. Running a selection gives the same result. See the plan.
- **Server dashboards and killing sessions:** per-engine admin work with a real blast radius. Worth its own decision.
- **OS keychain:** would not stop agents running as the same user, the main reason to want it. [unverified: see the table above]
- **Backup and restore:** native tools (`pg_dump` and others) do this better, and would need those tools on the daemon.

### Sources

- [Paseo plugin reference](https://paseo.sh/docs/plugins/reference) (primary)
- [Paseo plugin hooks](https://paseo.sh/docs/plugins/hooks) (primary)
- [Datadog: SQL injection in the PostgreSQL MCP server](https://securitylabs.datadoghq.com/articles/mcp-vulnerability-case-study-SQL-injection-in-the-postgresql-mcp-server/) (secondary, engineering write-up)
- [CVE-2025-59333](https://osv.dev/vulnerability/CVE-2025-59333) (primary advisory, read through a search summary)
- [Simon Willison on the Supabase MCP](https://simonwillison.net/b/8820) (secondary)
- [Supabase MCP docs](https://supabase.com/mcp) (primary for its own warnings, search summary)
- [JetBrains: DataGrip data editor](https://jetbrains.com/help/datagrip/table-editor.html) (primary)
- [JetBrains: DataGrip data editor and viewer, 2026.2](https://www.jetbrains.com/help/datagrip/data-editor-and-viewer.html) (primary)
- [JetBrains: DataGrip query execution plan](https://jetbrains.com/help/datagrip/query-execution-plan.html) (primary)
- [DBeaver Enterprise Edition](https://dbeaver.com/docs/dbeaver/Enterprise-Edition/) (primary)
- [Beekeeper Studio features](https://www.beekeeperstudio.io/features) (primary, vendor)
- [TablePlus documentation](https://docs.tableplus.com/preferences/crash-and-security) (primary, search summary)
- [TablePlus productivity tips](https://www.tableplus.com/blog/2018/05/11-tips-to-boost-productivity-with-tableplus.html) (vendor)
- `client/app.tsx`, `client/query-tab.tsx`, `server/adapters/postgres.ts`, `server/store.ts` (source code)
- `contextualise/index.client.tsx`, `contextualise/shared/contracts.ts` (M's own use of settings)

## Standardized review

### At a glance

- **Bottom line:** present after fixing 3 findings. All are applied in this version.
- **Where we are:** reviewed by an independent agent alongside the plan; partial, no second reviewer for the fixes.
- **Need from M:** pick an option; see the plan's briefing for the agent-access decision.
- **Why:** one false platform claim and two overstated arguments changed what could be recommended.
- **Intended outcome:** enough evidence to choose what to build next.
- **Findings:** 3 must-verify, all applied.

### Findings

1. **MUST-VERIFY (fixed) - "A code editor library cannot be used" was false.** Paseo's Markdown example bundles CodeMirror for web. Highlighting moved from left-out to 0.3, pending a spike.
2. **MUST-VERIFY (fixed) - The DBeaver argument was overstated.** Its page lists those features under Enterprise without saying they are exclusive, so "paid, therefore specialist" was dropped.
3. **MUST-VERIFY (fixed) - The comparison table implied more than was checked.** 24 of 36 cells were "not checked". It is now a labelled sample, and "what people hit every day" is marked as judgment.

### Scope and limits

- **Checks not run:** no user research, no trial of the tools themselves. TablePlus's full documentation file returned 404, and the General Analysis post was not found, so those rest on secondary sources.
- **Confidence:** medium. Platform facts are verified in source. Priorities are judgment, and M should cut freely.

### In plain terms

The evidence is solid on what Datawise can and can't do, and thin on what users want. That is why the first release is cheap and each later one is M's call.
