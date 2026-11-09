/**
 * 리뷰 수집 (매일 03:00, 게임 상세 다음) · 요구사항 8 ~ 12 · 18
 *
 *  produce : 게임마다 한국어 리뷰를 최신순으로
 *            추천(review_type 1) 125건 + 비추천(review_type 2) 125건 = 250건까지 Kafka(steam.reviews)에 발행
 *            - 3어절 미만 리뷰는 수집하지 않음
 *            - 이미 저장한 가장 최근 리뷰(MAX(created_at))보다 오래된 리뷰가 나오면 멈춤 → 새 리뷰만 (요구사항 18)
 *  consume : Kafka에서 받아 MongoDB review_text(원문) → MySQL REVIEW(mongo_id로 연결) → ES(검색) 순서로 저장
 *            저장이 모두 끝난 뒤 오프셋 커밋 · 같은 리뷰는 UPSERT
 *  (125건 초과분 정리는 trim-reviews.mjs)
 *
 * 실행: npm run reviews:produce -w backend / npm run reviews:consume -w backend
 */
import kafkaJs from "kafkajs";
import { setTimeout as delay } from "node:timers/promises";
import { writePool as sql, mongoDb, closeDb } from "../src/db.js";
import { indexReviews } from "../src/services/review-search.js";
import { enableApiLog } from "../src/services/api-log.js";
import { getReviewPage, wordCount } from "../src/integrations/steam-api.js";

const { Kafka } = kafkaJs;
const TOPIC = "steam.reviews";
export const PER_SAMPLE = 125; // 추천 125 · 비추천 125
const MAX_PAGES = Number(process.env.REVIEW_MAX_PAGES || 10); // 표본당 최대 페이지 (3어절 미만 제외로 더 넘길 수 있음)
const SAMPLES = [
  { votedUp: 1, reviewType: 1, label: "추천" },
  { votedUp: 0, reviewType: 2, label: "비추천" },
];

const kafka = new Kafka({
  clientId: "playlog-reviews",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean),
});

export function reviewIdOf(review) {
  const value = review.recommendationid;
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("정밀도가 손실된 Steam 리뷰 ID입니다.");
  }
  const id = String(value);
  if (!/^\d{1,20}$/.test(id)) throw new Error("Steam 리뷰 ID 형식이 올바르지 않습니다.");
  return id;
}

export function cleanText(text) {
  return String(text ?? "")
    .replace(/\[\/?[^\]]+\]/g, " ") // BBCode
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * direct=true : Kafka 없이 바로 저장 (Windows 테스트용 · npm run reviews:direct)
 *               Steam → MongoDB review_text → MySQL REVIEW
 */
async function produce({ direct = false } = {}) {
  enableApiLog(sql);
  const [games] = await sql.query(
    `SELECT g.appid, g.name,
            MAX(CASE WHEN r.voted_up = 1 THEN r.created_at END) AS last_pos,
            MAX(CASE WHEN r.voted_up = 0 THEN r.created_at END) AS last_neg
     FROM GAME g LEFT JOIN REVIEW r ON r.appid = g.appid
     GROUP BY g.appid, g.name
     ORDER BY g.appid`,
  );
  if (!games.length) {
    throw new Error("GAME이 비어 있습니다. 먼저 npm run collect:details -w backend 를 실행하세요.");
  }

  const producer = direct ? null : kafka.producer({ allowAutoTopicCreation: false });
  const db = direct ? await mongoDb() : null;
  if (direct) await db.collection("review_text").createIndex({ reviewId: 1 }, { unique: true });
  let total = 0;
  try {
    if (producer) await producer.connect();
    for (const game of games) {
      const appid = Number(game.appid);
      const counts = [];
      for (const { votedUp, reviewType, label } of SAMPLES) {
        const last = votedUp ? game.last_pos : game.last_neg;
        const lastSeconds = last ? Math.floor(new Date(last).getTime() / 1000) : 0;
        let cursor = "*";
        let published = 0;
        let short = 0;

        for (let page = 0; page < MAX_PAGES && published < PER_SAMPLE; page++) {
          let data;
          try {
            data = await getReviewPage(appid, { reviewType, cursor });
          } catch (error) {
            if (error.code !== "STEAM_REVIEW_PAGE_SHAPE") throw error;
            console.warn(`${game.name} ${label} · ${error.message}`);
            break;
          }
          const messages = [];
          let reachedOld = false;
          for (const review of data.reviews) {
            if (lastSeconds && review.timestamp_created <= lastSeconds) {
              reachedOld = true;
              break;
            }
            if (typeof review.review !== "string" || wordCount(review.review) < 3) {
              short++;
              continue;
            }
            messages.push({ key: reviewIdOf(review), value: JSON.stringify({ appid, review }), review });
            if (published + messages.length >= PER_SAMPLE) break;
          }
          if (messages.length) {
            if (direct) {
              for (const m of messages) await saveReview(db, appid, m.review);
            } else {
              await producer.send({ topic: TOPIC, acks: -1, messages: messages.map(({ key, value }) => ({ key, value })) });
            }
            published += messages.length;
          }
          if (reachedOld || !data.reviews.length || !data.cursor || data.cursor === cursor) break;
          cursor = data.cursor;
          await delay(1500);
        }
        counts.push(`새 ${label} ${published}건`);
        if (short) counts.push(`3어절 미만 제외 ${short}건`);
        total += published;
        await delay(1500);
      }
      console.log(`${game.name} · ${counts.join(" · ")}`);
    }
    console.log(direct ? `새 리뷰 총 ${total}건 저장 완료 (Kafka 없이)` : `steam.reviews에 새 리뷰 총 ${total}건 발행 완료`);
  } finally {
    if (producer) await producer.disconnect();
  }
}

/** 리뷰 1건 저장: MongoDB review_text(원문) → MySQL REVIEW(mongo_id). consume과 테스트에서 함께 사용 */
export async function saveReview(db, appid, review) {
  const id = reviewIdOf(review);
  if (
    !Number.isInteger(appid) ||
    typeof review.review !== "string" ||
    typeof review.voted_up !== "boolean" ||
    !Number.isInteger(review.timestamp_created) ||
    !/^\d{1,20}$/.test(String(review.author?.steamid ?? ""))
  ) {
    throw new Error(`리뷰 필드 확인 필요 · ${id}`);
  }
  const steamid = String(review.author.steamid);
  const cleaned = cleanText(review.review);
  const toDate = (s) => (Number.isInteger(s) && s > 0 ? new Date(s * 1000) : null);
  const texts = db.collection("review_text");

  // 같은 작성자가 리뷰를 지우고 다시 쓴 경우: 예전 리뷰 정리 (UNIQUE (appid, steamid) · 요구사항 8)
  const [old] = await sql.execute(
    "SELECT review_id, mongo_id FROM REVIEW WHERE appid = ? AND steamid = ? AND review_id <> ?",
    [appid, steamid, id],
  );
  for (const row of old) {
    await sql.execute("DELETE FROM REVIEW WHERE review_id = ?", [row.review_id]);
    await texts.deleteOne({ reviewId: String(row.review_id) });
  }

  // ① 원문(비정형) — MongoDB. author.num_reviews · hardware 등은 raw에만 남김 (요구사항 9)
  const doc = await texts.findOneAndUpdate(
    { reviewId: id },
    {
      $set: { reviewId: id, appid, original: review.review, cleaned, collectedAt: new Date(), raw: review },
    },
    { upsert: true, returnDocument: "after", projection: { _id: 1 } },
  );
  const mongoId = String((doc?.value ?? doc)?._id ?? "");
  if (!/^[0-9a-f]{24}$/.test(mongoId)) throw new Error(`MongoDB _id를 받지 못했습니다 · ${id}`);

  // ② 정형 — MySQL REVIEW. 리뷰가 수정됐으면 키워드를 지워 다시 추출되게 함
  const updatedAt = toDate(review.timestamp_updated) ?? toDate(review.timestamp_created);
  const [[prev]] = await sql.execute("SELECT updated_at FROM REVIEW WHERE review_id = ?", [id]);
  if (prev && new Date(prev.updated_at).getTime() !== updatedAt.getTime()) {
    await sql.execute("DELETE FROM REVIEW_KEYWORD WHERE review_id = ?", [id]);
  }
  const a = review.author ?? {};
  const minutes = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
  await sql.execute(
    `INSERT INTO REVIEW (review_id, appid, steamid, language, voted_up, created_at, updated_at,
                         votes_up, votes_funny, steam_purchase, received_for_free, early_access,
                         playtime_at_review, playtime_forever, last_played, mongo_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       voted_up = VALUES(voted_up), updated_at = VALUES(updated_at), votes_up = VALUES(votes_up),
       votes_funny = VALUES(votes_funny), playtime_at_review = VALUES(playtime_at_review),
       playtime_forever = VALUES(playtime_forever), last_played = VALUES(last_played), mongo_id = VALUES(mongo_id)`,
    [
      id, appid, steamid, String(review.language ?? "koreana").slice(0, 20), review.voted_up ? 1 : 0,
      toDate(review.timestamp_created), updatedAt,
      Number(review.votes_up ?? 0), Number(review.votes_funny ?? 0),
      review.steam_purchase === false ? 0 : 1, review.received_for_free ? 1 : 0,
      review.written_during_early_access ? 1 : 0,
      minutes(a.playtime_at_review), minutes(a.playtime_forever), toDate(a.last_played), mongoId,
    ],
  );
  return { id, cleaned, mongoId };
}

async function consume() {
  const db = await mongoDb();
  await db.collection("review_text").createIndex({ reviewId: 1 }, { unique: true });
  const consumer = kafka.consumer({ groupId: "playlog-reviews-db-v3", allowAutoTopicCreation: false });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try {
      await consumer.disconnect();
    } finally {
      await closeDb();
    }
  }
  const onError = (error) => {
    console.error("Consumer 실패:", error.message);
    process.exitCode = 1;
  };
  process.once("SIGINT", () => close().catch(onError));
  process.once("SIGTERM", () => close().catch(onError));
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    console.error("Consumer 오류:", payload.error.message);
    if (!payload.restart) {
      process.exitCode = 1;
      close().catch(onError);
    }
  });

  try {
    await sql.query("SELECT review_id FROM REVIEW LIMIT 1");
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
    console.log("steam.reviews 수신 대기 중");

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const { appid, review } = JSON.parse(message.value.toString());
        const { id, cleaned } = await saveReview(db, appid, review);
        if (cleaned && process.env.ELASTICSEARCH_URL) {
          await indexReviews([{ id, gameId: appid, text: cleaned, keywords: [], recommended: review.voted_up }]);
        }
        // 저장이 모두 성공한 뒤 다음 오프셋을 커밋
        await consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
        console.log(`리뷰 저장 · appid ${appid} · ${review.voted_up ? "추천" : "비추천"} · ${id}`);
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1]?.endsWith("steam-reviews.mjs")) {
  const mode = process.argv[2];
  try {
    if (mode === "consume") {
      await consume();
    } else if (mode === "produce" || mode === "direct") {
      try {
        await produce({ direct: mode === "direct" });
      } finally {
        await closeDb();
      }
    } else {
      throw new Error("실행 모드로 produce · consume · direct 중 하나를 지정하세요.");
    }
  } catch (error) {
    console.error("실패:", error.message);
    process.exitCode = 1;
  }
}
