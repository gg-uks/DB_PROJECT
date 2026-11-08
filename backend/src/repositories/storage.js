import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "playlog_dev",
  timezone: "Z",
  connectionLimit: 5,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

const mongo = new MongoClient(
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017",
  { serverSelectionTimeoutMS: 5000 },
);
const db = mongo.db(process.env.MONGODB_DATABASE || "playlog");

const keywordRules = {
  "친구와 함께": ["친구", "같이", "함께", "멀티"],
  혼자서: ["혼자", "싱글"],
  협동: ["협동", "협력", "co-op"],
  힐링: ["힐링", "편안", "여유"],
  스토리: ["스토리", "이야기"],
  도전: ["도전", "어렵"],
  퍼즐: ["퍼즐", "두뇌"],
  생존: ["생존"],
  오픈월드: ["오픈월드"],
  액션: ["액션", "전투"],
  농장: ["농장", "농사"],
  탐험: ["탐험"],
};

const reviewColumns = `review_id, appid, language, recommended, written_at,
  playtime_at_review_minutes`;
const reviewOrder = "ORDER BY written_at DESC, review_id DESC";

async function readReviewDocuments(rows) {
  if (!rows.length) return new Map();
  const docs = await db
    .collection("review_contents")
    .find(
      { _id: { $in: rows.map((row) => String(row.review_id)) } },
      { projection: { gameId: 1, cleanedText: 1, originalText: 1 } },
    )
    .toArray();
  return new Map(docs.map((doc) => [doc._id, doc]));
}

function formatReview(row, docs) {
  const id = String(row.review_id);
  const gameId = Number(row.appid);
  const doc = docs.get(id);
  const text =
    Number(doc?.gameId) === gameId
      ? (doc.cleanedText ?? doc.originalText ?? "")
      : "";
  const normalized = text.toLowerCase();

  return {
    id,
    reviewId: id,
    gameId,
    text,
    recommended: Number(row.recommended) === 1,
    playtimeAtReviewMinutes: row.playtime_at_review_minutes,
    language: row.language,
    createdAt: Math.floor(row.written_at.getTime() / 1000),
    keywords: Object.entries(keywordRules)
      .filter(([, terms]) => terms.some((term) => normalized.includes(term)))
      .map(([keyword]) => keyword),
    source: "steam",
  };
}

export async function readSnapshot() {
  const [[gameRows], [reviewRows]] = await Promise.all([
    pool.query(`
      SELECT appid, name, header_image_url, release_date_raw, is_free
      FROM games
      ORDER BY appid
    `),
    pool.query(`
      SELECT ${reviewColumns}
      FROM reviews
      WHERE content_status = 'ready'
      ${reviewOrder}
    `),
  ]);

  const games = gameRows.map((row) => ({
    id: Number(row.appid),
    title: row.name,
    image: row.header_image_url ?? "",
    releaseDateRaw: row.release_date_raw,
    description: "",
    price: 0,
    priceAvailable: Number(row.is_free) === 1,
    tags: [],
    developers: [],
    source: "steam",
  }));

  const reviews = [];
  for (let offset = 0; offset < reviewRows.length; offset += 500) {
    const batch = reviewRows.slice(offset, offset + 500);
    const docs = await readReviewDocuments(batch);

    for (const row of batch) {
      if (Number(docs.get(String(row.review_id))?.gameId) !== Number(row.appid))
        continue;
      reviews.push(formatReview(row, docs));
    }
  }

  return { games, reviews };
}

const playtimeConditions = {
  "under-2h":
    "playtime_at_review_minutes >= 0 AND playtime_at_review_minutes < 120",
  "2-to-10h":
    "playtime_at_review_minutes >= 120 AND playtime_at_review_minutes < 600",
  "10h-plus": "playtime_at_review_minutes >= 600",
  unknown:
    "playtime_at_review_minutes IS NULL OR playtime_at_review_minutes < 0",
};
export const reviewPlaytimeGroups = Object.keys(playtimeConditions);

export async function readReviewPage({
  gameId,
  requestedPage,
  sentiment,
  playtime,
}) {
  const pageSize = 10;
  const [[game]] = await pool.execute(
    "SELECT appid FROM games WHERE appid = ?",
    [gameId],
  );
  if (!game) return null;

  const gameCondition = "appid = ? AND content_status = 'ready'";
  const conditions = [gameCondition];
  const params = [gameId];

  if (sentiment !== "all") {
    conditions.push("recommended = ?");
    params.push(sentiment === "positive" ? 1 : 0);
  }
  if (playtime !== "all") conditions.push(`(${playtimeConditions[playtime]})`);

  const where = conditions.join(" AND ");
  const [[{ total: count }]] = await pool.execute(
    `SELECT COUNT(*) AS total FROM reviews WHERE ${where}`,
    params,
  );
  const total = Number(count);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, totalPages);

  const [[rows], [groups]] = await Promise.all([
    pool.execute(
      `SELECT ${reviewColumns}
       FROM reviews WHERE ${where}
       ${reviewOrder}
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize],
    ),
    pool.execute(
      `SELECT CASE
         WHEN playtime_at_review_minutes IS NULL OR playtime_at_review_minutes < 0 THEN 'unknown'
         WHEN playtime_at_review_minutes < 120 THEN 'under-2h'
         WHEN playtime_at_review_minutes < 600 THEN '2-to-10h'
         ELSE '10h-plus'
       END AS time_group,
       SUM(CASE WHEN recommended = 1 THEN 1 ELSE 0 END) AS positive,
       SUM(CASE WHEN recommended = 0 THEN 1 ELSE 0 END) AS negative
       FROM reviews WHERE ${gameCondition}
       GROUP BY time_group`,
      [gameId],
    ),
  ]);

  const docs = await readReviewDocuments(rows);
  const reviews = rows.map((row) => formatReview(row, docs));
  const byGroup = new Map(groups.map((row) => [row.time_group, row]));
  const comparison = reviewPlaytimeGroups.map((group) => ({
    group,
    positive: Number(byGroup.get(group)?.positive ?? 0),
    negative: Number(byGroup.get(group)?.negative ?? 0),
  }));

  return { reviews, page, total, totalPages, comparison };
}

export async function readGameRatings(gameIds) {
  const placeholders = gameIds.map(() => "?").join(", ");
  const [rows] = await pool.execute(
    `SELECT g.appid,
            COUNT(r.review_id) AS total,
            COUNT(CASE WHEN r.recommended = 1 THEN 1 END) AS positive,
            COUNT(CASE WHEN r.recommended = 0 THEN 1 END) AS negative
     FROM games AS g
     LEFT JOIN reviews AS r
       ON r.appid = g.appid AND r.content_status = 'ready'
     WHERE g.appid IN (${placeholders})
     GROUP BY g.appid`,
    gameIds,
  );

  const [weeklyRows] = await pool.execute(
    `SELECT appid,
            DATE_FORMAT(DATE_SUB(DATE(written_at), INTERVAL WEEKDAY(written_at) DAY), '%Y-%m-%d') AS week,
            COUNT(*) AS total,
            COUNT(CASE WHEN recommended = 1 THEN 1 END) AS positive,
            COUNT(CASE WHEN recommended = 0 THEN 1 END) AS negative
     FROM reviews
     WHERE appid IN (${placeholders})
       AND content_status = 'ready' AND written_at IS NOT NULL
     GROUP BY appid, week
     ORDER BY week`,
    gameIds,
  );

  return rows.map(({ appid, total, positive, negative }) => ({
    id: Number(appid),
    total: Number(total),
    positive: Number(positive),
    negative: Number(negative),
    weekly: weeklyRows
      .filter((row) => Number(row.appid) === Number(appid))
      .map((row) => ({
        week: row.week,
        total: Number(row.total),
        positive: Number(row.positive),
        negative: Number(row.negative),
      })),
  }));
}

export async function closeStorage() {
  await Promise.all([pool.end(), mongo.close()]);
}
