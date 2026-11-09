import { MongoClient } from "mongodb";

const client = new MongoClient("mongodb://127.0.0.1:27017", {
  serverSelectionTimeoutMS: 5000
});

const appid = 413150; // Stardew Valley

async function main() {
  // 1. 실제 Steam 리뷰 API 요청
  const url = new URL(
    "https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/"
  );

  url.searchParams.set(
    "input_json",
    JSON.stringify({
      appid,
      languages: ["koreana"],
      filter: 1,
      num_per_page: 100
    })
  );

  const response = await fetch(url, {
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    throw new Error(`Steam API 오류: HTTP ${response.status}`);
  }

  const payload = await response.json();
  const data = payload.response ?? payload;

  if (!Array.isArray(data.reviews)) {
    throw new Error("Steam 리뷰 응답 구조를 확인해야 합니다.");
  }

  if (data.reviews.length === 0) {
    console.log("이번 요청에서 받은 리뷰가 없습니다.");
    return;
  }

  // 2. MongoDB 연결
  await client.connect();

  const db = client.db("playlog");
  const collection = db.collection("review_contents");

  // 3. 원문 보존 + 간단한 서식 정제
  const operations = data.reviews.map((review) => {
    if (
      review.recommendationid == null ||
      typeof review.review !== "string"
    ) {
      throw new Error("리뷰 ID 또는 본문이 없습니다.");
    }

    const reviewId = String(review.recommendationid);

    const cleanedText = review.review
      .replace(/\[\/?[^\]]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return {
      updateOne: {
        filter: { _id: reviewId },
        update: {
          $set: {
            gameId: appid,
            originalText: review.review,
            cleanedText,
            sourceUpdatedAt: new Date(
              review.timestamp_updated * 1000
            ),
            collectedAt: new Date(),
            schemaVersion: 1,

            // MySQL 메타데이터 저장 연동 전까지 원본 보존
            raw: review
          }
        },
        upsert: true
      }
    };
  });

  // 4. 같은 리뷰 ID가 있으면 갱신, 없으면 추가
  const result = await collection.bulkWrite(operations);

  console.log("API에서 받은 리뷰:", data.reviews.length);
  console.log("신규 저장:", result.upsertedCount);
  console.log("기존 문서 매칭:", result.matchedCount);

  // 5. DB에서 실제 저장 결과 조회
  const saved = await collection.findOne(
    { gameId: appid },
    {
      projection: {
        _id: 1,
        gameId: 1,
        cleanedText: 1
      }
    }
  );

  console.log("저장 확인:", saved);
}

main()
  .catch((error) => {
    console.error("실패:", error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.close();
  });