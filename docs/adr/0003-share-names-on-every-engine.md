# 0003. Agents may be given names and rows on every engine

- Status: accepted
- Date: 2026-11-14
- Decided by: M, chat 2026-11-14 ("Approved, build it"), on the agent's proposal. M decided the input: agent queries cover all 12 engines (chat 2026-11-14).
- Supersedes: the catalog rule recorded in `docs/2026-11-06-1525_customisation-and-advanced-features_plan.md:42`
- Related records: 0002
- Owner: the Datawise maintainer
- Stakeholders: M, and anyone who shares a schemaless connection with agents
- Review when: a person reports data reaching an agent through names

## Context

- Sharing names needs an engine with a catalog: the five SQL engines, ClickHouse and Cassandra. The store refuses any other. [verified: `server/agent-tool.ts:37-39`; `server/store.ts:169`; `shared/engines.ts`, `catalogSchema`]
- Sharing rows also needs transactional edits and a development or staging label, so only the five SQL engines. [verified: `shared/agent-access.ts:13-15`]
- The reason for the catalog rule: on MongoDB, DynamoDB and Neo4j, column names come from sampled records, and Redis object names are key names, so names can carry data. [verified: `docs/2026-11-06-1525_customisation-and-advanced-features_plan.md:42`]
- M chose agent queries on all 12 engines. [decided: M, chat 2026-11-14] Queries need row access, and row access needs names. [verified: `shared/agent-access.ts:19`]

## Assumptions and unknowns

- People read the sharing text before turning sharing on for a schemaless connection. No check settles this; the text is the control.

## Decision drivers

1. Agent queries on all 12 engines (M's decision).
2. A person knows what an agent can see before sharing.
3. Production stays closed to agents.

## Options considered

| | Allow on every engine, with text | Keep the catalog rule | Allow rows without names |
| --- | --- | --- | --- |
| How it works | Names and rows can be shared on all 12 engines; the form says where names come from | As today | Rows on every engine, names still refused on schemaless ones |
| Driver 1 | Yes | No: five engines get no queries | Partly: an agent cannot list what it may query |
| Driver 2 | Text in the form | n/a | Confusing: rows without the names that index them |
| Driver 3 | Kept | Kept | Kept |
| What it gives up | Names on schemaless engines may hold data | M's choice | Coherence |

## Decision

`agentMayRead` and `rowAccessPossible` no longer require a catalog or transactional edits, and the store stops refusing them. On engines without a catalog, the Agents section says: "Names here come from your data: collection, key, index or label names, and field names seen in recent records." Production and the development-or-staging rule for rows stay.

## Consequences

- Good: agents can list, read, query and propose queries on MongoDB, Redis, Elasticsearch, DynamoDB, Neo4j, ClickHouse and Cassandra. Row-level proposals (`datawise_propose_write`) stay on the five SQL engines, because they need transactions. [verified: `server/agent-tool.ts:212`]
- Bad: a names-only share on a schemaless engine can send data held in names (for example a Redis key `session:alice@example.com`) to the agent's provider.
- Can it be undone: yes, by restoring the rule; connections already shared would be refused on their next tool call.

## Transition

Rolling back to v0.5.0: its store refuses to save such a connection again, and its tools refuse such a connection, so access closes. The file keeps the values.

## How we will know it is followed

Unit tests for the access rules on all 12 engines, and the form text checked in the browser.
