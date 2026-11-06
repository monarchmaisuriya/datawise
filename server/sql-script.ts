// Splits a script into statements and decides, without running them, whether each one can write.
// The rule is one-directional: a statement is "read" only when it is proved to be, and anything else
// counts as a write. A wrong "write" costs a prompt; a wrong "read" could cost data.
export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql" | "oracle" | "clickhouse" | "cassandra";
export type StatementClass = "read" | "write" | "unknown";

export interface Statement {
  text: string;
  class: StatementClass;
}

interface Scan {
  text: string;
  words: string[];
  // Next significant character after each word, so REPLACE( can be told from REPLACE INTO.
  followedByParen: boolean[];
}

const READ_HEADS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE", "WITH", "EXISTS"]);
const SQLITE_READ_PRAGMAS = new Set(["TABLE_INFO", "TABLE_XINFO", "TABLE_LIST", "INDEX_LIST", "INDEX_INFO", "INDEX_XINFO", "FOREIGN_KEY_LIST", "DATABASE_LIST", "COLLATION_LIST", "FUNCTION_LIST", "COMPILE_OPTIONS", "SCHEMA_VERSION", "USER_VERSION", "PAGE_COUNT", "PAGE_SIZE", "ENCODING", "INTEGRITY_CHECK", "QUICK_CHECK"]);
// These words cannot appear unquoted in a plain read, because each is reserved or starts a write.
const WRITE_WORDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT", "DROP", "CREATE", "ALTER", "TRUNCATE", "RENAME", "GRANT", "REVOKE", "INTO", "OUTFILE", "DUMPFILE", "EXEC", "EXECUTE", "COMMIT", "ROLLBACK", "ATTACH", "DETACH"]);
// T-SQL runs "SELECT 1 SET x OFF" and similar with no separator, and these words are reserved there.
const MSSQL_WRITE_WORDS = new Set(["SET", "BEGIN", "KILL", "SHUTDOWN", "BACKUP", "RESTORE", "DBCC", "USE", "RECONFIGURE", "BULK", "OPENROWSET", "OPENQUERY", "OPENDATASOURCE", "DENY", "DISABLE", "ENABLE", "RECEIVE", "SEND", "WRITETEXT", "UPDATETEXT", "CHECKPOINT", "OPEN", "CLOSE", "FETCH", "DEALLOCATE", "DECLARE", "GOTO", "IF", "WHILE"]);
// Functions that share a name with a write statement.
const FUNCTION_WORDS = new Set(["REPLACE", "TRUNCATE", "INSERT"]);

export function classifyScan(scan: Scan, dialect: SqlDialect): StatementClass {
  const head = scan.words[0];
  if (head === undefined) return "unknown";
  if (dialect === "sqlite" && head === "PRAGMA") {
    // A pragma with = changes a setting; a pragma not on the list may too.
    return !scan.text.includes("=") && SQLITE_READ_PRAGMAS.has(scan.words[1] ?? "") ? "read" : "unknown";
  }
  if (!READ_HEADS.has(head)) return "write";
  for (const [index, word] of scan.words.entries()) {
    if (WRITE_WORDS.has(word) && !(FUNCTION_WORDS.has(word) && scan.followedByParen[index])) return "write";
    if (dialect === "mssql" && MSSQL_WRITE_WORDS.has(word)) return "write";
    if (dialect === "postgres" && word === "ANALYZE" && head === "EXPLAIN") return "unknown";
  }
  return "read";
}

function matchLine(source: string, index: number, pattern: RegExp): string | null {
  if (index !== 0 && source[index - 1] !== "\n") return null;
  const end = source.indexOf("\n", index);
  const line = source.slice(index, end === -1 ? source.length : end);
  return pattern.test(line) ? line : null;
}

export function splitStatements(source: string, dialect: SqlDialect): Statement[] {
  const statements: Statement[] = [];
  let current = "";
  let words: string[] = [];
  let followedByParen: boolean[] = [];
  let delimiter = ";";
  // Nesting of BEGIN...END bodies, in which ; does not end a statement.
  let blockDepth = 0;
  // Oracle PL/SQL blocks end only at a line holding a single slash.
  let untilSlash = false;

  const flush = () => {
    const text = current.trim();
    if (text.length > 0 || words.length > 0) {
      if (text.length > 0) statements.push({ text, class: classifyScan({ text, words, followedByParen }, dialect) });
    }
    current = "";
    words = [];
    followedByParen = [];
    blockDepth = 0;
    untilSlash = false;
  };

  const noteWord = (word: string, nextIndex: number) => {
    const upper = word.toUpperCase();
    words.push(upper);
    let next = nextIndex;
    while (next < source.length && /\s/.test(source[next] ?? "")) next += 1;
    followedByParen.push(source[next] === "(");
    if (dialect === "oracle" && words.length <= 5 && !untilSlash) {
      const [first, second, third, fourth] = words;
      const named = first === "CREATE" && (second === "OR" ? third === "REPLACE" : true);
      const objectWord = second === "OR" ? fourth : second;
      if (first === "BEGIN" || first === "DECLARE" || (named && ["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE"].includes(objectWord ?? ""))) untilSlash = true;
    }
    const isTrigger = dialect === "sqlite" && words[0] === "CREATE" && words.includes("TRIGGER");
    const isAtomic = dialect === "postgres" && upper === "ATOMIC" && words[words.length - 2] === "BEGIN";
    if ((isTrigger && upper === "BEGIN") || isAtomic) blockDepth += 1;
    // T-SQL blocks hold ; of their own. BEGIN TRAN opens no block.
    if (dialect === "mssql" && upper === "BEGIN" && !/^(?:TRAN|TRANSACTION|DISTRIBUTED)\b/i.test(source.slice(next, next + 14))) blockDepth += 1;
    if (blockDepth > 0 && upper === "CASE") blockDepth += 1;
    if (blockDepth > 0 && upper === "END") blockDepth -= 1;
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const pair = source.slice(index, index + 2);

    if (dialect === "mssql") {
      const go = matchLine(source, index, /^\s*GO\s*$/i);
      if (go !== null) {
        flush();
        index += go.length;
        continue;
      }
    }
    if (dialect === "oracle") {
      const slash = matchLine(source, index, /^\s*\/\s*$/);
      if (slash !== null) {
        flush();
        index += slash.length;
        continue;
      }
    }
    if (dialect === "mysql") {
      const directive = matchLine(source, index, /^\s*DELIMITER\s+\S+\s*$/i);
      if (directive !== null) {
        flush();
        delimiter = directive.trim().split(/\s+/)[1] ?? ";";
        index += directive.length;
        continue;
      }
    }

    // Comments. MySQL runs the inside of /*! ... */, so those are read as ordinary text.
    // MySQL needs whitespace after --, so 1--1 is arithmetic there and what follows it still runs.
    const isDashComment = pair === "--" && (dialect !== "mysql" || /^\s?$/.test(source.slice(index + 2, index + 3)));
    if (isDashComment || (dialect === "mysql" && char === "#")) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      current += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (pair === "/*") {
      const isExecutable = dialect === "mysql" && (source.startsWith("/*!", index) || source.startsWith("/*M!", index));
      if (isExecutable) {
        const open = source.startsWith("/*!", index) ? 3 : 4;
        current += source.slice(index, index + open);
        index += open;
        while (index < source.length && /\d/.test(source[index] ?? "")) {
          current += source[index];
          index += 1;
        }
        continue;
      }
      // Dialects that nest block comments are the safe reading only when treated as nesting.
      let depth = 1;
      let cursor = index + 2;
      const nests = dialect === "postgres" || dialect === "mssql";
      while (cursor < source.length && depth > 0) {
        if (nests && source.startsWith("/*", cursor)) {
          depth += 1;
          cursor += 2;
        } else if (source.startsWith("*/", cursor)) {
          depth -= 1;
          cursor += 2;
        } else cursor += 1;
      }
      current += source.slice(index, cursor);
      index = cursor;
      continue;
    }
    if (dialect === "mysql" && pair === "*/") {
      current += pair;
      index += 2;
      continue;
    }

    // Strings and quoted identifiers.
    if (char === "'" || char === '"' || (char === "`" && dialect !== "postgres" && dialect !== "oracle") || (char === "[" && (dialect === "mssql" || dialect === "sqlite"))) {
      const close = char === "[" ? "]" : char;
      // E'...' is the one Postgres string form with backslash escapes.
      const postgresEscape = dialect === "postgres" && char === "'" && /(?:^|[^\p{L}\p{N}_$])[eE]$/u.test(source.slice(Math.max(0, index - 2), index));
      const backslash = ((dialect === "mysql" || dialect === "clickhouse") && char !== "`") || postgresEscape;
      let cursor = index + 1;
      while (cursor < source.length) {
        const inner = source[cursor];
        if (backslash && inner === "\\") {
          cursor += 2;
          continue;
        }
        if (inner === close) {
          if (source[cursor + 1] === close) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      current += source.slice(index, cursor + 1);
      index = cursor + 1;
      continue;
    }
    if (dialect === "postgres" && char === "$") {
      const tag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(source.slice(index, index + 80))?.[0];
      if (tag) {
        const end = source.indexOf(tag, index + tag.length);
        const stop = end === -1 ? source.length : end + tag.length;
        current += source.slice(index, stop);
        index = stop;
        continue;
      }
    }
    if (dialect === "oracle" && (pair === "q'" || pair === "Q'")) {
      const open = source[index + 2] ?? "";
      const close = { "[": "]", "{": "}", "(": ")", "<": ">" }[open] ?? open;
      const end = source.indexOf(`${close}'`, index + 3);
      const stop = end === -1 ? source.length : end + 2;
      current += source.slice(index, stop);
      index = stop;
      continue;
    }

    if (/[\p{L}_]/u.test(char)) {
      let cursor = index + 1;
      while (cursor < source.length && /[\p{L}\p{N}_$]/u.test(source[cursor] ?? "")) cursor += 1;
      const word = source.slice(index, cursor);
      current += word;
      noteWord(word, cursor);
      index = cursor;
      continue;
    }

    if (!untilSlash && blockDepth === 0 && source.startsWith(delimiter, index)) {
      flush();
      index += delimiter.length;
      continue;
    }
    current += char;
    index += 1;
  }
  flush();
  return statements;
}

// Cassandra allows only one statement per request and has no comments worth treating specially, but
// the same scan keeps quoting correct. Only these heads are reads there.
export function classifyCql(statement: Statement): StatementClass {
  const head = /^\s*([A-Za-z]+)/.exec(statement.text)?.[1]?.toUpperCase();
  if (head === "SELECT" || head === "DESCRIBE" || head === "DESC") return statement.class === "read" ? "read" : "write";
  return "write";
}
