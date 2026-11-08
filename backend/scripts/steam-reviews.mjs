import kafkaJs from "kafkajs";
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";
import { setTimeout as delay } from "node:timers/promises";
import { indexReviews } from "../src/services/review-search.js";

const { Kafka } = kafkaJs;
const TOPIC = "steam.reviews";
const TARGET = 1000;

const kafka = new Kafka({
  clientId: "playlog-reviews",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean),
});

const sql = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "playlog_dev",
  charset: "utf8mb4",
  timezone: "Z",
  connectionLimit: 2,
});

const mongo = new MongoClient(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  { serverSelectionTimeoutMS: 5000 },
);
const contents = mongo
  .db(process.env.MONGODB_DATABASE || "playlog")
  .collection("review_contents");

function reviewIdOf(review) {
  const value = review.recommendationid;

  // 큰 ID를 부정확한 숫자로 저장하지 않도록 검사합니다.
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("정밀도가 손실된 Steam 리뷰 ID입니다.");
  }

  const id = String(value);
  if (!/^\d{1,20}$/.test(id)) {
    throw new Error("Steam 리뷰 ID 형식이 올바르지 않습니다.");
  }
  return id;
}

async function fetchReviewPage(appid, cursor) {
  const url = new URL(
    "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/",
  );

  url.searchParams.set(
    "input_json",
    JSON.stringify({
      appid,
      languages: ["koreana"],
      filter: 1,
      num_per_page: 100,
      cursor,
    }),
  );

  const headers = {};
  if (process.env.STEAM_WEB_API_KEY) {
    headers["x-webapi-key"] = process.env.STEAM_WEB_API_KEY.trim();
  }

  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (response.ok) {
      const payload = await response.json();
      const page = payload.response ?? payload;

      if (!Array.isArray(page?.reviews)) {
        // API가 리뷰 0건을 명시하면 빈 페이지로 처리합니다.
        if (page?.query_summary?.num_reviews === 0) {
          return { reviews: [] };
        }

        const error = new Error(
          `리뷰 응답 형식 오류 · appid ${appid} · 응답 필드: ${
            Object.keys(page ?? {}).join(", ") || "(없음)"
          }`,
        );
        error.code = "STEAM_REVIEW_PAGE_SHAPE";
        throw error;
      }
      return page;
    }

    if (response.status === 429 && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await delay(Math.max(5000 * 2 ** attempt, retryAfter * 1000 || 0));
      continue;
    }

    throw new Error(
      `Steam 리뷰 요청 실패 · appid ${appid} · HTTP ${response.status}`,
    );
  }
}

async function produce() {
  // 이미 MySQL에 있는 게임만 사용해 리뷰 외래키 오류를 방지합니다.
  const [games] = await sql.query(
    "SELECT appid, name FROM games ORDER BY appid",
  );
  const preferred = [413150, 105600, 892970, 1245620, 1091500, 570, 730];
  const rank = (appid) => {
    const index = preferred.indexOf(Number(appid));
    return index === -1 ? preferred.length : index;
  };
  games.sort((a, b) => rank(a.appid) - rank(b.appid));

  if (!games.length) throw new Error("MySQL games 테이블이 비어 있습니다.");

  const producer = kafka.producer({ allowAutoTopicCreation: false });
  const seen = new Set();

  try {
    await producer.connect();

    for (const game of games) {
      const appid = Number(game.appid);
      let cursor = "*";

      // 여러 게임의 리뷰를 확보하도록 게임당 최대 3페이지를 읽습니다.
      for (
        let pageNumber = 0;
        pageNumber < 3 && seen.size < TARGET;
        pageNumber++
      ) {
        let page;

        try {
          page = await fetchReviewPage(appid, cursor);
        } catch (error) {
          if (error.code !== "STEAM_REVIEW_PAGE_SHAPE") throw error;

          console.warn(
            `${game.name}의 남은 페이지를 건너뜁니다. ${error.message}`,
          );
          break; // 이 게임의 페이지 반복을 끝내고 다음 게임으로 이동
        }
        const messages = [];

        for (const review of page.reviews) {
          const id = reviewIdOf(review);
          if (seen.has(id) || typeof review.review !== "string") continue;

          seen.add(id);
          messages.push({
            key: id,
            value: JSON.stringify({ appid, review }),
          });

          if (seen.size === TARGET) break;
        }

        if (messages.length) {
          await producer.send({ topic: TOPIC, acks: -1, messages });
          console.log(`${game.name} · 발행 누계 ${seen.size}/${TARGET}건`);
        }

        if (!page.reviews.length || !page.cursor || page.cursor === cursor)
          break;
        cursor = page.cursor;
        if (seen.size < TARGET) await delay(1500);
      }

      if (seen.size === TARGET) break;
      await delay(1500);
    }

    if (seen.size < TARGET) {
      throw new Error(`발행 ${seen.size}건 · 목표 ${TARGET}건에 미달했습니다.`);
    }

    console.log(`steam.reviews에 서로 다른 리뷰 ${seen.size}건 발행 완료`);
  } finally {
    await producer.disconnect();
  }
}

async function consume() {
  const consumer = kafka.consumer({
    groupId: "playlog-reviews-db-v1",
    allowAutoTopicCreation: false,
  });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    try {
      await consumer.disconnect();
    } finally {
      await Promise.all([sql.end(), mongo.close()]);
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
    await sql.query("SELECT review_id FROM reviews LIMIT 1");
    await mongo.connect();
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

    console.log("steam.reviews 수신 대기 중");

    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        const { appid, review } = JSON.parse(message.value.toString());
        const id = reviewIdOf(review);

        if (
          !Number.isInteger(appid) ||
          appid < 1 ||
          typeof review.review !== "string" ||
          typeof review.language !== "string" ||
          typeof review.voted_up !== "boolean" ||
          !Number.isInteger(review.timestamp_created) ||
          !Number.isInteger(review.timestamp_updated)
        ) {
          throw new Error(`리뷰 필드 확인 필요 · ${id}`);
        }

        const writtenAt = new Date(review.timestamp_created * 1000);
        const updatedAt = new Date(review.timestamp_updated * 1000);
        const collectedAt = new Date();
        const cleanedText = review.review
          .replace(/\[\/?[^\]]+\]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

        await contents.updateOne(
          { _id: id },
          {
            $set: {
              gameId: appid,
              originalText: review.review,
              cleanedText,
              sourceUpdatedAt: updatedAt,
              collectedAt,
              schemaVersion: 1,
              raw: review,
            },
          },
          { upsert: true },
        );

        await sql.execute(
          `INSERT INTO reviews (
             review_id, appid, language, recommended,
             playtime_at_review_minutes, helpful_votes,
             written_at, source_updated_at, collected_at, content_status
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
           ON DUPLICATE KEY UPDATE
             language = VALUES(language),
             recommended = VALUES(recommended),
             playtime_at_review_minutes = VALUES(playtime_at_review_minutes),
             helpful_votes = VALUES(helpful_votes),
             written_at = VALUES(written_at),
             source_updated_at = VALUES(source_updated_at),
             collected_at = VALUES(collected_at),
             content_status = 'ready'`,
          [
            id,
            appid,
            review.language,
            review.voted_up,
            review.author?.playtime_at_review ?? null,
            review.votes_up ?? 0,
            writtenAt,
            updatedAt,
            collectedAt,
          ],
        );

        if (cleanedText.trim()) {
          await indexReviews([
            {
              id,
              gameId: appid,
              text: cleanedText,
              keywords: [],
              recommended: review.voted_up,
            },
          ]);
        }

        // 양쪽 DB 저장이 성공한 뒤 다음 오프셋을 커밋합니다.
        await consumer.commitOffsets([
          {
            topic,
            partition,
            offset: (BigInt(message.offset) + 1n).toString(),
          },
        ]);

        console.log(`리뷰 저장 완료 · appid ${appid} · 리뷰 ${id}`);
      },
    });
  } catch (error) {
    await close();
    throw error;
  }
}

const mode = process.argv[2];

try {
  if (mode === "consume") {
    await consume();
  } else if (mode === "produce") {
    try {
      await produce();
    } finally {
      await sql.end();
    }
  } else {
    throw new Error("실행 모드로 produce 또는 consume을 지정하세요.");
  }
} catch (error) {
  console.error("실패:", error.message);
  process.exitCode = 1;
}
