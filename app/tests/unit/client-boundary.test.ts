// F3 slice ① RED — client→server import lint 경계(PLAN_mvp-domain-storage §1 lint 경계, §5 ①-a).
// 고정된 eslint의 ESLint.lintText에 가상 filePath를 넘겨 판정한다. 파일·DB·서버를 만들지 않고 grep으로 대신하지 않는다.
// 이미 통과하는 양성 제어(Konva 금지 유지·decorate Konva 허용·app server 허용·shared 타입 허용)는
// 각 it 안에서 먼저 확인한다. 그 뒤의 server 금지 단언이 미구현이면 실패한다(RED).
// 오류는 ruleId === "no-restricted-imports"로만 센다. 다른 규칙 오류·구문 오류·무시 경고는 환경 문제로 따로 실패시킨다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));
const RULE = "no-restricted-imports";
const LINT_TIMEOUT = 30_000;

let eslint: ESLint | undefined;
function getEslint(): ESLint {
  eslint ??= new ESLint({ cwd: APP_DIR });
  return eslint;
}

/** 가상 경로로 lint하고 메시지를 돌려준다. 구문 오류·무시된 파일은 RED가 아니라 환경 문제로 실패시킨다. */
async function lint(file: string, code: string): Promise<Linter.LintMessage[]> {
  const results = await getEslint().lintText(code, { filePath: path.join(APP_DIR, file) });
  expect(results).toHaveLength(1);
  const messages = results[0]!.messages;
  const env = messages.filter((m) => m.fatal || m.ruleId === null);
  expect(env, `lint environment problem for virtual ${file}: ${JSON.stringify(env)}`).toEqual([]);
  // 예제 코드는 다른 규칙에 걸리지 않게 썼다. 다른 규칙 메시지가 섞이면 거짓 통과·거짓 실패를 막기 위해 실패한다.
  const other = messages.filter((m) => m.ruleId !== RULE);
  expect(other, `unexpected non-${RULE} messages for ${file}: ${JSON.stringify(other)}`).toEqual([]);
  return messages;
}

/** no-restricted-imports 오류(severity 2)가 난 줄 번호. */
async function restrictedLines(file: string, code: string): Promise<number[]> {
  const messages = await lint(file, code);
  return messages.filter((m) => m.ruleId === RULE && m.severity === 2).map((m) => m.line);
}

async function expectAllowed(file: string, code: string): Promise<void> {
  expect(await restrictedLines(file, code), `${file} should be allowed:\n${code}`).toEqual([]);
}

const KONVA = 'import Konva from "konva";\nexport const k = Konva;\n';
const SHARED_DIARY_TYPE = 'import type { DiaryDay } from "@/shared/diary";\nexport type Day = DiaryDay;\n';

/** 기존 경계(이미 통과해야 하는 양성 제어). */
async function expectExistingBoundary(): Promise<void> {
  // 기존 Konva 금지는 ui/d에서 그대로 오류다(server 금지 블록과 합성해도 덮어쓰지 않아야 한다).
  expect(await restrictedLines("src/ui/d/x.tsx", KONVA)).toEqual([1]);
  // decorate 안에서는 Konva가 허용된다.
  await expectAllowed("src/ui/decorate/x.tsx", KONVA);
  // 서버 컴포넌트(src/app)는 server import가 허용된다.
  await expectAllowed(
    "src/app/x.tsx",
    'import { getDiaryContext } from "@/server/context";\nexport const ctx = getDiaryContext;\n',
  );
  // UI가 공유 타입 모듈을 type import하는 것은 허용된다.
  await expectAllowed("src/ui/d/x.tsx", SHARED_DIARY_TYPE);
}

describe("F3 client→server import boundary (ESLint lintText, PLAN §5 ①-a)", () => {
  it(
    "src/ui/d: alias @/server type import and value import are no-restricted-imports errors",
    async () => {
      await expectExistingBoundary();
      expect(
        await restrictedLines(
          "src/ui/d/x.tsx",
          'import type { DiaryDay } from "@/server/diary/store";\nexport type Day = DiaryDay;\n',
        ),
      ).toEqual([1]);
      expect(
        await restrictedLines(
          "src/ui/d/x.tsx",
          'import { getDiaryContext } from "@/server/context";\nexport const ctx = getDiaryContext;\n',
        ),
      ).toEqual([1]);
      // 하위 경로 없는 alias "@/server" 자체도 금지 대상이다.
      expect(
        await restrictedLines("src/ui/d/x.tsx", 'import type * as S from "@/server";\nexport type K = keyof typeof S;\n'),
      ).toEqual([1]);
      // 공유 타입 import와 섞여 있어도 server import 줄만 오류다.
      expect(
        await restrictedLines(
          "src/ui/d/x.tsx",
          'import type { DiaryDay } from "@/shared/diary";\nimport type { DiaryStore } from "@/server/diary/store";\nexport type T = [DiaryDay, DiaryStore];\n',
        ),
      ).toEqual([2]);
    },
    LINT_TIMEOUT,
  );

  it(
    "src/ui/d: relative ../../server/** import (value and type) is a no-restricted-imports error",
    async () => {
      await expectExistingBoundary();
      expect(
        await restrictedLines(
          "src/ui/d/x.tsx",
          'import { createMemoryDiaryStore } from "../../server/diary/store.memory";\nexport const c = createMemoryDiaryStore;\n',
        ),
      ).toEqual([1]);
      expect(
        await restrictedLines(
          "src/ui/d/x.tsx",
          'import type { DiaryDay } from "../../server/diary/store";\nexport type Day = DiaryDay;\n',
        ),
      ).toEqual([1]);
    },
    LINT_TIMEOUT,
  );

  it(
    "src/ui/d: Konva and server bans are both enforced in the same file (combined block, not overridden)",
    async () => {
      await expectExistingBoundary();
      expect(
        await restrictedLines(
          "src/ui/d/x.tsx",
          'import Konva from "konva";\nimport type { DiaryDay } from "@/server/diary/store";\nexport const k = Konva;\nexport type Day = DiaryDay;\n',
        ),
      ).toEqual([1, 2]);
    },
    LINT_TIMEOUT,
  );

  it(
    "src/shared: relative ../server/** and alias @/server/** imports are no-restricted-imports errors",
    async () => {
      await expectExistingBoundary();
      // shared 안의 shared import는 허용된다(양성 제어).
      await expectAllowed("src/shared/x.ts", 'import { parseLocalDate } from "./local-date";\nexport const p = parseLocalDate;\n');
      expect(
        await restrictedLines("src/shared/x.ts", 'import { isUuid } from "../server/ids";\nexport const u = isUuid;\n'),
      ).toEqual([1]);
      expect(
        await restrictedLines(
          "src/shared/x.ts",
          'import type { DiaryContext } from "@/server/context";\nexport type C = DiaryContext;\n',
        ),
      ).toEqual([1]);
      // Konva 금지도 shared에서 유지된다.
      expect(await restrictedLines("src/shared/x.ts", KONVA)).toEqual([1]);
    },
    LINT_TIMEOUT,
  );

  it(
    "src/ui/decorate: Konva stays allowed but @/server/** import is a no-restricted-imports error",
    async () => {
      await expectExistingBoundary();
      expect(
        await restrictedLines(
          "src/ui/decorate/x.tsx",
          'import { getDiaryContext } from "@/server/context";\nexport const ctx = getDiaryContext;\n',
        ),
      ).toEqual([1]);
      expect(
        await restrictedLines(
          "src/ui/decorate/x.tsx",
          'import Konva from "konva";\nimport type { DiaryDay } from "@/server/diary/store";\nexport const k = Konva;\nexport type Day = DiaryDay;\n',
        ),
      ).toEqual([2]);
    },
    LINT_TIMEOUT,
  );
});
