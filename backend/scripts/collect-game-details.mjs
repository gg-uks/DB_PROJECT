/**
 * 게임 상세 수집 (매일 03:00) · 요구사항 1 · 2 · 3 · 4 · 5
 *   data/target-games.json의 30개 게임마다
 *   ② appdetails  → GAME (가격은 최신값으로 덮어씀) · GENRE/GAME_GENRE · CATEGORY/GAME_CATEGORY · COMPANY/GAME_COMPANY
 *                  → MongoDB game_raw (소개 HTML · 스크린샷 · supported_languages 등 원본)
 *   ③ GetAppReviews 한국어 query_summary → GAME.ko_review_score · ko_positive · ko_negative
 *
 * 실행: npm run collect:details -w backend
 */
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { writePool, mongoDb, closeDb } from "../src/db.js";
import { enableApiLog } from "../src/services/api-log.js";
import { getAppDetails, getKoreanSummary, parseReleaseDate } from "../src/integrations/steam-api.js";

const DELAY_MS = Number(process.env.STEAM_DETAILS_DELAY_MS || 1600); // 5분 200회 제한 안쪽
export const MAX_GAMES = 30;

export async function loadTargets() {
  const file = new URL("../data/target-games.json", import.meta.url);
  const { games } = JSON.parse(await readFile(file, "utf8"));
  const list = games.filter((g) => Number.isInteger(g.appid) && g.appid > 0);
  if (list.length > MAX_GAMES) console.warn(`target-games.json ${list.length}개 → ${MAX_GAMES}개까지만 수집`);
  return list.slice(0, MAX_GAMES);
}

const int = (v) => (Number.isInteger(v) ? v : null);

/** 상세 1건을 MySQL에 저장 (한 트랜잭션). summary = 한국어 query_summary */
export async function saveGameDetails(pool, appid, data, summary) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const comingSoon = Boolean(data.release_date?.coming_soon);
    const price = data.price_overview;
    const hasPrice = price && Number.isInteger(price.final);
    const initial = hasPrice ? Math.round((price.initial ?? price.final) / 100) : null; // 원 × 100 → 원
    const final = hasPrice ? Math.round(price.final / 100) : null;
    const score = int(summary?.review_score);
    await conn.execute(
      `INSERT INTO GAME (appid, name, is_free, required_age, release_date, coming_soon, metacritic, header_image,
                         recommendations_total, ko_review_score, ko_positive, ko_negative,
                         initial_price, final_price, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), is_free = VALUES(is_free), required_age = VALUES(required_age),
         release_date = VALUES(release_date), coming_soon = VALUES(coming_soon), metacritic = VALUES(metacritic),
         header_image = VALUES(header_image), recommendations_total = VALUES(recommendations_total),
         ko_review_score = COALESCE(VALUES(ko_review_score), ko_review_score),
         ko_positive = IF(? IS NULL, ko_positive, VALUES(ko_positive)),
         ko_negative = IF(? IS NULL, ko_negative, VALUES(ko_negative)),
         initial_price = VALUES(initial_price), final_price = VALUES(final_price), currency = VALUES(currency)`,
      [
        appid,
        String(data.name ?? `app ${appid}`).slice(0, 255),
        data.is_free ? 1 : 0,
        Math.min(Math.max(Number(data.required_age) || 0, 0), 255),
        comingSoon ? null : parseReleaseDate(data.release_date?.date),
        comingSoon ? 1 : 0,
        int(data.metacritic?.score),
        typeof data.header_image === "string" ? data.header_image.slice(0, 500) : null,
        int(data.recommendations?.total),
        score >= 1 && score <= 9 ? score : null, // CHECK 1~9
        int(summary?.total_positive) ?? 0,
        int(summary?.total_negative) ?? 0,
        initial,
        final !== null && initial !== null ? Math.min(final, initial) : final, // CHECK 판매가 ≤ 정가
        hasPrice ? String(price.currency ?? "KRW").slice(0, 3) : null,
        summary ? 1 : null,
        summary ? 1 : null,
      ],
    );

    // 만든다: 회사 (개발 · 배급)
    await conn.execute("DELETE FROM GAME_COMPANY WHERE appid = ?", [appid]);
    for (const [role, names] of [["developer", data.developers], ["publisher", data.publishers]]) {
      for (const name of new Set((names ?? []).map((n) => String(n).trim()).filter(Boolean))) {
        await conn.execute("INSERT IGNORE INTO COMPANY (name) VALUES (?)", [name.slice(0, 150)]);
        const [[row]] = await conn.execute("SELECT company_id FROM COMPANY WHERE name = ?", [name.slice(0, 150)]);
        await conn.execute("INSERT IGNORE INTO GAME_COMPANY (appid, company_id, role) VALUES (?, ?, ?)",
          [appid, row.company_id, role]);
      }
    }

    // 속한다: 장르 / 가진다: 카테고리 — 스팀 번호를 그대로 PK
    for (const [items, master, link, key, len] of [
      [data.genres, "GENRE", "GAME_GENRE", "genre_id", 50],
      [data.categories, "CATEGORY", "GAME_CATEGORY", "category_id", 100],
    ]) {
      await conn.execute(`DELETE FROM ${link} WHERE appid = ?`, [appid]);
      for (const item of items ?? []) {
        const id = Number(item.id);
        if (!Number.isInteger(id)) continue;
        await conn.execute(
          `INSERT INTO ${master} (${key}, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)`,
          [id, String(item.description ?? id).slice(0, len)],
        );
        await conn.execute(`INSERT IGNORE INTO ${link} (appid, ${key}) VALUES (?, ?)`, [appid, id]);
      }
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function saveGameRaw(db, appid, data, summary) {
  await db.collection("game_raw").updateOne(
    { _id: appid },
    {
      $set: {
        name: data.name,
        shortDescription: data.short_description ?? "",
        detailedDescriptionHtml: data.detailed_description ?? "",
        aboutHtml: data.about_the_game ?? "",
        supportedLanguages: data.supported_languages ?? "",
        screenshots: (data.screenshots ?? []).map((s) => s.path_full).filter(Boolean),
        koreanSummary: summary ?? null,
        raw: data,
        collectedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

async function main() {
  enableApiLog(writePool);
  const targets = await loadTargets();
  const db = await mongoDb();
  let saved = 0;
  let skipped = 0;

  for (const [index, { appid, name }] of targets.entries()) {
    if (index > 0) await delay(DELAY_MS);
    try {
      const data = await getAppDetails(appid);
      if (!data || data.type !== "game") {
        skipped++;
        console.warn(`건너뜀 · ${appid} ${name ?? ""} (success: false 또는 게임 아님)`);
        continue;
      }
      const summary = await getKoreanSummary(appid).catch(() => null);
      await saveGameDetails(writePool, appid, data, summary);
      await saveGameRaw(db, appid, data, summary);
      saved++;
      console.log(
        `저장 · ${appid} ${data.name} · 장르 ${data.genres?.length ?? 0} · 카테고리 ${data.categories?.length ?? 0}` +
          (summary ? ` · 한국어 추천 ${summary.total_positive} / 비추천 ${summary.total_negative}` : ""),
      );
    } catch (error) {
      skipped++;
      console.error(`실패 · ${appid} ${name ?? ""} · ${error.message}`);
    }
  }
  console.log(`게임 상세 완료 · 저장 ${saved} · 건너뜀 ${skipped}`);
}

if (process.argv[1]?.endsWith("collect-game-details.mjs")) {
  main()
    .catch((error) => {
      console.error("게임 상세 수집 실패:", error.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
