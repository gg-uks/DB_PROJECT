import mysql from "mysql2/promise";
import { setTimeout as delay } from "node:timers/promises";

const db = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "playlog_dev",
  charset: "utf8mb4",
});

try {
  const [games] = await db.query(`
    SELECT g.appid, g.name
    FROM games AS g
    WHERE NULLIF(TRIM(g.header_image_url), '') IS NULL
      AND EXISTS (
        SELECT 1 FROM reviews AS r
        WHERE r.appid = g.appid AND r.content_status = 'ready'
      )
    ORDER BY g.appid
  `);

  let updated = 0;
  for (const [index, game] of games.entries()) {
    if (index > 0) await delay(1500);

    const url = new URL("https://store.steampowered.com/api/appdetails");
    url.searchParams.set("appids", String(game.appid));
    url.searchParams.set("cc", "kr");
    url.searchParams.set("l", "koreana");

    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) {
      throw new Error(`Steam 상세 조회 실패 · appid ${game.appid} · HTTP ${response.status}`);
    }

    const payload = await response.json();
    const entry = payload[String(game.appid)];
    const image = entry?.data?.header_image;

    if (!entry?.success || typeof image !== "string" || !image.startsWith("https://")) {
      console.warn(`이미지 주소 없음 · ${game.appid} · ${game.name}`);
      continue;
    }

    const [result] = await db.execute(
      `UPDATE games SET header_image_url = ?
       WHERE appid = ? AND NULLIF(TRIM(header_image_url), '') IS NULL`,
      [image, game.appid],
    );
    updated += result.affectedRows;
    if (result.affectedRows) console.log(`이미지 저장 · ${game.appid} · ${game.name}`);
  }

  console.log(`이미지 저장 ${updated}건 · 조회 대상 ${games.length}건`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
