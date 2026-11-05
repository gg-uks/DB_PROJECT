import { readFileSync } from "node:fs";

/**
 * [실제 데이터 연결 TODO]
 *
 * 1. 게임 데이터
 *    현재: mocks/games.json
 *    변경: MySQL 조회
 *    외부 게임 상세 API는 공급원·필드·사용 조건 확인 후 선정
 *
 * 2. 리뷰 데이터
 *    현재: mocks/reviews.json
 *    변경: 수집 후 MongoDB에 저장한 리뷰 조회
 *
 * 3. 키워드 분석
 *    현재: 목리뷰에 수동으로 넣은 keywords
 *    변경: 리뷰 본문 정제 → 키워드 추출 → 통계 저장
 *
 * 4. 검색
 *    현재: 키워드 사전 검색
 *    변경: 검색 조건 추출 + Elasticsearch 조회
 *
 * 5. Redis
 *    반복 조회되는 검색 결과·키워드 통계 캐시
 *
 * 6. Kafka
 *    리뷰 수집 이벤트 전달 및 분석 작업 연결
 *
 * 프론트에 반환하는 필드 이름은 유지해
 * 화면 수정 없이 데이터 공급원을 교체합니다.
 */


export const games = JSON.parse(
  readFileSync(new URL("../mocks/games.json", import.meta.url))
);
export const reviews = JSON.parse(
  readFileSync(new URL("../mocks/reviews.json", import.meta.url))
);
export function keywords(id, positive = false) {
  const counts = new Map();
  for (const r of reviews.filter(
    (r) => r.gameId === id && (!positive || r.recommended)
  ))
    for (const k of new Set(r.keywords))
      counts.set(k, (counts.get(k) || 0) + 1);
  return [...counts]
    .map(([keyword, reviewCount]) => ({ keyword, reviewCount }))
    .sort((a, b) => b.reviewCount - a.reviewCount);
}
export function enrich(g) {
  const rs = reviews.filter((r) => r.gameId === g.id);
  return {
    ...g,
    reviewCount: rs.length,
    positiveRate: Math.round(
      (rs.filter((r) => r.recommended).length / rs.length) * 100
    ),
    keywords: keywords(g.id),
  };
}
const synonyms = {
  "친구와 함께": ["친구", "같이", "함께", "멀티"],
  혼자서: ["혼자", "싱글"],
  힐링: ["힐링", "편안", "여유"],
  협동: ["협동", "협력"],
  스토리: ["스토리", "이야기"],
  도전: ["도전", "어려운", "어렵"],
  퍼즐: ["퍼즐", "두뇌"],
  생존: ["생존"],
  오픈월드: ["오픈월드", "자유"],
  액션: ["액션", "전투"],
  농장: ["농장", "농사"],
  탐험: ["탐험"],
};
export function search(q) {
  const terms = Object.entries(synonyms)
    .filter(([k, ss]) => ss.some((s) => q.includes(s)))
    .map(([k]) => k);
  const result = games
    .map((g) => {
      const matched = keywords(g.id).filter((k) => terms.includes(k.keyword));
      return {
        ...enrich(g),
        score: matched.reduce((s, k) => s + k.reviewCount, 0),
        matchedKeywords: matched.map((k) => k.keyword),
      };
    })
    .filter(
      (g) =>
        !q || g.score > 0 || g.title.toLowerCase().includes(q.toLowerCase())
    )
    .sort((a, b) => b.score - a.score);
  return { query: q, keywords: terms, games: result, mode: "mock-keyword" };
}
export function recommend(ids) {
  const profile = new Map();
  for (const id of ids)
    for (const k of keywords(id, true))
      profile.set(k.keyword, (profile.get(k.keyword) || 0) + k.reviewCount);
  return games
    .filter((g) => !ids.includes(g.id))
    .map((g) => {
      const ks = keywords(g.id, true);
      const common = ks.filter((k) => profile.has(k.keyword));
      const dot = ks.reduce(
        (s, k) => s + k.reviewCount * (profile.get(k.keyword) || 0),
        0
      );
      const norm =
        Math.sqrt([...profile.values()].reduce((s, v) => s + v * v, 0)) *
        Math.sqrt(ks.reduce((s, k) => s + k.reviewCount ** 2, 0));
      return {
        ...enrich(g),
        score: norm ? dot / norm : 0,
        matchedKeywords: common.map((k) => k.keyword),
      };
    })
    .filter((g) => g.score > 0)
    .sort((a, b) => b.score - a.score);
}
