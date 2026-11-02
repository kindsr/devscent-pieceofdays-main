/** 실제 로그인·저장소가 없을 때(F1 운영 빌드 기본) 보여 주는 안내. 가짜 기록이나 저장 성공을 보여 주지 않는다. */
export function NotConnected({ title }: { title: string }) {
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>{title}</h1>
      </header>
      <section className="notice" aria-labelledby="nc-h">
        <h2 id="nc-h">아직 준비 중이에요</h2>
        <p>로그인과 기록 저장이 아직 연결되지 않은 앱 골격이에요. 기록을 쓰거나 불러올 수 없어요.</p>
      </section>
    </>
  );
}
