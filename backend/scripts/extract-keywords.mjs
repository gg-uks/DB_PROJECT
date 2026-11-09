/**
 * 키워드 추출 (매일 04:30, 표본 정리 다음) · 요구사항 13 · 14
 *   REVIEW_KEYWORD가 아직 없는 리뷰만 → MongoDB review_text.cleaned → 명사 추출 → KEYWORD · REVIEW_KEYWORD
 *   (리뷰가 수정되면 consume 단계에서 REVIEW_KEYWORD를 지워 두므로 여기서 다시 추출됨)
 *   ES 색인이 있으면 리뷰 문서의 keywords 필드도 채움
 *
 * 실행: npm run keywords:extract -w backend
 *       (--rebuild 또는 KEYWORD_REBUILD=1 이면 모든 리뷰를 다시 추출: npm run keywords:extract -w backend -- --rebuild)
 */
import { ObjectId } from "mongodb";
import { writePool, mongoDb, closeDb } from "../src/db.js";
import { extractKeywords } from "../src/services/keyword-extractor.js";

const BATCH = 300;

/** 리뷰 묶음 처리. texts: Map(review_id 문자열 → 본문) */
export async function processReviews(pool, rows, texts) {
  const extracted = [];
  const methods = {};
  for (const row of rows) {
    const id = String(row.review_id);
    const { method, keywords } = await extractKeywords(texts.get(id) ?? "");
    methods[method] = (methods[method] ?? 0) + 1;
    extracted.push({ id, keywords });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const words = [...new Set(extracted.flatMap((e) => e.keywords.map((k) => k.word)))];
    const ids = new Map();
    if (words.length) {
      await conn.query("INSERT IGNORE INTO KEYWORD (word) VALUES ?", [words.map((w) => [w])]);
      const [kw] = await conn.query("SELECT keyword_id, word FROM KEYWORD WHERE word IN (?)", [words]);
      for (const k of kw) ids.set(k.word, k.keyword_id);
    }
    await conn.query("DELETE FROM REVIEW_KEYWORD WHERE review_id IN (?)", [extracted.map((e) => e.id)]);
    const pairs = extracted.flatMap((e) =>
      e.keywords.filter((k) => ids.has(k.word)).map((k) => [e.id, ids.get(k.word), k.tf]));
    if (pairs.length) {
      await conn.query(
        "INSERT INTO REVIEW_KEYWORD (review_id, keyword_id, tf) VALUES ? ON DUPLICATE KEY UPDATE tf = tf + VALUES(tf)",
        [pairs],
      );
    }
    await conn.commit();
    return { extracted, methods, pairs: pairs.length };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function updateSearchIndex(extracted) {
  const base = process.env.ELASTICSEARCH_URL;
  if (!base || !extracted.length) return;
  const index = process.env.ELASTICSEARCH_INDEX || "playlog-reviews-v1";
  const headers = { "Content-Type": "application/x-ndjson" };
  if (process.env.ELASTICSEARCH_API_KEY) headers.Authorization = `ApiKey ${process.env.ELASTICSEARCH_API_KEY}`;
  const body = extracted
    .flatMap(({ id, keywords }) => [
      JSON.stringify({ update: { _id: id } }),
      JSON.stringify({ doc: { keywords: keywords.map((k) => k.word) } }),
    ])
    .join("\n") + "\n";
  try {
    const response = await fetch(`${base.replace(/\/+$/, "")}/${index}/_bulk`, {
      method: "POST", headers, body, signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.warn(`ES keywords 갱신 건너뜀 (${error.message})`);
  }
}

async function main() {
  const db = await mongoDb();
  const texts = db.collection("review_text");
  const rebuild = process.env.KEYWORD_REBUILD === "1" || process.argv.includes("--rebuild");
  let lastId = "0";
  let total = 0;
  const methods = {};
  for (;;) {
    // 키워드가 하나도 없는 리뷰 = 아직 추출 안 한 리뷰 (명사가 없는 리뷰는 매번 다시 확인 — 수가 적음)
    const [rows] = await writePool.query(
      rebuild
        ? `SELECT review_id, mongo_id FROM REVIEW WHERE review_id > ? ORDER BY review_id LIMIT ?`
        : `SELECT r.review_id, r.mongo_id FROM REVIEW r
           WHERE r.review_id > ? AND NOT EXISTS (SELECT 1 FROM REVIEW_KEYWORD rk WHERE rk.review_id = r.review_id)
           ORDER BY r.review_id LIMIT ?`,
      [lastId, BATCH],
    );
    if (!rows.length) break;
    lastId = String(rows.at(-1).review_id);
    const oids = rows.map((r) => r.mongo_id).filter((m) => /^[0-9a-f]{24}$/.test(m)).map((m) => new ObjectId(m));
    const docs = await texts.find({ _id: { $in: oids } }, { projection: { cleaned: 1, original: 1, reviewId: 1 } }).toArray();
    const map = new Map(docs.map((d) => [String(d.reviewId), d.cleaned ?? d.original ?? ""]));
    const result = await processReviews(writePool, rows, map);
    await updateSearchIndex(result.extracted);
    for (const [m, n] of Object.entries(result.methods)) methods[m] = (methods[m] ?? 0) + n;
    total += rows.length;
    console.log(`키워드 추출 ${total}건 · 연결 ${result.pairs}개`);
  }
  console.log(`키워드 추출 완료 · ${total}건 · 방법 ${JSON.stringify(methods)}`);
}

if (process.argv[1]?.endsWith("extract-keywords.mjs")) {
  main()
    .catch((error) => {
      console.error("키워드 추출 실패:", error.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
