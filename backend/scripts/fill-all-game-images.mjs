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

async function fetchGameImage(appid) {
  const url = new URL("https://store.steampowered.com/api/appdetails");
  url.searchParams.set("appids", String(appid));
  url.searchParams.set("cc", "kr");
  url.searchParams.set("l", "koreana");

  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
    });

    if (response.ok) {
      const payload = await response.json();
      const entry = payload?.[String(appid)];
      const image = entry?.data?.header_image;

      if (entry?.success && typeof image === "string" && image.startsWith("https://")) {
        return image;
      }

      return null;
    }

    await response.body?.cancel();

    const canRetry = response.status === 429 || response.status >= 500;
    if (!canRetry || attempt === 3) {
      throw new Error(`Steam 조회 실패 · appid ${appid} · HTTP ${response.status}`);
    }

    const retryAfter = response.headers.get("retry-after");
    const retrySeconds = Number(retryAfter);
    const retryAfterMs = Number.isFinite(retrySeconds)
      ? retrySeconds * 1000
      : Date.parse(retryAfter) - Date.now();

    const waitMs = Math.max(attempt * 5000, retryAfterMs || 0);

    console.warn(
      `Steam HTTP ${response.status} · appid ${appid} · ${Math.ceil(waitMs / 1000)}초 후 재시도 (${attempt}/2)`,
    );
    await delay(waitMs);
  }
}

let updated = 0;
let missing = 0;

try {
  const [[connection]] = await db.query(
    "SELECT DATABASE() AS db_name, @@hostname AS db_host, @@port AS db_port",
  );
  console.log("접속한 DB:", connection);

  const [games] = await db.query(`
    SELECT appid, name
    FROM games
    WHERE NULLIF(TRIM(header_image_url), '') IS NULL
    ORDER BY appid
  `);
  console.log(`이미지 조회 대상 ${games.length}건`);

  for (const [index, game] of games.entries()) {
    if (index > 0) await delay(1500);

    const image = await fetchGameImage(game.appid);

    if (!image) {
      missing++;
      console.warn(`이미지 주소 없음 · ${game.appid} · ${game.name}`);
      continue;
    }

    const [result] = await db.execute(
      `UPDATE games
       SET header_image_url = ?
       WHERE appid = ?
         AND NULLIF(TRIM(header_image_url), '') IS NULL`,
      [image, game.appid],
    );

    updated += result.affectedRows;
    if (result.affectedRows) {
      console.log(`이미지 저장 · ${game.appid} · ${game.name}`);
    }
  }

  console.log(
    `이미지 저장 ${updated}건 · 주소 없음 ${missing}건 · 조회 대상 ${games.length}건`,
  );
} catch (error) {
  console.error(`중단 전 저장 ${updated}건 · ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.end();
}