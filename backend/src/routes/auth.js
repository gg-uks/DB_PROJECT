import express from "express";
import mysql from "mysql2/promise";
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const router = express.Router();
const sessionCookie = "playlog_session";
const sessionHours = 24;
const deriveKey = promisify(scrypt);

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
const db = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "playlog_dev",
  charset: "utf8mb4",
  connectionLimit: 5,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

router.post("/signup", async (req, res, next) => {
  const { email, password, nickname } = req.body ?? {};
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";
  const trimmedNickname = typeof nickname === "string" ? nickname.trim() : "";

  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128 ||
    trimmedNickname.length < 2 ||
    trimmedNickname.length > 20
  ) {
    return res.status(400).json({
      error: "이메일, 비밀번호(8~128자), 닉네임(2~20자)을 확인해주세요.",
    });
  }

  try {
    const salt = randomBytes(16).toString("hex");
    const hash = await deriveKey(password, salt, 64);

    await db.execute(
      "INSERT INTO users (email, nickname, password_hash) VALUES (?, ?, ?)",
      [normalizedEmail, trimmedNickname, `${salt}:${hash.toString("hex")}`],
    );

    return res.status(201).json({ message: "회원가입이 완료되었습니다." });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "이미 가입된 이메일입니다." });
    }
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  const { email, password } = req.body ?? {};
  const normalizedEmail =
    typeof email === "string" ? email.trim().toLowerCase() : "";

  if (
    !normalizedEmail ||
    normalizedEmail.length > 254 ||
    typeof password !== "string" ||
    !password ||
    password.length > 128
  ) {
    return res.status(400).json({ error: "이메일과 비밀번호를 확인해주세요." });
  }

  try {
    const [[user]] = await db.execute(
      "SELECT id, email, nickname, password_hash FROM users WHERE email = ? LIMIT 1",
      [normalizedEmail],
    );

    const [salt, hash] = user?.password_hash?.split(":") ?? [];
    const validHash =
      /^[0-9a-f]{32}$/.test(salt ?? "") && /^[0-9a-f]{128}$/.test(hash ?? "");

    const expected = validHash ? Buffer.from(hash, "hex") : Buffer.alloc(64);
    const actual = await deriveKey(
      password,
      validHash ? salt : "0".repeat(32),
      64,
    );
    const matches = timingSafeEqual(expected, actual);

    if (!validHash || !matches) {
      return res
        .status(401)
        .json({ error: "이메일 또는 비밀번호가 올바르지 않습니다." });
    }

    const token = randomBytes(32).toString("hex");

    await db.execute(
      `INSERT INTO user_sessions (token_hash, user_id, expires_at)
   VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))`,
      [hashToken(token), user.id],
    );

    res.cookie(sessionCookie, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/auth",
      maxAge: sessionHours * 60 * 60 * 1000,
    });

    return res.json({
      user: { id: user.id, email: user.email, nickname: user.nickname },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/me", async (req, res, next) => {
  res.set("Cache-Control", "no-store");

  const cookie = (req.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`));

  const token = cookie?.slice(sessionCookie.length + 1);

  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }

  try {
    const [[user]] = await db.execute(
      `SELECT u.id, u.email, u.nickname
       FROM user_sessions AS s
       JOIN users AS u ON u.id = s.user_id
       WHERE s.token_hash = ?
         AND s.expires_at > UTC_TIMESTAMP()`,
      [hashToken(token)],
    );

    if (!user) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }

    return res.json({ user });
  } catch (error) {
    next(error);
  }
});

export default router;
