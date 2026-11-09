/**
 * v2 테이블을 SQL로 바로 읽는 API (기존 /api/games 등은 그대로 둠)
 *   GET /api/analytics/games?genre=인디&category=협동&sort=rank  장르 · 카테고리 필터 + 정렬 (요구사항 3)
 *   GET /api/analytics/filters                                  장르 · 카테고리별 게임 수 (GROUP BY)
 *   GET /api/analytics/games/:id/info                           게임 상세 (V_GAME_SUMMARY: 할인율 · 추천 비율 계산)
 *   GET /api/analytics/games/:id/keywords?side=pos&limit=50      추천(pos) · 비추천(neg) · 전체(all) 키워드 (GAME_KEYWORD)
 *   GET /api/analytics/games/:id/keywords?band=ge100             플레이 시간대별 키워드 (lt10 · mid · ge100, REVIEW에서 바로 계산)
 *   GET /api/analytics/games/:id/wordcloud?side=pos|neg|all     워드클라우드 (ES nori 집계, ES가 없으면 GAME_KEYWORD)
 *   GET /api/analytics/games/:id/similar                        추천 키워드가 비슷한 게임 (조회 때 계산)
 *   GET /api/analytics/search?q=친구,힐링&exclude=버그            추천 리뷰 키워드로 게임 찾기
 * 비율의 분모(집단 전체 리뷰 수)는 저장하지 않고 REVIEW에서 셈 (2NF 결정)
 */
import express from "express";
import { readPool } from "../db.js";
import { getCachedCatalog } from "../services/ratings-cache.js";
import { hasReviewSearch, reviewWordCloud } from "../services/review-search.js";

const router = express.Router();
const BANDS = {
  lt10: "r.playtime_at_review < 600",
  mid: "r.playtime_at_review >= 600 AND r.playtime_at_review < 6000",
  ge100: "r.playtime_at_review >= 6000",
};

function gameId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    res.status(400).json({ error: "유효한 게임 ID가 필요합니다." });
    return null;
  }
  return id;
}
const words = (v) =>
  typeof v === "string" ? [...new Set(v.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean))].slice(0, 10) : [];
const num = (v) => (v === null || v === undefined ? null : Number(v));

/**
 * 게임 목록 · 필터 · 정렬을 SQL에서 처리 (화면의 장르 탭 · 카테고리 · 정렬)
 *   GET /api/analytics/games?genre=액션&category=협동&sort=rank|positive|reviews|discount|metacritic|release
 */
const GAME_SORTS = {
  rank: "s.rank_no IS NULL, s.rank_no, s.name",
  positive: "s.ko_positive_pct IS NULL, s.ko_positive_pct DESC, s.name",
  reviews: "(s.ko_positive + s.ko_negative) DESC, s.name",
  discount: "s.discount_pct IS NULL, s.discount_pct DESC, s.rank_no IS NULL, s.rank_no",
  metacritic: "g.metacritic IS NULL, g.metacritic DESC, s.name",
  release: "g.release_date IS NULL, g.release_date DESC, s.name",
};
router.get("/games", async (req, res, next) => {
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const genre = typeof req.query.genre === "string" ? req.query.genre.trim() : "";
  const sort = typeof req.query.sort === "string" && GAME_SORTS[req.query.sort] ? req.query.sort : "rank";
  try {
    const result = await getCachedCatalog("a-games", [genre, category, sort], 300, async () => {
      const params = [];
      let where = "1 = 1";
      if (genre) {
        where += ` AND s.appid IN (SELECT gg.appid FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id WHERE ge.name = ?)`;
        params.push(genre);
      }
      if (category) {
        where += ` AND s.appid IN (SELECT gc.appid FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id WHERE c.name = ?)`;
        params.push(category);
      }
      const [rows] = await readPool.execute(
        `SELECT s.appid, s.name, s.is_free, s.final_price, s.discount_pct, s.ko_review_score, s.ko_positive_pct,
                s.rank_no, CAST(s.last_week_rank AS SIGNED) - CAST(s.rank_no AS SIGNED) AS rank_change, g.header_image
         FROM V_GAME_SUMMARY s JOIN GAME g ON g.appid = s.appid
         WHERE ${where}
         ORDER BY ${GAME_SORTS[sort]}`,
        params,
      );
      return {
        genre: genre || null,
        category: category || null,
        sort,
        games: rows.map((r) => ({
          id: Number(r.appid), title: r.name, image: r.header_image ?? "", isFree: Boolean(r.is_free),
          finalPrice: num(r.final_price), discountPct: num(r.discount_pct), koReviewScore: num(r.ko_review_score),
          koPositivePct: num(r.ko_positive_pct), rank: num(r.rank_no), rankChange: num(r.rank_change),
        })),
      };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * 필터 목록 (장르 · 카테고리별 게임 수)
 *   GET /api/analytics/filters
 */
router.get("/filters", async (req, res, next) => {
  try {
    const result = await getCachedCatalog("a-filters", [], 600, async () => {
      const [genres] = await readPool.query(
        `SELECT ge.name, COUNT(*) AS games
         FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id
         GROUP BY ge.genre_id, ge.name
         ORDER BY games DESC, ge.name`,
      );
      const [categories] = await readPool.query(
        `SELECT c.name, COUNT(*) AS games
         FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id
         GROUP BY c.category_id, c.name
         ORDER BY games DESC, c.name`,
      );
      const shape = (r) => ({ name: r.name, games: Number(r.games) });
      return { genres: genres.map(shape), categories: categories.map(shape) };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/games/:id/info", async (req, res, next) => {
  const id = gameId(req, res);
  if (id === null) return;
  try {
    const result = await getCachedCatalog("a-info3", [id], 600, async () => {
      const [[g]] = await readPool.execute(
        `SELECT g.appid, g.name, g.is_free, g.required_age, DATE_FORMAT(g.release_date, '%Y-%m-%d') AS release_date,
                g.coming_soon, g.metacritic, g.header_image, g.recommendations_total, g.currency,
                s.initial_price, s.final_price, s.discount_pct, s.ko_review_score, s.ko_positive, s.ko_negative,
                s.ko_positive_pct, DATE_FORMAT(g.rank_date, '%Y-%m-%d') AS rank_date, s.rank_no, s.last_week_rank,
                CAST(s.last_week_rank AS SIGNED) - CAST(s.rank_no AS SIGNED) AS rank_change,
                s.peak_in_game, s.last_review_at, DATE_FORMAT(g.updated_at, '%Y-%m-%d %H:%i') AS updated_at
         FROM GAME g JOIN V_GAME_SUMMARY s USING (appid) WHERE g.appid = ?`,
        [id],
      );
      if (!g) return null;
      const [genres] = await readPool.execute(
        "SELECT ge.name FROM GAME_GENRE gg JOIN GENRE ge USING (genre_id) WHERE gg.appid = ? ORDER BY ge.name", [id]);
      const [categories] = await readPool.execute(
        "SELECT c.name FROM GAME_CATEGORY gc JOIN CATEGORY c USING (category_id) WHERE gc.appid = ? ORDER BY c.name", [id]);
      const [companies] = await readPool.execute(
        `SELECT c.name, gc.role FROM GAME_COMPANY gc JOIN COMPANY c USING (company_id)
         WHERE gc.appid = ? ORDER BY gc.role, c.name`, [id]);
      const [[sample]] = await readPool.execute(
        "SELECT SUM(voted_up = 1) AS pos, SUM(voted_up = 0) AS neg FROM REVIEW WHERE appid = ?", [id]);
      // 수집 표본(추천 · 비추천) 각각의 평균 플레이 시간 · 도움돼요 · 구매 경로 · 앞서 해보기 · 작성 기간
      const [sideStats] = await readPool.execute(
        `SELECT voted_up, COUNT(*) AS n,
                ROUND(AVG(playtime_at_review)) AS avg_at_review, ROUND(AVG(playtime_forever)) AS avg_forever,
                SUM(votes_up) AS votes_up, SUM(votes_funny) AS votes_funny,
                SUM(steam_purchase = 1) AS purchased, SUM(received_for_free = 1) AS free_copy,
                SUM(early_access = 1) AS early_access,
                DATE_FORMAT(MIN(created_at), '%Y-%m-%d') AS first_at, DATE_FORMAT(MAX(created_at), '%Y-%m-%d') AS last_at
         FROM REVIEW WHERE appid = ? GROUP BY voted_up`,
        [id],
      );
      return {
        id: Number(g.appid), title: g.name, image: g.header_image ?? "", isFree: Boolean(g.is_free),
        requiredAge: g.required_age, releaseDate: g.release_date, comingSoon: Boolean(g.coming_soon),
        metacritic: num(g.metacritic), recommendationsTotal: num(g.recommendations_total),
        price: { initial: num(g.initial_price), final: num(g.final_price), discountPct: num(g.discount_pct), currency: g.currency },
        korean: { reviewScore: num(g.ko_review_score), positive: num(g.ko_positive), negative: num(g.ko_negative), positivePct: num(g.ko_positive_pct) },
        rank: { date: g.rank_date, rank: num(g.rank_no), lastWeek: num(g.last_week_rank), change: num(g.rank_change), peak: num(g.peak_in_game) },
        lastReviewAt: g.last_review_at,
        updatedAt: g.updated_at,
        sampleStats: Object.fromEntries(
          sideStats.map((r) => [
            Number(r.voted_up) === 1 ? "pos" : "neg",
            {
              count: num(r.n), avgPlaytimeAtReview: num(r.avg_at_review), avgPlaytimeForever: num(r.avg_forever),
              votesUp: num(r.votes_up), votesFunny: num(r.votes_funny), purchased: num(r.purchased),
              freeCopy: num(r.free_copy), earlyAccess: num(r.early_access), firstAt: r.first_at, lastAt: r.last_at,
            },
          ]),
        ),
        sample: { positive: num(sample.pos) ?? 0, negative: num(sample.neg) ?? 0 },
        genres: genres.map((r) => r.name),
        categories: categories.map((r) => r.name),
        developers: companies.filter((c) => c.role === "developer").map((c) => c.name),
        publishers: companies.filter((c) => c.role === "publisher").map((c) => c.name),
      };
    });
    if (!result) return res.status(404).json({ error: "게임을 찾을 수 없습니다." });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/games/:id/keywords", async (req, res, next) => {
  const id = gameId(req, res);
  if (id === null) return;
  const side = String(req.query.side ?? "all");
  const band = req.query.band ? String(req.query.band) : "";
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  if (!["all", "pos", "neg"].includes(side) || (band && !BANDS[band])) {
    return res.status(400).json({ error: "side: all · pos · neg / band: lt10 · mid · ge100" });
  }
  try {
    const result = await getCachedCatalog("a-keywords", [id, side, band, limit], 3600, async () => {
      const voteCond = side === "pos" ? "r.voted_up = 1" : side === "neg" ? "r.voted_up = 0" : "1 = 1";
      const bandCond = band ? BANDS[band] : "1 = 1";
      const [[{ total }]] = await readPool.execute(
        `SELECT COUNT(*) AS total FROM REVIEW r WHERE r.appid = ? AND ${voteCond} AND ${bandCond}`, [id]);
      let rows;
      if (band) {
        // 플레이 시간대별은 저장하지 않고 REVIEW · REVIEW_KEYWORD에서 바로 계산 (설계서 확인 쿼리 ⑤)
        [rows] = await readPool.query(
          `SELECT k.word, COUNT(*) AS review_cnt
           FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id JOIN KEYWORD k ON k.keyword_id = rk.keyword_id
           WHERE r.appid = ? AND ${voteCond} AND ${bandCond}
           GROUP BY k.word ORDER BY review_cnt DESC, k.word LIMIT ?`,
          [id, limit],
        );
      } else {
        const sideCond = side === "pos" ? "AND gk.voted_up = 1" : side === "neg" ? "AND gk.voted_up = 0" : "";
        [rows] = await readPool.query(
          `SELECT k.word, SUM(gk.review_cnt) AS review_cnt
           FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
           WHERE gk.appid = ? ${sideCond}
           GROUP BY k.word ORDER BY review_cnt DESC, k.word LIMIT ?`,
          [id, limit],
        );
      }
      const t = Number(total);
      return {
        side, band: band || null, reviewTotal: t, enough: t >= 30,
        keywords: rows.map((r) => ({
          keyword: r.word, reviewCount: Number(r.review_cnt), ratio: t ? Math.round((Number(r.review_cnt) / t) * 1000) / 1000 : 0,
        })),
      };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get("/games/:id/wordcloud", async (req, res, next) => {
  const id = gameId(req, res);
  if (id === null) return;
  const side = String(req.query.side ?? "pos");
  const limit = Math.min(Math.max(Number(req.query.limit) || 60, 10), 150);
  if (!["all", "pos", "neg"].includes(side)) return res.status(400).json({ error: "side: all · pos · neg" });
  try {
    const result = await getCachedCatalog("a-wordcloud", [id, side, limit], 3600, async () => {
      // ① Elasticsearch (nori 형태소 분석 + terms · significant_text 집계)
      if (hasReviewSearch()) {
        try {
          const es = await reviewWordCloud(id, side, limit);
          if (es.words.length) return { source: "elasticsearch", side, reviewTotal: es.total, ...es };
        } catch (error) {
          console.warn(`워드클라우드 ES 실패 → MySQL로 대신함 (${error.message})`);
        }
      }
      // ② MySQL GAME_KEYWORD (매일 집계해 둔 키워드별 리뷰 수)
      const voteCond = side === "pos" ? "AND voted_up = 1" : side === "neg" ? "AND voted_up = 0" : "";
      const [[{ total }]] = await readPool.execute(`SELECT COUNT(*) AS total FROM REVIEW WHERE appid = ? ${voteCond}`, [id]);
      const [rows] = await readPool.query(
        `SELECT k.word, SUM(gk.review_cnt) AS cnt
         FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
         WHERE gk.appid = ? ${voteCond.replace("voted_up", "gk.voted_up")}
         GROUP BY k.word ORDER BY cnt DESC, k.word LIMIT ?`,
        [id, limit],
      );
      return {
        source: "mysql",
        side,
        reviewTotal: Number(total),
        words: rows.map((r) => ({ word: r.word, count: Number(r.cnt) })),
        distinctive: [],
      };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

async function positiveVectors() {
  // 추천 리뷰 키워드 비율 벡터 (게임당 상위 30개) — 게임이 30개라 조회 때 계산해도 가벼움
  const [rows] = await readPool.query(
    `SELECT gk.appid, k.word, gk.review_cnt / t.total AS ratio
     FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
     JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW WHERE voted_up = 1 GROUP BY appid) t ON t.appid = gk.appid
     WHERE gk.voted_up = 1
     ORDER BY gk.appid, ratio DESC`,
  );
  const vectors = new Map();
  for (const r of rows) {
    const id = Number(r.appid);
    if (!vectors.has(id)) vectors.set(id, new Map());
    const v = vectors.get(id);
    if (v.size < 30) v.set(r.word, Number(r.ratio));
  }
  return vectors;
}

router.get("/games/:id/similar", async (req, res, next) => {
  const id = gameId(req, res);
  if (id === null) return;
  try {
    const result = await getCachedCatalog("a-similar", [id], 3600, async () => {
      const vectors = await positiveVectors();
      const base = vectors.get(id);
      if (!base) return { games: [] };
      const norm = (v) => Math.sqrt([...v.values()].reduce((s, x) => s + x * x, 0));
      const [names] = await readPool.query("SELECT appid, name, header_image FROM GAME");
      const info = new Map(names.map((n) => [Number(n.appid), n]));
      const scored = [];
      for (const [other, v] of vectors) {
        if (other === id) continue;
        const common = [...base.keys()].filter((w) => v.has(w));
        if (!common.length) continue;
        const dot = common.reduce((s, w) => s + base.get(w) * v.get(w), 0);
        scored.push({
          id: other, title: info.get(other)?.name ?? String(other), image: info.get(other)?.header_image ?? "",
          score: Math.round((dot / (norm(base) * norm(v))) * 1000) / 1000,
          commonKeywords: common.sort((a, b) => base.get(b) * v.get(b) - base.get(a) * v.get(a)).slice(0, 3),
        });
      }
      return { games: scored.sort((a, b) => b.score - a.score).slice(0, 5) };
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// 추천 리뷰에 원하는 단어가 모두 나온 게임 · 제외 단어가 전체 리뷰 3% 이상인 게임은 뺌
router.get("/search", async (req, res, next) => {
  const include = words(req.query.q);
  const exclude = words(req.query.exclude);
  if (!include.length) return res.status(400).json({ error: "q에 키워드를 쉼표로 넣어주세요." });
  try {
    const params = [include];
    let excludeSql = "";
    if (exclude.length) {
      excludeSql = `AND gk.appid NOT IN (
        SELECT x.appid FROM GAME_KEYWORD x JOIN KEYWORD xk USING (keyword_id)
        JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW GROUP BY appid) xt ON xt.appid = x.appid
        WHERE xk.word IN (?) GROUP BY x.appid, xt.total HAVING SUM(x.review_cnt) / xt.total >= 0.03)`;
      params.push(exclude);
    }
    params.push(include.length);
    const [rows] = await readPool.query(
      `SELECT g.appid, g.name, g.header_image, SUM(gk.review_cnt / t.total) AS score,
              GROUP_CONCAT(CONCAT(k.word, ':', ROUND(gk.review_cnt * 100 / t.total)) ORDER BY gk.review_cnt DESC) AS reason
       FROM GAME_KEYWORD gk
       JOIN KEYWORD k USING (keyword_id)
       JOIN GAME g ON g.appid = gk.appid
       JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW WHERE voted_up = 1 GROUP BY appid) t ON t.appid = gk.appid
       WHERE gk.voted_up = 1 AND k.word IN (?) ${excludeSql}
       GROUP BY g.appid, g.name, g.header_image
       HAVING COUNT(*) = ?
       ORDER BY score DESC LIMIT 20`,
      params,
    );
    res.json({
      include, exclude,
      games: rows.map((r) => ({
        id: Number(r.appid), title: r.name, image: r.header_image ?? "", score: Math.round(Number(r.score) * 1000) / 1000,
        reason: String(r.reason ?? "").split(",").filter(Boolean).map((p) => {
          const [keyword, pct] = p.split(":");
          return { keyword, percent: Number(pct) };
        }),
      })),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
