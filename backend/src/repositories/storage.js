/**
 * 기존 화면 API(/api/games · /api/search · /api/recommendations · 리뷰 목록)가 쓰는 조회 모음 — v2 테이블 기준
 *   GAME · GENRE · REVIEW (MySQL) + review_text (MongoDB, REVIEW.mongo_id = _id)
 */
import { ObjectId } from "mongodb";
import { readPool as pool, mongoDb, closeDb } from "../db.js";

// 화면의 검색 · 추천용 의미 키워드 (리뷰 본문에 이 단어가 있으면 그 키워드로 봄)
const keywordRules = {
  "친구와 함께": ["친구", "같이", "함께", "멀티"],
  혼자서: ["혼자", "싱글"],
  협동: ["협동", "협력", "co-op"],
  힐링: ["힐링", "편안", "여유"],
  스토리: ["스토리", "이야기"],
  도전: ["도전", "어렵"],
  퍼즐: ["퍼즐", "두뇌"],
  생존: ["생존"],
  오픈월드: ["오픈월드"],
  액션: ["액션", "전투"],
  농장: ["농장", "농사"],
  탐험: ["탐험"],
};

const reviewColumns = `review_id, appid, language, voted_up, created_at, updated_at, votes_up, votes_funny,
  steam_purchase, received_for_free, early_access, playtime_at_review, playtime_forever, last_played, mongo_id`;
const reviewOrder = "ORDER BY created_at DESC, review_id DESC";
// 리뷰 목록 정렬: 최신순 · 도움이 돼요 많은 순 · 작성 당시 플레이 시간 긴 순
const reviewSorts = {
  recent: reviewOrder,
  helpful: "ORDER BY votes_up DESC, created_at DESC, review_id DESC",
  playtime: "ORDER BY playtime_at_review IS NULL, playtime_at_review DESC, review_id DESC",
};
export const reviewSortKeys = Object.keys(reviewSorts);

async function readReviewDocuments(rows) {
  const ids = rows.map((row) => row.mongo_id).filter((id) => /^[0-9a-f]{24}$/.test(id ?? ""));
  if (!ids.length) return new Map();
  const db = await mongoDb();
  const docs = await db
    .collection("review_text")
    .find({ _id: { $in: ids.map((id) => new ObjectId(id)) } }, { projection: { appid: 1, cleaned: 1, original: 1 } })
    .toArray();
  return new Map(docs.map((doc) => [String(doc._id), doc]));
}

function formatReview(row, docs) {
  const id = String(row.review_id);
  const gameId = Number(row.appid);
  const doc = docs.get(String(row.mongo_id));
  const text = Number(doc?.appid) === gameId ? (doc.cleaned ?? doc.original ?? "") : "";
  const normalized = text.toLowerCase();
  return {
    id,
    reviewId: id,
    gameId,
    text,
    recommended: Number(row.voted_up) === 1,
    playtimeAtReviewMinutes: row.playtime_at_review === null ? null : Number(row.playtime_at_review),
    playtimeForeverMinutes: row.playtime_forever == null ? null : Number(row.playtime_forever),
    votesUp: Number(row.votes_up ?? 0),
    votesFunny: Number(row.votes_funny ?? 0),
    steamPurchase: Number(row.steam_purchase ?? 1) === 1,
    receivedForFree: Number(row.received_for_free ?? 0) === 1,
    earlyAccess: Number(row.early_access ?? 0) === 1,
    lastPlayed: row.last_played ? Math.floor(new Date(row.last_played).getTime() / 1000) : null,
    updatedAt: row.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : null,
    language: row.language,
    createdAt: Math.floor(new Date(row.created_at).getTime() / 1000),
    keywords: Object.entries(keywordRules)
      .filter(([, terms]) => terms.some((term) => normalized.includes(term)))
      .map(([keyword]) => keyword),
    source: "steam",
  };
}

export async function readSnapshot() {
  const [[gameRows], [reviewRows], [keywordRows]] = await Promise.all([
    pool.query(`
      SELECT g.appid, g.name, g.header_image, g.is_free, g.coming_soon, g.required_age, g.metacritic,
             g.initial_price, g.final_price, g.currency, g.ko_review_score, g.ko_positive, g.ko_negative,
             g.recommendations_total, g.rank_no, g.last_week_rank, g.peak_in_game,
             s.discount_pct, s.ko_positive_pct,                      -- 할인율 · 한국어 긍정률은 뷰(V_GAME_SUMMARY)에서 계산
             CAST(g.last_week_rank AS SIGNED) - CAST(g.rank_no AS SIGNED) AS rank_change,         -- 지난주 대비 순위 변화 (+ 상승 · - 하락)
             DATE_FORMAT(g.release_date, '%Y-%m-%d') AS release_date,
             (SELECT GROUP_CONCAT(ge.name ORDER BY ge.genre_id SEPARATOR '|')
                FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id WHERE gg.appid = g.appid) AS genres,
             (SELECT GROUP_CONCAT(c.name ORDER BY c.category_id SEPARATOR '|')
                FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id WHERE gc.appid = g.appid) AS categories,
             (SELECT GROUP_CONCAT(co.name ORDER BY co.name SEPARATOR '|')
                FROM GAME_COMPANY gco JOIN COMPANY co ON co.company_id = gco.company_id
               WHERE gco.appid = g.appid AND gco.role = 'developer') AS developers,
             (SELECT GROUP_CONCAT(co.name ORDER BY co.name SEPARATOR '|')
                FROM GAME_COMPANY gco JOIN COMPANY co ON co.company_id = gco.company_id
               WHERE gco.appid = g.appid AND gco.role = 'publisher') AS publishers
      FROM GAME g
      JOIN V_GAME_SUMMARY s ON s.appid = g.appid
      ORDER BY g.rank_no IS NULL, g.rank_no, g.appid
    `),
    pool.query(`SELECT ${reviewColumns} FROM REVIEW ${reviewOrder}`),
    // 취향 추천용: 게임별 추천 리뷰 키워드 비율 (GAME_KEYWORD · 분모는 REVIEW에서 셈)
    pool.query(`
      SELECT gk.appid, k.word, gk.review_cnt / t.total AS ratio
      FROM GAME_KEYWORD gk
      JOIN KEYWORD k ON k.keyword_id = gk.keyword_id
      JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW WHERE voted_up = 1 GROUP BY appid) t ON t.appid = gk.appid
      WHERE gk.voted_up = 1 AND gk.review_cnt >= 2
      ORDER BY gk.appid, ratio DESC
    `),
  ]);

  // 게임당 상위 30개 키워드만 벡터로 사용
  const positiveVectors = new Map();
  for (const row of keywordRows) {
    const id = Number(row.appid);
    if (!positiveVectors.has(id)) positiveVectors.set(id, new Map());
    const vector = positiveVectors.get(id);
    if (vector.size < 30) vector.set(row.word, Number(row.ratio));
  }

  const games = gameRows.map((row) => ({
    id: Number(row.appid),
    title: row.name,
    image: row.header_image ?? "",
    releaseDateRaw: row.coming_soon ? "출시 예정" : row.release_date,
    description: "",
    price: row.final_price === null ? 0 : Number(row.final_price),
    priceAvailable: row.final_price !== null || Number(row.is_free) === 1,
    tags: row.genres ? row.genres.split("|") : [],
    koPositive: row.ko_positive === null ? null : Number(row.ko_positive),
    koNegative: row.ko_negative === null ? null : Number(row.ko_negative),
    categories: row.categories ? row.categories.split("|") : [],
    developers: row.developers ? row.developers.split("|") : [],
    publishers: row.publishers ? row.publishers.split("|") : [],
    isFree: Number(row.is_free) === 1,
    comingSoon: Number(row.coming_soon) === 1,
    releaseDate: row.release_date,
    requiredAge: Number(row.required_age ?? 0),
    metacritic: row.metacritic === null ? null : Number(row.metacritic),
    initialPrice: row.initial_price === null ? null : Number(row.initial_price),
    discountPct: row.discount_pct === null ? 0 : Number(row.discount_pct),
    koPositivePct: row.ko_positive_pct === null ? null : Number(row.ko_positive_pct),
    rankChange: row.rank_change === null ? null : Number(row.rank_change),
    currency: row.currency,
    koReviewScore: row.ko_review_score === null ? null : Number(row.ko_review_score),
    recommendationsTotal: row.recommendations_total === null ? null : Number(row.recommendations_total),
    rank: row.rank_no === null ? null : Number(row.rank_no),
    lastWeekRank: row.last_week_rank === null ? null : Number(row.last_week_rank),
    peakInGame: row.peak_in_game === null ? null : Number(row.peak_in_game),
    source: "steam",
  }));

  const reviews = [];
  for (let offset = 0; offset < reviewRows.length; offset += 500) {
    const batch = reviewRows.slice(offset, offset + 500);
    const docs = await readReviewDocuments(batch);
    for (const row of batch) {
      if (!docs.has(String(row.mongo_id))) continue;
      reviews.push(formatReview(row, docs));
    }
  }
  return { games, reviews, positiveVectors };
}

const playtimeConditions = {
  "under-2h": "playtime_at_review >= 0 AND playtime_at_review < 120",
  "2-to-10h": "playtime_at_review >= 120 AND playtime_at_review < 600",
  "10h-plus": "playtime_at_review >= 600",
  unknown: "playtime_at_review IS NULL",
};
export const reviewPlaytimeGroups = Object.keys(playtimeConditions);

export async function readReviewPage({ gameId, requestedPage, sentiment, playtime, sort = "recent" }) {
  const pageSize = 10;
  const [[game]] = await pool.execute("SELECT appid FROM GAME WHERE appid = ?", [gameId]);
  if (!game) return null;

  const conditions = ["appid = ?"];
  const params = [gameId];
  if (sentiment !== "all") {
    conditions.push("voted_up = ?");
    params.push(sentiment === "positive" ? 1 : 0);
  }
  if (playtime !== "all") conditions.push(`(${playtimeConditions[playtime]})`);

  const where = conditions.join(" AND ");
  const [[{ total: count }]] = await pool.execute(`SELECT COUNT(*) AS total FROM REVIEW WHERE ${where}`, params);
  const total = Number(count);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const [[rows], [groups]] = await Promise.all([
    pool.query(`SELECT ${reviewColumns} FROM REVIEW WHERE ${where} ${reviewSorts[sort] ?? reviewOrder} LIMIT ? OFFSET ?`, [
      ...params,
      pageSize,
      (page - 1) * pageSize,
    ]),
    pool.execute(
      `SELECT CASE
         WHEN playtime_at_review IS NULL THEN 'unknown'
         WHEN playtime_at_review < 120 THEN 'under-2h'
         WHEN playtime_at_review < 600 THEN '2-to-10h'
         ELSE '10h-plus'
       END AS time_group,
       SUM(CASE WHEN voted_up = 1 THEN 1 ELSE 0 END) AS positive,
       SUM(CASE WHEN voted_up = 0 THEN 1 ELSE 0 END) AS negative
       FROM REVIEW WHERE appid = ?
       GROUP BY time_group`,
      [gameId],
    ),
  ]);

  const docs = await readReviewDocuments(rows);
  const reviews = rows.map((row) => formatReview(row, docs));
  const byGroup = new Map(groups.map((row) => [row.time_group, row]));
  const comparison = reviewPlaytimeGroups.map((group) => ({
    group,
    positive: Number(byGroup.get(group)?.positive ?? 0),
    negative: Number(byGroup.get(group)?.negative ?? 0),
  }));
  return { reviews, page, total, totalPages, comparison };
}

/**
 * 게임 평가 비교 (최대 2개). total · positive · negative는 스팀 한국어 전체 집계(GAME.ko_*, 표본 아님),
 * weekly는 수집한 표본 리뷰의 주별 추이
 */
export async function readGameRatings(gameIds) {
  const placeholders = gameIds.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `SELECT appid, ko_positive, ko_negative FROM GAME WHERE appid IN (${placeholders})`,
    gameIds,
  );
  const [weeklyRows] = await pool.execute(
    `SELECT appid,
            DATE_FORMAT(DATE_SUB(DATE(created_at), INTERVAL WEEKDAY(created_at) DAY), '%Y-%m-%d') AS week,
            COUNT(*) AS total,
            SUM(voted_up = 1) AS positive,
            SUM(voted_up = 0) AS negative
     FROM REVIEW
     WHERE appid IN (${placeholders})
     GROUP BY appid, week
     ORDER BY week`,
    gameIds,
  );
  return rows.map(({ appid, ko_positive: positive, ko_negative: negative }) => ({
    id: Number(appid),
    total: Number(positive) + Number(negative),
    positive: Number(positive),
    negative: Number(negative),
    weekly: weeklyRows
      .filter((row) => Number(row.appid) === Number(appid))
      .map((row) => ({
        week: row.week,
        total: Number(row.total),
        positive: Number(row.positive),
        negative: Number(row.negative),
      })),
  }));
}

export async function closeStorage() {
  await closeDb();
}
