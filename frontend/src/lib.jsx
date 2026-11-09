/** 여러 화면에서 같이 쓰는 도우미 (API 호출 · 아이콘 · 숫자/날짜 표시) */
import React from "react";

/** GET(body 없음) / POST(body 있음) · 오류면 서버의 error 문구로 throw */
export async function api(path, body, signal) {
  const r = await fetch("/api" + path, {
    signal,
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "요청에 실패했습니다.");
  return d;
}

/** PATCH · DELETE 같은 다른 메서드 */
export async function apiSend(method, path, body) {
  const r = await fetch("/api" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(d.error || "요청에 실패했습니다.");
  return d;
}

/** 선 아이콘 (인스타그램 스타일 · 글자색을 따라감) */
export const ICON_PATHS = {
  thumb: (
    <>
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </>
  ),
  smile: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01" />
      <path d="M15 9h.01" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  check: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  alert: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  logout: (
    <>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </>
  ),
  tag: (
    <>
      <path d="M12.59 2.59A2 2 0 0 0 11.17 2H4a2 2 0 0 0-2 2v7.17a2 2 0 0 0 .59 1.42l8.7 8.7a2.43 2.43 0 0 0 3.42 0l6.58-6.58a2.43 2.43 0 0 0 0-3.42z" />
      <path d="M7.5 7.5h.01" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  back: <path d="m15 18-6-6 6-6" />,
  heart: (
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  ),
};
export function Icon({ name, filled = false, size = 16, label }) {
  return (
    <svg
      className={`icon icon-${name}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

// ───────── 표시용 도우미 ─────────
export const KO_SCORE_LABELS = {
  1: "압도적으로 부정적",
  2: "매우 부정적",
  3: "부정적",
  4: "대체로 부정적",
  5: "복합적",
  6: "대체로 긍정적",
  7: "긍정적",
  8: "매우 긍정적",
  9: "압도적으로 긍정적",
};
export const won = (n) => `₩ ${Number(n).toLocaleString()}`;
export const numText = (n) => (n == null ? "—" : Number(n).toLocaleString());
export function hoursText(minutes) {
  if (minutes == null) return "—";
  const hours = Math.floor(minutes / 60);
  return hours >= 1 ? `${hours.toLocaleString()}시간` : `${minutes}분`;
}
export const dateText = (unix) => (unix ? new Date(unix * 1000).toLocaleDateString("ko-KR") : "—");

/** 가격: 무료 · 출시 예정 · 할인(정가 취소선 + 할인율) · 정가 */
export function PriceTag({ game }) {
  if (game.isFree) return <span className="pricetag">무료</span>;
  const final = game.finalPrice ?? (game.priceAvailable === false ? null : game.price);
  if (final == null) return <span className="pricetag muted">{game.comingSoon ? "출시 예정" : "가격 정보 없음"}</span>;
  if (game.discountPct > 0 && game.initialPrice) {
    return (
      <span className="pricetag">
        <span className="discount">-{game.discountPct}%</span>
        <s>{won(game.initialPrice)}</s> <b>{won(final)}</b>
      </span>
    );
  }
  return <span className="pricetag">{won(final)}</span>;
}

/** 주간 최다 플레이 순위 변화 — change = SQL의 last_week_rank - rank_no (지난주 순위 없으면 NULL → NEW) */
export function RankChange({ rank, change }) {
  if (rank == null) return null;
  if (change == null) return <span className="rank-change is-new">NEW</span>;
  const diff = change;
  if (diff > 0) return <span className="rank-change is-up">▲{diff}</span>;
  if (diff < 0) return <span className="rank-change is-down">▼{-diff}</span>;
  return <span className="rank-change">–</span>;
}

