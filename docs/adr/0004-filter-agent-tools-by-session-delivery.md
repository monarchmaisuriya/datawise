# 0004. Filter the fixed agent catalog by session delivery

- Status: accepted; source verification pending
- Date: 2026-11-19
- Decided by: M, approved adaptive-plugin plan and delegated Datawise implementation, chat 2026-11-19
- Supersedes: 0002's unconditional tool delivery only; its one-hook, fixed-catalog and per-call access rules remain
- Related records: 0001, 0003
- Owner: the Datawise maintainer
- Stakeholders: people running Datawise agents on providers with different tool support
- Review when: the host changes attached-tool delivery or tool-disable semantics, or a limited open changes stored data or another session's tools

## Context

ADR 0002 calls for review when Paseo can offer tools to selected agents. The new host supplies a read-only `openSupport.attachedTools` descriptor at each session open, with delivery, the host tools switch and exact disabled names. Datawise can now filter delivery without consulting sharing or opening a database. [verified: `docs/adr/0002-agent-tools-for-every-agent.md:10,40-45`; `server/plugin.ts:141-148`]

Datawise's catalog handlers own access checks on every call. A delivered definition is not permission to read or change a connection. [verified: `server/agent-tool.ts:174-211`; `server/plugin.ts:292-315,359-368`]

## Decision drivers

1. Unsupported optional delivery must not stop a session opening.
2. Tools must return unchanged at the next supported open, except explicit host disables.
3. Keep one registered hook, a prebuilt catalog and no hook-time I/O.
4. Preserve sharing, production refusal, approvals, UI and stored data.

## Options considered

| Aspect | Filter the fixed catalog at open (chosen) | Always offer the catalog | Re-register from sharing/support changes |
| --- | --- | --- | --- |
| How | Inspect the host descriptor only, on each open | Ignore session delivery | Replace the hook when availability changes |
| Cost and scope | One local filter, setup gate, owning tests/docs | No change, but cannot adapt to unavailable delivery | Additional mutable state and registration lifecycle |
| Failure | Missing support omits optional tools | Unsupported delivery still receives contributions | Share changes can reopen sessions or leave stale lists |
| Tradeoff | A working but unconfirmed route receives no tools | Gives up conservative limitation | Gives up the fixed registration rule |
| Why | Matches M's approved limitation/restoration scope | Rejected by the new requirement | Unneeded state and reopening risk |

## Decision

Register one `agent.open.before` hook and build the catalog once. Its body derives contributions synchronously, with no I/O. History receives none. Missing support, `none`/`unknown` delivery or disabled host tools receives none. Enabled `native`/`mcp` delivery receives the prebuilt definitions minus exact names in `disabledTools`. Do not gate native delivery on external HTTP, instructions, provider identity or exact preapproval.

Keep every existing execution-time sharing, production and approval check. Do not persist availability, modify configuration, rewrite saved queries or connections, or register a second hook. At setup, require `server.features?.adaptiveAgentFeatures` once and otherwise throw update-host guidance. [verified implementation boundary: `server/plugin.ts:141-148`; `index.server.ts:4-7`]

## Consequences

- Supported and limited sessions derive independent tool lists from the same definitions.
- Missing support stays limited, even if the provider might have a usable route.
- Older hosts cannot load this adaptive source. The published SDK/manifest versions remain unchanged in this source-only task; release alignment is still required.
- Rollback is source-only: restore the prior unconditional hook and remove the setup gate. No data migration or reset is required. Do not install or restart a daemon as part of this change.

## Assumptions and verification still needed

The host owns descriptor validation and delivery. Plugin tests use synthetic descriptors, not provider discovery. [unverified: parent host contract/integration verification]

`server/agent-hook.test.ts` contains the fixed registration, restoration, no-HTTP native, disabled-tool, history, missing/unknown delivery, damaged-store independence and old-host setup cases. It compares the restored definitions with their original objects and asserts a stored-data fixture remains byte-identical. Existing `server/agent-tools.test.ts` retains the execution-safety cases and receives explicit support in its harness. These tests and typecheck have not run for this implementation. [unverified: run the two owning suites and `npm run typecheck` against the matching local SDK]
