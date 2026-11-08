import { extractKeywords } from "../services/review-keywords.js";

export async function readSplitSnapshot(pool, db) {
  const [gameRows] = await pool.query(`
    SELECT appid, name, header_image_url, release_date_raw, is_free
    FROM games
    ORDER BY appid
  `);

  const [reviewRows] = await pool.query(`
    SELECT review_id, appid, recommended, language, written_at,
           playtime_at_review_minutes
    FROM reviews
    WHERE content_status = 'ready'
    ORDER BY written_at DESC, review_id DESC
  `);

  const games = gameRows.map((row) => ({
    id: Number(row.appid),
    title: row.name,
    image: row.header_image_url ?? "",
    releaseDateRaw: row.release_date_raw,
    description: "",
    price: 0,
    priceAvailable: Boolean(row.is_free),
    tags: [],
    developers: [],
    source: "steam",
  }));

  const reviews = [];
  const contents = db.collection("review_contents");

  for (let offset = 0; offset < reviewRows.length; offset += 500) {
    const batch = reviewRows.slice(offset, offset + 500);

    const documents = await contents
      .find(
        { _id: { $in: batch.map((row) => row.review_id) } },
        { projection: { gameId: 1, cleanedText: 1, originalText: 1 } },
      )
      .toArray();

    const byId = new Map(documents.map((document) => [document._id, document]));

    for (const row of batch) {
      const document = byId.get(row.review_id);
      const gameId = Number(row.appid);

      if (!document || Number(document.gameId) !== gameId) continue;

      const text = document.cleanedText ?? document.originalText ?? "";

      reviews.push({
        id: row.review_id,
        reviewId: row.review_id,
        gameId,
        text,
        recommended: Boolean(row.recommended),
        playtimeAtReviewMinutes: row.playtime_at_review_minutes,
        language: row.language,
        createdAt: Math.floor(row.written_at.getTime() / 1000),
        keywords: extractKeywords(text),
        source: "steam",
      });
      if (String(row.review_id) === "239505683") {
        console.log(
          "[플레이 시간 확인]",
          import.meta.url,
          row.playtime_at_review_minutes,
        );
      }
    }
  }

  return { source: "steam", games, reviews };
}
