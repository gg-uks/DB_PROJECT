import { closeStorage, readSnapshot } from "../src/repositories/storage.js";
import { indexReviews } from "../src/services/review-search.js";

try {
  const { reviews } = await readSnapshot();
  const searchable = reviews.filter((review) => review.text.trim());
  if (!searchable.length) throw new Error("색인할 리뷰 본문이 없습니다.");
  await indexReviews(searchable);
  console.log(`Elasticsearch 리뷰 ${searchable.length}건 색인 완료`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await closeStorage();
}
