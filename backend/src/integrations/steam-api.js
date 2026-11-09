/**
 * Steam API 호출 모음 (수집 스크립트에서 사용) · 설계서의 원본 API 3종 + 접속자
 *  ① GetMostPlayedGames  주간 최다 플레이 순위 (키 불필요)
 *  ② appdetails          게임 상세 · 장르 · 회사 · 가격 · 소개 (키 불필요, 약 5분 200회)
 *  ③ GetAppReviews       리뷰 · 한국어 query_summary (키 불필요)
 *  +  GetNumberOfCurrentPlayers  동시 접속자 수
 * 모든 호출은 setApiLogger로 지정한 함수로 기록됩니다 (api_call_logs).
 */
import { setTimeout as delay } from "node:timers/promises";

let apiLogger = null;
/** fn({ api, appid, status, count, error }) — 실패해도 수집은 계속 */
export function setApiLogger(fn) {
  apiLogger = fn;
}
async function log(entry) {
  if (!apiLogger) return;
  try {
    await apiLogger(entry);
  } catch {
    // 기록 실패는 무시
  }
}

export async function fetchJson(url, { headers = {}, tries = 4, api = "unknown", appid = null, count = () => null } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
    } catch (error) {
      await log({ api, appid, status: null, count: null, error: error.message });
      if (attempt >= tries) throw error;
      await delay(5000 * attempt);
      continue;
    }
    if (response.ok) {
      const json = await response.json();
      let n = null;
      try {
        n = count(json);
      } catch {
        n = null;
      }
      await log({ api, appid, status: response.status, count: n, error: null });
      return json;
    }

    await response.body?.cancel();
    await log({ api, appid, status: response.status, count: null, error: `HTTP ${response.status}` });
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= tries) {
      throw new Error(`HTTP ${response.status} · ${api}${appid ? ` · ${appid}` : ""}`);
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Math.max(5000 * 2 ** (attempt - 1), Number.isFinite(retryAfter) ? retryAfter * 1000 : 0);
    console.warn(`HTTP ${response.status} · ${Math.round(wait / 1000)}초 후 재시도 (${attempt}/${tries - 1})`);
    await delay(wait);
  }
}

function keyHeaders() {
  const key = process.env.STEAM_WEB_API_KEY?.trim();
  return key ? { "x-webapi-key": key } : {};
}

/** ① 주간 최다 플레이 순위 상위 100 → { rollupDate: Date, ranks: [{ rank, appid, lastWeekRank|null, peak }] } */
export async function getMostPlayedGames() {
  const url = new URL("https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/");
  const json = await fetchJson(url, {
    api: "GetMostPlayedGames",
    count: (j) => j.response?.ranks?.length ?? 0,
  });
  const res = json?.response ?? {};
  if (!Array.isArray(res.ranks)) throw new Error("GetMostPlayedGames 응답에 ranks가 없습니다.");
  return {
    rollupDate: new Date(Number(res.rollup_date) * 1000),
    ranks: res.ranks.map((r) => ({
      rank: Number(r.rank),
      appid: Number(r.appid),
      lastWeekRank: Number(r.last_week_rank) > 0 ? Number(r.last_week_rank) : null, // -1 → NULL
      peak: Number(r.peak_in_game ?? 0),
    })),
  };
}

/** ② 게임 상세. 판매 중지 · 지역 제한 등으로 실패하면 null (success: false) */
export async function getAppDetails(appid) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("cc", "kr");
  url.searchParams.set("l", "koreana");
  const payload = await fetchJson(url, {
    api: "appdetails",
    appid,
    count: (j) => (j?.[String(appid)]?.success ? 1 : 0),
  });
  const entry = payload?.[String(appid)];
  if (!entry?.success || !entry.data) return null;
  return entry.data;
}

/** ③ 한국어 리뷰 1페이지. reviewType: 0 전체 · 1 추천 · 2 비추천 · filter 1 = 최신순 */
export async function getReviewPage(appid, { reviewType = 0, cursor = "*", perPage = 100 } = {}) {
  const url = new URL("https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/");
  url.searchParams.set(
    "input_json",
    JSON.stringify({
      appid,
      languages: ["koreana"],
      filter: 1,
      review_type: reviewType,
      purchase_type: 1,
      num_per_page: perPage,
      cursor,
    }),
  );
  const json = await fetchJson(url, {
    headers: keyHeaders(),
    api: "GetAppReviews",
    appid,
    count: (j) => (j.response ?? j)?.reviews?.length ?? 0,
  });
  const page = json?.response ?? json;
  if (!Array.isArray(page?.reviews)) {
    if (page?.query_summary?.num_reviews === 0) return { ...page, reviews: [] };
    throw Object.assign(new Error(`리뷰 응답 형식 오류 · appid ${appid}`), { code: "STEAM_REVIEW_PAGE_SHAPE" });
  }
  return page;
}

/** 한국어 기준 게임 요약 (첫 페이지에만 옴): { review_score, total_positive, total_negative, … } */
export async function getKoreanSummary(appid) {
  const page = await getReviewPage(appid, { reviewType: 0, cursor: "*", perPage: 1 });
  return page?.query_summary ?? null;
}

/** 현재 동시 접속자 수. 값이 없으면 null */
export async function getCurrentPlayers(appid) {
  const url = new URL("https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/");
  url.searchParams.set("appid", String(appid));
  const payload = await fetchJson(url, {
    headers: keyHeaders(),
    tries: 2,
    api: "GetNumberOfCurrentPlayers",
    appid,
    count: (j) => (j?.response?.result === 1 ? 1 : 0),
  });
  const count = payload?.response?.player_count;
  return payload?.response?.result === 1 && Number.isInteger(count) ? count : null;
}

/** "2016년 2월 27일" · "27 Feb, 2016" → "2016-02-27" (실패 시 null) */
export function parseReleaseDate(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const ko = raw.match(/(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (ko) return `${ko[1]}-${ko[2].padStart(2, "0")}-${ko[3].padStart(2, "0")}`;
  const time = Date.parse(raw.replace(",", ""));
  if (Number.isNaN(time)) return null;
  return new Date(time + 12 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 어절 수 (공백 기준) — 3어절 미만 리뷰는 수집하지 않음 */
export function wordCount(text) {
  return String(text ?? "")
    .replace(/\[\/?[^\]]+\]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}
