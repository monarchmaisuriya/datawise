import type { EngineId } from "../../shared/engines";
import { createCassandra } from "./cassandra";
import { createClickhouse } from "./clickhouse";
import { createDynamodb } from "./dynamodb";
import { createElasticsearch } from "./elasticsearch";
import { createMongodb } from "./mongodb";
import { createMssql } from "./mssql";
import { createMysql } from "./mysql";
import { createNeo4j } from "./neo4j";
import { createOracle } from "./oracle";
import { createPostgres } from "./postgres";
import { createRedis } from "./redis";
import { createSqlite } from "./sqlite";
import type { AdapterFactory } from "./types";

export const ADAPTERS: Record<EngineId, AdapterFactory> = {
  postgres: createPostgres,
  mysql: createMysql,
  sqlite: createSqlite,
  mssql: createMssql,
  oracle: createOracle,
  clickhouse: createClickhouse,
  mongodb: createMongodb,
  redis: createRedis,
  elasticsearch: createElasticsearch,
  cassandra: createCassandra,
  dynamodb: createDynamodb,
  neo4j: createNeo4j,
};
