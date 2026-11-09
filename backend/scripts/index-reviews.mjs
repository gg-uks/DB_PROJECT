import { closeStorage, readSnapshot } from "../src/repositories/storage.js";
/**
 * MySQL REVIEW + MongoDB review_text 전체를 Elasticsearch에 다시 색인
 *   npm run reviews:index -w backend              인덱스가 없으면 만들고 색인
 *   npm run reviews:index -w backend -- --recreate 인덱스를 지우고 nori 매핑으로 새로 만든 뒤 색인
 */
import { ensureReviewIndex, indexReviews } from "../src/services/review-search.js";

try {
  const { reviews } = await readSnapshot();
  const searchable = reviews.filter((review) => review.text.trim());
  if (!searchable.length) throw new Error("색인할 리뷰 본문이 없습니다.");
  await ensureReviewIndex({ recreate: process.argv.includes("--recreate") });
  await indexReviews(searchable);
  console.log(`Elasticsearch 리뷰 ${searchable.length}건 색인 완료`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeStorage();
}
