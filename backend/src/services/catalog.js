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

export function createCatalog({ games, reviews }) {
  // 게임별로 리뷰를 묶어 상세 조회와 키워드 집계에서 재사용합니다.
  const reviewsByGame = new Map();

  for (const review of reviews) {
    if (!reviewsByGame.has(review.gameId)) {
      reviewsByGame.set(review.gameId, []);
    }

    reviewsByGame.get(review.gameId).push(review);
  }

  function keywords(id, positive = false) {
    const counts = new Map();
    const gameReviews = reviewsByGame.get(id) ?? [];

    for (const review of gameReviews) {
      if (positive && !review.recommended) continue;

      // 같은 리뷰에서 키워드가 여러 번 나와도 한 건으로 집계합니다.
      for (const keyword of new Set(review.keywords ?? [])) {
        counts.set(keyword, (counts.get(keyword) ?? 0) + 1);
      }
    }

    return [...counts]
      .map(([keyword, reviewCount]) => ({ keyword, reviewCount }))
      .sort((a, b) => b.reviewCount - a.reviewCount);
  }

  function enrich(game) {
    const gameReviews = reviewsByGame.get(game.id) ?? [];
    const positiveCount = gameReviews.filter(
      (review) => review.recommended,
    ).length;

    return {
      ...game,
      reviewCount: gameReviews.length,
      positiveRate: gameReviews.length
        ? Math.round((positiveCount / gameReviews.length) * 100)
        : 0,
      keywords: keywords(game.id),
    };
  }

  function search(query) {
    const q = query.trim();
    const normalized = q.toLowerCase();

    const terms = Object.entries(synonyms)
      .filter(([, variants]) =>
        variants.some((variant) => normalized.includes(variant)),
      )
      .map(([keyword]) => keyword);

    const result = games
      .map((game) => {
        const enriched = enrich(game);
        const matched = enriched.keywords.filter(({ keyword }) =>
          terms.includes(keyword),
        );

        return {
          ...enriched,
          score: matched.reduce((sum, item) => sum + item.reviewCount, 0),
          matchedKeywords: matched.map(({ keyword }) => keyword),
        };
      })
      .filter(
        (game) =>
          !q || game.score > 0 || game.title.toLowerCase().includes(normalized),
      )
      .sort((a, b) => b.score - a.score);

    return {
      query: q,
      keywords: terms,
      games: result,
      mode: "steam-keyword",
    };
  }

  function recommend(ids) {
    const selectedIds = new Set(ids);
    const profile = new Map();

    // 선택한 게임들의 긍정 리뷰 키워드로 취향을 구성합니다.
    for (const id of selectedIds) {
      for (const { keyword, reviewCount } of keywords(id, true)) {
        profile.set(keyword, (profile.get(keyword) ?? 0) + reviewCount);
      }
    }

    const profileNorm = Math.sqrt(
      [...profile.values()].reduce((sum, count) => sum + count ** 2, 0),
    );

    if (profileNorm === 0) return [];

    return games
      .filter((game) => !selectedIds.has(game.id))
      .map((game) => {
        const positiveKeywords = keywords(game.id, true);
        const common = positiveKeywords.filter(({ keyword }) =>
          profile.has(keyword),
        );

        const dot = common.reduce(
          (sum, { keyword, reviewCount }) =>
            sum + reviewCount * profile.get(keyword),
          0,
        );

        const gameNorm = Math.sqrt(
          positiveKeywords.reduce(
            (sum, { reviewCount }) => sum + reviewCount ** 2,
            0,
          ),
        );

        return {
          ...enrich(game),
          score: gameNorm ? dot / (profileNorm * gameNorm) : 0,
          matchedKeywords: common.map(({ keyword }) => keyword),
        };
      })
      .filter((game) => game.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  return { games, reviews, enrich, keywords, search, recommend };
}
