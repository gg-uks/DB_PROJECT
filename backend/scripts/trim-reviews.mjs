/**
 * 표본 크기 유지 (매일 04:30, 리뷰 저장 다음) · 운영 규칙: 게임당 추천 125 · 비추천 125를 넘지 않음
 *   (appid, voted_up)마다 최신 125건만 남기고 나머지를 MySQL REVIEW · MongoDB review_text에서 삭제
 *   REVIEW_KEYWORD는 외래키 ON DELETE CASCADE로 함께 삭제
 *
 * 실행: npm run reviews:trim -w backend
 */
import { ObjectId } from "mongodb";
import { writePool, mongoDb, closeDb } from "../src/db.js";

export const PER_SAMPLE = 125;

export async function trimReviews(pool, db, perSample = PER_SAMPLE) {
  const [rows] = await pool.query(
    `SELECT review_id, mongo_id FROM (
       SELECT review_id, mongo_id,
              ROW_NUMBER() OVER (PARTITION BY appid, voted_up ORDER BY created_at DESC, review_id DESC) AS rn
       FROM REVIEW
     ) ranked
     WHERE rn > ?`,
    [perSample],
  );
  for (let i = 0; i < rows.length; i += 500) {
    const batch = rows.slice(i, i + 500);
    await pool.query("DELETE FROM REVIEW WHERE review_id IN (?)", [batch.map((r) => String(r.review_id))]);
    if (db) {
      const ids = batch.map((r) => r.mongo_id).filter((id) => /^[0-9a-f]{24}$/.test(id)).map((id) => new ObjectId(id));
      if (ids.length) await db.collection("review_text").deleteMany({ _id: { $in: ids } });
    }
  }
  return rows.length;
}

async function main() {
  const db = await mongoDb();
  const removed = await trimReviews(writePool, db);
  const [[s]] = await writePool.query(
    "SELECT COUNT(DISTINCT appid) AS games, SUM(voted_up = 1) AS positive, SUM(voted_up = 0) AS negative FROM REVIEW",
  );
  console.log(`표본 정리 · 삭제 ${removed}건 · 남은 리뷰: 게임 ${s.games}개 · 추천 ${s.positive ?? 0} · 비추천 ${s.negative ?? 0}`);
}

if (process.argv[1]?.endsWith("trim-reviews.mjs")) {
  main()
    .catch((error) => {
      console.error("표본 정리 실패:", error.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
