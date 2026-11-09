/**
 * 관리자 전용 통계 API — 로그인 + ADMIN_EMAILS(.env)에 있는 이메일만 접근 (그 외 401 · 403)
 *   GET /api/admin/overview   핵심 지표 · 테이블별 행 수 · 마지막 수집 시각
 *   GET /api/admin/api-log    Steam API 호출 기록 (API별 요약 · 일별 성공/실패 · 최근 실패 · 최근 호출)
 *   GET /api/admin/games      게임별 수집 상태 (표본 수 · 키워드 · 찜 · 빠진 정보)
 *   GET /api/admin/members    회원 · 가입 추이 · 많이 찜한 게임
 *   GET /api/admin/keywords   전체 추천 · 비추천 리뷰에서 많이 나온 키워드
 */
import express from "express";
import { readPool } from "../db.js";
import { sessionMember } from "./auth.js";

const router = express.Router();
const n = (v) => (v === null || v === undefined ? null : Number(v));

router.use(async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    const user = await sessionMember(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
    if (!user.isAdmin) return res.status(403).json({ error: "관리자만 볼 수 있습니다." });
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
});

const TABLES = ["GAME", "GENRE", "GAME_GENRE", "CATEGORY", "GAME_CATEGORY", "COMPANY", "GAME_COMPANY", "REVIEW",
  "KEYWORD", "REVIEW_KEYWORD", "GAME_KEYWORD", "MEMBER", "WISHLIST", "API_SYNC_LOG", "MEMBER_SESSION"];

router.get("/overview", async (req, res, next) => {
  try {
    const [[counts]] = await readPool.query(
      `SELECT ${TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}) AS ${t}`).join(", ")}`,
    );
    const [[kpi]] = await readPool.query(
      `SELECT
         (SELECT SUM(voted_up = 1) FROM REVIEW) AS review_pos,
         (SELECT SUM(voted_up = 0) FROM REVIEW) AS review_neg,
         (SELECT COUNT(*) FROM MEMBER WHERE created_at >= NOW() - INTERVAL 7 DAY) AS new_members_7d,
         (SELECT COUNT(*) FROM MEMBER_SESSION WHERE expires_at > NOW()) AS active_sessions,
         (SELECT COUNT(*) FROM API_SYNC_LOG WHERE req_at >= NOW() - INTERVAL 1 DAY) AS calls_24h,
         (SELECT COUNT(*) FROM API_SYNC_LOG
           WHERE req_at >= NOW() - INTERVAL 1 DAY AND status_code NOT BETWEEN 200 AND 299) AS failed_24h,
         (SELECT DATE_FORMAT(MAX(rank_date), '%Y-%m-%d') FROM GAME) AS rank_date,
         (SELECT DATE_FORMAT(MAX(updated_at), '%Y-%m-%d %H:%i') FROM GAME) AS game_updated_at,
         (SELECT DATE_FORMAT(MAX(created_at), '%Y-%m-%d %H:%i') FROM REVIEW) AS last_review_at`,
    );
    const [lastCalls] = await readPool.query(
      `SELECT api, DATE_FORMAT(MAX(req_at), '%Y-%m-%d %H:%i') AS last_at FROM API_SYNC_LOG GROUP BY api ORDER BY api`,
    );
    res.json({
      tables: TABLES.map((name) => ({ name, rows: Number(counts[name]) })),
      kpi: {
        games: Number(counts.GAME),
        reviews: Number(counts.REVIEW),
        reviewPos: n(kpi.review_pos) ?? 0,
        reviewNeg: n(kpi.review_neg) ?? 0,
        keywords: Number(counts.KEYWORD),
        members: Number(counts.MEMBER),
        newMembers7d: Number(kpi.new_members_7d),
        wishlist: Number(counts.WISHLIST),
        activeSessions: Number(kpi.active_sessions),
        calls24h: Number(kpi.calls_24h),
        failed24h: Number(kpi.failed_24h),
      },
      rankDate: kpi.rank_date,
      gameUpdatedAt: kpi.game_updated_at,
      lastReviewAt: kpi.last_review_at,
      lastCalls: lastCalls.map((r) => ({ api: r.api, lastAt: r.last_at })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/api-log", async (req, res, next) => {
  const days = Math.min(Math.max(Number(req.query.days) || 14, 1), 90);
  try {
    const [apis] = await readPool.query(
      `SELECT api, COUNT(*) AS calls, SUM(status_code BETWEEN 200 AND 299) AS ok,
              SUM(status_code NOT BETWEEN 200 AND 299) AS failed, SUM(item_count) AS items,
              DATE_FORMAT(MAX(req_at), '%Y-%m-%d %H:%i') AS last_at
       FROM API_SYNC_LOG GROUP BY api ORDER BY calls DESC`,
    );
    const [daily] = await readPool.query(
      `SELECT DATE_FORMAT(DATE(req_at), '%Y-%m-%d') AS day,
              SUM(status_code BETWEEN 200 AND 299) AS ok,
              SUM(status_code NOT BETWEEN 200 AND 299) AS failed,
              SUM(item_count) AS items
       FROM API_SYNC_LOG
       WHERE req_at >= CURDATE() - INTERVAL ? DAY
       GROUP BY day                -- MySQL 8 ONLY_FULL_GROUP_BY: SELECT의 별칭으로 묶어야 함
       ORDER BY day`,
      [days - 1],
    );
    const [failures] = await readPool.query(
      `SELECT l.log_id, l.api, l.appid, g.name, DATE_FORMAT(l.req_at, '%Y-%m-%d %H:%i:%s') AS req_at,
              l.status_code, l.error_msg
       FROM API_SYNC_LOG l LEFT JOIN GAME g ON g.appid = l.appid
       WHERE l.status_code NOT BETWEEN 200 AND 299
       ORDER BY l.log_id DESC LIMIT 20`,
    );
    const [recent] = await readPool.query(
      `SELECT l.log_id, l.api, l.appid, g.name, DATE_FORMAT(l.req_at, '%m-%d %H:%i:%s') AS req_at,
              l.status_code, l.item_count
       FROM API_SYNC_LOG l LEFT JOIN GAME g ON g.appid = l.appid
       ORDER BY l.log_id DESC LIMIT 30`,
    );
    res.json({
      days,
      apis: apis.map((r) => ({
        api: r.api, calls: Number(r.calls), ok: Number(r.ok), failed: Number(r.failed), items: Number(r.items), lastAt: r.last_at,
      })),
      daily: daily.map((r) => ({ day: r.day, ok: Number(r.ok), failed: Number(r.failed), items: Number(r.items) })),
      failures: failures.map((r) => ({
        id: Number(r.log_id), api: r.api, appid: n(r.appid), game: r.name, at: r.req_at, status: Number(r.status_code),
        error: r.error_msg,
      })),
      recent: recent.map((r) => ({
        id: Number(r.log_id), api: r.api, appid: n(r.appid), game: r.name, at: r.req_at, status: Number(r.status_code),
        items: Number(r.item_count),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/games", async (req, res, next) => {
  try {
    const [rows] = await readPool.query(
      `SELECT g.appid, g.name, g.header_image, g.ko_review_score, g.rank_no, g.final_price, g.is_free,
              DATE_FORMAT(g.updated_at, '%Y-%m-%d %H:%i') AS updated_at,
              COALESCE(r.pos, 0) AS pos, COALESCE(r.neg, 0) AS neg,
              DATE_FORMAT(r.last_at, '%Y-%m-%d') AS last_review_at,
              COALESCE(k.keyword_rows, 0) AS keyword_rows,
              COALESCE(w.wished, 0) AS wished,
              (SELECT COUNT(*) FROM GAME_GENRE gg WHERE gg.appid = g.appid) AS genres,
              (SELECT COUNT(*) FROM GAME_CATEGORY gc WHERE gc.appid = g.appid) AS categories
       FROM GAME g
       LEFT JOIN (SELECT appid, SUM(voted_up = 1) AS pos, SUM(voted_up = 0) AS neg, MAX(created_at) AS last_at
                  FROM REVIEW GROUP BY appid) r ON r.appid = g.appid
       LEFT JOIN (SELECT appid, COUNT(*) AS keyword_rows FROM GAME_KEYWORD GROUP BY appid) k ON k.appid = g.appid
       LEFT JOIN (SELECT appid, COUNT(*) AS wished FROM WISHLIST GROUP BY appid) w ON w.appid = g.appid
       ORDER BY g.rank_no IS NULL, g.rank_no, g.name`,
    );
    res.json({
      target: 125,
      games: rows.map((r) => {
        const issues = [];
        if (Number(r.pos) < 125) issues.push(`추천 ${125 - Number(r.pos)}건 부족`);
        if (Number(r.neg) < 125) issues.push(`비추천 ${125 - Number(r.neg)}건 부족`);
        if (r.ko_review_score === null) issues.push("한국어 평가 없음");
        if (!Number(r.keyword_rows)) issues.push("키워드 없음");
        if (!r.header_image) issues.push("이미지 없음");
        if (r.final_price === null && !r.is_free) issues.push("가격 없음");
        if (!Number(r.genres)) issues.push("장르 없음");
        return {
          id: Number(r.appid), title: r.name, rank: n(r.rank_no), koReviewScore: n(r.ko_review_score),
          pos: Number(r.pos), neg: Number(r.neg), lastReviewAt: r.last_review_at, keywordRows: Number(r.keyword_rows),
          wished: Number(r.wished), genres: Number(r.genres), categories: Number(r.categories), updatedAt: r.updated_at,
          issues,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/members", async (req, res, next) => {
  try {
    const [members] = await readPool.query(
      `SELECT m.member_id, m.email, m.nickname, DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS created_at,
              (SELECT COUNT(*) FROM WISHLIST w WHERE w.member_id = m.member_id) AS wished,
              (SELECT COUNT(*) FROM MEMBER_SESSION s WHERE s.member_id = m.member_id AND s.expires_at > NOW()) AS sessions
       FROM MEMBER m
       ORDER BY m.created_at DESC, m.member_id DESC
       LIMIT 50`,
    );
    const [signups] = await readPool.query(
      `SELECT DATE_FORMAT(DATE(created_at), '%Y-%m-%d') AS day, COUNT(*) AS members
       FROM MEMBER
       WHERE created_at >= CURDATE() - INTERVAL 29 DAY
       GROUP BY day                -- MySQL 8 ONLY_FULL_GROUP_BY: SELECT의 별칭으로 묶어야 함
       ORDER BY day`,
    );
    const [topWished] = await readPool.query(
      `SELECT g.appid, g.name, COUNT(*) AS wished
       FROM WISHLIST w JOIN GAME g ON g.appid = w.appid
       GROUP BY g.appid, g.name
       ORDER BY wished DESC, g.name
       LIMIT 10`,
    );
    res.json({
      members: members.map((m) => ({
        id: Number(m.member_id), email: m.email, nickname: m.nickname, createdAt: m.created_at,
        wished: Number(m.wished), sessions: Number(m.sessions),
      })),
      signups: signups.map((r) => ({ day: r.day, members: Number(r.members) })),
      topWished: topWished.map((r) => ({ id: Number(r.appid), title: r.name, wished: Number(r.wished) })),
    });
  } catch (error) {
    next(error);
  }
});

router.get("/keywords", async (req, res, next) => {
  try {
    const query = (votedUp) =>
      readPool.query(
        `SELECT k.word, SUM(gk.review_cnt) AS reviews, COUNT(DISTINCT gk.appid) AS games
         FROM GAME_KEYWORD gk JOIN KEYWORD k ON k.keyword_id = gk.keyword_id
         WHERE gk.voted_up = ?
         GROUP BY k.keyword_id, k.word
         ORDER BY reviews DESC, k.word
         LIMIT 15`,
        [votedUp],
      );
    const [[pos], [neg]] = await Promise.all([query(1), query(0)]);
    const shape = (r) => ({ word: r.word, reviews: Number(r.reviews), games: Number(r.games) });
    res.json({ pos: pos.map(shape), neg: neg.map(shape) });
  } catch (error) {
    next(error);
  }
});

export default router;
