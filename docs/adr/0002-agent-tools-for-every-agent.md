# 0002. Every agent gets Datawise's tools; each call checks access

- Status: accepted
- Date: 2026-11-14
- Decided by: M, chat 2026-11-14 ("Approved, build it"), on the agent's proposal. M decided the inputs: open-tab works on any connection, and agent queries cover all 12 engines (chat 2026-11-14).
- Supersedes: none
- Related records: 0001, 0003
- Owner: the Datawise maintainer
- Stakeholders: M, and anyone whose agents run on a daemon with Datawise
- Review when: Paseo adds a way to offer a tool to some agents only, or an agent misuses a tool

## Context

- Today Datawise adds its four tools only while at least one connection shares names with agents. Adding or removing the hook makes open agent sessions reopen. [verified: `server/plugin.ts:117-125`; form text in `client/connections.tsx`]
- Every tool already checks access on each call and gives the same refusal whether a connection is missing, unshared, or not allowed. [verified: `server/agent-tool.ts:105-112`]

## Assumptions and unknowns

- Agents handle a refusal from a tool they were offered without retrying in a loop. Check: one scratch-agent run on a throwaway daemon, with M's OK before any real prompt.

## Decision drivers

1. An agent can open a tab on any connection (M's decision).
2. Nothing an agent does changes data without the person's approval (M's rule since v0.3.0).
3. No access beyond what each connection's levels allow.
4. Few moving parts.

## Options considered

| | Fixed list for every agent | Hook only while something is shared | Two hooks | One hook, list from an in-memory flag |
| --- | --- | --- | --- | --- |
| How it works | One hook, always declared; all tools always offered; each refuses unless the connection allows it | As today, plus the open-tab tool | Open-tab always; others as today | One hook always declared; adds the data tools when a flag, kept in memory on each save, says something is shared |
| Driver 1 | Yes | No: no tool until something is shared | Yes | Yes |
| Driver 2, 3 | Per-call checks, as today | Same | Same | Same |
| Driver 4 | Fewest; no session reopening on share changes | As today | Two hooks; reopening remains | One hook, but sessions opened before a share lack the tools until they reopen |
| What it gives up | Every agent sees 10 Datawise tools in its list | M's tab decision | Simplicity | A session opened earlier cannot use a new share, with no message saying why |

## Decision

Datawise declares its `agent.open.before` hook once at start and always adds the same tool list. Every tool checks the connection's levels on each call, as today. Which engines can be shared is decided separately, in 0003.

## Consequences

- Good: an agent can open any connection as a tab. Changing what is shared no longer makes agent sessions reopen.
- Bad: every agent session carries Datawise's tool descriptions, even with nothing shared. A hook that throws would stop every session from opening, so the handler must stay a constant with no I/O. An agent can tell whether a connection name exists from the open-tab answer.
- Can it be undone: yes, by restoring the conditional hook.

## Transition

Sessions pick up the tools at their next open. Rolling back to v0.5.0 restores the conditional hook.

## How we will know it is followed

A unit test asserts the hook's tool list is constant and that every tool refuses on an unshared connection.
