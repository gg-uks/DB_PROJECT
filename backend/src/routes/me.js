/**
 * 로그인한 회원의 찜 목록 (요구사항 17 · WISHLIST)
 *   GET    /api/me/wishlist           찜 목록
 *   POST   /api/me/wishlist  {appid}  찜 추가
 *   DELETE /api/me/wishlist/:appid    찜 삭제
 *   GET    /api/me/summary            마이페이지 요약 (찜 수 · 할인 중 · 찜 총액 · 장르 분포)
 *   PATCH  /api/me/profile {nickname} 닉네임 변경
 *   POST   /api/me/password {currentPassword, newPassword}  비밀번호 변경 (다른 기기 세션 종료)
 *   DELETE /api/me {password}         회원 탈퇴 (WISHLIST · MEMBER_SESSION은 ON DELETE CASCADE로 같이 삭제)
 */
import express from "express";
import { writePool, readPool } from "../db.js";
import bcrypt from "bcryptjs";
import { sessionMember, BCRYPT_ROUNDS, sessionCookie, hashToken, readSessionToken } from "./auth.js";

const router = express.Router();

router.use(async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    req.user = await sessionMember(req);
    if (req.user) req.tokenHash = hashToken(readSessionToken(req));
    if (!req.user) return res.status(401).json({ error: "로그인이 필요합니다." });
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/wishlist", async (req, res, next) => {
  try {
    const [rows] = await readPool.execute(
      `SELECT g.appid, g.name, g.header_image, w.added_at, s.final_price, s.discount_pct, s.is_free, s.ko_positive_pct
       FROM WISHLIST w JOIN GAME g ON g.appid = w.appid JOIN V_GAME_SUMMARY s ON s.appid = g.appid
       WHERE w.member_id = ? ORDER BY w.added_at DESC`,
      [req.user.id],
    );
    res.json({
      games: rows.map((r) => ({
        id: Number(r.appid), title: r.name, image: r.header_image ?? "", addedAt: r.added_at,
        finalPrice: r.final_price === null ? null : Number(r.final_price),
        discountPct: r.discount_pct === null ? 0 : Number(r.discount_pct),
        isFree: Boolean(r.is_free),
        koPositivePct: r.ko_positive_pct === null ? null : Number(r.ko_positive_pct),
      })),
    });
  } catch (error) {
    next(error);
  }
});

router.post("/wishlist", async (req, res, next) => {
  const appid = req.body?.appid;
  if (!Number.isSafeInteger(appid) || appid < 1) return res.status(400).json({ error: "appid가 필요합니다." });
  try {
    // INSERT IGNORE는 외래키 오류까지 숨기므로, 중복만 무시하도록 ON DUPLICATE KEY 사용
    await writePool.execute(
      "INSERT INTO WISHLIST (member_id, appid) VALUES (?, ?) ON DUPLICATE KEY UPDATE added_at = added_at",
      [req.user.id, appid],
    );
    res.status(201).json({ ok: true });
  } catch (error) {
    if (error.code === "ER_NO_REFERENCED_ROW_2") return res.status(404).json({ error: "게임을 찾을 수 없습니다." });
    next(error);
  }
});

router.delete("/wishlist/:appid", async (req, res, next) => {
  const appid = Number(req.params.appid);
  if (!Number.isSafeInteger(appid) || appid < 1) return res.status(400).json({ error: "appid가 필요합니다." });
  try {
    await writePool.execute("DELETE FROM WISHLIST WHERE member_id = ? AND appid = ?", [req.user.id, appid]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/summary", async (req, res, next) => {
  try {
    const [[totals]] = await readPool.execute(
      `SELECT COUNT(*) AS wished,
              SUM(s.discount_pct > 0) AS on_sale,
              SUM(CASE WHEN s.is_free THEN 0 ELSE s.final_price END) AS total_price,
              SUM(CASE WHEN s.is_free THEN 0 ELSE COALESCE(s.initial_price, s.final_price) END) AS total_initial,
              ROUND(AVG(s.ko_positive_pct), 1) AS avg_positive
       FROM WISHLIST w JOIN V_GAME_SUMMARY s ON s.appid = w.appid
       WHERE w.member_id = ?`,
      [req.user.id],
    );
    const [genres] = await readPool.execute(
      `SELECT ge.name, COUNT(*) AS games
       FROM WISHLIST w
       JOIN GAME_GENRE gg ON gg.appid = w.appid
       JOIN GENRE ge ON ge.genre_id = gg.genre_id
       WHERE w.member_id = ?
       GROUP BY ge.genre_id, ge.name
       ORDER BY games DESC, ge.name
       LIMIT 6`,
      [req.user.id],
    );
    const [[member]] = await readPool.execute(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS joined_at, DATEDIFF(CURDATE(), DATE(created_at)) + 1 AS days
       FROM MEMBER WHERE member_id = ?`,
      [req.user.id],
    );
    const n = (v) => (v === null || v === undefined ? 0 : Number(v));
    res.json({
      wished: n(totals.wished),
      onSale: n(totals.on_sale),
      totalPrice: n(totals.total_price),
      totalInitial: n(totals.total_initial),
      avgPositive: totals.avg_positive === null ? null : Number(totals.avg_positive),
      genres: genres.map((g) => ({ name: g.name, games: Number(g.games) })),
      joinedAt: member?.joined_at ?? null,
      days: n(member?.days),
    });
  } catch (error) {
    next(error);
  }
});

router.patch("/profile", async (req, res, next) => {
  const nickname = typeof req.body?.nickname === "string" ? req.body.nickname.trim() : "";
  if (nickname.length < 2 || nickname.length > 20) {
    return res.status(400).json({ error: "닉네임은 2~20자로 입력해주세요." });
  }
  try {
    await writePool.execute("UPDATE MEMBER SET nickname = ? WHERE member_id = ?", [nickname, req.user.id]);
    res.json({ user: { ...req.user, nickname } });
  } catch (error) {
    next(error);
  }
});

router.post("/password", async (req, res, next) => {
  const { currentPassword, newPassword } = req.body ?? {};
  if (typeof currentPassword !== "string" || typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 72) {
    return res.status(400).json({ error: "새 비밀번호는 8~72자로 입력해주세요." });
  }
  try {
    const [[row]] = await writePool.execute("SELECT password_hash FROM MEMBER WHERE member_id = ?", [req.user.id]);
    if (!row || !(await bcrypt.compare(currentPassword, row.password_hash))) {
      return res.status(401).json({ error: "현재 비밀번호가 올바르지 않습니다." });
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await writePool.execute("UPDATE MEMBER SET password_hash = ? WHERE member_id = ?", [hash, req.user.id]);
    // 지금 쓰는 세션만 남기고 다른 기기의 로그인은 끊음
    await writePool.execute("DELETE FROM MEMBER_SESSION WHERE member_id = ? AND token_hash <> ?", [req.user.id, req.tokenHash]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.delete("/", async (req, res, next) => {
  const password = req.body?.password;
  if (typeof password !== "string" || !password) {
    return res.status(400).json({ error: "비밀번호를 입력해주세요." });
  }
  try {
    const [[row]] = await writePool.execute("SELECT password_hash FROM MEMBER WHERE member_id = ?", [req.user.id]);
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ error: "비밀번호가 올바르지 않습니다." });
    }
    await writePool.execute("DELETE FROM MEMBER WHERE member_id = ?", [req.user.id]);
    res.clearCookie(sessionCookie, { path: "/" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

export default router;
