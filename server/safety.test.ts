import { describe, expect, it } from "vitest";
import { classifyMongoStatement, splitMongoScript } from "./adapters/mongodb";
import { classifyCypher } from "./adapters/neo4j";
import { splitCommandLine } from "./adapters/redis";
import { classifyRequest, splitConsole } from "./adapters/elasticsearch";
import { checkDestroyName, gate } from "./safety";
import { checkedPath } from "./http";
import { splitStatements, type SqlDialect } from "./sql-script";

const classes = (text: string, dialect: SqlDialect) => splitStatements(text, dialect).map((statement) => statement.class);

describe("SQL classifier fails closed", () => {
  it.each([
    ["select * from t", "postgres"],
    ["SELECT a FROM t WHERE b = 'DROP TABLE x'", "postgres"],
    ['select "update" from t', "postgres"],
    ["with x as (select 1) select * from x", "postgres"],
    ["select replace(a, 'x', 'y') from t", "mysql"],
    ["show tables", "mysql"],
    ["select start, set_id from t", "postgres"],
    ["pragma table_info(t)", "sqlite"],
  ] as const)("reads: %s", (text, dialect) => {
    expect(classes(text, dialect)).toEqual(["read"]);
  });

  it.each([
    ["delete from t", "postgres"],
    ["with x as (delete from t returning *) select * from x", "postgres"],
    ["select * into u from t", "postgres"],
    ["select 1; drop table t", "postgres"],
    ["copy t to program 'id'", "postgres"],
    ["do $$ begin delete from t; end $$", "postgres"],
    ["/*! delete from t */", "mysql"],
    ["select 1 /*! into outfile '/x' */", "mysql"],
    ["select 1 delete from t", "mssql"],
    ["select 1 set implicit_transactions off", "mssql"],
    ["exec('delete from t')", "mssql"],
    ["select * from openrowset('a','b','c')", "mssql"],
    ["begin delete from t; end;", "oracle"],
    ["vacuum into '/x'", "sqlite"],
    ["pragma writable_schema = 1", "sqlite"],
    ["commit", "postgres"],
    ["set transaction read write", "postgres"],
    ["with x as (select E'\\'') delete from t --'", "postgres"],
    ["select $é$ a $é$; delete from t", "postgres"],
    ["with x as (select 1--1) delete from t", "mysql"],
    ["select 1--1 into outfile '/x'", "mysql"],
    ["select [a'b] from t; delete from t", "sqlite"],
    ["select 1 deny select on t to u", "mssql"],
    ["select 1 disable trigger x on t", "mssql"],
  ] as const)("not reads: %s", (text, dialect) => {
    expect(classes(text, dialect).every((item) => item === "read")).toBe(false);
  });

  it("treats explain analyze as not a read in Postgres", () => {
    expect(classes("explain analyze select 1", "postgres")).toEqual(["unknown"]);
  });

  it("treats a comment-only statement as not a read", () => {
    expect(classes("/* nothing */", "postgres")).toEqual(["unknown"]);
  });
});

describe("statement splitting", () => {
  it("keeps semicolons inside strings, comments and dollar quotes", () => {
    expect(splitStatements("select ';'; select 1 -- a;b\n; select $x$ ; $x$;", "postgres").map((item) => item.text)).toHaveLength(3);
  });

  it("does not take a backslash escape as the end of a MySQL string", () => {
    expect(splitStatements("select 'a\\'; drop table t'", "mysql")).toHaveLength(1);
  });

  it("does not apply backslash escapes in Postgres", () => {
    expect(classes("select 'a\\'; drop table t; select '", "postgres")).toContain("write");
  });

  it("follows GO on SQL Server and a slash on Oracle", () => {
    expect(splitStatements("select 1\nGO\nselect 2", "mssql")).toHaveLength(2);
    expect(splitStatements("begin null; null; end;\n/\nselect 1 from dual", "oracle")).toHaveLength(2);
  });

  it("follows DELIMITER on MySQL", () => {
    expect(splitStatements("DELIMITER //\ncreate procedure p() begin select 1; end//\nDELIMITER ;\nselect 2;", "mysql")).toHaveLength(2);
  });
});

describe("the write gate", () => {
  const base = { writes: true, confirmed: false, preview: "x" };
  it("refuses on read-only even when confirmed", () => {
    expect(() => gate({ ...base, mode: "read-only", confirmed: true })).toThrow(/read-only/);
  });
  it("asks on confirm until confirmed", () => {
    expect(gate({ ...base, mode: "confirm" }).kind).toBe("confirm");
    expect(gate({ ...base, mode: "confirm", confirmed: true }).kind).toBe("run");
  });
  it("lets a read through on read-only", () => {
    expect(gate({ ...base, mode: "read-only", writes: false }).kind).toBe("run");
  });
  it("needs the exact name to destroy", () => {
    expect(() => checkDestroyName("users", "user")).toThrow();
    expect(() => checkDestroyName("users", "users")).not.toThrow();
  });
});

describe("other query languages", () => {
  it("MongoDB: reads, writes, and writing stages", () => {
    expect(classifyMongoStatement("db.a.find({})").class).toBe("read");
    expect(classifyMongoStatement("db.a.deleteMany({})").class).toBe("write");
    expect(classifyMongoStatement('db.a.aggregate([{$out:"b"}])').class).toBe("write");
    expect(classifyMongoStatement('db.a.aggregate([{$lookup:{pipeline:[{$merge:"b"}]}}])').class).toBe("write");
    expect(classifyMongoStatement("db.runCommand({drop:'a'})").class).toBe("write");
    expect(classifyMongoStatement("process.exit(1)").class).toBe("unknown");
  });
  it("MongoDB: splits statements on new db lines", () => {
    expect(splitMongoScript('db.a.find({x:"; db.b"})\ndb.b.find({})')).toHaveLength(2);
  });
  it("Cypher", () => {
    expect(classifyCypher("match (n) return n")).toBe("read");
    expect(classifyCypher("match (n) return 'create' as x")).toBe("read");
    expect(classifyCypher("match (n) detach delete n")).toBe("write");
    expect(classifyCypher("call db.createLabel('x')")).toBe("write");
    expect(classifyCypher("foo")).toBe("write");
    expect(classifyCypher("match (n:Page) where n.url = 'https://old.example' detach delete n")).toBe("write");
    expect(classifyCypher("match (n) return n // delete")).toBe("read");
    expect(classifyCypher("match (n) return n /* ' */ detach delete n")).toBe("write");
  });
  it("Redis command lines", () => {
    expect(splitCommandLine(`SET a "b c\\n" 'd e'`)).toEqual(["SET", "a", "b c\n", "d e"]);
    expect(() => splitCommandLine('GET "a')).toThrow();
  });
  it("Elasticsearch requests", () => {
    expect(classifyRequest("GET", "/a/_search")).toBe("read");
    expect(classifyRequest("POST", "/a/_search")).toBe("read");
    expect(classifyRequest("POST", "/a/_delete_by_query")).toBe("write");
    expect(classifyRequest("POST", "/a/_update/1")).toBe("write");
    expect(classifyRequest("DELETE", "/a")).toBe("write");
    expect(classifyRequest("POST", "/_bulk?filter_path=/_search")).toBe("write");
    expect(classifyRequest("POST", "/_bulk/_search")).toBe("write");
    expect(classifyRequest("POST", "/a/../_bulk")).toBe("write");
    expect(classifyRequest("GET", "/a/../_search")).toBe("write");
    expect(classifyRequest("POST", "/%5Fbulk/_search")).toBe("write");
    expect(classifyRequest("POST", "/_all/_search?size=1")).toBe("read");
    expect(splitConsole('GET /a/_search\n{"a":1}\nDELETE /b')).toHaveLength(2);
  });
});

describe("HTTP paths stay on the configured server", () => {
  it.each(["//evil.example/x", "http://evil.example/", "x", "/a\\b", "/a b"])("refuses %s", (path) => {
    expect(() => checkedPath(path)).toThrow();
  });
  it("allows a normal path", () => {
    expect(checkedPath("/a/_search?size=1")).toBe("/a/_search?size=1");
  });
});
