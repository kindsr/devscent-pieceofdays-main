/** 실제 로그인·저장소가 없을 때(F1 운영 빌드 기본) 보여 주는 안내. 가짜 기록이나 저장 성공을 보여 주지 않는다. */
export function NotConnected({ title, readFailed = false }: { title: string; readFailed?: boolean }) {
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>{title}</h1>
      </header>
      <section className="notice" aria-labelledby="nc-h">
        <h2 id="nc-h">{readFailed ? "기록을 불러오지 못했어요" : "아직 준비 중이에요"}</h2>
        <p>{readFailed ? "잠시 뒤 다시 열어 주세요." : "로그인과 기록 저장이 아직 연결되지 않은 앱 골격이에요. 기록을 쓰거나 불러올 수 없어요."}</p>
      </section>
    </>
  );
}
