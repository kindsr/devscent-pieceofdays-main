import Link from "next/link";
import type { DiaryDay } from "@/shared/diary";
import { WEEK, dateLabel } from "@/shared/local-date";
import { SAMPLE_IMAGES } from "./sample-images";

/** D 모아보기 달력 한 달. 조각이 있는 날만 누를 수 있고, 첫 사진 조각을 덮개로 보여 준다. */
export function MonthCalendar({ year, month, days, today, picked }: { year: number; month: number; days: DiaryDay[]; today: string; picked: string | null }) {
  const start = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells = [];
  for (let i = 0; i < start; i++) cells.push(<li key={`b${i}`} aria-hidden="true" />);
  for (let d = 1; d <= count; d++) {
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const day = byDate.get(iso);
    if (day && day.moments.length) {
      const cover = day.moments.find((m) => m.image);
      cells.push(
        <li key={iso}>
          <Link className="cell" href={`/days/${iso}`} aria-current={picked === iso ? "date" : undefined} aria-label={`${dateLabel(iso)}, 조각 ${day.moments.length}개`}>
            <span className="n" aria-hidden="true">
              {d}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {cover?.image ? <img src={SAMPLE_IMAGES[cover.image].src} alt="" /> : null}
          </Link>
        </li>,
      );
    } else {
      cells.push(
        <li key={iso}>
          <span className={`cell ${iso > today ? "future" : "none"}`}>
            <span className="n">{d}</span>
          </span>
        </li>,
      );
    }
  }
  return (
    <section className="cal" aria-label={`${year}년 ${month}월`}>
      <h2>
        {year}년 {month}월
      </h2>
      <ul className="cal-grid">
        {WEEK.map((w) => (
          <li key={w} className="wk" aria-hidden="true">
            {w}
          </li>
        ))}
        {cells}
      </ul>
    </section>
  );
}
