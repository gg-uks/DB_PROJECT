import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import AuthModal from "./components/AuthModal.jsx";
import MyPage from "./components/MyPage.jsx";
import AdminPage from "./components/AdminPage.jsx";
import { AlertDialog, Toasts } from "./components/Feedback.jsx";
import {
  api,
  apiSend,
  Icon,
  KO_SCORE_LABELS,
  won,
  numText,
  hoursText,
  dateText,
  PriceTag,
  RankChange,
} from "./lib.jsx";
import "./style.css";

/**
 * [프론트 → 백엔드 API]
 *
 * GET  /api/gamesx
 *      게임 목록 조회
 *
 * GET  /api/games/:id
 *      게임 상세정보 조회
 *
 * GET  /api/games/:id/reviews
 *      게임 리뷰 목록 조회
 *
 * GET  /api/games/:id/keywords
 *      워드클라우드용 키워드와 언급 리뷰 수 조회
 *
 * POST /api/search
 *      요청: { query: "친구와 함께 즐기는 게임" }
 *      응답: 관련 게임 목록
 *
 * POST /api/recommendations
 *      요청: { gameIds: [413150] }
 *      응답: 선택한 게임의 긍정 리뷰와 비슷한 게임 목록
 *
 * 개발환경:
 * React → Vite 프록시 → Node.js:3001
 *
 * 외부 Steam API와 DB는 백엔드에서 연결합니다.
 */

function GameImage({ game }) {
  const [failed, setFailed] = useState(false);

  if (!game.image || failed) {
    return (
      <div
        className="muted"
        style={{
          aspectRatio: "460 / 215",
          display: "grid",
          placeItems: "center",
          background: "#142638",
        }}
      >
        게임 이미지 없음
      </div>
    );
  }

  return (
    <img
      src={game.image}
      alt={game.title}
      onError={() => setFailed(true)}
      style={{ width: "100%", display: "block", objectFit: "cover" }}
    />
  );
}

const reviewTimeLabels = {
  all: "전체 시간",
  "under-2h": "2시간 미만",
  "2-to-10h": "2시간 이상 ~ 10시간 미만",
  "10h-plus": "10시간 이상",
  unknown: "시간 정보 없음",
};

/** 게임 하나의 추천 · 비추천 리뷰 키워드 (GAME_KEYWORD · nori) — /api/analytics/games/:id/keywords */
function useSideKeywords(gameId) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!gameId) return;
    const controller = new AbortController();
    const load = (side) =>
      api(`/analytics/games/${gameId}/keywords?side=${side}&limit=10`, undefined, controller.signal);
    Promise.all([load("pos"), load("neg")])
      .then(([pos, neg]) => !controller.signal.aborted && setResult({ gameId, pos, neg }))
      .catch(() => !controller.signal.aborted && setResult({ gameId, error: true }));
    return () => controller.abort();
  }, [gameId]);
  return result?.gameId === gameId ? result : null;
}

const percentText = (ratio) => `${(ratio * 100).toFixed(1)}%`;

/** 키워드 목록을 가로 막대로 (비율 = 그 단어가 나온 리뷰 / 그쪽 리뷰 전체) */
function KeywordBars({ title, data, tone }) {
  if (!data) return null;
  const top = data.keywords.slice(0, 6);
  const max = Math.max(0.01, ...top.map((k) => k.ratio));
  return (
    <div className={`keyword-bars ${tone}`}>
      <h4>
        {title} <small>· {data.reviewTotal}건 중</small>
      </h4>
      {!top.length && <p className="muted">아직 분석된 키워드가 없어요.</p>}
      <ul>
        {top.map((k) => (
          <li key={k.keyword} title={`${k.keyword} · 리뷰 ${k.reviewCount}건`}>
            <span className="keyword-bars-word">{k.keyword}</span>
            <span className="keyword-bars-track">
              <span style={{ width: `${(k.ratio / max) * 100}%` }} />
            </span>
            <span className="keyword-bars-value">{percentText(k.ratio)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 키워드 비교 차트
 *   게임 1개: 같은 키워드가 추천 리뷰 · 비추천 리뷰에서 각각 몇 %에 나왔나
 *   게임 2개: 선택한 쪽(추천 / 비추천) 리뷰에서 두 게임의 키워드 비율 비교
 */
function KeywordCompareChart({ games, keywordSets }) {
  const [side, setSide] = useState("pos");
  const ready = games.map((game) => keywordSets.find((set) => set?.gameId === game.id));
  if (ready.some((set) => !set || set.error)) return null;

  const pick = (list, n) => list.keywords.slice(0, n).map((k) => k.keyword);
  const ratioOf = (list, word) => list.keywords.find((k) => k.keyword === word)?.ratio ?? 0;
  let words;
  let bars;
  let subtitle;
  if (games.length === 1) {
    const [set] = ready;
    words = [...new Set([...pick(set.pos, 6), ...pick(set.neg, 6)])];
    bars = [
      { key: "pos", name: "추천 리뷰", color: "#67c1f5", value: (w) => ratioOf(set.pos, w) },
      { key: "neg", name: "비추천 리뷰", color: "#ff7b8a", value: (w) => ratioOf(set.neg, w) },
    ];
    subtitle = `${games[0].title} · 같은 단어가 추천 · 비추천 리뷰에 얼마나 나왔는지`;
  } else {
    words = [...new Set(ready.flatMap((set) => pick(set[side], 6)))];
    bars = games.map((game, i) => ({
      key: `g${game.id}`,
      name: game.title,
      color: i === 0 ? "#67c1f5" : "#f0a36b",
      value: (w) => ratioOf(ready[i][side], w),
    }));
    subtitle = `${side === "pos" ? "추천" : "비추천"} 리뷰에서 두 게임의 키워드 비율`;
  }
  const data = words
    .map((word) => {
      const row = { word };
      for (const bar of bars) row[bar.key] = Math.round(bar.value(word) * 1000) / 10;
      return row;
    })
    .sort((a, b) => Math.max(...bars.map((x) => b[x.key])) - Math.max(...bars.map((x) => a[x.key])));
  if (!data.length) return <p className="muted">비교할 키워드가 없어요.</p>;

  return (
    <section aria-label="키워드 비교" className="keyword-compare">
      <div className="keyword-compare-head">
        <div>
          <h3>리뷰 키워드 비교</h3>
          <p className="muted">{subtitle} · 막대 = 그 단어가 나온 리뷰 비율(%)</p>
        </div>
        {games.length === 2 && (
          <div className="wordcloud-tabs" role="group" aria-label="리뷰 종류">
            <button type="button" className="is-positive" aria-pressed={side === "pos"} onClick={() => setSide("pos")}>
              추천 리뷰
            </button>
            <button type="button" className="is-negative" aria-pressed={side === "neg"} onClick={() => setSide("neg")}>
              비추천 리뷰
            </button>
          </div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={Math.max(260, data.length * 34 + 60)}>
        <BarChart data={data} layout="vertical" margin={{ left: 8, right: 24 }} barCategoryGap={6}>
          <CartesianGrid stroke="#29455b" horizontal={false} />
          <XAxis type="number" unit="%" tick={{ fill: "#c5d9e8", fontSize: 12 }} />
          <YAxis type="category" dataKey="word" width={88} tick={{ fill: "#e5edf4", fontSize: 13 }} />
          <Tooltip
            cursor={{ fill: "rgba(103, 193, 245, 0.08)" }}
            contentStyle={{ background: "#122535", border: "1px solid #29455b", color: "#edf7ff" }}
            formatter={(value, name) => [`${value}%`, name]}
          />
          <Legend />
          {bars.map((bar) => (
            <Bar key={bar.key} dataKey={bar.key} name={bar.name} fill={bar.color} radius={[0, 4, 4, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </section>
  );
}

function GameRatingBar({ rating }) {
  if (!rating.total) return <p>스팀 한국어 리뷰 집계 없음</p>;

  const percent = (count) => (count * 100) / rating.total;
  return (
    <div className="game-rating">
      <div className="game-rating-bar" aria-hidden="true">
        <span style={{ width: `${percent(rating.positive)}%` }} />
        <span style={{ width: `${percent(rating.negative)}%` }} />
      </div>
      <p>
        추천 {rating.positive.toLocaleString()}건 ({percent(rating.positive).toFixed(1)}%)
        {" · "}비추천 {rating.negative.toLocaleString()}건 ({percent(rating.negative).toFixed(1)}%)
      </p>
      <small className="muted">스팀 한국어 리뷰 {rating.total.toLocaleString()}건 기준</small>
    </div>
  );
}

function GameComparison({ games }) {
  const [selection, setSelection] = useState(["", ""]);
  const [ratingResult, setRatingResult] = useState(null);
  const ids = selection.filter(Boolean).join(",");
  const keywordSets = [useSideKeywords(Number(selection[0]) || 0), useSideKeywords(Number(selection[1]) || 0)];

  useEffect(() => {
    if (!ids) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ ids });

    api(`/game-ratings?${params}`, undefined, controller.signal)
      .then(({ ratings }) => {
        if (!controller.signal.aborted) setRatingResult({ ids, ratings });
      })
      .catch(() => {
        if (!controller.signal.aborted) setRatingResult({ ids, error: true });
      });

    return () => controller.abort();
  }, [ids]);

  const currentRatings = ratingResult?.ids === ids ? ratingResult : null;
  const candidates = games.filter((game) => game.reviewCount > 0);
  const chosen = selection.map((id) =>
    candidates.find((game) => String(game.id) === id),
  );

  return (
    <section id="compare" aria-labelledby="compare-title">
      <div className="sectionhead">
        <h2 id="compare-title">게임 비교</h2>
      </div>
      <p className="muted">
        게임을 한 개 또는 두 개 선택하세요. 평가는 스팀 한국어 리뷰 전체, 키워드는 수집한 리뷰(추천 125 · 비추천
        125)를 nori로 분석한 결과예요. %는 그 단어가 나온 리뷰의 비율이에요.
      </p>
      {candidates.length < 2 && (
        <p>비교하려면 리뷰가 수집된 게임이 두 개 이상 필요해요.</p>
      )}
      <div className="game-comparison-grid">
        {chosen.map((game, index) => {
          const rating = currentRatings?.ratings?.find(
            (item) => item.id === game?.id,
          );
          const keywordSet = keywordSets[index];
          return (
            <article className="game-comparison-card" key={index}>
              <label>
                {index === 0 ? "첫 번째 게임" : "두 번째 게임"}
                <select
                  value={selection[index]}
                  onChange={(event) => {
                    const id = event.target.value;
                    setSelection((current) =>
                      current.map((value, position) =>
                        position === index ? id : value,
                      ),
                    );
                  }}
                >
                  <option value="">게임 선택</option>
                  {candidates.map(({ id, title }) => (
                    <option
                      key={id}
                      value={id}
                      disabled={String(id) === selection[1 - index]}
                    >
                      {title}
                    </option>
                  ))}
                </select>
              </label>
              {game && (
                <>
                  <h3>{game.title}</h3>
                  {rating && <GameRatingBar rating={rating} />}
                  {currentRatings?.error && (
                    <p role="alert">평가 집계를 불러오지 못했어요.</p>
                  )}
                  {!currentRatings && (
                    <p role="status">평가 집계를 불러오는 중…</p>
                  )}
                  {keywordSet?.error && <p role="alert">키워드를 불러오지 못했어요.</p>}
                  {!keywordSet && <p role="status">키워드를 불러오는 중…</p>}
                  {keywordSet && !keywordSet.error && (
                    <div className="keyword-bars-pair">
                      <KeywordBars title="추천 리뷰 키워드" data={keywordSet.pos} tone="is-positive" />
                      <KeywordBars title="비추천 리뷰 키워드" data={keywordSet.neg} tone="is-negative" />
                    </div>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
      {chosen.some(Boolean) && (
        <KeywordCompareChart
          key={ids}
          games={chosen.filter(Boolean)}
          keywordSets={keywordSets}
        />
      )}
    </section>
  );
}



/**
 * 게임 상세 정보 — GET /api/analytics/games/:id/info
 *   GAME 전체 컬럼 · GENRE · CATEGORY · COMPANY(개발 · 배급) · V_GAME_SUMMARY(할인율 · 긍정률 · 마지막 리뷰)
 *   · REVIEW 표본 통계(추천 vs 비추천)
 */
function GameInfoPanel({ gameId, wished, onToggleWish }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api(`/analytics/games/${gameId}/info`, undefined, controller.signal)
      .then((d) => !controller.signal.aborted && setInfo(d))
      .catch((e) => !controller.signal.aborted && setError(e.message));
    return () => controller.abort();
  }, [gameId]);

  if (error) return <p role="alert">{error}</p>;
  if (!info) return <p role="status">게임 정보를 불러오는 중…</p>;

  const { price, korean, rank, sampleStats = {} } = info;
  const priceGame = {
    isFree: info.isFree,
    comingSoon: info.comingSoon,
    finalPrice: price.final,
    initialPrice: price.initial,
    discountPct: price.discountPct ?? 0,
  };
  const facts = [
    ["출시일", info.comingSoon ? "출시 예정" : (info.releaseDate ?? "—")],
    ["이용 연령", info.requiredAge ? `${info.requiredAge}세 이상` : "전체 이용가"],
    ["메타크리틱", info.metacritic ?? "—"],
    ["스팀 추천 수 (전체 언어)", numText(info.recommendationsTotal)],
    ["가격", <PriceTag key="p" game={priceGame} />],
    ["통화", price.currency ?? "—"],
    ["개발사", info.developers?.join(", ") || "—"],
    ["배급사", info.publishers?.join(", ") || "—"],
    [
      "주간 최다 플레이 순위",
      rank.rank ? (
        <span key="r">
          {rank.rank}위 <RankChange rank={rank.rank} change={rank.change} />
          <small className="muted"> · 지난주 {rank.lastWeek ? `${rank.lastWeek}위` : "순위 밖"}</small>
        </span>
      ) : (
        "100위 밖"
      ),
    ],
    ["주간 최고 동시 접속자", rank.peak ? `${numText(rank.peak)}명` : "—"],
    ["순위 기준일", rank.date ?? "—"],
    ["마지막 수집 리뷰", info.lastReviewAt ? new Date(info.lastReviewAt).toLocaleString("ko-KR") : "—"],
    ["게임 정보 갱신", info.updatedAt ?? "—"],
  ];
  const sides = [
    ["pos", "추천 리뷰"],
    ["neg", "비추천 리뷰"],
  ];
  const statRows = [
    ["수집 리뷰 수", (s) => `${numText(s.count)}건`],
    ["평균 플레이 (작성 당시)", (s) => hoursText(s.avgPlaytimeAtReview)],
    ["평균 플레이 (수집 시점 총)", (s) => hoursText(s.avgPlaytimeForever)],
    ["도움이 돼요 합계", (s) => numText(s.votesUp)],
    ["재밌어요 합계", (s) => numText(s.votesFunny)],
    ["스팀에서 구매", (s) => `${numText(s.purchased)}건`],
    ["무료로 받음", (s) => `${numText(s.freeCopy)}건`],
    ["앞서 해보기 중 작성", (s) => `${numText(s.earlyAccess)}건`],
    ["작성 기간", (s) => (s.firstAt ? `${s.firstAt} ~ ${s.lastAt}` : "—")],
  ];

  return (
    <section className="gameinfo" aria-label="게임 정보">
      <div className="gameinfo-top">
        <div className="gameinfo-score">
          <strong>{korean.reviewScore ? KO_SCORE_LABELS[korean.reviewScore] : "한국어 평가 없음"}</strong>
          <span>
            스팀 한국어 리뷰 {numText((korean.positive ?? 0) + (korean.negative ?? 0))}건 중 긍정{" "}
            {korean.positivePct ?? "—"}%
          </span>
          <small className="muted">
            추천 {numText(korean.positive)} · 비추천 {numText(korean.negative)}
          </small>
        </div>
        <button
          type="button"
          className={`wish-button ${wished ? "is-on" : ""}`}
          aria-pressed={wished}
          onClick={() => onToggleWish(info.id)}
        >
          <Icon name="heart" filled={wished} />
          {wished ? "찜한 게임" : "찜하기"}
        </button>
      </div>
      <div className="chips">
        {info.genres?.map((g) => (
          <span key={"g" + g} className="chip is-genre">
            {g}
          </span>
        ))}
        {info.categories?.map((c) => (
          <span key={"c" + c} className="chip">
            {c}
          </span>
        ))}
      </div>
      <dl className="facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <h3>수집 리뷰 비교 (추천 vs 비추천)</h3>
      <table className="sample-table">
        <thead>
          <tr>
            <th scope="col">항목</th>
            {sides.map(([key, label]) => (
              <th scope="col" key={key} className={key === "pos" ? "is-positive" : "is-negative"}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {statRows.map(([label, format]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              {sides.map(([key]) => (
                <td key={key}>{sampleStats[key] ? format(sampleStats[key]) : "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** 플레이 시간대별 키워드 — GET /api/analytics/games/:id/keywords?band= (REVIEW · REVIEW_KEYWORD에서 바로 계산) */
function PlaytimeKeywords({ gameId }) {
  const bands = [
    ["lt10", "10시간 미만"],
    ["mid", "10~100시간"],
    ["ge100", "100시간 이상"],
  ];
  const [band, setBand] = useState("lt10");
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    api(`/analytics/games/${gameId}/keywords?band=${band}&limit=12`, undefined, controller.signal)
      .then((d) => !controller.signal.aborted && setData(d))
      .catch(() => !controller.signal.aborted && setData({ keywords: [], reviewTotal: 0, failed: true }));
    return () => controller.abort();
  }, [gameId, band]);

  return (
    <section aria-labelledby="band-title">
      <h3 id="band-title">플레이 시간대별 키워드</h3>
      <p className="muted">리뷰 작성 당시 플레이 시간으로 나눠, 그 구간 리뷰에서 많이 나온 단어예요.</p>
      <div className="wordcloud-tabs" role="group" aria-label="플레이 시간대">
        {bands.map(([key, label]) => (
          <button key={key} type="button" aria-pressed={band === key} className="is-positive" onClick={() => setBand(key)}>
            {label}
          </button>
        ))}
      </div>
      {!data && <p role="status">불러오는 중…</p>}
      {data && (
        <>
          <p className="muted">
            이 구간 리뷰 {data.reviewTotal}건
            {data.reviewTotal > 0 && !data.enough && " · 30건 미만이라 참고용이에요"}
          </p>
          {data.keywords.length ? (
            <div className="chips">
              {data.keywords.map((k) => (
                <span key={k.keyword} className="chip is-keyword">
                  {k.keyword} <small>{(k.ratio * 100).toFixed(0)}%</small>
                </span>
              ))}
            </div>
          ) : (
            <p className="muted">이 구간에는 분석된 키워드가 없어요.</p>
          )}
        </>
      )}
    </section>
  );
}

/** 추천 키워드가 비슷한 게임 — GET /api/analytics/games/:id/similar */
function SimilarGames({ gameId, onOpenGame }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    api(`/analytics/games/${gameId}/similar`, undefined, controller.signal)
      .then((d) => !controller.signal.aborted && setData(d))
      .catch(() => !controller.signal.aborted && setData({ games: [] }));
    return () => controller.abort();
  }, [gameId]);
  if (!data) return null;
  return (
    <section aria-labelledby="similar-title">
      <h3 id="similar-title">추천 리뷰 키워드가 비슷한 게임</h3>
      {!data.games.length && <p className="muted">비교할 키워드가 아직 없어요.</p>}
      <ul className="similar-list">
        {data.games.map((g) => (
          <li key={g.id}>
            <button type="button" onClick={() => onOpenGame(g.id)}>
              <strong>{g.title}</strong>
              <span className="match">유사도 {Math.round(g.score * 100)}%</span>
              <small>공통 키워드 · {g.commonKeywords.join(", ")}</small>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ReviewList({ gameId, keywords, onOpenGame }) {
  const [sentiment, setSentiment] = useState("all");
  const [playtime, setPlaytime] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [sort, setSort] = useState("recent");
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    const params = new URLSearchParams({ page, sentiment, playtime, keyword, sort });
    api(`/games/${gameId}/reviews?${params}`, undefined, controller.signal)
      .then((result) => {
        if (
          !Array.isArray(result.reviews) ||
          !Number.isInteger(result.totalPages)
        ) {
          throw new Error("백엔드의 리뷰 페이지네이션 응답을 확인해주세요.");
        }
        if (!controller.signal.aborted) setData(result);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });

    return () => controller.abort();
  }, [gameId, page, sentiment, playtime, keyword, sort]);

  function goToPage(nextPage) {
    setError("");
    setData(null);
    setPage(nextPage);
  }

  return (
    <section aria-label="Steam 리뷰">
      <h3>Steam 리뷰</h3>
      <div className="review-filters">
        <label>
          정렬
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value);
              goToPage(1);
            }}
          >
            <option value="recent">최신순</option>
            <option value="helpful">도움이 돼요 많은 순</option>
            <option value="playtime">플레이 시간 긴 순</option>
          </select>
        </label>
        <label>
          평가
          <select
            value={sentiment}
            onChange={(e) => {
              setSentiment(e.target.value);
              goToPage(1);
            }}
          >
            <option value="all">전체 평가</option>
            <option value="positive">추천</option>
            <option value="negative">비추천</option>
          </select>
        </label>
        <label>
          리뷰 작성 당시 플레이 시간
          <select
            value={playtime}
            onChange={(e) => {
              setPlaytime(e.target.value);
              goToPage(1);
            }}
          >
            {Object.entries(reviewTimeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          같은 키워드를 언급한 게임
          <select
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value);
              goToPage(1);
            }}
          >
            <option value="">키워드 선택</option>
            {keywords.map(({ keyword }) => (
              <option key={keyword}>{keyword}</option>
            ))}
          </select>
        </label>
      </div>

      {data?.comparison && (
        <table className="review-comparison">
          <caption>전체 수집 리뷰의 플레이 시간별 평가</caption>
          <thead>
            <tr>
              <th>플레이 시간</th>
              <th>추천</th>
              <th>비추천</th>
              <th>추천 비율</th>
            </tr>
          </thead>
          <tbody>
            {data.comparison.map(({ group, positive, negative }) => (
              <tr key={group}>
                <th scope="row">{reviewTimeLabels[group]}</th>
                <td>{positive}</td>
                <td>{negative}</td>
                <td>
                  {positive + negative
                    ? Math.round((100 * positive) / (positive + negative)) + "%"
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {keyword && data?.similarGames && (
        <section>
          <h4>
            ‘{keyword}’을 언급한 다른 게임 ·{" "}
            {sentiment === "all"
              ? "전체 평가"
              : sentiment === "positive"
                ? "추천 리뷰"
                : "비추천 리뷰"}
          </h4>
          {data.similarGames.length === 0 && (
            <p>같은 키워드를 언급한 게임이 없습니다.</p>
          )}
          <ul>
            {data.similarGames.map(({ id, title, reviewCount }) => (
              <li key={id}>
                <button
                  className="review-link"
                  type="button"
                  onClick={() => onOpenGame(id)}
                >
                  {title} · {reviewCount}건
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {error && <p role="alert">{error}</p>}
      {!error && !data && <p role="status">리뷰를 불러오는 중…</p>}

      {data?.total === 0 && <p>조건에 맞는 리뷰가 없습니다.</p>}
      {data?.total > 0 && <p>조건에 맞는 리뷰 {data.total}건</p>}

      {data?.reviews.map((review) => (
        <article key={review.id} className="steam-review-card">
          <strong
            className={`steam-review-badge ${review.recommended ? "is-positive" : "is-negative"}`}
          >
            {review.recommended ? "추천" : "비추천"}
          </strong>
          {!review.steamPurchase && <span className="review-flag">스팀 외 구매</span>}
          {review.receivedForFree && <span className="review-flag">무료로 받음</span>}
          {review.earlyAccess && <span className="review-flag">앞서 해보기</span>}
          <small className="review-meta">
            작성 {dateText(review.createdAt)}
            {review.updatedAt && review.updatedAt !== review.createdAt && ` · 수정 ${dateText(review.updatedAt)}`}
            {review.playtimeAtReviewMinutes != null &&
              ` · 작성 당시 ${hoursText(review.playtimeAtReviewMinutes)} 플레이`}
            {review.playtimeForeverMinutes != null && ` · 총 ${hoursText(review.playtimeForeverMinutes)}`}
            {review.lastPlayed && ` · 마지막 플레이 ${dateText(review.lastPlayed)}`}
          </small>
          <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
            {review.text?.trim() ? review.text : "리뷰 본문이 없습니다."}
          </p>
          <small className="review-votes">
            <span>
              <Icon name="thumb" size={15} /> 도움이 돼요 {review.votesUp ?? 0}
            </span>
            <span>
              <Icon name="smile" size={15} /> 재밌어요 {review.votesFunny ?? 0}
            </span>
          </small>
        </article>
      ))}

      {data?.totalPages > 1 && (
        <nav className="steam-review-pagination" aria-label="리뷰 페이지">
          <button
            type="button"
            disabled={data.page <= 1}
            onClick={() => goToPage(data.page - 1)}
          >
            이전
          </button>
          <span>
            {" "}
            {data.page} / {data.totalPages}{" "}
          </span>
          <button
            type="button"
            disabled={data.page >= data.totalPages}
            onClick={() => goToPage(data.page + 1)}
          >
            다음
          </button>
        </nav>
      )}
    </section>
  );
}

/**
 * 워드클라우드 — GET /api/analytics/games/:id/wordcloud?side=pos|neg
 *   글자 크기 = 그 단어가 나온 리뷰 수 · 파랑 = 추천 리뷰 · 빨강 = 비추천 리뷰
 *   "이 게임만의 단어"는 ES significant_text (다른 게임보다 유독 많이 나온 단어)
 */
function WordCloud({ gameId }) {
  const [side, setSide] = useState("pos");
  const [mode, setMode] = useState("words");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError("");
    api(`/analytics/games/${gameId}/wordcloud?side=${side}`, undefined, controller.signal)
      .then((result) => !controller.signal.aborted && setData(result))
      .catch((e) => !controller.signal.aborted && setError(e.message));
    return () => controller.abort();
  }, [gameId, side]);

  const list = mode === "distinctive" && data?.distinctive?.length ? data.distinctive : (data?.words ?? []);
  const max = Math.max(1, ...list.map((w) => w.count));
  const min = Math.min(max, ...list.map((w) => w.count));
  // 큰 단어가 가운데 오도록: 빈도순으로 왼쪽 · 오른쪽에 번갈아 배치
  const arranged = [];
  list.forEach((w, i) => (i % 2 ? arranged.push(w) : arranged.unshift(w)));
  const size = (count) =>
    max === min ? 26 : 14 + Math.round((30 * Math.log(count - min + 1)) / Math.log(max - min + 1));

  return (
    <section className="wordcloud" aria-labelledby="wordcloud-title">
      <h3 id="wordcloud-title">리뷰 워드클라우드</h3>
      <div className="wordcloud-tabs" role="group" aria-label="리뷰 종류">
        <button type="button" aria-pressed={side === "pos"} className="is-positive" onClick={() => setSide("pos")}>
          추천 리뷰
        </button>
        <button type="button" aria-pressed={side === "neg"} className="is-negative" onClick={() => setSide("neg")}>
          비추천 리뷰
        </button>
        {data?.distinctive?.length > 0 && (
          <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="단어 기준">
            <option value="words">많이 나온 단어</option>
            <option value="distinctive">이 게임만의 단어</option>
          </select>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {!error && !data && <p role="status">워드클라우드를 불러오는 중…</p>}
      {data && list.length === 0 && <p>아직 분석된 단어가 없습니다.</p>}
      {list.length > 0 && (
        <div className={`wordcloud-box ${side === "pos" ? "is-positive" : "is-negative"}`}>
          {arranged.map((w) => (
            <span
              key={w.word}
              title={`${w.word} · 리뷰 ${w.count}건`}
              style={{ fontSize: size(w.count), opacity: 0.55 + (0.45 * w.count) / max }}
            >
              {w.word}
            </span>
          ))}
        </div>
      )}
      {data && (
        <p className="muted">
          {data.source === "elasticsearch" ? "Elasticsearch nori 형태소 분석" : "MySQL 키워드 집계(GAME_KEYWORD)"} ·{" "}
          {side === "pos" ? "추천" : "비추천"} 리뷰 {data.reviewTotal}건 기준 · 글자 크기 = 그 단어가 나온 리뷰 수
        </p>
      )}
    </section>
  );
}

/** 주소의 해시로 페이지 결정: #/mypage · #/admin · 그 외(#discover 같은 앵커 포함)는 홈 */
function routeOf(hash) {
  if (hash.startsWith("#/mypage")) return "mypage";
  if (hash.startsWith("#/admin")) return "admin";
  return "home";
}

const PAGE_SIZE = 24;
const FEATURED_LIMIT = 8;

function App() {
  // null: 닫힘 / login: 로그인 / signup: 회원가입
  const [authMode, setAuthMode] = useState(null);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const controller = new AbortController();

    async function restoreLogin() {
      const response = await fetch("/api/auth/me", {
        credentials: "include",
        signal: controller.signal,
      });

      if (response.status === 401) return;
      if (!response.ok) throw new Error(`회원 조회 실패 (${response.status})`);

      const { user } = await response.json();
      if (!controller.signal.aborted && user) {
        setUser((currentUser) => currentUser ?? user);
      }
    }

    restoreLogin().catch((error) => {
      if (!controller.signal.aborted) console.error(error);
    });

    return () => controller.abort();
  }, []);

  const [games, setGames] = useState([]),
    [results, setResults] = useState(null),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0),
    [selected, setSelected] = useState(null),
    [recommendations, setRecommendations] = useState(null),
    [seed, setSeed] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("전체"),
    [category, setCategory] = useState(""),
    [sortKey, setSortKey] = useState("rank"),
    [sqlList, setSqlList] = useState(null),
    [filters, setFilters] = useState({ genres: [], categories: [] }),
    [wishlist, setWishlist] = useState([]),
    [route, setRoute] = useState(routeOf(location.hash)),
    [alert, setAlert] = useState(null),
    [toasts, setToasts] = useState([]),
    [authEmail, setAuthEmail] = useState("");

  // 페이지 이동: #/mypage · #/admin (그 외 #discover 같은 앵커는 홈)
  useEffect(() => {
    const onHash = () => {
      const next = routeOf(location.hash);
      setRoute(next);
      if (next !== "home") window.scrollTo({ top: 0 });
      else setTimeout(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ behavior: "smooth" }), 60);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  function notify(toast) {
    const id = Date.now() + Math.random();
    setToasts((list) => [...list, { ...toast, id }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 2600);
  }

  function handleSignedUp({ email, nickname }) {
    setAuthMode(null);
    setAlert({
      title: "회원가입 완료!",
      message: `${nickname}님, PLAYLOG에 오신 걸 환영해요. 가입한 이메일로 로그인하면 찜 목록과 마이페이지를 쓸 수 있어요.`,
      secondary: { label: "나중에" },
      primary: {
        label: "로그인하기",
        onClick: () => {
          setAuthEmail(email);
          setAuthMode("login");
        },
      },
    });
  }

  function handleLogin(nextUser) {
    setUser(nextUser);
    notify({ message: `${nextUser.nickname}님, 반가워요!`, icon: "check" });
  }

  // 장르 · 카테고리 목록 (GROUP BY로 게임 수 집계) — GET /api/analytics/filters
  useEffect(() => {
    api("/analytics/filters").then(setFilters).catch((e) => console.error(e));
  }, []);

  // 장르 탭 · 카테고리 · 정렬은 SQL(WHERE … IN 서브쿼리 · ORDER BY)에서 처리 — GET /api/analytics/games
  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ sort: sortKey });
    if (tab !== "전체") params.set("genre", tab);
    if (category) params.set("category", category);
    api(`/analytics/games?${params}`, undefined, controller.signal)
      .then((d) => !controller.signal.aborted && setSqlList(d.games.map((g) => g.id)))
      .catch((e) => !controller.signal.aborted && setError(e.message));
    return () => controller.abort();
  }, [tab, category, sortKey]);

  // 찜 목록 (WISHLIST) — 로그인하면 불러오고, 로그아웃하면 비움
  async function loadWishlist() {
    const data = await api("/me/wishlist");
    setWishlist(data.games);
  }
  useEffect(() => {
    if (!user) {
      setWishlist([]);
      return;
    }
    loadWishlist().catch((e) => console.error(e));
  }, [user]);
  const wishedIds = new Set(wishlist.map((g) => g.id));

  async function toggleWish(id) {
    if (!user) {
      setAuthMode("login");
      return;
    }
    try {
      const title = games.find((g) => g.id === id)?.title ?? "게임";
      if (wishedIds.has(id)) {
        await apiSend("DELETE", `/me/wishlist/${id}`);
        notify({ message: `${title}을(를) 찜 목록에서 뺐어요.`, icon: "heart" });
      } else {
        await api("/me/wishlist", { appid: id });
        notify({ message: `${title}을(를) 찜했어요.`, icon: "heart", tone: "wish" });
      }
      await loadWishlist();
    } catch (e) {
      setAlert({ tone: "error", title: "찜하지 못했어요", message: e.message });
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    notify({ message: "로그아웃했어요.", icon: "logout" });
  }

  function openGame(id) {
    const game = games.find((item) => item.id === id);
    if (game) setSelected(game);
  }

  const [page, setPage] = useState(1);

  useEffect(() => {
    api("/games")
      .then((d) => setGames(d.games))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!selected) return;
    const onKey = (e) => {
      if (e.key === "Escape") setSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);
  async function search(e, value = query) {
    e?.preventDefault();
    setQuery(value);
    setBusy(true);
    setError("");
    try {
      const { games: matches } = await api("/search", { query: value });
      setResults(matches);
      setTab("전체");
      setPage(1);
      document
        .getElementById("game-catalog")
        ?.scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function getRecommendations() {
    if (!seed) return;
    setBusy(true);
    setError("");
    try {
      setRecommendations(
        (await api("/recommendations", { gameIds: [Number(seed)] })).games,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const featuredGames = games
    .filter((game) => game.image)
    .slice(0, FEATURED_LIMIT);
  const featured = featuredGames.length
    ? featuredGames
    : games.slice(0, FEATURED_LIMIT);
  const hero = featured[active];
  // 화면은 SQL이 돌려준 순서(appid 목록)대로 보여주기만 함
  const genreTabs = ["전체", ...filters.genres.slice(0, 8).map((g) => g.name)];
  const categoryOptions = filters.categories.map((c) => [c.name, c.games]);
  const gamesById = new Map(games.map((g) => [g.id, g]));
  const sqlGames = sqlList ? sqlList.map((id) => gamesById.get(id)).filter(Boolean) : games;
  const allowed = new Set(sqlGames.map((g) => g.id));
  // 검색 결과는 검색 점수 순서를 유지하고, 장르 · 카테고리 조건(SQL 결과)에 맞는 게임만 남김
  const list = results ? results.filter((g) => allowed.has(g.id)) : sqlGames;
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const firstIndex = (currentPage - 1) * PAGE_SIZE;
  const pageGames = list.slice(firstIndex, firstIndex + PAGE_SIZE);

  function goToPage(nextPage) {
    setPage(nextPage);
    document
      .getElementById("game-catalog")
      ?.scrollIntoView({ behavior: "smooth" });
  }

  function Card({ g, similarity }) {
    return (
      <button className="card" onClick={() => setSelected(g)}>
        <span className="card-badges">
          {g.rank != null && (
            <span className="badge-rank">
              #{g.rank} <RankChange rank={g.rank} change={g.rankChange} />
            </span>
          )}
          {g.discountPct > 0 && <span className="badge-discount">-{g.discountPct}%</span>}
          {wishedIds.has(g.id) && <span className="badge-wish"><Icon name="heart" filled size={13} label="찜한 게임" /></span>}
        </span>
        <GameImage key={g.image} game={g} />
        <div className="cardbody">
          <h3>{g.title}</h3>
          {similarity != null && (
            <p className="match">취향 일치 {Math.round(similarity * 100)}%</p>
          )}
          <p className="cyan">
            {g.koReviewTotal ? (
              <>
                스팀 한국어 긍정 {g.positiveRate}%{" "}
                <span>· 리뷰 {g.koReviewTotal.toLocaleString()}건</span>
              </>
            ) : (
              <>
                긍정 리뷰 {g.positiveRate}% <span>· 샘플 {g.reviewCount}건</span>
              </>
            )}
          </p>
          <div className="tags">
            {(g.matchedKeywords?.length
              ? g.matchedKeywords
              : g.tags.slice(0, 3)
            ).map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <p className="card-sub">
            {g.koReviewScore ? KO_SCORE_LABELS[g.koReviewScore] : "평가 정보 없음"}
            {g.metacritic != null && ` · 메타크리틱 ${g.metacritic}`}
            {g.comingSoon ? " · 출시 예정" : g.releaseDate ? ` · ${g.releaseDate.slice(0, 4)}년` : ""}
          </p>
          <div className="price">
            <PriceTag game={g} />
          </div>
        </div>
      </button>
    );
  }
  return (
    <>
      <header>
        <div className="headerinner">
          <a className="brand" href="/">
            ◉ <b>PLAYLOG</b>
          </a>

          <nav>
            <a className={route === "home" ? "current" : ""} href="#discover">
              게임 탐색
            </a>
            <a href="#taste">취향 추천</a>
            <a href="#keywords">리뷰 인사이트</a>
            <a href="#compare">게임 비교</a>
          </nav>

          <div className="auth-actions">
            {user ? (
              <>
                {user.isAdmin && (
                  <a className={`auth-trigger is-admin ${route === "admin" ? "is-current" : ""}`} href="#/admin">
                    <Icon name="shield" size={14} /> 관리자
                  </a>
                )}
                <a className={`user-chip ${route === "mypage" ? "is-current" : ""}`} href="#/mypage" title="마이페이지">
                  <span className="user-chip-avatar" aria-hidden="true">
                    {user.nickname.slice(0, 1)}
                  </span>
                  {user.nickname}
                  <span className="user-chip-count" aria-label={`찜 ${wishlist.length}개`}>
                    <Icon name="heart" size={12} filled /> {wishlist.length}
                  </span>
                </a>
                <button className="auth-trigger" onClick={logout} aria-label="로그아웃" title="로그아웃">
                  <Icon name="logout" size={15} />
                </button>
              </>
            ) : (
              <>
                <button
                  className="auth-trigger"
                  onClick={() => setAuthMode("login")}
                >
                  로그인
                </button>

                <button
                  className="auth-trigger"
                  onClick={() => setAuthMode("signup")}
                >
                  회원가입
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="subnav">
        <div>
          <a href="#discover">스토어 홈</a>
          <a href="#taste">나를 위한 추천</a>
          <a href="#keywords">인기 키워드</a>
          <span>리뷰 속에서 발견하는, 다음 게임</span>
        </div>
      </div>
      {route === "mypage" && (
        <MyPage
          user={user}
          wishlist={wishlist}
          onRemoveWish={toggleWish}
          onOpenGame={openGame}
          onUserChange={setUser}
          onDeleted={() => {
            setUser(null);
            location.hash = "#/";
            setAlert({ title: "탈퇴가 완료됐어요", message: "그동안 PLAYLOG를 이용해 주셔서 고마워요." });
          }}
          onLogin={() => setAuthMode("login")}
          notify={notify}
          showAlert={setAlert}
        />
      )}
      {route === "admin" && <AdminPage user={user} onLogin={() => setAuthMode("login")} />}
      {route === "home" && (
      <main>
        <section className="searchintro">
          <p className="eyebrow">YOUR NEXT GAME STARTS WITH A REVIEW</p>
          <h1>어떤 게임을 찾고 있나요?</h1>
          <p>장르보다 정확한 취향. 플레이어의 리뷰에서 찾아보세요.</p>
          <form onSubmit={search}>
            <span aria-hidden="true">⌕</span>
            <input
              aria-label="원하는 게임 설명"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="친구랑 함께 할 수 있는 힐링 게임을 찾고 있어"
              maxLength={500}
            />
            <button disabled={busy}>게임 찾기 →</button>
          </form>
          <div className="suggestions">
            <span>이렇게 검색해 보세요</span>
            {["친구와 함께", "혼자 즐기는 스토리", "힐링 농장 게임"].map(
              (t) => (
                <button key={t} disabled={busy} onClick={() => search(null, t)}>
                  {t} ↗
                </button>
              ),
            )}
          </div>
        </section>
        {error && (
          <p className="error" role="alert">
            {error} <button onClick={() => location.reload()}>다시 연결</button>
          </p>
        )}
        <section id="discover">
          <div className="sectionhead">
            <h2>주목할 만한 게임</h2>
            <span>FEATURED & RECOMMENDED</span>
          </div>
          {hero ? (
            <>
              <div className="hero">
                <button
                  className="heroart"
                  onClick={() => setSelected(hero)}
                  style={{
                    backgroundImage: `linear-gradient(0deg,rgba(9,20,31,.85),transparent 75%),url("${hero.image}")`,
                  }}
                >
                  <span className="ribbon">오늘의 발견</span>
                  <div>
                    <p>당신의 다음 플레이리스트</p>
                    <h2>{hero.title}</h2>
                    <span>{hero.description}</span>
                  </div>
                </button>
                <div className="heroinfo">
                  <p className="eyebrow">THE COMMUNITY SAYS</p>
                  <h2>{hero.title}</h2>
                  <p className="cyan">
                    {hero.koReviewTotal ? "스팀 한국어 긍정" : "긍정 리뷰"}{" "}
                    {hero.positiveRate}%{" "}
                    <small>
                      ·{" "}
                      {hero.koReviewTotal
                        ? `리뷰 ${hero.koReviewTotal.toLocaleString()}건`
                        : `샘플 ${hero.reviewCount}건`}
                    </small>
                  </p>
                  <p className="muted hero-facts">
                    {hero.rank != null && `주간 최다 플레이 ${hero.rank}위 · `}
                    {hero.koReviewScore ? `${KO_SCORE_LABELS[hero.koReviewScore]} · ` : ""}
                    {hero.developers?.length ? `개발 ${hero.developers.join(", ")}` : ""}
                    {hero.peakInGame ? ` · 최고 동시 접속 ${hero.peakInGame.toLocaleString()}명` : ""}
                  </p>
                  <div className="herotags">
                    {hero.tags.map((t) => (
                      <button onClick={() => search(null, t)} key={t}>
                        # {t}
                      </button>
                    ))}
                  </div>
                  <blockquote>
                    {hero.categories?.length ? hero.categories.slice(0, 6).join(" · ") : "카테고리 정보 없음"}
                    <small>Steam 카테고리</small>
                  </blockquote>
                  <button className="primary" onClick={() => setSelected(hero)}>
                    리뷰 키워드 살펴보기 →
                  </button>
                  <div className="herobottom">
                    <span>리뷰 기반 게임 탐색</span>
                    <b>
                      <PriceTag game={hero} />
                    </b>
                  </div>
                </div>
              </div>
              <div className="dots">
                {featured.map((g, i) => (
                  <button
                    aria-label={`${g.title} 배너 보기`}
                    aria-pressed={i === active}
                    className={i === active ? "active" : ""}
                    onClick={() => setActive(i)}
                    key={g.id}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="loading">게임 목록을 불러오는 중…</div>
          )}
        </section>
        <section id="game-catalog" className="catalog">
          <div className="sectionhead">
            <h2>
              {results ? "검색 결과" : "리뷰로 발견하는 게임"}{" "}
              <small>{list.length}개</small>
            </h2>
            {results && (
              <button
                className="outline"
                onClick={() => {
                  setResults(null);
                  setQuery("");
                  setTab("전체");
                  setCategory("");
                  setPage(1);
                }}
              >
                전체 게임 보기
              </button>
            )}
          </div>
          <div className="tabs">
            {genreTabs.map((t) => (
              <button
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => {
                  setTab(t);
                  setPage(1);
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="catalog-filters">
            <label>
              카테고리
              <select
                value={category}
                onChange={(e) => {
                  setCategory(e.target.value);
                  setPage(1);
                }}
              >
                <option value="">전체 카테고리</option>
                {categoryOptions.map(([name, count]) => (
                  <option key={name} value={name}>
                    {name} ({count})
                  </option>
                ))}
              </select>
            </label>
            {!results && (
              <label>
                정렬
                <select value={sortKey} onChange={(e) => setSortKey(e.target.value)}>
                  <option value="rank">주간 플레이 순위</option>
                  <option value="positive">한국어 긍정률</option>
                  <option value="reviews">한국어 리뷰 많은 순</option>
                  <option value="discount">할인율</option>
                  <option value="metacritic">메타크리틱</option>
                  <option value="release">최신 출시</option>
                </select>
              </label>
            )}
          </div>
          {list.length ? (
            <div className="grid">
              {pageGames.map((g) => (
                <Card g={g} key={g.id} />
              ))}
            </div>
          ) : (
            <p className="empty">
              일치하는 게임이 없어요. 다른 키워드로 검색해 보세요.
            </p>
          )}
          {totalPages > 1 && (
            <nav
              aria-label="게임 목록 페이지 이동"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                marginTop: 20,
              }}
            >
              <button
                type="button"
                className="outline"
                disabled={currentPage === 1}
                onClick={() => goToPage(currentPage - 1)}
              >
                이전
              </button>
              <span aria-live="polite">
                {currentPage} / {totalPages} 페이지
              </span>
              <button
                type="button"
                className="outline"
                disabled={currentPage === totalPages}
                onClick={() => goToPage(currentPage + 1)}
              >
                다음
              </button>
            </nav>
          )}
        </section>
        <section id="taste" className="taste">
          <div>
            <p className="eyebrow">BECAUSE YOU ENJOYED</p>
            <h2>재밌게 한 게임, 하나만 골라주세요.</h2>
            <p>추천 리뷰의 공통 키워드로 다음 게임을 찾아드려요.</p>
          </div>
          <div className="pick">
            <select
              aria-label="재밌게 한 게임 선택"
              value={seed}
              onChange={(e) => {
                setSeed(e.target.value);
                setRecommendations(null);
              }}
            >
              <option value="">게임을 선택하세요</option>
              {games.map((g) => (
                <option value={g.id} key={g.id}>
                  {g.title}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!seed || busy}
              onClick={getRecommendations}
            >
              취향 추천 받기 →
            </button>
          </div>
        </section>
        {recommendations && (
          <section>
            <div className="sectionhead">
              <h2>당신의 취향과 닮은 게임</h2>
              <span>
                {recommendations[0]?.recommendMode === "game-keyword"
                  ? "추천 리뷰 키워드 코사인 유사도"
                  : "긍정 리뷰 키워드 기반"}
              </span>
            </div>
            <div className="grid">
              {recommendations.slice(0, 4).map((g) => (
                <Card
                  key={g.id}
                  g={g}
                  similarity={g.recommendMode === "game-keyword" ? g.score : null}
                />
              ))}
            </div>
            {!recommendations.length && (
              <p>공통 키워드를 가진 게임이 없습니다.</p>
            )}
          </section>
        )}
        <GameComparison games={games} />
        <section id="keywords">
          <div className="sectionhead">
            <h2>어떤 플레이를 좋아하세요?</h2>
            <span>EXPLORE BY REVIEW KEYWORD</span>
          </div>
          <div className="themes">
            {[
              ["친구와 함께", "함께라서 더 즐거운"],
              ["혼자서", "온전히 나만의 시간"],
              ["힐링", "잠시 쉬어가는 세계"],
              ["도전", "한계를 넘어서는 순간"],
            ].map(([t, s], i) => (
              <button
                key={t}
                className={"theme t" + i}
                onClick={() => search(null, t)}
              >
                <small>{s}</small>
                <strong>{t} ↗</strong>
              </button>
            ))}
          </div>
        </section>
        <footer>
          <b>◉ PLAYLOG</b>
          <span>게임을 고르는 새로운 방법, 리뷰에서 시작하세요.</span>
          <small>
            학습용 독립 프로젝트 · Steam과 무관합니다. 게임 이미지의 권리는 각
            권리자에게 있습니다.
            <br />
            평가 · 순위 · 가격은 Steam 전체 집계, 키워드 분석은 수집한 리뷰(게임당 추천 125 · 비추천 125)를
            기준으로 합니다.
          </small>
        </footer>
      </main>
      )}
      {selected && (
        <div className="overlay" onClick={() => setSelected(null)}>
          <article
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="detail-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              autoFocus
              className="close"
              aria-label="상세 닫기"
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
            <GameImage key={selected.image} game={selected} />
            <div className="modalbody">
              <p className="eyebrow">REVIEW INSIGHTS · STEAM</p>
              <h2 id="detail-title">{selected.title}</h2>
              <GameInfoPanel
                key={`info-${selected.id}`}
                gameId={selected.id}
                wished={wishedIds.has(selected.id)}
                onToggleWish={toggleWish}
              />
              <WordCloud key={`wc-${selected.id}`} gameId={selected.id} />
              <PlaytimeKeywords key={`band-${selected.id}`} gameId={selected.id} />
              <SimilarGames key={`sim-${selected.id}`} gameId={selected.id} onOpenGame={openGame} />
              <ReviewList
                key={selected.id}
                gameId={selected.id}
                keywords={selected.keywords ?? []}
                onOpenGame={openGame}
              />
            </div>
          </article>
        </div>
      )}
      {/* 로그인·회원가입 창 */}
      {authMode && (
        <AuthModal
          mode={authMode}
          onClose={() => setAuthMode(null)}
          onModeChange={setAuthMode}
          onSuccess={handleLogin}
          onSignedUp={handleSignedUp}
          initialEmail={authEmail}
        />
      )}
      {alert && <AlertDialog alert={alert} onClose={() => setAlert(null)} />}
      <Toasts toasts={toasts} />
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
