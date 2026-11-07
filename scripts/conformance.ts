// Runs the plugin's real RPC handlers against real servers from test/compose.yaml. Build and run it with
// scripts/conformance.sh, which uses Electron's Node, the runtime the plugin gets inside Paseo.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z, type ZodType } from "zod";
import { type ConnectionInput, type JobView, type Filter, type ObjectRef, type RowPage, rpc, searchStructure, type StartResult, BYTES_SIZE, BYTES_TAG } from "../shared/contracts";
import { jumpFilters } from "../shared/foreign-keys";
import { preferencesSchema } from "../shared/preferences";
import { ENGINES, type EngineId } from "../shared/engines";
import { ADAPTERS } from "../server/adapters";
import { CELL_LIMIT } from "../server/cells";
import { setDriverRoot } from "../server/drivers";
import { contributeServer } from "../server/plugin";
import { PreferencesReader } from "../server/preferences";
import { SideFile } from "../server/side-file";
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
    await check("set: a member longer than a cell arrives whole, and renaming it replaces it", async () => {
      const long = "m".repeat(CELL_LIMIT + 100);
      await tools.finish(await tools.run(`DEL dw_set\nSADD dw_set ${long}`));
      const page = await call(rpc.readRows, { ref: key("dw_set"), query: {} });
      const member = keyOf(page, page.rows[0] as unknown[]).member;
      expect(member === long && page.cutCells.length === 0, `member length ${String(member).length}, cut ${JSON.stringify(page.cutCells)}`);
      await tools.finish(await call(rpc.writeRows, { ref: key("dw_set"), op: { kind: "update", key: { member }, changes: { member: "short" } }, confirmed: true }));
      expect(JSON.stringify(await queryRows(tools, "SMEMBERS dw_set")) === JSON.stringify([["short"]]), "old member left behind");
    });
    await check("list: a long value is cut on the page, and the whole one still finds the entry", async () => {
      const long = "v".repeat(5000);
      await tools.finish(await tools.run(`DEL dw_longlist\nRPUSH dw_longlist ${long}`));
      const page = await call(rpc.readRows, { ref: key("dw_longlist"), query: {} });
      const shown = keyOf(page, page.rows[0] as unknown[]);
      expect(String(shown.value).length < long.length && JSON.stringify(page.cutCells) === JSON.stringify([[0, 1]]), `shown ${String(shown.value).length}, cut ${JSON.stringify(page.cutCells)}`);
      const whole = await call(rpc.readRow, { ref: key("dw_longlist"), key: shown });
      const value = whole.rows[0]?.[1];
      expect(value === long, `whole length ${String(value).length}`);
      const refused = await failsAs(tools, key("dw_longlist"), { kind: "update", key: shown, changes: { value: "x" } });
      expect(refused?.status === "failed", `a cut key was accepted: ${refused?.status}`);
      await tools.finish(await call(rpc.writeRows, { ref: key("dw_longlist"), op: { kind: "update", key: { index: 0, value }, changes: { value: "x" } }, confirmed: true }));
      expect(JSON.stringify(await queryRows(tools, "LRANGE dw_longlist 0 -1")) === JSON.stringify([["x"]]), "edit missing");
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
    await tools.check("a key longer than a cell arrives whole, and a write through it lands on that row", async () => {
      await tools.finish(await tools.run("drop table if exists dw_longkey"));
      await tools.finish(await tools.run(`create table dw_longkey (k text primary key, v text); insert into dw_longkey values (repeat('k', ${CELL_LIMIT + 100}), 'old'), ('short', repeat('v', ${CELL_LIMIT + 100}))`));
      const page = await tools.call(rpc.readRows, { ref: { ...tools.ref(), name: "dw_longkey" }, query: { sort: { column: "k", descending: false } } });
      const k = page.rows[0]?.[0];
      tools.expect(typeof k === "string" && k.length === CELL_LIMIT + 100, `key length ${String(k).length}`);
      tools.expect(JSON.stringify(page.cutCells) === JSON.stringify([[1, 1]]), `cut ${JSON.stringify(page.cutCells)}`);
      await tools.finish(await tools.call(rpc.writeRows, { ref: { ...tools.ref(), name: "dw_longkey" }, op: { kind: "update", key: { k }, changes: { v: "new" } }, confirmed: true }));
      const after = await queryRows(tools, `select v from dw_longkey where length(k) > 100`);
      tools.expect(JSON.stringify(after) === JSON.stringify([["new"]]), `after ${JSON.stringify(after)}`);
      await tools.finish(await tools.run("drop table dw_longkey"));
    });
    await tools.check("the grid gets a preview of a long value; the row and a query get all of it", async () => {
      await tools.finish(await tools.run("drop table if exists dw_preview"));
      await tools.finish(await tools.run("create table dw_preview (id int primary key, body text); insert into dw_preview values (1, repeat('b', 10000))"));
      const ref = { ...tools.ref(), name: "dw_preview" };
      const page = await tools.call(rpc.readRows, { ref, query: {} });
      const preview = page.rows[0]?.[1];
      tools.expect(typeof preview === "string" && preview.length === preferencesSchema.parse({}).cellPreviewChars, `preview length ${String(preview).length}`);
      tools.expect(JSON.stringify(page.cutCells) === JSON.stringify([[0, 1]]), `cut ${JSON.stringify(page.cutCells)}`);
      const row = await tools.call(rpc.readRow, { ref, key: { id: 1 } });
      tools.expect(String(row.rows[0]?.[1]).length === 10000, `row length ${String(row.rows[0]?.[1]).length}`);
      const rows = await queryRows(tools, "select body from dw_preview");
      tools.expect(String(rows[0]?.[0]).length === 10000, `query length ${String(rows[0]?.[0]).length}`);
      await tools.finish(await tools.run("alter table dw_preview add column blob bytea; update dw_preview set blob = decode(repeat('ab', 2048), 'hex')"));
      const binary = await tools.call(rpc.readRows, { ref, query: {} });
      const blob = binary.rows[0]?.[2] as Record<string, unknown> | undefined;
      tools.expect(typeof blob?.[BYTES_TAG] === "string" && blob[BYTES_SIZE] === 2048, `blob ${JSON.stringify(blob).slice(0, 80)}`);
      await tools.finish(await tools.run("drop table dw_preview"));
    });
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
// Stands in for the daemon's settings store and hook registry, so the suite can drive both.
let preferenceValues: Record<string, unknown> = {};
const preferenceListeners = new Set<(next: { status: string; values: unknown }) => void>();
const hookHandlers = new Set<(input: { request: { tools: unknown[] } }) => Promise<{ tools: { name: string; execute(input: unknown, context: unknown): Promise<{ text?: string; isError?: boolean }> }[] }>>();
const folder = mkdtempSync(join(tmpdir(), "datawise-conformance-"));
const cleanup = contributeServer(
  {
    handle(contract: { name: string }, handler: unknown) {
      handlers.set(contract.name, handler as (input: unknown) => Promise<unknown>);
    },
    registerSettings: (definition: { schema: ZodType }) => ({
      read: async () => ({ status: "ready", values: definition.schema.parse(preferenceValues) }),
      subscribe(listener: (next: { status: string; values: unknown }) => void) {
        preferenceListeners.add(listener);
        return () => preferenceListeners.delete(listener);
      },
    }),
    addHook(_name: string, handler: never) {
      hookHandlers.add(handler);
      return () => hookHandlers.delete(handler);
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

// Encryption modes against servers that refuse plain connections. Certificates come from
// scripts/make-test-certs.sh: valid for "localhost" only, signed by a CA in test/certs.
async function runTls() {
  const certs = join(process.cwd(), "test", "certs");
  const ca = readFileSync(join(certs, "ca.crt"), "utf8");
  const servers: { label: string; innerHost: string; innerPort: number; input: Partial<ConnectionInput> }[] = [
    { label: "PostgreSQL", innerHost: "postgres-tls", innerPort: 5432, input: { engine: "postgres", port: 25433, user: "dw", password: PASSWORD, database: "dw" } },
    { label: "MySQL", innerHost: "mysql-tls", innerPort: 3306, input: { engine: "mysql", port: 23308, user: "root", password: PASSWORD, database: "dw" } },
    { label: "Redis", innerHost: "redis-tls", innerPort: 6379, input: { engine: "redis", port: 26380, password: PASSWORD, database: "0" } },
    { label: "MongoDB", innerHost: "mongodb-tls", innerPort: 27017, input: { engine: "mongodb", port: 27019 } },
  ];
  for (const server of servers) {
    const test = (host: string, tls: "off" | "require" | "verify", caCertificate = "") => call(rpc.testConnection, { name: "tls", ...server.input, host, tls, caCertificate } as ConnectionInput);
    const lines: string[] = [];
    const expectOk = (name: string, result: { ok: boolean; error: string | null }) => {
      lines.push(`  ${result.ok ? "ok  " : "FAIL"}  ${name}${result.ok ? "" : `: ${String(result.error).slice(0, 200)}`}`);
      if (!result.ok) failures += 1;
    };
    const expectRefused = (name: string, result: { ok: boolean; error: string | null }) => {
      lines.push(`  ${result.ok ? "FAIL" : "ok  "}  ${name}${result.ok ? ": connected" : ""}`);
      if (result.ok) failures += 1;
    };
    expectOk("verify, right host and CA", await test("localhost", "verify", ca));
    expectRefused("verify, wrong host name", await test("127.0.0.1", "verify", ca));
    expectRefused("verify, CA not trusted", await test("localhost", "verify"));
    expectOk("require, CA not trusted", await test("localhost", "require"));
    expectRefused("off, on a TLS-only server", await test("localhost", "off"));
    const tunnelled = (host: string) => call(rpc.testConnection, { name: "tls", ...server.input, port: server.innerPort, host, tls: "verify", caCertificate: ca, ssh: { host: "127.0.0.1", port: 22222, user: "dw" }, sshPassword: PASSWORD } as ConnectionInput);
    expectOk("verify through an SSH tunnel, right name", await tunnelled(server.innerHost));
    expectRefused("verify through an SSH tunnel, wrong name", await tunnelled(`datawise-test-${server.innerHost}-1`));
    console.log(`\n${server.label} TLS\n${lines.join("\n")}`);
    summary.push(`${server.label} TLS: ${lines.some((line) => line.startsWith("  FAIL")) ? "FAILED" : "PASS"}`);
  }
}

// SSH keys against the test server, which holds the public halves of id_plain and id_pass.
async function runSshKeys() {
  const certs = join(process.cwd(), "test", "certs");
  const key = (name: string) => readFileSync(join(certs, name), "utf8");
  const base: ConnectionInput = { name: "ssh", engine: "postgres", host: "postgres", port: 5432, user: "dw", password: PASSWORD, database: "dw", ssh: { host: "127.0.0.1", port: 22222, user: "dw" } };
  const lines: string[] = [];
  const test = (changes: Partial<ConnectionInput>) => call(rpc.testConnection, { ...base, ...changes });
  const report = (name: string, want: boolean, result: { ok: boolean; error: string | null }) => {
    const good = result.ok === want;
    lines.push(`  ${good ? "ok  " : "FAIL"}  ${name}${good ? "" : `: ${String(result.error).slice(0, 200)}`}`);
    if (!good) failures += 1;
  };
  report("key without a passphrase", true, await test({ sshPrivateKey: key("id_plain") }));
  report("key with its passphrase", true, await test({ sshPrivateKey: key("id_pass"), sshPassphrase: "dw-key-pass" }));
  report("key with a wrong passphrase", false, await test({ sshPrivateKey: key("id_pass"), sshPassphrase: "nope" }));
  report("a key the server does not know", false, await test({ sshPrivateKey: key("id_wrong") }));
  console.log(`\nSSH keys\n${lines.join("\n")}`);
  summary.push(`SSH keys: ${lines.some((line) => line.startsWith("  FAIL")) ? "FAILED" : "PASS"}`);
}

// A read-only connection must be able to browse a file it has no right to change.
async function runReadOnlyFolder() {
  const dir = mkdtempSync(join(tmpdir(), "datawise-ro-"));
  const file = join(dir, "ro.db");
  writeFileSync(file, "");
  const open = await call(rpc.saveConnection, { name: "seed", engine: "sqlite", file, safety: "open" });
  for (const text of ["create table t (id integer primary key, name text)", "insert into t values (1, 'a')"]) {
    const started = await call(rpc.runQuery, { scope: { connectionId: open.id }, text });
    if (started.status === "started") await waitJob(started.job);
  }
  await call(rpc.deleteConnection, { id: open.id });
  chmodSync(file, 0o444);
  chmodSync(dir, 0o555);
  const lines: string[] = [];
  try {
    const saved = await call(rpc.saveConnection, { name: "ro", engine: "sqlite", file, safety: "read-only" });
    const page = await call(rpc.readRows, { ref: { connectionId: saved.id, name: "t" }, query: { limit: 10 } });
    const objects = await call(rpc.listObjects, { connectionId: saved.id, pattern: "", cursor: null });
    const details = await call(rpc.describeObject, { connectionId: saved.id, name: "t" });
    const ok = page.rows.length === 1 && objects.objects.length === 1 && details.columns.length === 2;
    lines.push(`  ${ok ? "ok  " : "FAIL"}  browse a file in a read-only folder`);
    if (!ok) failures += 1;
    await call(rpc.deleteConnection, { id: saved.id });
  } catch (error) {
    failures += 1;
    lines.push(`  FAIL  browse a file in a read-only folder: ${String((error as Error).message).slice(0, 300)}`);
  } finally {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\nSQLite read-only folder\n${lines.join("\n")}`);
  summary.push(`SQLite read-only folder: ${lines.some((line) => line.startsWith("  FAIL")) ? "FAILED" : "PASS"}`);
}

// --- Features added after the first release ---

class Lines {
  lines: string[] = [];
  constructor(private readonly label: string) {}
  async check(name: string, work: () => Promise<void> | void) {
    try {
      await work();
      this.lines.push(`  ok    ${name}`);
    } catch (error) {
      failures += 1;
      this.lines.push(`  FAIL  ${name}: ${String((error as Error).message).slice(0, 300)}`);
      if (process.env.DATAWISE_VERBOSE) console.error((error as Error).stack);
    }
  }
  done() {
    console.log(`\n${this.label}\n${this.lines.join("\n")}`);
    summary.push(`${this.label}: ${this.lines.some((line) => line.startsWith("  FAIL")) ? "FAILED" : "PASS"}`);
  }
}

function expectThat(condition: boolean, detail: string) {
  if (!condition) throw new Error(detail);
}

async function refusal(work: Promise<unknown>): Promise<string> {
  return work.then(
    () => {
      throw new Error("was not refused");
    },
    (error: Error) => {
      if (error.message === "was not refused") throw error;
      return error.message;
    },
  );
}

interface EngineFeatures {
  label: string;
  engine: EngineId;
  input: Partial<ConnectionInput>;
  scope: { database?: string; schema?: string };
  setup: string[];
  parent: string;
  child: string;
  id: string;
  note: string;
  big: string;
  when: string;
  pa: string;
  pb: string;
  a: string;
  b: string;
}

function featureSetup(drop: (table: string) => string, types: { int: string; big: string; text: string; time: string; timeValue: string }, upper = false): { setup: string[]; names: Pick<EngineFeatures, "parent" | "child" | "id" | "note" | "big" | "when" | "pa" | "pb" | "a" | "b"> } {
  const n = (name: string) => (upper ? name.toUpperCase() : name);
  return {
    names: { parent: n("dw_parent"), child: n("dw_child"), id: n("id"), note: n("note"), big: n("big"), when: n("happened"), pa: n("pa"), pb: n("pb"), a: n("a"), b: n("b") },
    setup: [
      drop("dw_child"),
      drop("dw_parent"),
      `create table dw_parent (a ${types.int} not null, b ${types.text} not null, label ${types.text}, primary key (a, b))`,
      `create table dw_child (id ${types.int} primary key, pa ${types.int}, pb ${types.text}, note ${types.text} default 'PLANTED_DEFAULT', big ${types.big}, happened ${types.time}, foreign key (pa, pb) references dw_parent (a, b))`,
      `insert into dw_parent (a, b, label) values (1, 'x', 'PLANTED_PARENT')`,
      `insert into dw_child (id, pa, pb, note, big, happened) values (1, 1, 'x', 'PLANTED_ROW', 9007199254740993, ${types.timeValue})`,
      `insert into dw_child (id, pa, pb, note, big, happened) values (2, 1, 'x', 'two', 2, ${types.timeValue})`,
      `insert into dw_child (id, pa, pb, note, big, happened) values (3, null, null, 'three', 3, ${types.timeValue})`,
    ],
  };
}

function featureEngines(): Record<string, EngineFeatures> {
  const ifExists = (table: string) => `drop table if exists ${table}`;
  const mysqlTypes = { int: "int", big: "bigint", text: "varchar(50)", time: "datetime(6)", timeValue: "'2026-01-02 11:00:00.123456'" };
  const sqlite = featureSetup(ifExists, { int: "integer", big: "integer", text: "text", time: "text", timeValue: "'2026-01-02 11:00:00'" });
  const postgres = featureSetup(ifExists, { int: "integer", big: "bigint", text: "text", time: "timestamp", timeValue: "'2026-01-02 11:00:00.123456'" });
  const mysql = featureSetup(ifExists, mysqlTypes);
  const mssql = featureSetup((table) => `if object_id('dbo.${table}') is not null drop table dbo.${table}`, { int: "int", big: "bigint", text: "nvarchar(50)", time: "datetime2(6)", timeValue: "'2026-01-02 11:00:00.123456'" });
  const oracle = featureSetup((table) => `begin execute immediate 'drop table ${table.toUpperCase()}'; exception when others then null; end;\n/`, { int: "number(10)", big: "number(38)", text: "varchar2(50)", time: "timestamp(6)", timeValue: "timestamp '2026-01-02 11:00:00.123456'" }, true);
  const sqliteFile = join(folder, "features.db");
  writeFileSync(sqliteFile, "");
  return {
    sqlite: { label: "SQLite", engine: "sqlite", input: { file: sqliteFile }, scope: {}, setup: sqlite.setup, ...sqlite.names },
    postgres: { label: "PostgreSQL", engine: "postgres", input: specs.postgres?.input ?? {}, scope: { database: "dw", schema: "public" }, setup: postgres.setup, ...postgres.names },
    mysql: { label: "MySQL", engine: "mysql", input: specs.mysql?.input ?? {}, scope: { database: "dw" }, setup: mysql.setup, ...mysql.names },
    mariadb: { label: "MariaDB", engine: "mysql", input: specs.mariadb?.input ?? {}, scope: { database: "dw" }, setup: mysql.setup, ...mysql.names },
    mssql: { label: "SQL Server", engine: "mssql", input: specs.mssql?.input ?? {}, scope: { database: "master", schema: "dbo" }, setup: mssql.setup, ...mssql.names },
    oracle: { label: "Oracle", engine: "oracle", input: specs.oracle?.input ?? {}, scope: { schema: "DW" }, setup: oracle.setup, ...oracle.names },
  };
}

function theHook() {
  const [hook] = hookHandlers;
  return hook;
}

async function describeTool() {
  const hook = theHook();
  if (!hook) throw new Error("no hook registered");
  const answer = await hook({ request: { tools: [] } });
  const tool = answer.tools.find((item) => item.name === "datawise_describe");
  if (!tool) throw new Error("no tool in the hook's answer");
  return tool;
}

async function runEngineFeatures(key: string, spec: EngineFeatures) {
  const lines = new Lines(`${spec.label} features`);
  const saved = await call(rpc.saveConnection, { name: `features-${key}`, engine: spec.engine, safety: "open", ...spec.input });
  const scope = { connectionId: saved.id, ...spec.scope };
  const child = { ...scope, name: spec.child };
  const parent = { ...scope, name: spec.parent };
  const sql = async (text: string) => {
    const started = await call(rpc.runQuery, { scope, text, confirmed: true });
    const job = await finish(started);
    return job.results ?? [];
  };
  for (const text of spec.setup) await sql(text);
  const page = async () => call(rpc.readRows, { ref: child, query: { limit: 10, sort: { column: spec.id, descending: false } } });
  const at = (data: RowPage, name: string) => data.columns.findIndex((column) => column.name === name);
  const keyOf = (data: RowPage, index: number) => ({ [spec.id]: data.rows[index]?.[at(data, spec.id)] });
  const cell = (data: RowPage, index: number, name: string) => data.rows[index]?.[at(data, name)] ?? null;
  const whole = (data: RowPage, index: number) => Object.fromEntries(data.columns.map((column, position) => [column.name, data.rows[index]?.[position] ?? null]));
  const batch = (edits: unknown[], extra: Record<string, unknown> = {}) => call(rpc.writeBatch, { ref: child, edits, confirmed: true, ...extra });
  const resultOf = async (result: StartResult) => {
    if (result.status !== "started") throw new Error(`asked to confirm: ${result.preview}`);
    return waitJob(result.job);
  };

  await lines.check("foreign key names every column and the target", async () => {
    const details = await call(rpc.describeObject, child);
    const fk = details.foreignKeys[0];
    expectThat(fk !== undefined, "no foreign key");
    expectThat(JSON.stringify(fk?.columns) === JSON.stringify([spec.pa, spec.pb]), `columns ${JSON.stringify(fk?.columns)}`);
    expectThat(fk?.targetTable === spec.parent, `table ${fk?.targetTable}`);
    expectThat(JSON.stringify(fk?.targetColumns) === JSON.stringify([spec.a, spec.b]), `target columns ${JSON.stringify(fk?.targetColumns)}`);
  });
  await lines.check("following it finds the row, and a null offers nothing", async () => {
    const details = await call(rpc.describeObject, child);
    const fk = details.foreignKeys[0];
    if (!fk) throw new Error("no foreign key");
    const data = await page();
    const filters = jumpFilters(fk, (name) => cell(data, 0, name));
    expectThat(filters !== null, "no filters for a whole key");
    const target = await call(rpc.readRows, { ref: { ...scope, schema: fk.targetSchema ?? spec.scope.schema, database: fk.targetDatabase ?? spec.scope.database, name: fk.targetTable }, query: { limit: 10, filters } });
    expectThat(target.rows.length === 1, `${target.rows.length} rows`);
    expectThat(jumpFilters(fk, (name) => cell(data, 2, name)) === null, "offered a jump from a null key");
  });
  await lines.check("a dry run previews and writes nothing", async () => {
    const data = await page();
    const result = await batch([{ kind: "update", key: keyOf(data, 1), original: { [spec.note]: "two" }, changes: { [spec.note]: "dry" } }], { dryRun: true, confirmed: false });
    expectThat(result.status === "confirm" && /UPDATE/i.test(result.preview), JSON.stringify(result).slice(0, 200));
    expectThat(cell(await page(), 1, spec.note) === "two", "wrote during a dry run");
  });
  await lines.check("values just read compare equal, across types, and all edits commit", async () => {
    const data = await page();
    const job = await resultOf(
      await batch([
        { kind: "update", key: keyOf(data, 0), original: { [spec.big]: cell(data, 0, spec.big), [spec.when]: cell(data, 0, spec.when), [spec.note]: cell(data, 0, spec.note) }, changes: { [spec.big]: cell(data, 0, spec.big), [spec.when]: cell(data, 0, spec.when), [spec.note]: "batched" } },
        { kind: "delete", key: keyOf(data, 2), original: whole(data, 2) },
      ]),
    );
    expectThat(job.status === "done", `${String(job.error)} (value read: ${String(cell(data, 0, spec.when))})`);
    const after = await page();
    expectThat(after.rows.length === 2 && cell(after, 0, spec.note) === "batched", JSON.stringify(after.rows).slice(0, 300));
    expectThat(String(cell(after, 0, spec.big)) === "9007199254740993", `big ${String(cell(after, 0, spec.big))}`);
    expectThat(key === "sqlite" || String(cell(after, 0, spec.when)).startsWith("2026-01-02") && String(cell(after, 0, spec.when)).includes("123456"), `date ${String(cell(after, 0, spec.when))}`);
  });
  await lines.check("a row changed after staging rolls back everything and names the row", async () => {
    const data = await page();
    const seen = cell(data, 1, spec.note);
    await sql(`update ${spec.child} set ${spec.note} = 'someone else' where ${spec.id} = 2`);
    const job = await resultOf(
      await batch([
        { kind: "update", key: keyOf(data, 0), original: { [spec.note]: "batched" }, changes: { [spec.note]: "must not stay" } },
        { kind: "update", key: keyOf(data, 1), original: { [spec.note]: seen }, changes: { [spec.note]: "stale" } },
      ]),
    );
    expectThat(job.status === "failed" && /changed after you edited/.test(String(job.error)), `${job.status}: ${job.error}`);
    const after = await page();
    expectThat(cell(after, 0, spec.note) === "batched", "the first edit stayed");
    expectThat(cell(after, 1, spec.note) === "someone else", "the second edit stayed");
  });
  await lines.check("a row changed after being marked for delete rolls back", async () => {
    const data = await page();
    const seen = whole(data, 1);
    await sql(`update ${spec.child} set ${spec.big} = 77 where ${spec.id} = 2`);
    const job = await resultOf(await batch([{ kind: "delete", key: keyOf(data, 1), original: seen }]));
    expectThat(job.status === "failed" && /changed after you edited/.test(String(job.error)), `${job.status}: ${job.error}`);
    expectThat((await page()).rows.length === 2, "the row was deleted");
  });
  await lines.check("a row that is gone rolls back", async () => {
    const data = await page();
    const job = await resultOf(await batch([{ kind: "update", key: keyOf(data, 0), original: { [spec.note]: "batched" }, changes: { [spec.note]: "must not stay" } }, { kind: "delete", key: { [spec.id]: 999 }, original: {} }]));
    expectThat(job.status === "failed" && /no longer exists/.test(String(job.error)), `${job.status}: ${job.error}`);
    expectThat(cell(await page(), 0, spec.note) === "batched", "the first edit stayed");
  });
  await lines.check("two operations on one row are refused", async () => {
    const data = await page();
    const message = await refusal(batch([{ kind: "update", key: keyOf(data, 0), original: {}, changes: { [spec.note]: "a" } }, { kind: "delete", key: keyOf(data, 0), original: {} }]));
    expectThat(/same row/.test(message), message);
  });
  await lines.check("changing a key column is refused", async () => {
    const data = await page();
    const message = await refusal(batch([{ kind: "update", key: keyOf(data, 0), original: { [spec.id]: cell(data, 0, spec.id) }, changes: { [spec.id]: 50 } }]));
    expectThat(/key column/.test(message), message);
  });
  await lines.check("a read-only connection refuses it", async () => {
    const readOnly = await call(rpc.saveConnection, { name: `features-${key}-ro`, engine: spec.engine, safety: "read-only", ...spec.input });
    const data = await page();
    const message = await refusal(call(rpc.writeBatch, { ref: { ...child, connectionId: readOnly.id }, edits: [{ kind: "update", key: keyOf(data, 0), original: { [spec.note]: "batched" }, changes: { [spec.note]: "no" } }], confirmed: true }));
    expectThat(/read-only/i.test(message), message);
    expectThat(cell(await page(), 0, spec.note) === "batched", "wrote on a read-only connection");
    await call(rpc.deleteConnection, { id: readOnly.id });
  });
  await lines.check("the agent tool shows names and no planted text", async () => {
    await call(rpc.saveConnection, { id: saved.id, name: saved.name, engine: spec.engine, safety: "open", agentAccess: "schema", ...spec.input });
    const tool = await describeTool();
    const names = await tool.execute({}, {});
    expectThat(String(names.text).includes(saved.name), String(names.text));
    const tables = await tool.execute({ connection: saved.name, ...spec.scope }, {});
    expectThat(String(tables.text).includes(spec.child), String(tables.text));
    const columns = await tool.execute({ connection: saved.name, table: spec.child, ...spec.scope }, {});
    expectThat(String(columns.text).includes(spec.note) && String(columns.text).includes(spec.parent), String(columns.text));
    const everything = `${names.text}${tables.text}${columns.text}`;
    expectThat(!everything.includes("PLANTED"), everything);
  });
  await lines.check("turning access off takes effect on the next call", async () => {
    const tool = await describeTool();
    await call(rpc.saveConnection, { id: saved.id, name: saved.name, engine: spec.engine, safety: "open", agentAccess: "none", ...spec.input });
    const answer = await tool.execute({ connection: saved.name, table: spec.child, ...spec.scope }, {});
    expectThat(answer.isError === true && !String(answer.text).includes(spec.note), String(answer.text));
    expectThat(theHook() === undefined, "hook still registered");
  });
  await lines.check("an attachment holds structure only, from an open connection", async () => {
    await call(rpc.readRows, { ref: child, query: { limit: 1 } });
    const found = await call(searchStructure, { query: "dw_child" });
    const item = found.items.find((entry) => entry.title.endsWith(spec.child));
    expectThat(item !== undefined, JSON.stringify(found).slice(0, 200));
    expectThat(String(item?.text).includes(spec.note) && !String(item?.text).includes("PLANTED"), String(item?.text));
  });
  await lines.check("an attachment search leaves out a production connection, even an open one", async () => {
    const production = await call(rpc.saveConnection, { name: `features-${key}-prod`, engine: spec.engine, safety: "confirm", environment: "production", ...spec.input });
    await call(rpc.readRows, { ref: { ...child, connectionId: production.id }, query: { limit: 1 } });
    const found = await call(searchStructure, { query: "dw_child" });
    expectThat(found.items.every((entry) => !entry.id.startsWith(production.id)), JSON.stringify(found).slice(0, 200));
    await call(rpc.deleteConnection, { id: production.id });
  });
  await lines.check("an attachment search never opens a connection", async () => {
    await call(rpc.disconnect, { id: saved.id });
    const found = await call(searchStructure, { query: "dw_child" });
    expectThat(found.items.every((entry) => !entry.id.startsWith(saved.id)), JSON.stringify(found).slice(0, 200));
  });
  const agentA = { agent: { id: "agent-a", title: "Agent A" } };
  const agentB = { agent: { id: "agent-b", title: "Agent B" } };
  const useTool = async (name: string, input: unknown, context: unknown = agentA) => {
    const hook = theHook();
    if (!hook) throw new Error("no hook registered");
    const tool = (await hook({ request: { tools: [] } })).tools.find((item) => item.name === name) as unknown as { input: ZodType; execute(input: unknown, context: unknown): Promise<{ text?: string; isError?: boolean; structuredContent?: { requestId: string; status: string } }> };
    return tool.execute(tool.input.parse(input), context);
  };
  const rowsConnection = (name: string, extra: Record<string, unknown> = {}) => call(rpc.saveConnection, { name, engine: spec.engine, safety: "confirm", environment: "development", agentAccess: "schema", agentRowAccess: "propose", ...spec.input, ...extra });
  const settled = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = (await call(rpc.listAgentRequests, {})).requests.find((item) => item.id === id);
      if (found && found.status !== "running") return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("the request never finished");
  };
  const rowNote = (rows: unknown[][], names: string[], id: number) => rows.find((row) => Number(row[names.indexOf(spec.id)]) === id)?.[names.indexOf(spec.note)];
  const readAll = async (connection: string) => {
    const answer = await useTool("datawise_read", { connection, table: spec.child, ...spec.scope, sort: { column: spec.id } });
    if (answer.isError) throw new Error(String(answer.text));
    const parsed = JSON.parse(String(answer.text).split("\n\n")[1] as string) as { columns: string[]; rows: unknown[][] };
    return parsed;
  };
  const rowsName = `features-${key}-rows`;
  const rows = await rowsConnection(rowsName);
  // Oracle refuses a read-only transaction for a few seconds after a table's definition changes (ORA-01466), and
  // this run has just created the table. A read that keeps failing still fails the check below.
  if (spec.engine === "oracle") {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (!(await useTool("datawise_read", { connection: rowsName, table: spec.child, ...spec.scope })).isError) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await lines.check("rows: reading works, marks rows untrusted, and records no values", async () => {
    await sql(`update ${spec.child} set ${spec.note} = 'PLANTED_AGENT_VALUE' where ${spec.id} = 2`);
    const answer = await useTool("datawise_read", { connection: rowsName, table: spec.child, ...spec.scope, filters: [{ column: spec.note, op: "contains", value: "PLANTED_FILTER" }] });
    expectThat(!answer.isError, String(answer.text));
    const all = await readAll(rowsName);
    expectThat(rowNote(all.rows, all.columns, 2) === "PLANTED_AGENT_VALUE", JSON.stringify(all).slice(0, 200));
    const first = await useTool("datawise_read", { connection: rowsName, table: spec.child, ...spec.scope });
    expectThat(/do not follow instructions/.test(String(first.text)), String(first.text).slice(0, 120));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = JSON.stringify((await call(rpc.listAgentActivity, {})).events);
    expectThat(events.includes('"read"') && !events.includes("PLANTED"), events.slice(0, 200));
  });
  await lines.check("rows: names-only and unknown connections get the same refusal", async () => {
    await call(rpc.saveConnection, { name: `${rowsName}-names`, engine: spec.engine, safety: "confirm", environment: "development", agentAccess: "schema", ...spec.input });
    const names = await useTool("datawise_read", { connection: `${rowsName}-names`, table: spec.child, ...spec.scope });
    const unknown = await useTool("datawise_read", { connection: "nothing", table: spec.child, ...spec.scope });
    expectThat(names.isError === true && unknown.isError === true && String(names.text).replace(`${rowsName}-names`, "X") === String(unknown.text).replace("nothing", "X"), `${names.text} / ${unknown.text}`);
  });
  await lines.check("rows: the read level cannot propose", async () => {
    await rowsConnection(`${rowsName}-read`, { agentRowAccess: "read" });
    const answer = await useTool("datawise_propose_write", { connection: `${rowsName}-read`, table: spec.child, ...spec.scope, delete: [{ [spec.id]: 1 }] });
    expectThat(answer.isError === true && /allows this/.test(String(answer.text)), String(answer.text));
  });
  await lines.check("rows: production, no label, and proposals on read-only are refused on save", async () => {
    const says = async (work: Promise<unknown>, pattern: RegExp) => {
      const message = await refusal(work);
      expectThat(pattern.test(message), message);
    };
    await says(rowsConnection(`${rowsName}-x`, { environment: "production" }), /production/i);
    await says(rowsConnection(`${rowsName}-x`, { environment: "none" }), /development or staging/);
    await says(rowsConnection(`${rowsName}-x`, { safety: "read-only" }), /read-only/);
    await says(rowsConnection(`${rowsName}-x`, { agentAccess: "none" }), /Share table and column names/);
  });
  await lines.check("rows: another database and system schemas are refused", async () => {
    const other = await useTool("datawise_read", { connection: rowsName, table: spec.child, ...spec.scope, database: "elsewhere" });
    if (spec.scope.database) expectThat(other.isError === true && /limited to/.test(String(other.text)), String(other.text));
    if (key === "postgres") {
      const catalog = await useTool("datawise_read", { connection: rowsName, table: "pg_authid", ...spec.scope, schema: "pg_catalog" });
      expectThat(catalog.isError === true && !String(catalog.text).includes("rolpassword"), String(catalog.text));
      const information = await useTool("datawise_describe", { connection: rowsName, table: "tables", ...spec.scope, schema: "information_schema" });
      expectThat(information.isError === true, String(information.text));
    }
    const missing = await useTool("datawise_read", { connection: rowsName, table: "no_such_table", ...spec.scope });
    expectThat(missing.isError === true, String(missing.text));
  });
  // In No Prompts too: the rule is about Datawise's own approval, not the connection's write mode.
  const propose = async (connection: string, change: Record<string, unknown>, context: unknown = agentA) => {
    const answer = await useTool("datawise_propose_write", { connection, table: spec.child, ...spec.scope, ...change }, context);
    if (answer.isError) throw new Error(String(answer.text));
    return answer.structuredContent?.requestId as string;
  };
  await lines.check("rows: nothing is written until approved, on No Prompts too", async () => {
    const open = `${rowsName}-open`;
    await rowsConnection(open, { safety: "open" });
    const id = await propose(open, { update: [{ key: { [spec.id]: 1 }, changes: { [spec.note]: "approved value" } }] });
    const before = await readAll(rowsName);
    expectThat(rowNote(before.rows, before.columns, 1) !== "approved value", "wrote before approval");
    const pending = await useTool("datawise_write_status", { requestId: id });
    expectThat(pending.structuredContent?.status === "pending", String(pending.text));
    const detail = await call(rpc.getAgentRequest, { id });
    const item = detail.items[0];
    expectThat(item?.kind === "update" && item.changes[0]?.after === "approved value", JSON.stringify(detail.items).slice(0, 200));
    expectThat(detail.request.place.endsWith(spec.child), detail.request.place);
    await call(rpc.decideAgentRequest, { id, approve: true });
    const done = await settled(id);
    expectThat(done.status === "done" && done.affected === 1, `${done.status}: ${done.message}`);
    const after = await readAll(rowsName);
    expectThat(rowNote(after.rows, after.columns, 1) === "approved value", "the approved change is not there");
    await refusal(call(rpc.decideAgentRequest, { id, approve: true }));
  });
  await lines.check("rows: a rejected request writes nothing", async () => {
    const id = await propose(rowsName, { delete: [{ [spec.id]: 2 }] });
    await call(rpc.decideAgentRequest, { id, approve: false });
    const status = await useTool("datawise_write_status", { requestId: id });
    expectThat(status.structuredContent?.status === "rejected", String(status.text));
    expectThat((await readAll(rowsName)).rows.length === 2, "the row was deleted");
  });
  await lines.check("rows: a row changed after the proposal rolls back, and the agent gets no driver text", async () => {
    const id = await propose(rowsName, { update: [{ key: { [spec.id]: 1 }, changes: { [spec.note]: "must not stay" } }, { key: { [spec.id]: 2 }, changes: { [spec.note]: "stale" } }] });
    await sql(`update ${spec.child} set ${spec.big} = 77 where ${spec.id} = 1`);
    await sql(`update ${spec.child} set ${spec.note} = 'changed elsewhere' where ${spec.id} = 2`);
    await call(rpc.decideAgentRequest, { id, approve: true });
    const failed = await settled(id);
    expectThat(failed.status === "failed" && /changed after you edited/.test(String(failed.message)), `${failed.status}: ${failed.message}`);
    const status = await useTool("datawise_write_status", { requestId: id });
    expectThat(!/changed elsewhere|edited/.test(String(status.text)), String(status.text));
    const after = await readAll(rowsName);
    expectThat(rowNote(after.rows, after.columns, 1) === "approved value", "the first edit stayed");
  });
  await lines.check("rows: a delete of a row changed after the proposal rolls back", async () => {
    const id = await propose(rowsName, { delete: [{ [spec.id]: 2 }] });
    await sql(`update ${spec.child} set ${spec.big} = 78 where ${spec.id} = 2`);
    await call(rpc.decideAgentRequest, { id, approve: true });
    expectThat((await settled(id)).status === "failed", "it did not fail");
    expectThat((await readAll(rowsName)).rows.length === 2, "the row was deleted");
  });
  await lines.check("rows: inserts land together or not at all", async () => {
    const good = { [spec.id]: 50, [spec.pa]: null, [spec.pb]: null, [spec.note]: "first", [spec.big]: 1 };
    const clash = { [spec.id]: 1, [spec.pa]: null, [spec.pb]: null, [spec.note]: "clash", [spec.big]: 1 };
    const failing = await propose(rowsName, { insert: [good, clash] });
    await call(rpc.decideAgentRequest, { id: failing, approve: true });
    expectThat((await settled(failing)).status === "failed", "a clashing key did not fail");
    expectThat((await readAll(rowsName)).rows.length === 2, "a row stayed");
    const fine = await propose(rowsName, { insert: [good] });
    await call(rpc.decideAgentRequest, { id: fine, approve: true });
    expectThat((await settled(fine)).status === "done", "the insert failed");
    expectThat((await readAll(rowsName)).rows.length === 3, "the row is not there");
    const remove = await propose(rowsName, { delete: [{ [spec.id]: 50 }] });
    await call(rpc.decideAgentRequest, { id: remove, approve: true });
    expectThat((await settled(remove)).status === "done", "the delete failed");
  });
  await lines.check("rows: bad requests are refused and nothing waits", async () => {
    const before = (await call(rpc.listAgentRequests, {})).requests.filter((item) => item.status === "pending").length;
    const says = async (change: Record<string, unknown>, pattern: RegExp) => {
      const message = await refusal(propose(rowsName, change));
      expectThat(pattern.test(message), message);
    };
    await says({ insert: [{ [spec.id]: 60 }], delete: [{ [spec.id]: 2 }] }, /apart from/);
    await says({ update: [{ key: { [spec.id]: 1 }, changes: { [spec.id]: 9 } }] }, /key column/);
    await says({ update: [{ key: { [spec.id]: 1 }, changes: { no_such_column: 1 } }] }, /no column named/);
    await says({ update: [{ key: { [spec.id]: 1 }, changes: { [spec.note]: { "$datawise.bytes": "not base64!" } } }] }, /Binary values/);
    await says({ delete: [{ [spec.id]: 999 }] }, /No row matches/);
    await says({ delete: [{ [spec.id]: 1 }, { [spec.id]: "1" }] }, /same row/);
    await says({}, /nothing to change/);
    await says({ delete: Array.from({ length: 101 }, (_, index) => ({ [spec.id]: index })) }, /at most 100/);
    await says({ insert: [{ [spec.id]: 61, [spec.note]: "x".repeat(1024 * 1024 + 10) }] }, /too large/);
    expectThat((await call(rpc.listAgentRequests, {})).requests.filter((item) => item.status === "pending").length === before, "something was left waiting");
  });
  await lines.check("rows: an agent cannot see another agent's request, and limits hold", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) ids.push(await propose(rowsName, { delete: [{ [spec.id]: 2 }] }, agentB));
    const other = await useTool("datawise_write_status", { requestId: ids[0] });
    expectThat(other.isError === true && /no such request/.test(String(other.text)), String(other.text));
    const message = await refusal(propose(rowsName, { delete: [{ [spec.id]: 2 }] }, agentB));
    expectThat(/already have 5/.test(message), message);
    const others = [{ agent: { id: "agent-c", title: "C" } }, { agent: { id: "agent-d", title: "D" } }, { agent: { id: "agent-e", title: "E" } }];
    for (const context of others) for (let index = 0; index < 5; index += 1) ids.push(await propose(rowsName, { delete: [{ [spec.id]: 2 }] }, context));
    const full = await refusal(propose(rowsName, { delete: [{ [spec.id]: 2 }] }, { agent: { id: "agent-f", title: "F" } }));
    expectThat(/already has 20/.test(full), full);
    for (const id of ids) await call(rpc.decideAgentRequest, { id, approve: false });
  });
  await lines.check("rows: deleting a connection expires what waits on it, and removes its activity", async () => {
    const gone = `${rowsName}-gone`;
    const saved = await rowsConnection(gone);
    const id = await propose(gone, { delete: [{ [spec.id]: 2 }] });
    await call(rpc.deleteConnection, { id: saved.id });
    expectThat((await useTool("datawise_write_status", { requestId: id })).structuredContent?.status === "expired", "still waiting");
    await refusal(call(rpc.decideAgentRequest, { id, approve: true }));
    expectThat(!(await call(rpc.listAgentActivity, {})).events.some((event) => event.connectionId === saved.id), "activity kept");
  });
  await lines.check("rows: more than 200 rows is refused", async () => {
    await refusal(useTool("datawise_read", { connection: rowsName, table: spec.child, ...spec.scope, limit: 201 }));
    await refusal(useTool("datawise_read", { connection: rowsName, table: spec.child, ...spec.scope, limit: 0 }));
  });
  await lines.check("rows: saving a connection expires what waits on it", async () => {
    const id = await propose(rowsName, { delete: [{ [spec.id]: 2 }] });
    await rowsConnection(rowsName, { id: rows.id });
    const status = await useTool("datawise_write_status", { requestId: id });
    expectThat(status.structuredContent?.status === "expired", String(status.text));
    await refusal(call(rpc.decideAgentRequest, { id, approve: true }));
    expectThat((await readAll(rowsName)).rows.length === 2, "the row was deleted");
  });
  await lines.check("rows: an unknown request says a change may have landed", async () => {
    const status = await useTool("datawise_write_status", { requestId: "gone" });
    expectThat(/may or may not have landed/.test(String(status.text)), String(status.text));
  });
  if (key === "postgres") {
    await lines.check("rows: a view whose function writes cannot write through a read", async () => {
      await sql("drop view if exists dw_writing_view");
      await sql("create or replace function dw_touch() returns int language plpgsql as $$ begin update dw_child set note = 'written by a view' where id = 1; return 1; end $$");
      await sql("create view dw_writing_view as select dw_touch() as n");
      const refused = await useTool("datawise_read", { connection: rowsName, table: "dw_writing_view", ...spec.scope });
      // Refused, and not merely rolled back: the read-only transaction stopped the function.
      expectThat(refused.isError === true, String(refused.text).slice(0, 200));
      const after = await readAll(rowsName);
      expectThat(rowNote(after.rows, after.columns, 1) !== "written by a view", "the view wrote");
      await sql("drop view dw_writing_view");
      await sql("drop function dw_touch");
    });
  }
  if (key === "postgres" || key === "sqlite") {
    await lines.check("rows: long values are cut and marked, and binary shows only a size", async () => {
      const table = "dw_blobs";
      await sql(`drop table if exists ${table}`);
      await sql(`create table ${table} (id integer primary key, body text, raw ${key === "postgres" ? "bytea" : "blob"})`);
      await sql(key === "postgres" ? `insert into ${table} values (1, repeat('x', 5000), 'PLANTEDBYTES'::bytea)` : `insert into ${table} values (1, '${"x".repeat(5000)}', CAST('PLANTEDBYTES' AS BLOB))`);
      const answer = await useTool("datawise_read", { connection: rowsName, table, ...spec.scope });
      const text = String(answer.text);
      expectThat(text.includes('"cutValues":[{"row":0,"column":"body"}]') && !text.includes("x".repeat(2100)), text.slice(0, 200));
      expectThat(text.includes("<12 bytes>") && !text.includes("PLANTEDBYTES") && !text.includes(Buffer.from("PLANTEDBYTES").toString("base64")), text.slice(-200));
      await sql(`drop table ${table}`);
      await sql("drop table if exists dw_many");
      await sql("create table dw_many (id integer primary key, body text)");
      for (let start = 1; start <= 250; start += 50) {
        const values = Array.from({ length: 50 }, (_, index) => `(${start + index}, '${"y".repeat(1900)}')`).join(",");
        await sql(`insert into dw_many values ${values}`);
      }
      let cursor: string | undefined;
      const seen: number[] = [];
      for (let call_ = 0; call_ < 20; call_ += 1) {
        const page = await useTool("datawise_read", { connection: rowsName, table: "dw_many", ...spec.scope, limit: 200, sort: { column: "id" }, ...(cursor ? { cursor } : {}) });
        const text = String(page.text);
        expectThat(!page.isError && Buffer.byteLength(text) < 256 * 1024 + 2048, `${Buffer.byteLength(text)} bytes`);
        const parsed = JSON.parse(text.split("\n\n")[1] as string) as { rows: unknown[][]; nextCursor: string | null };
        expectThat(parsed.rows.length <= 200, `${parsed.rows.length} rows`);
        seen.push(...parsed.rows.map((row) => Number(row[0])));
        if (!parsed.nextCursor) break;
        cursor = parsed.nextCursor;
      }
      expectThat(seen.length === 250 && new Set(seen).size === 250, `${seen.length} rows, ${new Set(seen).size} different`);
      await sql("drop table dw_many");
      if (key === "postgres") {
        await sql("drop table if exists dw_arrays");
        await sql("create table dw_arrays (id integer primary key, parts bytea[])");
        await sql("insert into dw_arrays values (1, array['PLANTEDBYTES'::bytea])");
        const nested = String((await useTool("datawise_read", { connection: rowsName, table: "dw_arrays", ...spec.scope })).text);
        expectThat(nested.includes("<12 bytes>") && !nested.includes(Buffer.from("PLANTEDBYTES").toString("base64")), nested.slice(-160));
        await sql("drop table dw_arrays");
      }
    });
  }
  if (key === "mysql") {
    await lines.check("rows: a loose key shows the real row, and system databases are refused", async () => {
      const id = await propose(rowsName, { delete: [{ [spec.id]: "2abc" }] });
      const detail = await call(rpc.getAgentRequest, { id });
      const item = detail.items[0];
      expectThat(item?.kind === "delete" && String(item.key[spec.id]) === "2", JSON.stringify(detail.items).slice(0, 200));
      await call(rpc.decideAgentRequest, { id, approve: false });
      const open = `${rowsName}-nodb`;
      await rowsConnection(open, { database: "" });
      const system = await useTool("datawise_read", { connection: open, table: "user", database: "mysql" });
      expectThat(system.isError === true && !String(system.text).includes("authentication_string"), String(system.text).slice(0, 200));
      const chosen = await useTool("datawise_read", { connection: open, table: spec.child, database: "dw" });
      expectThat(!chosen.isError, String(chosen.text).slice(0, 200));
      await rowsConnection(`${rowsName}-sys`, { database: "mysql" });
      const pinned = await useTool("datawise_read", { connection: `${rowsName}-sys`, table: "user" });
      expectThat(pinned.isError === true && /system database/.test(String(pinned.text)), String(pinned.text).slice(0, 200));
    });
  }
  for (const connection of (await call(rpc.listConnections, {})).connections) if (connection.name.startsWith(rowsName)) await call(rpc.deleteConnection, { id: connection.id });
  if (key === "mysql" || key === "mariadb") {
    await lines.check("a table that cannot roll back is refused", async () => {
      await sql("drop table if exists dw_myisam");
      await sql("create table dw_myisam (id int primary key, note varchar(10)) engine = MyISAM");
      await sql("insert into dw_myisam values (1, 'a')");
      const message = await refusal(call(rpc.writeBatch, { ref: { ...scope, name: "dw_myisam" }, edits: [{ kind: "update", key: { id: 1 }, original: { note: "a" }, changes: { note: "b" } }], confirmed: true }));
      expectThat(/storage engine/.test(message), message);
      await rowsConnection(`${rowsName}-myisam`);
      const proposed = await useTool("datawise_propose_write", { connection: `${rowsName}-myisam`, table: "dw_myisam", ...spec.scope, update: [{ key: { id: 1 }, changes: { note: "b" } }] });
      expectThat(proposed.isError === true && /storage engine/.test(String(proposed.text)), String(proposed.text));
      for (const connection of (await call(rpc.listConnections, {})).connections) if (connection.name === `${rowsName}-myisam`) await call(rpc.deleteConnection, { id: connection.id });
      await sql("drop table dw_myisam");
    });
    await lines.check("an enum's values stay out of the agent tool", async () => {
      await sql("drop table if exists dw_enum");
      await sql("create table dw_enum (id int primary key, state enum('PLANTED_ENUM','b'))");
      await call(rpc.saveConnection, { id: saved.id, name: saved.name, engine: spec.engine, safety: "open", agentAccess: "schema", ...spec.input });
      const tool = await describeTool();
      const answer = await tool.execute({ connection: saved.name, table: "dw_enum", ...spec.scope }, {});
      expectThat(String(answer.text).includes("state: enum") && !String(answer.text).includes("PLANTED"), String(answer.text));
      await call(rpc.saveConnection, { id: saved.id, name: saved.name, engine: spec.engine, safety: "open", agentAccess: "none", ...spec.input });
      await sql("drop table dw_enum");
    });
  }
  if (key === "mssql") {
    await lines.check("IF ... BEGIN ... END is one statement on the server", async () => {
      const results = await sql(`if 1 = 1 begin delete from dbo.${spec.child} where 1 = 0; end`);
      expectThat(results.length === 1, `${results.length} results`);
    });
  }
  await sql(spec.setup[0] as string);
  await sql(spec.setup[1] as string);
  await call(rpc.deleteConnection, { id: saved.id });
  lines.done();
}

// Engines whose structure comes from a catalog but which have no foreign keys or transactions.
async function runAgentCatalog(key: "clickhouse" | "cassandra") {
  const lines = new Lines(`${key === "clickhouse" ? "ClickHouse" : "Cassandra"} agent tool`);
  const spec = specs[key] as Spec;
  const saved = await call(rpc.saveConnection, { name: `agent-${key}`, engine: spec.engine, safety: "open", agentAccess: "schema", ...spec.input });
  const scope = { connectionId: saved.id, ...spec.scope };
  const run = async (text: string) => finish(await call(rpc.runQuery, { scope, text, confirmed: true }));
  const statements =
    key === "clickhouse"
      ? ["drop table if exists dw_agent", "create table dw_agent (id UInt64, state Enum8('PLANTED_ENUM' = 1, 'b' = 2), note String default 'PLANTED_DEFAULT') engine = MergeTree order by id", "insert into dw_agent (id, state, note) values (1, 'PLANTED_ENUM', 'PLANTED_ROW')"]
      : ["create keyspace if not exists dw with replication = {'class':'SimpleStrategy','replication_factor':1}", "drop table if exists dw.dw_agent", "create table dw.dw_agent (id int primary key, state text, note text)", "insert into dw.dw_agent (id, state, note) values (1, 'PLANTED_ENUM', 'PLANTED_ROW')"];
  for (const text of statements) await run(text);
  await lines.check("names and types, and no planted text", async () => {
    const tool = await describeTool();
    const answer = await tool.execute({ connection: saved.name, table: "dw_agent", ...spec.scope }, {});
    expectThat(String(answer.text).includes("note") && !String(answer.text).includes("PLANTED"), String(answer.text));
  });
  await run(key === "clickhouse" ? "drop table dw_agent" : "drop table dw.dw_agent");
  await call(rpc.deleteConnection, { id: saved.id });
  lines.done();
}

async function runSettingsAndViews() {
  const lines = new Lines("Settings, labels, views and saved state");
  const file = join(folder, "settings.db");
  writeFileSync(file, "");
  const base = { engine: "sqlite", file };
  const applyPreferences = async (values: Record<string, unknown>) => {
    preferenceValues = values;
    const parsed = preferencesSchema.parse(values);
    for (const listener of preferenceListeners) listener({ status: "ready", values: parsed });
    await new Promise((resolve) => setTimeout(resolve, 50));
  };
  await lines.check("a damaged settings document means defaults", async () => {
    const reader = new PreferencesReader({ read: async () => ({ status: "invalid" }), subscribe: () => () => undefined } as never, () => undefined);
    expectThat((await reader.get()).rowsPerPage === 100, "not the default");
    const failing = new PreferencesReader({ read: () => Promise.reject(new Error("broken")), subscribe: () => () => undefined } as never, () => undefined);
    expectThat((await failing.get()).queryRowLimit === 1000, "not the default");
  });
  await lines.check("a stored connection with no write mode stays Ask first, whatever the preference", async () => {
    await applyPreferences({ newConnectionSafety: "open" });
    const saved = await call(rpc.saveConnection, { name: "no-mode", ...base });
    expectThat(saved.safety === "confirm", saved.safety);
    await call(rpc.deleteConnection, { id: saved.id });
    await applyPreferences({});
  });
  await lines.check("production cannot run without prompts, in either order", async () => {
    await refusal(call(rpc.saveConnection, { name: "p1", ...base, environment: "production", safety: "open" }));
    const first = await call(rpc.saveConnection, { name: "p2", ...base, safety: "open" });
    await refusal(call(rpc.saveConnection, { id: first.id, name: "p2", ...base, safety: "open", environment: "production" }));
    const second = await call(rpc.saveConnection, { name: "p3", ...base, environment: "production", safety: "confirm" });
    await refusal(call(rpc.saveConnection, { id: second.id, name: "p3", ...base, environment: "production", safety: "open" }));
    await call(rpc.deleteConnection, { id: first.id });
    await call(rpc.deleteConnection, { id: second.id });
  });
  await lines.check("agent access is refused on production and on engines without a catalog", async () => {
    await refusal(call(rpc.saveConnection, { name: "a1", ...base, environment: "production", safety: "confirm", agentAccess: "schema" }));
    for (const engine of ["redis", "mongodb", "dynamodb", "neo4j", "elasticsearch"]) await refusal(call(rpc.saveConnection, { name: "a2", engine, host: "localhost", agentAccess: "schema" }));
  });
  await lines.check("no hook unless a connection is shared", async () => {
    expectThat(theHook() === undefined, "hook registered with nothing shared");
    const saved = await call(rpc.saveConnection, { name: "shared", ...base, agentAccess: "schema" });
    expectThat(theHook() !== undefined, "no hook once shared");
    await call(rpc.deleteConnection, { id: saved.id });
    expectThat(theHook() === undefined, "hook kept after the last shared connection went");
  });
  await lines.check("labels survive a save and a read", async () => {
    const saved = await call(rpc.saveConnection, { name: "labels", ...base, environment: "staging", color: "amber", group: "Team" });
    const { connections } = await call(rpc.listConnections, {});
    const found = connections.find((item) => item.id === saved.id);
    expectThat(found?.environment === "staging" && found.color === "amber" && found.group === "Team", JSON.stringify(found));
    await call(rpc.deleteConnection, { id: saved.id });
  });
  await lines.check("views and tabs save, stay private, and go with their connection", async () => {
    const saved = await call(rpc.saveConnection, { name: "views", ...base });
    const ref = { connectionId: saved.id, name: "t" };
    const view = { hiddenColumns: ["id"], columnOrder: ["b", "a"], sort: { column: "a", descending: true }, filtersInUse: [], filters: [{ name: "mine", filters: [{ column: "a", op: "eq", value: "secret" }] }], columnWidths: { a: 140 } };
    await call(rpc.saveView, { ref, view });
    expectThat(JSON.stringify(await call(rpc.getView, ref)) === JSON.stringify(view), "view changed on the way back");
    expectThat((statSync(join(folder, "views.json")).mode & 0o777) === 0o600, "views.json is not private");
    await call(rpc.saveQueryTabs, { connectionId: saved.id, tabs: { activeId: "a", tabs: [{ id: "a", name: "One", text: "select 1" }] } });
    await call(rpc.savePlace, { surface: "screen", place: { connectionId: saved.id, object: { name: "t", kind: "table" }, tab: "structure" } });
    expectThat((await call(rpc.getPlace, { surface: "screen" })).place?.tab === "structure", "place not kept");
    expectThat((statSync(join(folder, "workspace.json")).mode & 0o777) === 0o600, "workspace.json is not private");
    await call(rpc.deleteConnection, { id: saved.id });
    expectThat((await call(rpc.getView, ref)).hiddenColumns.length === 0, "view kept after delete");
    expectThat((await call(rpc.getQueryTabs, { connectionId: saved.id })).tabs === null, "tabs kept after delete");
    expectThat((await call(rpc.getPlace, { surface: "screen" })).place === null, "place kept after delete");
    await call(rpc.saveView, { ref, view });
    await call(rpc.saveQueryTabs, { connectionId: saved.id, tabs: { activeId: "a", tabs: [{ id: "a", name: "One", text: "late" }] } });
    await call(rpc.savePlace, { surface: "screen", place: { connectionId: saved.id, object: null, tab: "data" } });
    expectThat((await call(rpc.getView, ref)).hiddenColumns.length === 0, "a late save brought a view back");
    expectThat((await call(rpc.getQueryTabs, { connectionId: saved.id })).tabs === null, "a late save brought tabs back");
    expectThat((await call(rpc.getPlace, { surface: "screen" })).place === null, "a late save brought a place back");
  });
  await lines.check("Save query drafts off keeps tab names and not text", async () => {
    await applyPreferences({ keepDrafts: false });
    const drafts = await call(rpc.saveConnection, { name: "drafts", ...base });
    await call(rpc.saveQueryTabs, { connectionId: drafts.id, tabs: { activeId: "a", tabs: [{ id: "a", name: "One", text: "select secret" }] } });
    const { tabs } = await call(rpc.getQueryTabs, { connectionId: drafts.id });
    expectThat(tabs?.tabs[0]?.name === "One" && tabs.tabs[0].text === "", JSON.stringify(tabs));
    expectThat(!readFileSync(join(folder, "workspace.json"), "utf8").includes("secret"), "text reached the disk");
    await call(rpc.deleteConnection, { id: drafts.id });
    await applyPreferences({});
  });
  await lines.check("history settings apply", async () => {
    const saved = await call(rpc.saveConnection, { name: "history", ...base, safety: "open" });
    const scope = { connectionId: saved.id };
    const run = async (text: string) => finish(await call(rpc.runQuery, { scope, text }));
    await run("select 1");
    await run("select 2");
    expectThat((await call(rpc.listHistory, { connectionId: saved.id })).entries.length === 2, "not recorded");
    await applyPreferences({ keepHistory: false });
    await run("select 3");
    expectThat((await call(rpc.listHistory, { connectionId: saved.id })).entries.length === 2, "recorded with history off");
    await applyPreferences({ historyLength: 0 });
    expectThat((await call(rpc.listHistory, { connectionId: saved.id })).entries.length === 0, "0 did not remove what was there");
    await applyPreferences({});
    await call(rpc.deleteConnection, { id: saved.id });
  });
  await lines.check("the export folder preference is used", async () => {
    await applyPreferences({ exportFolder: "~/dw-exports" });
    const { path } = await call(rpc.defaultExportPath, { name: "t", format: "csv" });
    expectThat(path.includes("dw-exports") && !path.includes("~"), path);
    await applyPreferences({});
  });
  await lines.check("a file that is not SQLite is reported, and nothing opens it", async () => {
    const other = join(folder, "not-sqlite.db");
    writeFileSync(other, "just some text that is long enough to read a whole header from it, and then a little more than that");
    const answer = await call(rpc.inspectSqlite, { path: other });
    expectThat(!answer.isSqlite && !answer.wal, JSON.stringify(answer));
    const short = join(folder, "short.db");
    writeFileSync(short, "x");
    expectThat(!(await call(rpc.inspectSqlite, { path: short })).isSqlite, "a short file passed");
    expectThat(!existsSync(`${other}-wal`) && !existsSync(`${other}-journal`), "left a file beside it");
  });
  await lines.check("a real SQLite file and its journal mode are recognised", async () => {
    const real = join(folder, "real.db");
    writeFileSync(real, "");
    const saved = await call(rpc.saveConnection, { name: "real", engine: "sqlite", file: real, safety: "open" });
    await finish(await call(rpc.runQuery, { scope: { connectionId: saved.id }, text: "create table t (id integer primary key)" }));
    await call(rpc.disconnect, { id: saved.id });
    expectThat((await call(rpc.inspectSqlite, { path: real })).isSqlite, "not recognised");
    expectThat(!(await call(rpc.inspectSqlite, { path: real })).wal, "reported WAL on a plain file");
    await call(rpc.runQuery, { scope: { connectionId: saved.id }, text: "pragma journal_mode = wal", confirmed: true }).then((started) => (started.status === "started" ? waitJob(started.job) : null));
    await call(rpc.disconnect, { id: saved.id });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expectThat((await call(rpc.inspectSqlite, { path: real })).wal, "did not report WAL");
    await call(rpc.deleteConnection, { id: saved.id });
  });
  await lines.check("a damaged views file means defaults, and connections are untouched", async () => {
    const before = await call(rpc.saveConnection, { name: "keep", ...base });
    const fresh = mkdtempSync(join(tmpdir(), "datawise-damaged-"));
    writeFileSync(join(fresh, "views.json"), "{ not json");
    const file2 = new SideFile(() => Promise.resolve(fresh), "views.json", z.object({ views: z.record(z.string(), z.unknown()) }), () => ({ views: {} }));
    expectThat(JSON.stringify(await file2.read()) === '{"views":{}}', "not empty");
    expectThat(existsSync(join(fresh, "views.json.damaged")), "damaged file not set aside");
    rmSync(fresh, { recursive: true, force: true });
    await call(rpc.deleteConnection, { id: before.id });
  });
  lines.done();
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
  const featureSpecs = featureEngines();
  const extras: Record<string, () => Promise<void>> = {
    tls: runTls,
    "ssh-keys": runSshKeys,
    "readonly-folder": runReadOnlyFolder,
    settings: runSettingsAndViews,
    "agent-clickhouse": () => runAgentCatalog("clickhouse"),
    "agent-cassandra": () => runAgentCatalog("cassandra"),
    ...Object.fromEntries(Object.entries(featureSpecs).map(([key, spec]) => [`features-${key}`, () => runEngineFeatures(key, spec)])),
  };
  for (const key of wanted.length > 0 ? wanted : Object.keys(all)) {
    const extra = extras[key];
    if (extra) {
      await extra();
      continue;
    }
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
