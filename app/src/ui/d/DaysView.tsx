import type { ReactNode } from "react";
import type { DiaryDay } from "@/shared/diary";
import { dateParts } from "@/shared/local-date";
import { DayBoard } from "./DayBoard";
import { MonthCalendar } from "./MonthCalendar";

/**
 * D 모아보기: 이번 달·지난달 달력 + (선택한 날이 있으면) 그날의 조각.
 * story가 있으면 원본이 0인 선택 날짜도 같은 날짜 key의 빈 보드로 유지한다(마지막 조각 삭제 뒤 알림·이야기 보존).
 * storyDates=null은 이야기 날짜 읽기 실패다. 원본 달력은 그대로 두고 경고만 따로 보인다.
 */
export function DaysView({ today, picked, thisMonth, lastMonth, day, mode = "fixture", photosEnabled = false, storyDates, story }: {
  today: string;
  picked: string | null;
  thisMonth: DiaryDay[];
  lastMonth: DiaryDay[];
  day: DiaryDay | null;
  mode?: "fixture" | "account";
  photosEnabled?: boolean;
  storyDates?: readonly string[] | null;
  story?: ReactNode;
}) {
  const shown = day ?? (picked && story ? { date: picked, summary: "", summaryVersion: null, moments: [] } : null);
  const t = dateParts(today);
  const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>모아보기</h1>
        <p className="sub">조각이 있는 날에 그날의 첫 조각이 보여요</p>
      </header>
      {storyDates === null ? <p className="err">AI 하루 이야기가 있는 날짜를 불러오지 못했어요. 조각이 있는 날은 그대로 볼 수 있어요.</p> : null}
      <div className="cal-wrap two">
        <MonthCalendar year={t.y} month={t.m} days={thisMonth} today={today} picked={picked} includeSummary={mode === "account"} storyDates={storyDates ?? []} />
        <MonthCalendar year={prev.y} month={prev.m} days={lastMonth} today={today} picked={picked} includeSummary={mode === "account"} storyDates={storyDates ?? []} />
      </div>
      <section className="picked" style={{ marginTop: 32 }}>
        {shown ? (
          <DayBoard key={shown.date} day={shown} mode={mode} photosEnabled={photosEnabled} isToday={shown.date === today} sub={shown.date === today ? "오늘" : "지난 날"} headingLevel={2} story={story} />
        ) : picked ? (
          <p className="cal-hint">이 날에는 조각이 없어요. 빈 날은 그냥 비워 둬요.</p>
        ) : (
          <p className="cal-hint">날짜를 누르면 그날의 조각이 여기에 펼쳐져요. 빈 날은 그냥 비워 둬요.</p>
        )}
      </section>
    </>
  );
}
