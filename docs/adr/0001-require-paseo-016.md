# 0001. Datawise requires Paseo 0.16

- Status: accepted
- Date: 2026-11-14
- Decided by: M, chat 2026-11-14 ("0.16 only"), confirmed the same day after the context below was corrected
- Supersedes: none
- Related records: 0002
- Owner: the Datawise maintainer
- Stakeholders: everyone who installs Datawise from the Paseo registry or from git
- Review when: Paseo 0.16 leaves beta, or a registry user on 0.15 asks for support

## Context

- Datawise declares `"requirements": { "paseo": ">=0.15.1" }` and builds against `@getpaseo/plugin` 0.15.1. [verified: `paseo-plugin.json`; `package.json:48`]
- An agent asked to open database tabs could not: no Paseo tool opens a plugin tab, and Datawise offers none. [verified: agent report quoted by M, 2026-11-14]
- A plugin's client can open its own workspace panel with `client.openPanel(id, { workspaceId })` on 0.15.1 already. [verified: `@getpaseo/plugin` 0.15.1 `dist/client/contracts.d.ts:136-139`, `:168`] An earlier draft of this record said otherwise; that was wrong.
- What is new in 0.16 is `client.subscribe(...)`, a live channel the server can push events down. [verified: 0.16.0-beta.2 `dist/client/contracts.d.ts:194-198`; no match in 0.15.1 `dist/rpc.d.ts`] On 0.15, the app would have to ask the server on a timer whether an agent wants a tab opened.
- Datawise typechecks against 0.16.0-beta.2 with no source changes. [verified: `tsc --noEmit` on both configs in a scratch copy, 2026-11-14]
- M runs Paseo 0.16.0-beta.2: the CLI [verified: `paseo --version`] and the desktop app [verified: `Paseo.app` Info.plist]. Other apps M uses are unknown.

## Assumptions and unknowns

- The 0.16 host's `openPanel` behaves in beta.2 as in the beta.1 source: it moves that client to the workspace and opens the panel. Check: call it from a throwaway daemon on beta.2 (Part 3).
- Whether the Paseo registry hides a version from hosts that do not meet its requirement. Check: read the registry's validation code or ask its maintainers before the pin PR.

## Decision drivers

1. Agents can open Datawise tabs (M's request).
2. One code path to keep true, not two.
3. Registry users on 0.15 keep working. M ranked this below 1 and 2.

## Options considered

| | Require 0.16 | Support both | Stay on 0.15, poll |
| --- | --- | --- | --- |
| How it works | Raise the requirement; the server pushes open requests over `subscribe` | Build on 0.16; detect `subscribe` at run time; poll on 0.15 | No version change; the app asks the server about every 3 s for open requests |
| Driver 1 | Yes, instantly | Yes | Yes, up to about 3 s late |
| Driver 2 | One path | Two paths and a feature check | One path, plus a timer in every open app |
| Driver 3 | 0.15 users cannot update | Kept | Kept |
| Why chosen or rejected | Chosen by M, twice | Rejected by M: more code for a beta-era audience | Rejected by M after the correction |

## Decision

Datawise declares `"paseo": ">=0.16.0-beta.2"`, builds against `@getpaseo/plugin` 0.16.0-beta.2, and uses 0.16 APIs without run-time checks. The registry pin for this version is held until Paseo 0.16 is available to registry users, unless M says otherwise.

## Consequences

- Good: the open-tab tool works the same way everywhere Datawise runs.
- Bad: a host on 0.15 cannot install this version, and an update attempt there fails. The last 0.15 version is v0.5.0.
- Bad: the requirement is checked for each Paseo app too, so a phone or desktop app below 0.16 shows no Datawise at all, including the approval view. [verified: Paseo source `packages/app/src/plugins/registry.ts:96`, `plugin-requirements.ts:21-40`]
- Can it be undone: yes. Revert the requirement and the tab feature in a later release; no stored data depends on 0.16.

## Transition

M's daemon updates from git as before. The registry keeps v0.5.0 until 0.16 is stable or M asks for the pin. Roll back by installing v0.5.0.

## How we will know it is followed

`paseo-plugin.json` names 0.16, and the release check rehearses a clean install on a 0.16 daemon.
