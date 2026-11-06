# Datawise

A database client for [Paseo](https://paseo.sh). See [OVERVIEW.md](OVERVIEW.md) for what it does and its limits.

## Install

```bash
paseo plugin install /path/to/datawise
```

From a git remote, Paseo runs `npm ci --omit=dev --ignore-scripts` itself. For a directory install, run that first.

## Develop

```bash
npm install
npm run typecheck
npm test
paseo plugin reload datawise
```

Drivers are not bundled. Paseo's compiler breaks some of them, so `server/drivers.ts` loads each from the plugin's own `node_modules` on first use.

## Conformance tests

`scripts/conformance.ts` runs the plugin's real RPC handlers against real servers, on Electron's Node, the runtime the plugin gets inside Paseo. It includes attempts to write through read-only connections and values that lose precision if handled carelessly.

```bash
docker compose -f test/compose.yaml up -d
./scripts/conformance.sh sqlite postgres mysql mariadb redis mongodb clickhouse dynamodb
```

Heavy engines have a profile and limited memory. Start them one at a time.

```bash
docker compose -f test/compose.yaml --profile heavy up -d oracle
./scripts/conformance.sh oracle
```

Heavy spec names: `oracle`, `mssql`, `elasticsearch`, `opensearch`, `cassandra`, `neo4j`. Remove everything with:

```bash
docker compose -f test/compose.yaml --profile heavy down -v
```

## Adding an engine

Add a row to `shared/engines.ts`, an adapter implementing `server/adapters/types.ts`, an entry in `server/adapters/index.ts`, and a spec in `scripts/conformance.ts`. The client reads the engine table and needs no change.
