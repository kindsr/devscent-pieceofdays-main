/**
 * migration 파일 정책(PLAN_mvp-database §3). 실행기가 감싼 트랜잭션을 파일이 끊지 못하게 한다.
 *
 * 전역 정규식 대신 작은 문장 분리기를 쓴다. 주석(`--`, 중첩 `/* *\/`), 작은따옴표 문자열(E'' 포함),
 * 큰따옴표 식별자, 달러 인용(`$tag$ … $tag$`)을 건너뛴 뒤 최상위 `;`로 문장을 나누고
 * 각 문장의 첫 키워드를 검사한다. 위반하면 문장 번호·줄·키워드를 담은 오류를 던진다.
 *
 * DB 없이 동작하는 순수 함수다. Node 직접 실행(migrate-cli.ts)에서도 쓰므로 import가 없다.
 */

type Statement = { index: number; line: number; words: string[] };

export class SqlPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlPolicyError";
  }
}

const IDENT_START = /[A-Za-z_\u0080-￿]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

function countLines(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === "\n") n++;
  return n;
}

/** 최상위 문장마다 따옴표·주석 밖의 단어(대문자)를 모은다. 빈 문장은 넣지 않는다. */
function splitStatements(sql: string): Statement[] {
  const statements: Statement[] = [];
  let words: string[] = [];
  let firstLine = 0;
  let line = 1;
  let i = 0;
  const n = sql.length;

  const finish = () => {
    if (words.length > 0) statements.push({ index: statements.length + 1, line: firstLine, words });
    words = [];
    firstLine = 0;
  };
  const unterminated = (what: string, startLine: number): never => {
    throw new SqlPolicyError(`SQL policy violation: unterminated ${what} starting at line ${startLine}`);
  };

  while (i < n) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    if (ch === "\n") {
      line++;
      i++;
    } else if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? n : end;
    } else if (ch === "/" && next === "*") {
      const startLine = line;
      let depth = 1;
      i += 2;
      while (depth > 0) {
        if (i >= n) unterminated("block comment", startLine);
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          if (sql[i] === "\n") line++;
          i++;
        }
      }
    } else if (ch === "'") {
      // E'...' 문자열에서는 백슬래시가 다음 글자를 이스케이프한다. 바로 앞 단어가 정확히 E일 때만이다.
      const prev = words[words.length - 1];
      const escapes = prev === "E" && (sql[i - 1] === "E" || sql[i - 1] === "e");
      if (escapes) words.pop();
      const startLine = line;
      i++;
      for (;;) {
        if (i >= n) unterminated("string literal", startLine);
        const c = sql[i];
        if (c === "\n") line++;
        if (escapes && c === "\\") {
          if (sql[i + 1] === "\n") line++;
          i += 2;
        } else if (c === "'") {
          if (sql[i + 1] === "'") i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      if (firstLine === 0) firstLine = startLine;
    } else if (ch === '"') {
      const startLine = line;
      i++;
      for (;;) {
        if (i >= n) unterminated("quoted identifier", startLine);
        const c = sql[i];
        if (c === "\n") line++;
        if (c === '"') {
          if (sql[i + 1] === '"') i += 2;
          else {
            i++;
            break;
          }
        } else i++;
      }
      // 따옴표 식별자는 키워드가 아니다. 문장의 첫 단어 자리를 차지하도록 표시만 한다.
      words.push('"');
      if (firstLine === 0) firstLine = startLine;
    } else if (ch === "$" && !(i > 0 && IDENT_PART.test(sql[i - 1] as string)) && DOLLAR_TAG.test(sql.slice(i, i + 66))) {
      const tag = (DOLLAR_TAG.exec(sql.slice(i, i + 66)) as RegExpExecArray)[0];
      const startLine = line;
      const end = sql.indexOf(tag, i + tag.length);
      if (end === -1) unterminated(`dollar-quoted body ${tag}`, startLine);
      line += countLines(sql.slice(i, end + tag.length));
      i = end + tag.length;
      words.push("$");
      if (firstLine === 0) firstLine = startLine;
    } else if (ch === ";") {
      finish();
      i++;
    } else if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_PART.test(sql[j] as string)) j++;
      words.push(sql.slice(i, j).toUpperCase());
      if (firstLine === 0) firstLine = line;
      i = j;
    } else {
      if (!/\s/.test(ch) && firstLine === 0) firstLine = line;
      if (!/\s/.test(ch)) words.push(ch);
      i++;
    }
  }
  finish();
  return statements;
}

/** 금지 규칙에 걸리면 위반 키워드를, 아니면 null을 돌려준다. */
function violation(words: string[]): string | null {
  const [w0, w1, w2, w3] = words;
  switch (w0) {
    case "BEGIN":
    case "COMMIT":
    case "END":
    case "ROLLBACK":
    case "ABORT":
    case "SAVEPOINT":
    case "RELEASE":
    case "VACUUM":
      return w0;
    case "START":
      return w1 === "TRANSACTION" ? "START TRANSACTION" : null;
    case "PREPARE":
      return w1 === "TRANSACTION" ? "PREPARE TRANSACTION" : null;
    case "ALTER":
      return w1 === "SYSTEM" ? "ALTER SYSTEM" : null;
    case "CREATE":
      if (w1 === "DATABASE") return "CREATE DATABASE";
      if (w1 === "INDEX" && w2 === "CONCURRENTLY") return "CREATE INDEX CONCURRENTLY";
      if (w1 === "UNIQUE" && w2 === "INDEX" && w3 === "CONCURRENTLY") return "CREATE UNIQUE INDEX CONCURRENTLY";
      break;
  }
  // SQL 표준 함수 본문은 최상위 `;`로 쪼개져 문장 경계가 흐려지므로 쓰지 않는다(달러 인용 PL/pgSQL만).
  for (let k = 0; k + 1 < words.length; k++) {
    if (words[k] === "BEGIN" && words[k + 1] === "ATOMIC") return "BEGIN ATOMIC";
  }
  return null;
}

/** migration SQL이 정책을 지키면 아무것도 돌려주지 않고, 어기면 SqlPolicyError를 던진다. */
export function validateSqlPolicy(sql: string): void {
  for (const st of splitStatements(sql)) {
    const keyword = violation(st.words);
    if (keyword !== null) {
      throw new SqlPolicyError(
        `SQL policy violation at statement ${st.index} (line ${st.line}): ${keyword} is not allowed in a migration file`,
      );
    }
  }
}
