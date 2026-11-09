/**
 * 키워드 집계 (매일 04:30, 키워드 추출 다음) · 요구사항 15 · 의도적 반정규화
 *   REVIEW + REVIEW_KEYWORD → GAME_KEYWORD (appid, keyword_id, voted_up, review_cnt) 전체 재계산
 *   비율의 분모(집단 전체 리뷰 수)는 저장하지 않고 조회할 때 REVIEW에서 바로 셈 (2NF 결정)
 *
 * 실행: npm run keywords:aggregate -w backend
 */
import { writePool, closeDb } from "../src/db.js";

export async function aggregateKeywords(pool) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM GAME_KEYWORD");
    await conn.query(
      `INSERT INTO GAME_KEYWORD (appid, keyword_id, voted_up, review_cnt)
       SELECT r.appid, rk.keyword_id, r.voted_up, COUNT(*)
       FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
       GROUP BY r.appid, rk.keyword_id, r.voted_up`,
    );
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  const [[row]] = await pool.query(
    "SELECT COUNT(*) AS n, SUM(voted_up = 1) AS pos, SUM(voted_up = 0) AS neg FROM GAME_KEYWORD",
  );
  return { rows: Number(row.n), positive: Number(row.pos ?? 0), negative: Number(row.neg ?? 0) };
}

if (process.argv[1]?.endsWith("aggregate-keywords.mjs")) {
  aggregateKeywords(writePool)
    .then((r) => console.log(`GAME_KEYWORD 재계산 · ${r.rows}행 (추천 ${r.positive} · 비추천 ${r.negative})`))
    .catch((error) => {
      console.error("키워드 집계 실패:", error.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
