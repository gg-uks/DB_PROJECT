import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";

const appid = 413150;

const mongo = new MongoClient(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  { serverSelectionTimeoutMS: 5000 },
);

let connection;

async function main() {
  // 1. 실제 Steam 게임 정보 요청
  const url = new URL("https://store.steampowered.com/api/appdetails");

  url.searchParams.set("appids", String(appid));
  url.searchParams.set("cc", "kr");
  url.searchParams.set("l", "koreana");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) {
    throw new Error(`게임 API 오류: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const result = payload[String(appid)];

  if (!result?.success || result.data?.type !== "game") {
    throw new Error("게임 정보를 가져오지 못했습니다.");
  }

  const game = result.data;

  // 2. MongoDB에 이미 저장한 리뷰 가져오기
  await mongo.connect();

  const documents = await mongo
    .db(process.env.MONGODB_DATABASE || "playlog")
    .collection("review_contents")
    .find({ gameId: appid })
    .toArray();

  if (documents.length === 0) {
    throw new Error("MongoDB에 저장된 리뷰가 없습니다.");
  }

  // 저장 전 원본 필드 확인
  for (const document of documents) {
    const review = document.raw;

    if (
      !review ||
      String(review.recommendationid) !== document._id ||
      typeof review.voted_up !== "boolean" ||
      typeof review.timestamp_created !== "number" ||
      typeof review.timestamp_updated !== "number"
    ) {
      throw new Error(`리뷰 원본 형식 확인 필요: ${document._id}`);
    }
  }

  // 3. MySQL 연결
  connection = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || "playlog_dev",
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  await connection.beginTransaction();

  try {
    // 4. 게임 먼저 저장: 리뷰의 외래키 대상
    await connection.execute(
      `INSERT INTO games (
        appid,
        name,
        release_date,
        release_date_raw,
        coming_soon,
        is_free,
        metacritic_score,
        header_image_url,
        collected_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        release_date_raw = VALUES(release_date_raw),
        coming_soon = VALUES(coming_soon),
        is_free = VALUES(is_free),
        metacritic_score = VALUES(metacritic_score),
        header_image_url = VALUES(header_image_url),
        collected_at = VALUES(collected_at)`,
      [
        appid,
        game.name,
        null, // 출시일 문자열을 확실히 파싱하기 전에는 NULL
        game.release_date?.date ?? null,
        game.release_date?.coming_soon ?? null,
        game.is_free ?? null,
        game.metacritic?.score ?? null,
        game.header_image ?? null,
        new Date(),
      ],
    );

    // 5. MongoDB 원본에서 리뷰 메타데이터 추출
    for (const document of documents) {
      const review = document.raw;

      await connection.execute(
        `INSERT INTO reviews (
          review_id,
          appid,
          language,
          recommended,
          playtime_at_review_minutes,
          helpful_votes,
          written_at,
          source_updated_at,
          collected_at,
          content_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
        ON DUPLICATE KEY UPDATE
          language = VALUES(language),
          recommended = VALUES(recommended),
          playtime_at_review_minutes =
            VALUES(playtime_at_review_minutes),
          helpful_votes = VALUES(helpful_votes),
          written_at = VALUES(written_at),
          source_updated_at = VALUES(source_updated_at),
          collected_at = VALUES(collected_at),
          content_status = VALUES(content_status)`,
        [
          document._id,
          appid,
          review.language,
          review.voted_up,
          review.author?.playtime_at_review ?? null,
          review.votes_up ?? 0,
          new Date(review.timestamp_created * 1000),
          new Date(review.timestamp_updated * 1000),
          new Date(),
        ],
      );
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  }

  // 6. 저장 결과 확인
  const [rows] = await connection.execute(
    `SELECT
       g.appid,
       g.name,
       COUNT(r.review_id) AS review_count
     FROM games g
     LEFT JOIN reviews r ON r.appid = g.appid
     WHERE g.appid = ?
     GROUP BY g.appid, g.name`,
    [appid],
  );

  console.table(rows);
  console.log("MySQL 저장 완료!");
}

main()
  .catch((error) => {
    console.error("실패:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await connection?.end();
    await mongo.close();
  });
