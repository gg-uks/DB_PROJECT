import express from "express";
import {
  games,
  reviews,
  enrich,
  keywords,
  search,
  recommend,
} from "./services/catalog.js";
import { fileURLToPath } from "node:url";
const app = express();
app.use(express.json({ limit: "32kb" }));
app.get("/api/health", (req, res) =>
  res.json({ status: "ok", dataSource: "mock" })
);
// [게임 목록]
// 현재: games.json 조회
// TODO: MySQL에서 게임 목록 조회
app.get("/api/games", (req, res) => res.json({ games: games.map(enrich) }));

// [게임 상세정보]
// 현재: 목데이터에서 id로 게임 조회
// TODO: MySQL에서 gameId로 단건 조회
app.get("/api/games/:id", (req, res) => {
  const g = games.find((g) => g.id === Number(req.params.id));
  if (!g) return res.status(404).json({ error: "게임을 찾을 수 없습니다." });
  res.json(enrich(g));
});

// [워드클라우드]
// 현재: 목리뷰의 keywords 집계
// TODO: 실제 리뷰에서 추출해 저장한 키워드 통계 조회
// 응답 예시: { keywords: [{ keyword: "협동", reviewCount: 32 }] }
app.get("/api/games/:id/keywords", (req, res) =>
  res.json({ keywords: keywords(Number(req.params.id)) })
);

// [게임 리뷰]
// 현재: reviews.json에서 gameId로 필터링
// TODO: MongoDB에서 리뷰 조회
// TODO: 페이지네이션, 긍정/부정 필터 추가
app.get("/api/games/:id/reviews", (req, res) =>
  res.json({
    reviews: reviews.filter((r) => r.gameId === Number(req.params.id)),
  })
);

// [자연어 형태 검색]
// 현재: 키워드 사전으로 검색
// TODO: 검색 문장 → 조건·키워드 추출
// TODO: Elasticsearch 리뷰 검색 → 게임별 점수 집계
app.post("/api/search", (req, res) => {
  if (typeof req.body.query !== "string" || req.body.query.length > 500)
    return res
      .status(400)
      .json({ error: "검색어는 500자 이내 문자열이어야 합니다." });
  res.json(search(req.body.query.trim()));
});

// [취향 기반 추천]
// 현재: 목데이터의 긍정 리뷰 키워드 유사도 계산
// TODO: DB에 저장한 게임별 긍정 리뷰 특징으로 추천
// TODO: 선택한 게임은 추천 결과에서 제외
app.post("/api/recommendations", (req, res) => {
  const ids = req.body.gameIds;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    !ids.every((id) => games.some((g) => g.id === id))
  )
    return res.status(400).json({ error: "유효한 gameIds 배열이 필요합니다." });
  res.json({ games: recommend([...new Set(ids)]) });
});


app.use("/api", (req, res) =>
  res.status(404).json({ error: "존재하지 않는 API입니다." })
);
const dist = fileURLToPath(new URL("../../frontend/dist/", import.meta.url));
app.use(express.static(dist));
app.get("/", (req, res) => res.sendFile(dist + "index.html"));
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(err.status || 500).json({
    error:
      err.status === 400
        ? "잘못된 JSON 요청입니다."
        : "서버 오류가 발생했습니다.",
  });
});
app.listen(Number(process.env.PORT) || 3001, "0.0.0.0", () =>
  console.log("API ready: http://localhost:" + (process.env.PORT || 3001))
);
