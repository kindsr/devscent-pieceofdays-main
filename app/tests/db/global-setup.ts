// vitest.db.config.ts globalSetup: 환경을 먼저 검사(fail closed)하고 CI role을 준비한다.
// DB는 만들지 않는다. 시험 파일이 helpers.createDisposableDatabase로 자기 DB를 만들고 지운다.
import { CI_ROLES, assertServerIs18, bootstrapRoles, closeAllClients, readDisposableEnv, withAdmin } from "./helpers";

export default async function setup(): Promise<void> {
  try {
    const env = readDisposableEnv();
    await withAdmin(env, async (admin) => {
      const version = await assertServerIs18(admin);
      const { created } = await bootstrapRoles(admin);
      const reused = Object.values(CI_ROLES).filter((r) => !created.includes(r));
      console.log(`[db-harness] server_version_num=${version} roles created=[${created.join(",")}] reused=[${reused.join(",")}]`);
    });
  } catch (err) {
    // vitest 5.0.5는 globalSetup 오류의 stack을 해석하다 실패해 원래 메시지를 숨길 수 있다.
    // 메시지(비밀값 제거됨)를 먼저 출력하고, stack을 메시지로 고정한 오류로 다시 던진다.
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    const out = new Error(message);
    out.stack = message;
    throw out;
  } finally {
    await closeAllClients();
  }
}
