/**
 * 회원 가입 · 로그인 · 로그아웃 (요구사항 16)
 *   MEMBER: 이메일(UNIQUE) · bcrypt 비밀번호 해시 · 닉네임 · 가입일
 *   MEMBER_SESSION(구현용): 쿠키 토큰의 SHA-256 해시 · 24시간 뒤 만료
 */
import express from "express";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { writePool as db } from "../db.js";

const router = express.Router();
export const sessionCookie = "playlog_session";
const sessionHours = 24;
const BCRYPT_ROUNDS = 10;
const DUMMY_HASH = bcrypt.hashSync("timing-safe-dummy", BCRYPT_ROUNDS); // 없는 이메일도 같은 시간 걸리게

/**
 * 관리자: MEMBER 테이블은 팀 설계(v2) 그대로 두고, .env의 ADMIN_EMAILS(쉼표 구분)에 있는 이메일만 관리자로 봄
 *   예) ADMIN_EMAILS=admin@playlog.com,leader@playlog.com
 */
export function isAdminEmail(email) {
  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(String(email ?? "").toLowerCase());
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function readSessionToken(req) {
  const cookie = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`));
  const token = cookie?.slice(sessionCookie.length + 1);
  return token && /^[0-9a-f]{64}$/.test(token) ? token : null;
}

/** 쿠키의 세션으로 회원 찾기 (없거나 만료면 null) */
export async function sessionMember(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const [[member]] = await db.execute(
    `SELECT m.member_id AS id, m.email, m.nickname, DATE_FORMAT(m.created_at, '%Y-%m-%d') AS joinedAt
     FROM MEMBER_SESSION s JOIN MEMBER m ON m.member_id = s.member_id
     WHERE s.token_hash = ? AND s.expires_at > NOW()`,
    [hashToken(token)],
  );
  return member ? { ...member, id: Number(member.id), isAdmin: isAdminEmail(member.email) } : null;
}

router.post("/signup", async (req, res, next) => {
  const { email, password, nickname } = req.body ?? {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  const trimmedNickname = typeof nickname === "string" ? nickname.trim() : "";

  if (
    normalizedEmail.length > 100 || // 도메인: 이메일 VARCHAR(100)
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 72 || // bcrypt는 72바이트까지
    trimmedNickname.length < 2 ||
    trimmedNickname.length > 20
  ) {
    return res.status(400).json({ error: "이메일, 비밀번호(8~72자), 닉네임(2~20자)을 확인해주세요." });
  }

  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await db.execute("INSERT INTO MEMBER (email, password_hash, nickname) VALUES (?, ?, ?)", [
      normalizedEmail,
      hash,
      trimmedNickname,
    ]);
    return res.status(201).json({ message: "회원가입이 완료되었습니다." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "이미 가입된 이메일입니다." });
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (!normalizedEmail || normalizedEmail.length > 100 || typeof password !== "string" || !password || password.length > 72) {
    return res.status(400).json({ error: "이메일과 비밀번호를 확인해주세요." });
  }

  try {
    const [[member]] = await db.execute(
      "SELECT member_id, email, nickname, password_hash, DATE_FORMAT(created_at, '%Y-%m-%d') AS joined_at FROM MEMBER WHERE email = ? LIMIT 1",
      [normalizedEmail],
    );
    const matches = await bcrypt.compare(password, member?.password_hash ?? DUMMY_HASH);
    if (!member || !matches) {
      return res.status(401).json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    }

    const token = randomBytes(32).toString("hex");
    await db.execute(
      `INSERT INTO MEMBER_SESSION (token_hash, member_id, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ${sessionHours} HOUR))`,
      [hashToken(token), member.member_id],
    );
    await db.execute("DELETE FROM MEMBER_SESSION WHERE expires_at < NOW()"); // 만료된 세션 정리

    res.cookie(sessionCookie, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/", // /api/me(찜 등)에도 쿠키가 전달되도록
      maxAge: sessionHours * 60 * 60 * 1000,
    });
    return res.json({ user: { id: Number(member.member_id), email: member.email, nickname: member.nickname, joinedAt: member.joined_at, isAdmin: isAdminEmail(member.email) } });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    const token = readSessionToken(req);
    if (token) await db.execute("DELETE FROM MEMBER_SESSION WHERE token_hash = ?", [hashToken(token)]);
    res.clearCookie(sessionCookie, { path: "/" });
    res.clearCookie(sessionCookie, { path: "/api/auth" }); // 예전 경로로 발급된 쿠키도 정리
    return res.json({ message: "로그아웃되었습니다." });
  } catch (error) {
    next(error);
  }
});

router.get("/me", async (req, res, next) => {
  res.set("Cache-Control", "no-store");
  try {
    const user = await sessionMember(req);
    if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });
    return res.json({ user });
  } catch (error) {
    next(error);
  }
});

export { BCRYPT_ROUNDS };
export default router;
