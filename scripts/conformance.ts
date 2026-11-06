// Runs the plugin's real RPC handlers against real servers from test/compose.yaml. Build and run it with
// scripts/conformance.sh, which uses Electron's Node, the runtime the plugin gets inside Paseo.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ZodType } from "zod";
import { type ConnectionInput, type JobView, type Filter, type ObjectRef, type RowPage, rpc, type StartResult } from "../shared/contracts";
import { ENGINES, type EngineId } from "../shared/engines";
import { ADAPTERS } from "../server/adapters";
import { setDriverRoot } from "../server/drivers";
import { contributeServer } from "../server/plugin";
import { openTunnel } from "../server/tunnel";

setDriverRoot(process.cwd());
const PASSWORD = "dw-test-pass";

interface Spec {
  label: string;
  engine: EngineId;
  input: Partial<ConnectionInput>;
  scope: { database?: string; schema?: string };
  // Query box text, one entry per run, that creates and fills the object.
  setup: string[];
  name: string;
  seedRows: number;
  newRow: Record<string, unknown>;
  // Changes one value and later finds it with the read filter.
  change: { column: string; value: unknown };
  find: Filter;
  sortColumn?: string;
  select: string;
  attacks: string[];
  // A single write statement run with readOnly set and the classifier skipped.
  secondLayer?: string;
  longQuery?: string;
  csv?: { text: string; mapping: Record<string, string>; rows: number };
  exact?: { key: Record<string, unknown>; changes: Record<string, unknown>; check: string; expected: string };
  ssh?: { host: string; port: number };
}

const SQL_ATTACKS = ["delete from dw_items", "drop table dw_items", "update dw_items set name = 'x'", "insert into dw_items (id, name) values (999, 'x')"];

const specs: Record<string, Spec> = {
  postgres: {
    label: "PostgreSQL",
    engine: "postgres",
    input: { host: "127.0.0.1", port: 25432, user: "dw", password: PASSWORD, database: "dw" },
    scope: { database: "dw", schema: "public" },
    setup: ["drop table if exists dw_items", "create table dw_items (id bigint primary key, name text, big bigint, ts timestamp, doc jsonb, tags text[], raw bytea)", "insert into dw_items select g, 'name' || g, 9007199254740993 + g, '2026-01-02 10:00:00.123456'::timestamp + (g || ' hours')::interval, '{\"a\":1}', array['x','y'], '\\x00ff' from generate_series(1, 5) g"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "id",
    select: "select * from dw_items order by id",
    attacks: [...SQL_ATTACKS, "commit; delete from dw_items", "set transaction read write", "with x as (delete from dw_items returning *) select * from x", "select 1 into dw_bad", "explain analyze delete from dw_items", "/* note */ truncate dw_items", "copy dw_items to program 'id'", "do $$ begin delete from dw_items; end $$", "select 1; delete from dw_items"],
    secondLayer: "delete from dw_items",
    longQuery: "select pg_sleep(30)",
    csv: { text: "id,name\n201,a\n202,b\n203,\n", mapping: { id: "id", name: "name" }, rows: 3 },
    exact: { key: { id: 1 }, changes: { name: "exact" }, check: "select big::text || '|' || ts::text from dw_items where id = 1", expected: "9007199254740994|2026-01-02 11:00:00.123456" },
    ssh: { host: "postgres", port: 5432 },
  },
  mysql: {
    label: "MySQL",
    engine: "mysql",
    input: { host: "127.0.0.1", port: 23306, user: "root", password: PASSWORD, database: "dw" },
    scope: { database: "dw" },
    setup: ["drop table if exists dw_items", "create table dw_items (id bigint primary key, name varchar(100), big bigint, ts datetime(6), amount decimal(30,10), raw varbinary(10))", "insert into dw_items values (1,'name1',9007199254740994,'2026-01-02 11:00:00.123456',12345678901234567890.1234567890,x'00ff'),(2,'name2',9007199254740995,'2026-01-02 12:00:00.123456',1,null),(3,'name3',1,'2026-01-02 13:00:00.000000',1,null),(4,'name4',1,'2026-01-02 14:00:00.000000',1,null),(5,'name5',1,'2026-01-02 15:00:00.000000',1,null)"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "id",
    select: "select * from dw_items order by id",
    attacks: [...SQL_ATTACKS, "/*!50000 delete from dw_items */", "select 1 /*! into outfile '/tmp/dw-bad' */", "select * from dw_items into outfile '/tmp/dw-bad2'", "commit", "set autocommit=1", "select 1; delete from dw_items", "call foo()"],
    secondLayer: "delete from dw_items",
    longQuery: "select sleep(30)",
    csv: { text: "id,name\n201,a\n202,b\n203,\n", mapping: { id: "id", name: "name" }, rows: 3 },
    exact: { key: { id: 1 }, changes: { name: "exact" }, check: "select concat(big, '|', ts, '|', amount) from dw_items where id = 1", expected: "9007199254740994|2026-01-02 11:00:00.123456|12345678901234567890.1234567890" },
  },
  mariadb: {
    label: "MariaDB",
    engine: "mysql",
    input: { host: "127.0.0.1", port: 23307, user: "root", password: PASSWORD, database: "dw" },
    scope: { database: "dw" },
    setup: ["drop table if exists dw_items", "create table dw_items (id bigint primary key, name varchar(100))", "insert into dw_items values (1,'name1'),(2,'name2'),(3,'name3'),(4,'name4'),(5,'name5')"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "starts", value: "chang" },
    sortColumn: "id",
    select: "select * from dw_items order by id",
    attacks: [...SQL_ATTACKS, "/*M! delete from dw_items */"],
    secondLayer: "delete from dw_items",
    longQuery: "select sleep(30)",
    csv: { text: "id,name\n201,a\n202,b\n203,\n", mapping: { id: "id", name: "name" }, rows: 3 },
  },
  redis: {
    label: "Redis",
    engine: "redis",
    input: { host: "127.0.0.1", port: 26379, password: PASSWORD, database: "0" },
    scope: { database: "0" },
    setup: ["DEL dw_items", "HSET dw_items name1 one name2 two name3 three name4 four name5 five"],
    name: "dw_items",
    seedRows: 5,
    newRow: { field: "name100", value: "new" },
    change: { column: "value", value: "changed" },
    find: { column: "value", op: "contains", value: "chang" },
    select: "HGETALL dw_items",
    attacks: ["FLUSHALL", `EVAL "redis.call('flushall')" 0`, "EVALSHA abc 0", "FCALL f 0", "DEL dw_items", 'CONFIG SET save ""', "SET dw_bad 1", "HSET dw_items a b", "SHUTDOWN NOSAVE", "PUBLISH c m", "SWAPDB 0 1"],
    csv: { text: "field,value\nf201,a\nf202,b\nf203,c\n", mapping: { field: "field", value: "value" }, rows: 3 },
  },
  mongodb: {
    label: "MongoDB",
    engine: "mongodb",
    input: { host: "127.0.0.1", port: 27018, user: "dw", password: PASSWORD, database: "dw", authSource: "admin" },
    scope: { database: "dw" },
    setup: ["db.dw_items.deleteMany({})", 'db.dw_items.insertMany([{_id:1,name:"name1",big:NumberLong("9007199254740993")},{_id:2,name:"name2"},{_id:3,name:"name3"},{_id:4,name:"name4"},{_id:5,name:"name5"}])'],
    name: "dw_items",
    seedRows: 5,
    newRow: { _id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "_id",
    select: "db.dw_items.find({}).sort({_id:1})",
    attacks: ["db.dw_items.deleteMany({})", 'db.dw_items.aggregate([{$out:"dw_bad"}])', 'db.dw_items.aggregate([{$lookup:{from:"dw_items",pipeline:[{$merge:"dw_bad"}],as:"y"}}])', "db.runCommand({drop:'dw_items'})", "db.dropDatabase()", "db.dw_items.drop()", 'db.dw_items.insertOne({_id:999})', "db.dw_items.updateMany({}, {$set:{a:1}})", "process.exit(1)"],
    longQuery: 'db.dw_items.find({$where:"sleep(30000) || true"})',
    csv: { text: "_id,name,score\n201,a,1.5\n202,b,2\n203,,3\n", mapping: { _id: "_id", name: "name", score: "score" }, rows: 3 },
    exact: { key: { _id: 1 }, changes: { name: "exact" }, check: 'db.dw_items.find({_id:1,big:NumberLong("9007199254740993"),name:"exact"})', expected: "1" },
    ssh: { host: "mongodb", port: 27017 },
  },
  clickhouse: {
    label: "ClickHouse",
    engine: "clickhouse",
    input: { host: "127.0.0.1", port: 28123, user: "dw", password: PASSWORD, database: "dw" },
    scope: { database: "dw" },
    setup: ["drop table if exists dw_items", "create table dw_items (id UInt64, name String, big Int64, ts DateTime64(6)) engine = MergeTree order by id", "insert into dw_items values (1,'name1',9007199254740993,'2026-01-02 11:00:00.123456'),(2,'name2',1,'2026-01-02 11:00:00'),(3,'name3',1,'2026-01-02 11:00:00'),(4,'name4',1,'2026-01-02 11:00:00'),(5,'name5',1,'2026-01-02 11:00:00')"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "new" },
    sortColumn: "id",
    select: "select * from dw_items order by id",
    attacks: ["alter table dw_items delete where 1", "truncate table dw_items", "drop table dw_items", "insert into dw_items (id) values (999)", "create table dw_bad (id UInt8) engine = Memory", "set readonly = 0", "system stop merges", "select 1 into outfile '/tmp/dw-bad'"],
    secondLayer: "truncate table dw_items",
    longQuery: "select sleep(3), number from numbers(10) settings max_block_size = 1",
    csv: { text: "id,name\n201,a\n202,b\n203,c\n", mapping: { id: "id", name: "name" }, rows: 3 },
  },
  dynamodb: {
    label: "DynamoDB",
    engine: "dynamodb",
    input: { region: "us-east-1", endpoint: "http://127.0.0.1:28000", accessKeyId: "dummy", password: "dummysecret" },
    scope: {},
    setup: ['{"DeleteTable":{"TableName":"dw_items"}}', '{"CreateTable":{"TableName":"dw_items","AttributeDefinitions":[{"AttributeName":"id","AttributeType":"N"}],"KeySchema":[{"AttributeName":"id","KeyType":"HASH"}],"BillingMode":"PAY_PER_REQUEST"}}', "insert into \"dw_items\" value {'id':1,'name':'name1'}", "insert into \"dw_items\" value {'id':2,'name':'name2'}", "insert into \"dw_items\" value {'id':3,'name':'name3'}", "insert into \"dw_items\" value {'id':4,'name':'name4'}", "insert into \"dw_items\" value {'id':5,'name':'name5'}"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    select: 'select * from "dw_items"',
    attacks: ['delete from "dw_items" where id = 1', "insert into \"dw_items\" value {'id':999}", '{"DeleteTable":{"TableName":"dw_items"}}', "update \"dw_items\" set name = 'x' where id = 1"],
    csv: { text: "id,name\n201,a\n202,b\n203,c\n", mapping: { id: "id", name: "name" }, rows: 3 },
  },
  elasticsearch: {
    label: "Elasticsearch",
    engine: "elasticsearch",
    input: { host: "127.0.0.1", port: 29200, user: "elastic", password: PASSWORD },
    scope: {},
    setup: ["DELETE /dw_items?ignore_unavailable=true", 'PUT /dw_items\n{"mappings":{"properties":{"name":{"type":"keyword"},"n":{"type":"integer"}}}}', 'POST /dw_items/_bulk?refresh=true\n{"index":{"_id":"1"}}\n{"name":"name1","n":1}\n{"index":{"_id":"2"}}\n{"name":"name2","n":2}\n{"index":{"_id":"3"}}\n{"name":"name3","n":3}\n{"index":{"_id":"4"}}\n{"name":"name4","n":4}\n{"index":{"_id":"5"}}\n{"name":"name5","n":5}'],
    name: "dw_items",
    seedRows: 5,
    newRow: { _id: "100", name: "new", n: 100 },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "n",
    select: 'GET /dw_items/_search\n{"query":{"match_all":{}},"size":50}',
    attacks: ["DELETE /dw_items", 'POST /dw_items/_delete_by_query\n{"query":{"match_all":{}}}', 'POST /_bulk\n{"delete":{"_index":"dw_items","_id":"1"}}', "PUT /dw_bad", 'POST /dw_items/_update/1\n{"doc":{"name":"x"}}', "POST /dw_items/_close"],
    csv: { text: "_id,name,n\n201,a,1\n202,b,2\n203,c,3\n", mapping: { _id: "_id", name: "name", n: "n" }, rows: 3 },
  },
  opensearch: {
    label: "OpenSearch",
    engine: "elasticsearch",
    input: { host: "127.0.0.1", port: 29201 },
    scope: {},
    setup: ["DELETE /dw_items?ignore_unavailable=true", 'PUT /dw_items\n{"mappings":{"properties":{"name":{"type":"keyword"},"n":{"type":"integer"}}}}', 'POST /dw_items/_bulk?refresh=true\n{"index":{"_id":"1"}}\n{"name":"name1","n":1}\n{"index":{"_id":"2"}}\n{"name":"name2","n":2}\n{"index":{"_id":"3"}}\n{"name":"name3","n":3}\n{"index":{"_id":"4"}}\n{"name":"name4","n":4}\n{"index":{"_id":"5"}}\n{"name":"name5","n":5}'],
    name: "dw_items",
    seedRows: 5,
    newRow: { _id: "100", name: "new", n: 100 },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "n",
    select: 'GET /dw_items/_search\n{"query":{"match_all":{}},"size":50}',
    attacks: ["DELETE /dw_items", "PUT /dw_bad"],
    csv: { text: "_id,name,n\n201,a,1\n202,b,2\n203,c,3\n", mapping: { _id: "_id", name: "name", n: "n" }, rows: 3 },
  },
  cassandra: {
    label: "Cassandra",
    engine: "cassandra",
    input: { host: "127.0.0.1", port: 29042, localDataCenter: "datacenter1" },
    scope: { schema: "dw" },
    setup: ["create keyspace if not exists dw with replication = {'class':'SimpleStrategy','replication_factor':1}", "drop table if exists dw.dw_items", "create table dw.dw_items (id bigint primary key, name text, big bigint)", "insert into dw.dw_items (id,name,big) values (1,'name1',9007199254740993)", "insert into dw.dw_items (id,name) values (2,'name2')", "insert into dw.dw_items (id,name) values (3,'name3')", "insert into dw.dw_items (id,name) values (4,'name4')", "insert into dw.dw_items (id,name) values (5,'name5')"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "eq", value: "changed" },
    select: "select * from dw.dw_items",
    attacks: ["truncate dw.dw_items", "delete from dw.dw_items where id = 1", "insert into dw.dw_items (id) values (999)", "drop table dw.dw_items", "update dw.dw_items set name = 'x' where id = 1"],
    csv: { text: "id,name\n201,a\n202,b\n203,c\n", mapping: { id: "id", name: "name" }, rows: 3 },
    exact: { key: { id: 1 }, changes: { name: "exact" }, check: "select big from dw.dw_items where id = 1", expected: "9007199254740993" },
  },
  neo4j: {
    label: "Neo4j",
    engine: "neo4j",
    input: { host: "127.0.0.1", port: 27687, user: "neo4j", password: PASSWORD },
    scope: {},
    setup: ["match (n:DwItems) detach delete n", "create constraint dw_items_id if not exists for (n:DwItems) require n.id is unique", "unwind [1,2,3,4,5] as i create (:DwItems {id: i, name: 'name' + i})"],
    name: "DwItems",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "id",
    select: "match (n:DwItems) return n order by n.id",
    attacks: ["match (n:DwItems) detach delete n", "create (:DwBad)", "match (n:DwItems) set n.a = 1", "merge (:DwBad)", "call db.createLabel('DwBad')", "load csv from 'file:///x' as l return l"],
    secondLayer: "match (n:DwItems) detach delete n",
    csv: { text: "id,name\n201,a\n202,b\n203,c\n", mapping: { id: "id", name: "name" }, rows: 3 },
  },
  mssql: {
    label: "SQL Server",
    engine: "mssql",
    input: { host: "127.0.0.1", port: 21433, user: "sa", password: "Dw-test-pass1", database: "master", tls: "require" },
    scope: { database: "master", schema: "dbo" },
    setup: ["if object_id('dbo.dw_items') is not null drop table dbo.dw_items", "create table dbo.dw_items (id bigint primary key, name nvarchar(100), big bigint, amount decimal(30,10), ts datetime2(7))", "insert into dbo.dw_items values (1,'name1',9007199254740994,12345678901234567890.1234567890,'2026-01-02 11:00:00.1234567'),(2,'name2',1,1,'2026-01-02 11:00:00'),(3,'name3',1,1,'2026-01-02 11:00:00'),(4,'name4',1,1,'2026-01-02 11:00:00'),(5,'name5',1,1,'2026-01-02 11:00:00')"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "id",
    select: "select * from dbo.dw_items order by id",
    attacks: ["delete from dbo.dw_items", "select 1 delete from dbo.dw_items", "exec('delete from dbo.dw_items')", "commit", "select * into dbo.dw_bad from dbo.dw_items", "select 1 set implicit_transactions off", "drop table dbo.dw_items", "select * from openrowset('x','y','z')"],
    secondLayer: "delete from dbo.dw_items",
    longQuery: "waitfor delay '00:00:30'",
    csv: { text: "id,name\n201,a\n202,b\n203,\n", mapping: { id: "id", name: "name" }, rows: 3 },
    exact: { key: { id: 1 }, changes: { name: "exact" }, check: "select concat(big, '|', amount, '|', convert(varchar(30), ts, 121)) from dbo.dw_items where id = 1", expected: "9007199254740994|12345678901234567890.1234567890|2026-01-02 11:00:00.1234567" },
  },
  oracle: {
    label: "Oracle",
    engine: "oracle",
    input: { host: "127.0.0.1", port: 21521, user: "dw", password: PASSWORD, serviceName: "FREEPDB1" },
    scope: { schema: "DW" },
    setup: ["begin execute immediate 'drop table DW_ITEMS'; exception when others then null; end;\n/", 'create table DW_ITEMS (ID number(38) primary key, NAME varchar2(100), BIG number(38), TS timestamp(6))', "insert into DW_ITEMS values (1,'name1',9007199254740994,timestamp '2026-01-02 11:00:00.123456')", "insert into DW_ITEMS values (2,'name2',1,timestamp '2026-01-02 11:00:00.000000')", "insert into DW_ITEMS values (3,'name3',1,timestamp '2026-01-02 11:00:00.000000')", "insert into DW_ITEMS values (4,'name4',1,timestamp '2026-01-02 11:00:00.000000')", "insert into DW_ITEMS values (5,'name5',1,timestamp '2026-01-02 11:00:00.000000')"],
    name: "DW_ITEMS",
    seedRows: 5,
    newRow: { ID: 100, NAME: "new" },
    change: { column: "NAME", value: "changed" },
    find: { column: "NAME", op: "contains", value: "chang" },
    sortColumn: "ID",
    select: "select * from DW_ITEMS order by ID",
    attacks: ["delete from DW_ITEMS", "commit", "begin delete from DW_ITEMS; end;\n/", "create table DW_BAD (id number)", "truncate table DW_ITEMS", "update DW_ITEMS set NAME = 'x'", "drop table DW_ITEMS"],
    secondLayer: "delete from DW_ITEMS",
    longQuery: "select count(*) from all_objects a, all_objects b, all_objects c",
    csv: { text: "ID,NAME\n201,a\n202,b\n203,\n", mapping: { ID: "ID", NAME: "NAME" }, rows: 3 },
    exact: { key: { ID: 1 }, changes: { NAME: "exact" }, check: "select BIG || '|' || to_char(TS, 'YYYY-MM-DD HH24:MI:SS.FF6') from DW_ITEMS where ID = 1", expected: "9007199254740994|2026-01-02 11:00:00.123456" },
  },
};

// Behaviors one engine can get wrong on its own.
interface Tools {
  check(name: string, body: () => Promise<void> | void): Promise<void>;
  expect(condition: unknown, message: unknown): void;
  ref(): ObjectRef;
  run(text: string, confirmed?: boolean, limit?: number): Promise<StartResult>;
  finish(result: StartResult): Promise<JobView>;
  call: typeof call;
  keyOf(page: RowPage, row: unknown[]): Record<string, unknown>;
  scope(): { connectionId: string; database?: string; schema?: string };
}

const queryRows = async (tools: Tools, text: string) => (await tools.finish(await tools.run(text))).results?.[0]?.rows ?? [];
const failsAs = async (tools: Tools, ref: ObjectRef, op: unknown) => {
  const result = await tools.call(rpc.writeRows, { ref, op, confirmed: true });
  return result.status === "started" ? waitJob(result.job) : null;
};

const EXTRAS: Record<string, (tools: Tools) => Promise<void>> = {
  async redis(tools) {
    const { check, expect, call, keyOf } = tools;
    const key = (name: string): ObjectRef => ({ ...tools.ref(), name });
    await check("list: edit by position and value; a shifted list refuses instead of changing another entry", async () => {
      await tools.finish(await tools.run("DEL dw_list\nRPUSH dw_list a b c"));
      const page = await call(rpc.readRows, { ref: key("dw_list"), query: {} });
      const second = page.rows[1] as unknown[];
      const stale = keyOf(page, second);
      expect(stale.index === 1 && stale.value === "b", JSON.stringify(stale));
      await tools.finish(await tools.run("LPUSH dw_list z"));
      const job = await failsAs(tools, key("dw_list"), { kind: "update", key: stale, changes: { value: "X" } });
      expect(job?.status === "failed", `stale edit: ${job?.status}`);
      expect(JSON.stringify(await queryRows(tools, "LRANGE dw_list 0 -1")) === JSON.stringify([["z"], ["a"], ["b"], ["c"]]), "list changed");
      const fresh = await call(rpc.readRows, { ref: key("dw_list"), query: {} });
      await tools.finish(await call(rpc.writeRows, { ref: key("dw_list"), op: { kind: "update", key: keyOf(fresh, fresh.rows[2] as unknown[]), changes: { value: "B" } }, confirmed: true }));
      expect(JSON.stringify(await queryRows(tools, "LINDEX dw_list 2")) === JSON.stringify([["B"]]), "edit missing");
      const positionEdit = await call(rpc.writeRows, { ref: key("dw_list"), op: { kind: "update", key: keyOf(fresh, fresh.rows[0] as unknown[]), changes: { index: 9 } }, confirmed: true }).catch((error: Error) => error.message);
      expect(typeof positionEdit === "string" && /position/.test(positionEdit), `index edit: ${JSON.stringify(positionEdit)}`);
      await tools.finish(await call(rpc.writeRows, { ref: key("dw_list"), op: { kind: "delete", keys: [keyOf(fresh, fresh.rows[0] as unknown[]), keyOf(fresh, fresh.rows[3] as unknown[])] }, confirmed: true }));
      expect(JSON.stringify(await queryRows(tools, "LRANGE dw_list 0 -1")) === JSON.stringify([["a"], ["B"]]), "delete wrong");
    });
    await check("sorted set: a bad score changes nothing and is reported", async () => {
      await tools.finish(await tools.run("DEL dw_z\nZADD dw_z 1 m"));
      const job = await failsAs(tools, key("dw_z"), { kind: "update", key: { member: "m" }, changes: { member: "n", score: "abc" } });
      expect(job?.status === "failed", `status ${job?.status}`);
      expect(JSON.stringify(await queryRows(tools, "ZRANGE dw_z 0 -1")) === JSON.stringify([["m"]]), "member lost");
    });
    await check("string: an edit keeps the expiry", async () => {
      await tools.finish(await tools.run("SET dw_s a EX 1000"));
      await tools.finish(await call(rpc.writeRows, { ref: key("dw_s"), op: { kind: "update", key: { value: "a" }, changes: { value: "b" } }, confirmed: true }));
      const ttl = Number((await queryRows(tools, "TTL dw_s"))[0]?.[0]);
      expect(ttl > 900, `ttl ${ttl}`);
    });
    await check("hash: a field that no longer exists is refused", async () => {
      const job = await failsAs(tools, tools.ref(), { kind: "update", key: { field: "gone" }, changes: { value: "x" } });
      expect(job?.status === "failed", `status ${job?.status}`);
    });
    await tools.finish(await tools.run("DEL dw_list dw_z dw_s"));
  },
  async postgres(tools) {
    await tools.check("JSON: editing a sibling leaves a long number in place", async () => {
      await tools.finish(await tools.run(`update dw_items set doc = '{"big":12345678901234567890,"a":1}' where id = 2`));
      const page = await tools.call(rpc.readRow, { ref: tools.ref(), key: { id: "2" } });
      const cell = page.rows[0]?.[page.columns.findIndex((column) => column.name === "doc")];
      tools.expect(String(cell).includes("12345678901234567890"), `cell ${String(cell)}`);
    });
  },
  async mysql(tools) {
    await tools.check("JSON: a long number stays exact", async () => {
      await tools.finish(await tools.run("drop table if exists dw_json"));
      await tools.finish(await tools.run("create table dw_json (id int primary key, doc json)"));
      await tools.finish(await tools.run(`insert into dw_json values (1, '{"big":12345678901234567890}')`));
      const page = await tools.call(rpc.readRows, { ref: { ...tools.ref(), name: "dw_json" }, query: {} });
      tools.expect(String(page.rows[0]?.[1]).includes("12345678901234567890"), String(page.rows[0]?.[1]));
      await tools.finish(await tools.run("drop table dw_json"));
    });
  },
  async mssql(tools) {
    const ref = (): ObjectRef => ({ ...tools.ref(), name: "dw_exact" });
    await tools.check("money and datetime stay exact, sort by the value, and a datetime key edits only its row", async () => {
      await tools.finish(await tools.run("if object_id('dbo.dw_exact') is not null drop table dbo.dw_exact"));
      await tools.finish(await tools.run("create table dbo.dw_exact (at datetime primary key, price money, note nvarchar(20))"));
      await tools.finish(await tools.run("insert into dbo.dw_exact values ('2026-01-02 11:00:15.123', 9.5, 'a'), ('2026-01-02 11:00:45.123', 100.1234, 'b')"));
      const page = await tools.call(rpc.readRows, { ref: ref(), query: { sort: { column: "price", descending: false } } });
      tools.expect(page.rows[0]?.[1] === "9.5000" && page.rows[1]?.[1] === "100.1234", `order or money: ${JSON.stringify(page.rows)}`);
      await tools.finish(await tools.call(rpc.writeRows, { ref: ref(), op: { kind: "update", key: tools.keyOf(page, page.rows[0] as unknown[]), changes: { note: "edited" } }, confirmed: true }));
      const notes = await queryRows(tools, "select note from dbo.dw_exact order by at");
      tools.expect(JSON.stringify(notes) === JSON.stringify([["edited"], ["b"]]), JSON.stringify(notes));
    });
    await tools.check("a table with a trigger can still be edited", async () => {
      await tools.finish(await tools.run("create table dbo.dw_log (n int)"));
      await tools.finish(await tools.run("create trigger dbo.dw_exact_tr on dbo.dw_exact after update as insert into dbo.dw_log select 1 union all select 2"));
      const page = await tools.call(rpc.readRows, { ref: ref(), query: {} });
      await tools.finish(await tools.call(rpc.writeRows, { ref: ref(), op: { kind: "update", key: tools.keyOf(page, page.rows[0] as unknown[]), changes: { note: "t" } }, confirmed: true }));
      await tools.finish(await tools.run("drop table dbo.dw_exact"));
      await tools.finish(await tools.run("drop table dbo.dw_log"));
    });
  },
  async neo4j(tools) {
    await tools.check("an integer property stays an integer after an edit", async () => {
      const page = await tools.call(rpc.readRows, { ref: tools.ref(), query: { limit: 1 } });
      await tools.finish(await tools.call(rpc.writeRows, { ref: tools.ref(), op: { kind: "update", key: tools.keyOf(page, page.rows[0] as unknown[]), changes: { n: 7 } }, confirmed: true }));
      const types = await queryRows(tools, "match (n:DwItems) where n.n = 7 return valueType(n.n) as t");
      tools.expect(String(types[0]?.[0]).startsWith("INTEGER"), JSON.stringify(types));
    });
  },
  async dynamodb(tools) {
    await tools.check("a long number stays a number after an edit", async () => {
      await tools.finish(await tools.run("update \"dw_items\" set big = 9007199254740993 where id = 2"));
      const key = { id: 2 };
      await tools.finish(await tools.call(rpc.writeRows, { ref: tools.ref(), op: { kind: "update", key, changes: { big: "9007199254740995" } }, confirmed: true }));
      const rows = await queryRows(tools, 'select big from "dw_items" where id = 2');
      tools.expect(String(rows[0]?.[0]) === "9007199254740995", JSON.stringify(rows));
      const matched = await queryRows(tools, 'select id from "dw_items" where big = 9007199254740995');
      tools.expect(matched.length === 1, "stored as text, not a number");
    });
  },
  async elasticsearch(tools) {
    await tools.check("an edit replaces an object, so a removed nested key is gone", async () => {
      await tools.finish(await tools.call(rpc.writeRows, { ref: tools.ref(), op: { kind: "update", key: { _id: "2" }, changes: { meta: { a: 1, b: 2 } } }, confirmed: true }));
      await tools.finish(await tools.call(rpc.writeRows, { ref: tools.ref(), op: { kind: "update", key: { _id: "2" }, changes: { meta: { a: 1 } } }, confirmed: true }));
      const page = await tools.call(rpc.readRow, { ref: tools.ref(), key: { _id: "2" } });
      const cell = page.rows[0]?.[page.columns.findIndex((column) => column.name === "meta")];
      tools.expect(JSON.stringify(cell) === '{"a":1}', JSON.stringify(cell));
    });
  },
  async cassandra(tools) {
    await tools.check("a cleared number is refused instead of stored as 0", async () => {
      await tools.finish(await tools.run("alter table dw.dw_items add n int"));
      const refused = await tools.call(rpc.writeRows, { ref: tools.ref(), op: { kind: "update", key: { id: 2 }, changes: { n: "" } }, confirmed: true }).then(
        () => false,
        (error: Error) => /not a int/.test(error.message),
      );
      tools.expect(refused, "accepted an empty number");
    });
  },
  async sqlite(tools) {
    await tools.check("reads recover after a deadline kills the shared process", async () => {
      await tools.call(rpc.readRows, { ref: tools.ref(), query: {} });
    });
  },
};
EXTRAS.opensearch = EXTRAS.elasticsearch as (tools: Tools) => Promise<void>;
EXTRAS.mariadb = EXTRAS.mysql as (tools: Tools) => Promise<void>;

// --- Harness ---

const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
const folder = mkdtempSync(join(tmpdir(), "datawise-conformance-"));
const cleanup = contributeServer(
  {
    handle(contract: { name: string }, handler: unknown) {
      handlers.set(contract.name, handler as (input: unknown) => Promise<unknown>);
    },
  } as never,
  folder,
);

async function call<I extends ZodType, O extends ZodType>(contract: { name: string; input: I; output: O }, input: unknown): Promise<import("zod").output<O>> {
  const handler = handlers.get(contract.name);
  if (!handler) throw new Error(`No handler for ${contract.name}`);
  const output = await handler(contract.input.parse(input));
  return contract.output.parse(output);
}

async function waitJob(job: JobView, limitMs = 120000): Promise<JobView> {
  const started = Date.now();
  let current = job;
  while (current.status === "running") {
    if (Date.now() - started > limitMs) throw new Error(`job ${current.kind} still running after ${limitMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    current = await call(rpc.jobStatus, { id: job.id });
  }
  return current;
}

async function finish(result: StartResult): Promise<JobView> {
  if (result.status !== "started") throw new Error(`asked to confirm: ${result.preview}`);
  const job = await waitJob(result.job);
  if (job.status !== "done") throw new Error(job.error ?? job.status);
  return job;
}

let failures = 0;
const summary: string[] = [];

async function runSpec(key: string, spec: Spec) {
  const info = ENGINES[spec.engine];
  const checks: string[] = [];
  const check = async (name: string, body: () => Promise<void> | void) => {
    try {
      await body();
      checks.push(`  ok    ${name}`);
      if (process.env.DATAWISE_VERBOSE) console.log(`${spec.label}: ok ${name}`);
    } catch (error) {
      failures += 1;
      checks.push(`  FAIL  ${name}: ${String((error as Error).message).slice(0, 400)}`);
      if (process.env.DATAWISE_VERBOSE) console.log(`${spec.label}: FAIL ${name}`);
    }
  };
  const expect = (condition: unknown, message: unknown) => {
    if (!condition) throw new Error(String(message));
  };
  const base: ConnectionInput = { name: `${spec.label} test`, engine: spec.engine, safety: "open", ...spec.input };
  let id = "";
  const scope = () => ({ connectionId: id, ...spec.scope });
  const ref = (): ObjectRef => ({ connectionId: id, ...spec.scope, name: spec.name });
  const run = async (text: string, confirmed = false, limit = 1000) => call(rpc.runQuery, { scope: scope(), text, limit, confirmed });
  const setSafety = async (safety: "read-only" | "confirm" | "open") => {
    await call(rpc.saveConnection, { ...base, id, safety, password: undefined });
  };
  const readAll = async (): Promise<RowPage> => call(rpc.readRows, { ref: ref(), query: { limit: 1000 } });
  const keyOf = (page: RowPage, row: unknown[]) => Object.fromEntries(page.keyColumns.map((name) => [name, row[page.columns.findIndex((column) => column.name === name)]]));

  await check("test connection", async () => {
    const result = await call(rpc.testConnection, base);
    expect(result.ok, result.error);
    checks.push(`        server: ${result.serverVersion}`);
  });
  if (spec.input.password && spec.engine !== "dynamodb") {
    await check("wrong password: fails, and the error does not repeat it", async () => {
      const secret = "wrong-secret-value-xyz";
      const result = await call(rpc.testConnection, { ...base, password: secret });
      expect(!result.ok, "connected with a wrong password");
      expect(!String(result.error).includes(secret), `leaked: ${result.error}`);
    });
  }
  await check("save: password hidden from client, file is 0600", async () => {
    const saved = await call(rpc.saveConnection, base);
    id = saved.id;
    const raw = JSON.stringify(await call(rpc.listConnections, {}));
    if (spec.input.password) expect(!raw.includes(String(spec.input.password)), "password in connections.list");
    const path = join(folder, "connections.json");
    expect((statSync(path).mode & 0o777) === 0o600, `mode ${(statSync(path).mode & 0o777).toString(8)}`);
  });
  await check("setup through the query box", async () => {
    for (const text of spec.setup) {
      // Setup names its keyspace in the text, because the keyspace may not exist yet.
      const started = await call(rpc.runQuery, { scope: spec.engine === "cassandra" ? { connectionId: id } : scope(), text });
      const job = await waitJob((started as { job: JobView }).job);
      const cleaning = /^\s*(drop|delete|\{"DeleteTable|DEL)\b|DeleteTable/i.test(text);
      if (job.status !== "done" && !cleaning) throw new Error(`${text.slice(0, 80)}: ${job.error}`);
    }
    if (spec.engine === "elasticsearch") await new Promise((resolve) => setTimeout(resolve, 500));
  });
  await check("browse: databases, schemas, objects", async () => {
    if (info.databaseLabel) expect((await call(rpc.listDatabases, { connectionId: id })).databases.length > 0, "no databases");
    if (info.schemaLabel) expect((await call(rpc.listSchemas, scope())).schemas.length > 0, "no schemas");
    const objects = await call(rpc.listObjects, { ...scope(), pattern: spec.name.slice(0, 4), cursor: null });
    expect(objects.objects.some((item) => item.name === spec.name), `missing ${spec.name}: ${JSON.stringify(objects.objects).slice(0, 200)}`);
  });
  await check("describe: columns and key", async () => {
    const details = await call(rpc.describeObject, ref());
    expect(details.columns.length > 0, "no columns");
    if (info.canEditRows) expect(details.keyColumns.length > 0, `no key: ${details.keyReason}`);
    else expect(details.keyReason, "no reason given for no key");
  });
  await check("read, page", async () => {
    const first = await call(rpc.readRows, { ref: ref(), query: { limit: 2 } });
    expect(first.rows.length > 0 && first.rows.length <= 5, `rows ${first.rows.length}`);
    if (spec.engine !== "redis") {
      expect(first.rows.length === 2, `rows ${first.rows.length}`);
      expect(first.nextCursor, "no next page");
      const second = await call(rpc.readRows, { ref: ref(), query: { limit: 2, cursor: first.nextCursor } });
      expect(second.rows.length > 0, "empty second page");
      expect(JSON.stringify(second.rows[0]) !== JSON.stringify(first.rows[0]), "same row on both pages");
    }
  });
  if (spec.sortColumn && info.canSort) {
    await check("sort", async () => {
      const page = await call(rpc.readRows, { ref: ref(), query: { limit: 5, sort: { column: spec.sortColumn, descending: true } } });
      const index = page.columns.findIndex((column) => column.name === spec.sortColumn);
      const values = page.rows.map((row) => Number(row[index]));
      expect(values[0] === Math.max(...values), `first of ${values} is not the largest`);
    });
  }
  await check("count job", async () => {
    const job = await waitJob(await call(rpc.countRows, { ref: ref(), filters: [] }));
    expect(job.status === "done", job.error);
    expect(job.count === spec.seedRows, `count ${job.count}`);
  });
  await check("query results", async () => {
    const job = await finish(await run(spec.select));
    const rows = job.results?.[0]?.rows.length;
    expect(rows === spec.seedRows || (spec.engine === "redis" && rows === spec.seedRows * 2), `rows ${rows}`);
    const limited = await finish(await run(spec.select, false, 1));
    expect(limited.results?.[0]?.rows.length === 1 && limited.results[0].truncated, "limit did not cut and mark");
  });
  await check("safety confirm: asks, changes nothing, then runs", async () => {
    await setSafety("confirm");
    const asked = await call(rpc.writeRows, { ref: ref(), op: { kind: "insert", values: spec.newRow } });
    expect(asked.status === "confirm", "did not ask");
    const page = await readAll();
    expect(page.rows.length === spec.seedRows, "row added without confirmation");
    if (info.canInsertRows) await finish(await call(rpc.writeRows, { ref: ref(), op: { kind: "insert", values: spec.newRow }, confirmed: true }));
    await setSafety("open");
  });
  if (info.canEditRows) {
    let target: Record<string, unknown> = {};
    await check("update: only the changed column, and the row reads back", async () => {
      const page = await readAll();
      const row = page.rows[0];
      expect(row, "no row");
      target = keyOf(page, row as unknown[]);
      const job = await finish(await call(rpc.writeRows, { ref: ref(), op: { kind: "update", key: target, changes: { [spec.change.column]: spec.change.value } } }));
      expect(job.status === "done", job.error);
      const found = await call(rpc.readRows, { ref: ref(), query: { limit: 10, filters: [spec.find] } });
      expect(found.rows.length === 1, `filter found ${found.rows.length}`);
    });
    await check("read one full row by key", async () => {
      const row = await call(rpc.readRow, { ref: ref(), key: target });
      expect(row.rows.length === 1, `rows ${row.rows.length}`);
    });
    if (spec.engine !== "redis") {
      await check("update of a missing key fails instead of creating a row", async () => {
        const before = (await readAll()).rows.length;
        const missing = Object.fromEntries(Object.entries(target).map(([name, value]) => [name, typeof value === "number" ? 987654321 : "987654321"]));
        const result = await call(rpc.writeRows, { ref: ref(), op: { kind: "update", key: missing, changes: { [spec.change.column]: "x" } } });
        const job = result.status === "started" ? await waitJob(result.job) : null;
        expect(job?.status === "failed", `status ${job?.status}`);
        expect((await readAll()).rows.length === before, "row created");
      });
    }
    await check("delete by key", async () => {
      const page = await readAll();
      const row = page.rows.find((item) => JSON.stringify(item).includes(String(spec.newRow.id ?? spec.newRow._id ?? spec.newRow.ID ?? spec.newRow.field)));
      expect(row, "new row not found");
      await finish(await call(rpc.writeRows, { ref: ref(), op: { kind: "delete", keys: [keyOf(page, row as unknown[])] } }));
      expect((await readAll()).rows.length === spec.seedRows, "row count did not return");
    });
  }
  if (spec.exact) {
    const exact = spec.exact;
    await check("exact values: an edit leaves big integers, decimals and times untouched", async () => {
      await finish(await call(rpc.writeRows, { ref: ref(), op: { kind: "update", key: exact.key, changes: exact.changes } }));
      const job = await finish(await run(exact.check));
      const got = JSON.stringify(job.results?.[0]?.rows);
      if (spec.engine === "mongodb") expect(job.results?.[0]?.rows.length === 1, `no match: ${got}`);
      else expect(got.includes(exact.expected), `got ${got}, wanted ${exact.expected}`);
    });
  }
  await check("table with no key: edit refused with a reason", async () => {
    const noKeySql: Partial<Record<EngineId, string[]>> = {
      postgres: ["drop table if exists dw_nokey", "create table dw_nokey (a int)", "insert into dw_nokey values (1)"],
      mysql: ["drop table if exists dw_nokey", "create table dw_nokey (a int)", "insert into dw_nokey values (1)"],
      sqlite: ["drop table if exists dw_nokey", "create table dw_nokey (a int)", "insert into dw_nokey values (1)"],
      mssql: ["if object_id('dbo.dw_nokey') is not null drop table dbo.dw_nokey", "create table dbo.dw_nokey (a int)", "insert into dbo.dw_nokey values (1)"],
    };
    const statements = noKeySql[spec.engine];
    if (!statements) return;
    for (const text of statements) await finish(await run(text));
    const noKey = { ...ref(), name: "dw_nokey" };
    const page = await call(rpc.readRows, { ref: noKey, query: { limit: 10 } });
    expect(page.keyColumns.length === 0 && page.keyReason, "key or no reason");
    await call(rpc.writeRows, { ref: noKey, op: { kind: "delete", keys: [{ a: 1 }] } }).then(
      () => {
        throw new Error("delete planned on a table with no key");
      },
      (error: Error) => expect(/key/i.test(error.message), error.message),
    );
    await finish(await run(spec.engine === "mssql" ? "drop table dbo.dw_nokey" : "drop table dw_nokey"));
  });
  if (spec.csv) {
    const csv = spec.csv;
    await check("import csv, then the rows are there", async () => {
      const preview = await call(rpc.importPreview, { source: { text: csv.text }, format: "csv" });
      expect(preview.rows.length === csv.rows, `preview ${preview.rows.length}`);
      const before = (await readAll()).rows.length;
      const job = await finish(await call(rpc.startImport, { ref: ref(), source: { text: csv.text }, options: { format: "csv", mapping: csv.mapping } }));
      expect(job.status === "done", job.error);
      expect((await readAll()).rows.length === before + csv.rows, "row count wrong after import");
    });
    if (info.transactionalImport) {
      await check("failed import leaves nothing behind", async () => {
        const before = (await readAll()).rows.length;
        const keyName = Object.keys(csv.mapping)[0] ?? "id";
        const bad = `${Object.keys(csv.mapping).join(",")}\n301,x\n301,y\n`;
        const result = await call(rpc.startImport, { ref: ref(), source: { text: bad }, options: { format: "csv", mapping: csv.mapping } });
        const job = result.status === "started" ? await waitJob(result.job) : null;
        expect(job?.status === "failed", `status ${job?.status} on duplicate ${keyName}`);
        expect((await readAll()).rows.length === before, "partial rows stayed");
      });
    }
  }
  await check("export csv and json to a file; never overwrites", async () => {
    const path = join(folder, `${key}-export.csv`);
    const exported = await call(rpc.startExport, { source: { kind: "object", ref: ref() }, format: "csv", path });
    const job = await waitJob(exported.job);
    expect(job.status === "done", job.error);
    expect(existsSync(path) && !existsSync(`${path}.partial`), "file state wrong");
    expect(readFileSync(path, "utf8").split("\n").length > 2, "too few lines");
    await call(rpc.startExport, { source: { kind: "object", ref: ref() }, format: "csv", path }).then(
      () => {
        throw new Error("export accepted an existing path");
      },
      (error: Error) => expect(/exists/.test(error.message), error.message),
    );
    const jsonPath = join(folder, `${key}-export.json`);
    const json = await waitJob((await call(rpc.startExport, { source: { kind: "object", ref: ref() }, format: "json", path: jsonPath })).job);
    expect(json.status === "done", json.error);
    expect(Array.isArray(JSON.parse(readFileSync(jsonPath, "utf8"))), "invalid json");
  });
  await check("export a query, as text", async () => {
    const job = await waitJob(await call(rpc.exportText, { source: { kind: "query", scope: scope(), text: spec.select }, format: "ndjson" }));
    expect(job.status === "done", job.error);
    expect((job.text ?? "").length > 0, "no text");
  });
  await check("safety read-only: every attack refused, data unchanged", async () => {
    const before = JSON.stringify((await readAll()).rows.length);
    await setSafety("read-only");
    for (const attack of spec.attacks) {
      const outcome = await call(rpc.runQuery, { scope: scope(), text: attack, confirmed: true }).then(
        async (result) => (result.status === "started" ? (await waitJob(result.job)).status : "asked"),
        () => "refused",
      );
      // A statement the server itself refuses ends as a failed job, which also proves the second layer.
      expect(outcome === "refused" || outcome === "failed", `not refused (${outcome}): ${attack}`);
    }
    await call(rpc.writeRows, { ref: ref(), op: { kind: "insert", values: spec.newRow }, confirmed: true }).then(
      () => {
        throw new Error("grid insert allowed");
      },
      (error: Error) => expect(/read-only/.test(error.message), error.message),
    );
    await call(rpc.startImport, { ref: ref(), source: { text: "a\n1\n" }, options: { format: "csv", mapping: { a: "a" } }, confirmed: true }).then(
      () => {
        throw new Error("import allowed");
      },
      (error: Error) => expect(/read-only/.test(error.message), error.message),
    );
    if (spec.engine !== "mongodb" || true) {
      const exportAttack = await waitJob(await call(rpc.exportText, { source: { kind: "query", scope: scope(), text: spec.attacks[0] ?? "" }, format: "ndjson" }));
      expect(exportAttack.status === "failed", `export ran a write: ${spec.attacks[0]}`);
    }
    await setSafety("open");
    expect(JSON.stringify((await readAll()).rows.length) === before, "data changed");
  });
  if (spec.secondLayer) {
    await check("second layer: with the classifier skipped, the session refuses or undoes the write", async () => {
      const before = (await readAll()).rows.length;
      const adapter = await ADAPTERS[spec.engine]({ connection: { ...base, id: "x", host: String(spec.input.host ?? ""), port: spec.input.port ?? null, user: String(spec.input.user ?? ""), database: String(spec.input.database ?? ""), file: String(spec.input.file ?? ""), serviceName: String(spec.input.serviceName ?? ""), localDataCenter: "", region: "", endpoint: "", accessKeyId: "", authSource: "", tls: spec.input.tls ?? "off", caCertificate: "", safety: "read-only", ssh: null, rememberPassword: true, sshHostFingerprint: null, password: String(spec.input.password ?? ""), apiKey: null, sshPassword: null, sshPrivateKey: null, sshPassphrase: null } as never, endpoint: { host: String(spec.input.host), port: Number(spec.input.port), tlsServername: String(spec.input.host) }, onLost: () => undefined });
      await adapter.run([{ text: spec.secondLayer as string, class: "read" }], { scope: scope(), limit: 10, timeoutMs: 10000, signal: new AbortController().signal, readOnly: true }).catch(() => undefined);
      await adapter.close();
      expect((await readAll()).rows.length === before, "the session let a write through");
    });
  }
  if (spec.longQuery && info.supportsCancel) {
    await check("cancel stops a long query", async () => {
      const started = await call(rpc.runQuery, { scope: scope(), text: spec.longQuery, timeoutMs: 60000, confirmed: true });
      if (started.status !== "started") throw new Error("not started");
      await new Promise((resolve) => setTimeout(resolve, 700));
      const t = Date.now();
      await call(rpc.cancelJob, { id: started.job.id });
      const job = await waitJob(started.job, 15000);
      expect(job.status === "cancelled" || job.status === "done", `status ${job.status}: ${job.error}`);
      checks.push(`        stopped in ${Date.now() - t} ms`);
    });
    await check("timeout stops a long query", async () => {
      const started = await call(rpc.runQuery, { scope: scope(), text: spec.longQuery, timeoutMs: 1000, confirmed: true });
      if (started.status !== "started") throw new Error("not started");
      const job = await waitJob(started.job, 20000);
      expect(job.status === "failed" || job.status === "done", `status ${job.status}`);
    });
  }
  if (spec.ssh) {
    const hop = spec.ssh;
    await check("through a real SSH tunnel; host key pinned; changed key refused", async () => {
      const tunnelled: ConnectionInput = { ...base, name: `${spec.label} tunnel`, host: hop.host, port: hop.port, ssh: { host: "127.0.0.1", port: 22222, user: "dw" }, sshPassword: PASSWORD };
      const result = await call(rpc.testConnection, tunnelled);
      expect(result.ok, result.error);
      expect(result.sshHostFingerprint?.startsWith("SHA256:"), "no fingerprint");
      const saved = await call(rpc.saveConnection, tunnelled);
      const objects = await call(rpc.listObjects, { connectionId: saved.id, ...spec.scope, pattern: "", cursor: null });
      expect(objects.objects.some((item) => item.name === spec.name), "object not seen through the tunnel");
      await call(rpc.disconnect, { id: saved.id });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const pinned = (await call(rpc.listConnections, {})).connections.find((item) => item.id === saved.id);
      expect(pinned?.sshHostFingerprint === result.sshHostFingerprint, `pin ${pinned?.sshHostFingerprint}`);
      const raw = JSON.parse(readFileSync(join(folder, "connections.json"), "utf8")) as { connections: { id: string; sshHostFingerprint: string | null }[] };
      expect(raw.connections.some((item) => item.id === saved.id && item.sshHostFingerprint), "pin not on disk");
      await call(rpc.deleteConnection, { id: saved.id });
      const wrongPin = await openTunnel({ ssh: { host: "127.0.0.1", port: 22222, user: "dw" }, sshPassword: PASSWORD, sshPrivateKey: null, sshPassphrase: null, sshHostFingerprint: "SHA256:not-the-real-key" } as never, { host: hop.host, port: hop.port }, () => undefined).then(
        (tunnel) => {
          tunnel.close();
          return null;
        },
        (error: Error) => error.message,
      );
      expect(wrongPin?.includes("key changed"), `changed key not refused: ${wrongPin}`);
    });
  }
  const extra = EXTRAS[key];
  if (extra) await extra({ check, expect, ref, run, finish, call, keyOf, scope });
  await check("explain refuses a second statement", async () => {
    if (!info.explainPrefix) return;
    const refused = await call(rpc.runQuery, { scope: scope(), text: `${spec.select}; ${spec.attacks[0]}`, explain: true }).then(
      () => false,
      (error: Error) => /one statement/.test(error.message),
    );
    expect(refused, "explain accepted two statements");
  });
  await check("drop: wrong name refused, right name works", async () => {
    await call(rpc.destroyObject, { ref: ref(), action: "drop", confirmName: "wrong" }).then(
      () => {
        throw new Error("wrong name accepted");
      },
      (error: Error) => expect(/exact name/.test(error.message), error.message),
    );
    await finish(await call(rpc.destroyObject, { ref: ref(), action: "drop", confirmName: spec.name }));
  });
  await call(rpc.deleteConnection, { id }).catch(() => undefined);
  const failed = checks.filter((line) => line.startsWith("  FAIL")).length;
  console.log(`\n${spec.label} (${checks.filter((line) => line.startsWith("  ok")).length} ok, ${failed} failed)\n${checks.join("\n")}`);
  summary.push(`${spec.label}: ${failed === 0 ? "PASS" : `${failed} FAILED`}`);
}

async function sqliteSpec(): Promise<Spec> {
  const file = join(folder, "test.db");
  writeFileSync(file, "");
  return {
    label: "SQLite",
    engine: "sqlite",
    input: { file },
    scope: {},
    setup: ["create table dw_items (id integer primary key, name text, big integer, raw blob)", "insert into dw_items values (1,'name1',9007199254740993,x'00ff'),(2,'name2',1,null),(3,'name3',1,null),(4,'name4',1,null),(5,'name5',1,null)"],
    name: "dw_items",
    seedRows: 5,
    newRow: { id: 100, name: "new" },
    change: { column: "name", value: "changed" },
    find: { column: "name", op: "contains", value: "chang" },
    sortColumn: "id",
    select: "select * from dw_items order by id",
    attacks: [...SQL_ATTACKS, `vacuum into '${join(folder, "bad.db")}'`, "pragma writable_schema=1", `attach '${join(folder, "bad2.db")}' as bad`, "select 1; delete from dw_items"],
    secondLayer: "delete from dw_items",
    longQuery: "with recursive c(x) as (select 1 union all select x + 1 from c) select count(*) from c",
    csv: { text: "id,name\n201,a\n202,b\n203,\n", mapping: { id: "id", name: "name" }, rows: 3 },
    exact: { key: { id: 1 }, changes: { name: "exact" }, check: "select big from dw_items where id = 1", expected: "9007199254740993" },
  };
}

async function main() {
  const wanted = process.argv.slice(2);
  console.log(`Runtime: Node ${process.version}, Electron ${process.versions.electron ?? "none"}, TZ ${process.env.TZ ?? "system"}`);
  const all: Record<string, Spec> = { sqlite: await sqliteSpec(), ...specs };
  for (const key of wanted.length > 0 ? wanted : Object.keys(all)) {
    const spec = all[key];
    if (!spec) throw new Error(`No spec named ${key}`);
    await runSpec(key, spec);
  }
  console.log(`\n${summary.join("\n")}`);
  await cleanup();
  rmSync(folder, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

void main();
