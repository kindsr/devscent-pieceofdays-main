import type { DiaryDay } from "@/shared/diary";
import { dateParts } from "@/shared/local-date";
import { DayBoard } from "./DayBoard";
import { MonthCalendar } from "./MonthCalendar";

/** D 모아보기: 이번 달·지난달 달력 + (선택한 날이 있으면) 그날의 조각. */
export function DaysView({ today, picked, thisMonth, lastMonth, day, mode = "fixture", photosEnabled = false }: {
  today: string;
  picked: string | null;
  thisMonth: DiaryDay[];
  lastMonth: DiaryDay[];
  day: DiaryDay | null;
  mode?: "fixture" | "account";
  photosEnabled?: boolean;
}) {
  const t = dateParts(today);
  const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
  return (
    <>
      <header className="board-head">
        <h1 tabIndex={-1}>모아보기</h1>
        <p className="sub">조각이 있는 날에 그날의 첫 조각이 보여요</p>
      </header>
      <div className="cal-wrap two">
        <MonthCalendar year={t.y} month={t.m} days={thisMonth} today={today} picked={picked} includeSummary={mode === "account"} />
        <MonthCalendar year={prev.y} month={prev.m} days={lastMonth} today={today} picked={picked} includeSummary={mode === "account"} />
      </div>
      <section className="picked" style={{ marginTop: 32 }}>
        {day ? (
          <DayBoard key={day.date} day={day} mode={mode} photosEnabled={photosEnabled} isToday={day.date === today} sub={day.date === today ? "오늘" : "지난 날"} headingLevel={2} />
        ) : picked ? (
          <p className="cal-hint">이 날에는 조각이 없어요. 빈 날은 그냥 비워 둬요.</p>
        ) : (
          <p className="cal-hint">날짜를 누르면 그날의 조각이 여기에 펼쳐져요. 빈 날은 그냥 비워 둬요.</p>
        )}
      </section>
    </>
  );
}
