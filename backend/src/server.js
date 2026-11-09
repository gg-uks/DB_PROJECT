import { getCachedCatalog } from "./services/ratings-cache.js";
import express from "express";
import { fileURLToPath } from "node:url";
import { createCatalog } from "./services/catalog.js";
import {
  readSnapshot,
  readReviewPage,
  reviewPlaytimeGroups,
  reviewSortKeys,
  readGameRatings,
} from "./repositories/storage.js";
import {
  hasReviewSearch,
  searchReviewGames,
} from "./services/review-search.js";
import authRouter from "./routes/auth.js";
import meRouter from "./routes/me.js";
import analyticsRouter from "./routes/analytics.js";
import adminRouter from "./routes/admin.js";

const app = express();
const port = Number(process.env.PORT) || 3001;

app.use(express.json({ limit: "32kb" }));
app.use("/api/auth", authRouter);
app.use("/api/me", meRouter);
app.use("/api/analytics", analyticsRouter);
app.use("/api/admin", adminRouter); // 관리자 전용 (ADMIN_EMAILS)

const api = express.Router();

api.get("/health", (req, res) => {
  res.json({ status: "ok", dataSource: "steam-db" });
});

api.get("/game-ratings", async (req, res, next) => {
  const ids = typeof req.query.ids === "string" ? req.query.ids.split(",") : [];
  if (
    !ids.length ||
    ids.length > 2 ||
    ids.some(
      (id) => !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)),
    )
  ) {
    return res
      .status(400)
      .json({ error: "게임 ID를 1개 또는 2개 입력해주세요." });
  }

  try {
    const gameIds = [...new Set(ids.map(Number))].sort((a, b) => a - b);
    const ratings = await getCachedCatalog("game-ratings", gameIds, 60, () =>
      readGameRatings(gameIds),
    );
    return res.json({ ratings });
  } catch (error) {
    next(error);
  }
});

api.get("/games/:id/reviews", async (req, res) => {
  const gameId = Number(req.params.id);
  const {
    page = "1",
    sentiment = "all",
    playtime = "all",
    keyword = "",
    sort = "recent",
  } = req.query;

  if (!Number.isSafeInteger(gameId) || gameId < 1) {
    return res.status(400).json({ error: "유효한 게임 ID가 필요합니다." });
  }

  if (
    typeof page !== "string" ||
    !/^[1-9][0-9]*$/.test(page) ||
    !Number.isSafeInteger(Number(page))
  ) {
    return res
      .status(400)
      .json({ error: "페이지는 1 이상의 정수여야 합니다." });
  }

  if (
    !["all", "positive", "negative"].includes(sentiment) ||
    !["all", ...reviewPlaytimeGroups].includes(playtime) ||
    !reviewSortKeys.includes(sort) ||
    typeof keyword !== "string" ||
    keyword.length > 80
  ) {
    return res.status(400).json({ error: "리뷰 필터 값이 올바르지 않습니다." });
  }

  try {
    const result = await readReviewPage({
      gameId,
      requestedPage: Number(page),
      sentiment,
      playtime,
      sort,
    });
    if (!result) {
      return res.status(404).json({ error: "게임을 찾을 수 없습니다." });
    }

    let similarGames = [];
    if (keyword)
      similarGames = await getCachedCatalog(
        "similar-games",
        [gameId, sentiment, keyword],
        60,
        async () => {
          const { games, reviews } = await readSnapshot();
          const counts = new Map();

          for (const review of reviews) {
            if (review.gameId === gameId || !review.keywords.includes(keyword))
              continue;
            if (
              sentiment !== "all" &&
              review.recommended !== (sentiment === "positive")
            )
              continue;
            counts.set(review.gameId, (counts.get(review.gameId) ?? 0) + 1);
          }

          return games
            .filter((game) => counts.has(game.id))
            .map(({ id, title }) => ({
              id,
              title,
              reviewCount: counts.get(id),
            }))
            .sort((a, b) => b.reviewCount - a.reviewCount || a.id - b.id)
            .slice(0, 10);
        },
      );

    return res.json({ ...result, similarGames });
  } catch (error) {
    console.error("리뷰 조회 실패:", error.message);
    return res.status(503).json({
      error: "MySQL 또는 MongoDB 연결과 테이블 설정을 확인해주세요.",
    });
  }
});

async function catalogResponse(res, scope, params, ttl, load) {
  try {
    const result = await getCachedCatalog(scope, params, ttl, async () =>
      load(createCatalog(await readSnapshot())),
    );

    if (result === null) {
      return res.status(404).json({ error: "게임을 찾을 수 없습니다." });
    }
    if (result.invalidGameIds) {
      return res
        .status(400)
        .json({ error: "유효한 gameIds 배열이 필요합니다." });
    }
    return res.json(result);
  } catch (error) {
    console.error("DB 조회 실패:", error.message);
    return res.status(503).json({
      error: "MySQL 또는 MongoDB 연결과 테이블 설정을 확인해주세요.",
    });
  }
}

api.get("/games", (req, res) =>
  catalogResponse(res, "games", [], 60, ({ games, enrich }) => ({
    games: games.map(enrich),
  })),
);

api.get("/games/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return res.status(404).json({ error: "게임을 찾을 수 없습니다." });
  }
  return catalogResponse(res, "game", [id], 60, ({ games, enrich }) => {
    const game = games.find((item) => item.id === id);
    return game ? enrich(game) : null;
  });
});

api.get("/games/:id/keywords", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id < 1) return res.json({ keywords: [] });
  return catalogResponse(res, "keywords", [id], 60, ({ keywords }) => ({
    keywords: keywords(id),
  }));
});

api.post("/search", async (req, res) => {
  const query = req.body?.query;

  if (typeof query !== "string" || query.length > 500) {
    return res
      .status(400)
      .json({ error: "검색어는 500자 이내 문자열이어야 합니다." });
  }

  const text = query.trim();
  return catalogResponse(
    res,
    "search",
    [hasReviewSearch(), text],
    30,
    async (catalog) => {
      const existing = catalog.search(text);
      if (!text || !hasReviewSearch()) return existing;

      try {
        const hits = await searchReviewGames(text);
        const gamesById = new Map(catalog.games.map((game) => [game.id, game]));
        const matches = new Map(existing.games.map((game) => [game.id, game]));
        const games = [];

        for (const { id, score } of hits) {
          const game = gamesById.get(id);
          if (!game) continue;
          games.push({
            ...(matches.get(id) ?? catalog.enrich(game)),
            score,
          });
          matches.delete(id);
        }

        return {
          ...existing,
          games: [...games, ...matches.values()],
          mode: "elasticsearch",
        };
      } catch (error) {
        console.error("Elasticsearch 검색 실패:", error.message);
        return { ...existing, mode: "steam-keyword-fallback" };
      }
    },
  );
});

api.post("/recommendations", (req, res) => {
  const ids = req.body?.gameIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    !ids.every((id) => Number.isSafeInteger(id) && id > 0)
  ) {
    return res.status(400).json({ error: "유효한 gameIds 배열이 필요합니다." });
  }

  const uniqueIds = [...new Set(ids)];
  return catalogResponse(
    res,
    "recommendations",
    uniqueIds,
    60,
    ({ games, recommend }) => {
      if (!uniqueIds.every((id) => games.some((game) => game.id === id))) {
        return { invalidGameIds: true };
      }
      return { games: recommend(uniqueIds) };
    },
  );
});

app.use("/api", api);

app.use("/api", (req, res) => {
  res.status(404).json({ error: "존재하지 않는 API입니다." });
});

const dist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
app.use(express.static(dist));
app.get("/", (req, res) => res.sendFile(dist + "index.html"));

app.use((error, req, res, next) => {
  console.error(error.message);

  const status = error.status || 500;
  res.status(status).json({
    error:
      status === 400 ? "잘못된 JSON 요청입니다." : "서버 오류가 발생했습니다.",
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`API ready: http://localhost:${port}`);
});
