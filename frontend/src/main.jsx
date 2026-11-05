import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import AuthModal from "./components/AuthModal.jsx";
import "./style.css";

/**
 * [프론트 → 백엔드 API]
 *
 * GET  /api/games
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

async function api(path, body, signal) {
  const r = await fetch("/api" + path, {
    signal,
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const d = await r.json();
  if (!r.ok) throw Error(d.error || "요청에 실패했습니다.");
  return d;
}
function App() {
  // null: 닫힘 / login: 로그인 / signup: 회원가입
  const [authMode, setAuthMode] = useState(null);
  const [user, setUser] = useState(null);
  const [games, setGames] = useState([]),
    [results, setResults] = useState(null),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(0),
    [selected, setSelected] = useState(null),
    [recommendations, setRecommendations] = useState(null),
    [seed, setSeed] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("전체");

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
      setResults((await api("/search", { query: value })).games);
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
        (await api("/recommendations", { gameIds: [Number(seed)] })).games
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const hero = games[active],
    list = (results ?? games).filter(
      (g) => tab === "전체" || g.tags.includes(tab)
    );
  function Card({ g }) {
    return (
      <button className="card" onClick={() => setSelected(g)}>
        <img
          src={g.image}
          alt={g.title}
          onError={(e) => {
            e.target.style.visibility = "hidden";
          }}
        />
        <div className="cardbody">
          <h3>{g.title}</h3>
          <p className="cyan">
            긍정 리뷰 {g.positiveRate}% <span>· 샘플 {g.reviewCount}건</span>
          </p>
          <div className="tags">
            {(g.matchedKeywords?.length
              ? g.matchedKeywords
              : g.tags.slice(0, 3)
            ).map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <div className="price">
            ₩ {g.price.toLocaleString()} <small>예시 가격</small>
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
            <a className="current" href="#discover">
              게임 탐색
            </a>
            <a href="#taste">취향 추천</a>
            <a href="#keywords">리뷰 인사이트</a>
          </nav>

          <div className="auth-actions">
            {user ? (
              <span>{user.nickname}님</span>
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
              )
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
                    긍정 리뷰 {hero.positiveRate}%{" "}
                    <small>· 샘플 {hero.reviewCount}건</small>
                  </p>
                  <div className="herotags">
                    {hero.tags.map((t) => (
                      <button onClick={() => search(null, t)} key={t}>
                        # {t}
                      </button>
                    ))}
                  </div>
                  <blockquote>
                    “{hero.description}”<small>목데이터 게임 소개</small>
                  </blockquote>
                  <button className="primary" onClick={() => setSelected(hero)}>
                    리뷰 키워드 살펴보기 →
                  </button>
                  <div className="herobottom">
                    <span>리뷰 기반 게임 탐색</span>
                    <b>₩ {hero.price.toLocaleString()}</b>
                  </div>
                </div>
              </div>
              <div className="dots">
                {games.map((g, i) => (
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
        <section className="catalog">
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
                }}
              >
                전체 게임 보기
              </button>
            )}
          </div>
          <div className="tabs">
            {["전체", "친구와 함께", "혼자서", "힐링", "스토리", "도전"].map(
              (t) => (
                <button
                  key={t}
                  className={tab === t ? "active" : ""}
                  onClick={() => setTab(t)}
                >
                  {t}
                </button>
              )
            )}
          </div>
          {list.length ? (
            <div className="grid">
              {list.map((g) => (
                <Card g={g} key={g.id} />
              ))}
            </div>
          ) : (
            <p className="empty">
              일치하는 게임이 없어요. 다른 키워드로 검색해 보세요.
            </p>
          )}
        </section>
        <section id="taste" className="taste">
          <div>
            <p className="eyebrow">BECAUSE YOU ENJOYED</p>
            <h2>재밌게 한 게임, 하나만 골라주세요.</h2>
            <p>긍정 리뷰의 공통 키워드로 다음 게임을 찾아드려요.</p>
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
              <span>긍정 리뷰 키워드 기반</span>
            </div>
            <div className="grid">
              {recommendations.slice(0, 4).map((g) => (
                <Card key={g.id} g={g} />
              ))}
            </div>
            {!recommendations.length && (
              <p>공통 키워드를 가진 게임이 없습니다.</p>
            )}
          </section>
        )}
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
                onClick={() => {
                  search(null, t);
                  document
                    .querySelector(".catalog")
                    .scrollIntoView({ behavior: "smooth" });
                }}
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
            리뷰·분석·가격은 시연용 목데이터입니다. 검색은 한국어 키워드 사전
            방식입니다.
          </small>
        </footer>
      </main>
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
            <img src={selected.image} alt="" />
            <div className="modalbody">
              <p className="eyebrow">REVIEW INSIGHTS · MOCK DATA</p>
              <h2 id="detail-title">{selected.title}</h2>
              <p>{selected.description}</p>
              <h3>리뷰 속 자주 등장하는 키워드</h3>
              <p className="muted">
                크기는 키워드를 언급한 샘플 리뷰 수를 나타냅니다.
              </p>
              <div className="cloud">
                {selected.keywords.map((k, i) => (
                  <button
                    key={k.keyword}
                    style={{
                      fontSize: 20 + k.reviewCount * 2,
                      color: i % 2 ? "#a4d5ec" : "#67c1f5",
                    }}
                    onClick={() => {
                      setSelected(null);
                      search(null, k.keyword);
                    }}
                  >
                    {k.keyword}
                    <sup>{k.reviewCount}</sup>
                  </button>
                ))}
              </div>
              <p className="muted">
                전체 리뷰 {selected.reviewCount}건 · 긍정{" "}
                {selected.positiveRate}% · 상세페이지는 다음 단계에서 확장할 수
                있습니다.
              </p>
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
          onSuccess={setUser}
        />
      )}
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
