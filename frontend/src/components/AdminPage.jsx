/**
 * 관리자 페이지 (#/admin) — 로그인 + ADMIN_EMAILS 회원만
 *   GET /api/admin/overview · /api-log · /games · /members · /keywords
 */
import React, { useEffect, useState } from "react";
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
import { api, Icon, numText } from "../lib.jsx";

const TABS = [
  ["overview", "개요"],
  ["collect", "수집 현황"],
  ["games", "게임 데이터"],
  ["members", "회원"],
  ["keywords", "키워드"],
];
const axis = { fill: "#c5d9e8", fontSize: 12 };
const tooltipStyle = { background: "#122535", border: "1px solid #29455b", color: "#edf7ff" };

function useAdmin(path) {
  const [state, setState] = useState({ data: null, error: "" });
  useEffect(() => {
    let alive = true;
    api(`/admin/${path}`)
      .then((data) => alive && setState({ data, error: "" }))
      .catch((e) => alive && setState({ data: null, error: e.message }));
    return () => {
      alive = false;
    };
  }, [path]);
  return state;
}

export default function AdminPage({ user, onLogin }) {
  const [tab, setTab] = useState("overview");

  if (!user || !user.isAdmin) {
    return (
      <main className="page">
        <a className="page-back" href="#/">
          <Icon name="back" size={16} /> 스토어로 돌아가기
        </a>
        <section className="page-empty">
          <span className="page-empty-icon">
            <Icon name="shield" size={36} />
          </span>
          <h1>관리자만 들어올 수 있어요</h1>
          <p className="muted">
            {user ? "이 계정은 관리자 권한이 없어요." : "관리자 계정으로 로그인해주세요."}
          </p>
          {!user && (
            <button type="button" className="primary" onClick={onLogin}>
              로그인하기
            </button>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="page admin">
      <a className="page-back" href="#/">
        <Icon name="back" size={16} /> 스토어로 돌아가기
      </a>
      <div className="admin-head">
        <div>
          <p className="eyebrow">ADMIN CONSOLE</p>
          <h1>
            <Icon name="shield" size={26} /> 관리자 대시보드
          </h1>
          <p className="muted">{user.email} · 수집 · 데이터 · 회원 현황을 한곳에서 봐요.</p>
        </div>
      </div>
      <nav className="admin-tabs" role="tablist">
        {TABS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview />}
      {tab === "collect" && <Collect />}
      {tab === "games" && <Games />}
      {tab === "members" && <Members />}
      {tab === "keywords" && <Keywords />}
    </main>
  );
}

function Loading({ error }) {
  return error ? <p role="alert">{error}</p> : <p role="status" className="muted">불러오는 중…</p>;
}

function Overview() {
  const { data, error } = useAdmin("overview");
  if (!data) return <Loading error={error} />;
  const k = data.kpi;
  const cards = [
    ["게임", k.games, "수집 대상 (목표 30)"],
    ["리뷰", k.reviews, `추천 ${numText(k.reviewPos)} · 비추천 ${numText(k.reviewNeg)}`],
    ["키워드", k.keywords, "nori 명사 사전"],
    ["회원", k.members, `최근 7일 신규 ${numText(k.newMembers7d)}`],
    ["찜", k.wishlist, `로그인 중 세션 ${numText(k.activeSessions)}`],
    ["API 호출 (24시간)", k.calls24h, `실패 ${numText(k.failed24h)}`, k.failed24h > 0],
  ];
  return (
    <>
      <section className="kpi-grid">
        {cards.map(([label, value, sub, warn]) => (
          <div key={label} className={warn ? "is-warn" : ""}>
            <small>{label}</small>
            <strong>{numText(value)}</strong>
            <em>{sub}</em>
          </div>
        ))}
      </section>
      <FreshnessPanel data={data} />
      <TableCountsPanel tables={data.tables} />
    </>
  );
}


// ───────── 개요: 마지막 갱신 · 테이블별 행 수 ─────────

/** "2026-11-09 17:29" → 몇 분/시간/일 전 */
function ago(text) {
  if (!text) return null;
  const t = new Date(text.length <= 10 ? `${text}T00:00:00` : text.replace(" ", "T"));
  const min = Math.round((Date.now() - t.getTime()) / 60000);
  if (Number.isNaN(min)) return null;
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  if (min < 60 * 24) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 1440)}일 전`;
}
/** 갱신 상태: 24시간 안 = 정상 · 그보다 오래됨 = 주의 · 기록 없음 = 미실행 */
function freshness(text, limitHours = 26) {
  if (!text) return "none";
  const t = new Date(text.length <= 10 ? `${text}T00:00:00` : text.replace(" ", "T"));
  return Date.now() - t.getTime() <= limitHours * 3600000 ? "fresh" : "stale";
}
const FRESH_LABEL = { fresh: "정상", stale: "오래됨", none: "기록 없음" };

function FreshnessPanel({ data }) {
  const callAt = (api) => data.lastCalls.find((c) => c.api === api)?.lastAt ?? null;
  const rows = [
    {
      title: "게임 상세 수집",
      desc: "가격 · 장르 · 카테고리 · 회사 (Steam appdetails)",
      at: callAt("appdetails"),
      cmd: "npm run collect:details -w backend",
      schedule: "매일 03:00",
    },
    {
      title: "리뷰 수집",
      desc: "추천 125 · 비추천 125 (Steam GetAppReviews)",
      at: callAt("GetAppReviews"),
      cmd: "npm run reviews:produce -w backend",
      schedule: "매일 03:00",
    },
    {
      title: "주간 순위 수집",
      desc: "순위 · 지난주 순위 · 최고 동시 접속자 (GetMostPlayedGames)",
      at: callAt("GetMostPlayedGames"),
      cmd: "npm run collect:ranks -w backend",
      schedule: "매일 05:00",
      extra: data.rankDate ? `순위 기준일 ${data.rankDate}` : null,
      limit: 24 * 8,
    },
    {
      title: "게임 정보 마지막 변경",
      desc: "GAME.updated_at — 값이 바뀐 게임이 있을 때 갱신",
      at: data.gameUpdatedAt,
      limit: 24 * 8,
    },
    {
      title: "가장 최근 리뷰",
      desc: "수집한 리뷰 중 가장 최근에 작성된 리뷰 (REVIEW.created_at)",
      at: data.lastReviewAt,
      limit: 24 * 8,
    },
  ];
  return (
    <section className="admin-panel">
      <h2>데이터 갱신 상태</h2>
      <ul className="fresh-list">
        {rows.map((r) => {
          const state = freshness(r.at, r.limit);
          return (
            <li key={r.title} className={`is-${state}`}>
              <span className="fresh-dot" aria-hidden="true" />
              <div className="fresh-main">
                <strong>{r.title}</strong>
                <small>{r.desc}</small>
                {state === "none" && r.cmd && (
                  <small className="fresh-hint">
                    아직 실행 기록이 없어요 → <code>{r.cmd}</code>
                  </small>
                )}
              </div>
              <div className="fresh-time">
                <span className={`fresh-badge is-${state}`}>{FRESH_LABEL[state]}</span>
                {r.at ? (
                  <>
                    <b>{ago(r.at)}</b>
                    <small>
                      {r.at}
                      {r.extra ? ` · ${r.extra}` : ""}
                    </small>
                  </>
                ) : (
                  <small>{r.schedule ? `자동 실행: ${r.schedule}` : "—"}</small>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const TABLE_GROUPS = [
  {
    title: "게임과 분류",
    tables: [
      ["GAME", "게임", "목표 30개", 30],
      ["GENRE", "장르"],
      ["GAME_GENRE", "게임 ↔ 장르", "연결 테이블"],
      ["CATEGORY", "카테고리"],
      ["GAME_CATEGORY", "게임 ↔ 카테고리", "연결 테이블"],
      ["COMPANY", "회사 (개발 · 배급)"],
      ["GAME_COMPANY", "게임 ↔ 회사", "연결 테이블 · role"],
    ],
  },
  {
    title: "리뷰와 키워드",
    tables: [
      ["REVIEW", "리뷰 (정형 · 본문은 MongoDB)", "목표 7,500건", 7500],
      ["KEYWORD", "키워드 사전 (nori 명사)"],
      ["REVIEW_KEYWORD", "리뷰 ↔ 키워드", "연결 테이블 · tf"],
      ["GAME_KEYWORD", "게임별 키워드 집계", "의도적 반정규화"],
    ],
  },
  {
    title: "회원",
    tables: [
      ["MEMBER", "회원"],
      ["WISHLIST", "찜", "회원 ↔ 게임"],
      ["MEMBER_SESSION", "로그인 세션", "구현용 (v2 외)"],
    ],
  },
  {
    title: "수집 기록",
    tables: [["API_SYNC_LOG", "Steam API 호출 기록", "FK 없음 (실패도 기록)"]],
  },
];

function TableCountsPanel({ tables }) {
  const rows = new Map(tables.map((t) => [t.name, t.rows]));
  const max = Math.max(1, ...tables.map((t) => t.rows));
  // 행 수 차이가 커서(30 ~ 8만) 막대는 로그 비율로 그림
  const width = (n) => (n > 0 ? Math.max(3, (Math.log10(n + 1) / Math.log10(max + 1)) * 100) : 0);
  const total = tables.reduce((sum, t) => sum + t.rows, 0);
  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <h2>테이블별 행 수</h2>
        <span className="muted">
          {tables.length}개 테이블 · 전체 {total.toLocaleString()}행 · 막대는 로그 비율
        </span>
      </div>
      <div className="table-groups">
        {TABLE_GROUPS.map((group) => (
          <div key={group.title} className="table-group">
            <h3>{group.title}</h3>
            <ul>
              {group.tables.map(([name, label, note, target]) => {
                const n = rows.get(name) ?? 0;
                const reached = target ? n >= target : null;
                return (
                  <li key={name} className={n === 0 ? "is-empty" : ""}>
                    <div className="tc-name">
                      <span>{label}</span>
                      <code>{name}</code>
                    </div>
                    <div className="tc-bar" aria-hidden="true">
                      <span style={{ width: `${width(n)}%` }} />
                    </div>
                    <div className="tc-count">
                      <b>{n.toLocaleString()}</b>
                      {note && (
                        <small className={reached === false ? "is-warn" : reached ? "is-ok" : ""}>
                          {target ? `${reached ? "달성 · " : ""}${note}` : note}
                        </small>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatusCode({ code }) {
  const ok = code >= 200 && code < 300;
  return <span className={`status-code ${ok ? "is-ok" : "is-fail"}`}>{code || "ERR"}</span>;
}

function Collect() {
  const { data, error } = useAdmin("api-log?days=14");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <section className="admin-panel">
        <h2>일별 Steam API 호출 (최근 {data.days}일)</h2>
        {data.daily.length ? (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data.daily}>
              <CartesianGrid stroke="#29455b" vertical={false} />
              <XAxis dataKey="day" tick={axis} />
              <YAxis tick={axis} allowDecimals={false} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(103,193,245,.08)" }} />
              <Legend />
              <Bar dataKey="ok" name="성공" stackId="a" fill="#67c1f5" maxBarSize={48} />
              <Bar dataKey="failed" name="실패" stackId="a" fill="#ff7b8a" radius={[4, 4, 0, 0]} maxBarSize={48} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <p className="muted">기간 안에 호출 기록이 없어요.</p>
        )}
      </section>
      <section className="admin-panel">
        <h2>API별 요약</h2>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>API</th>
                <th>호출</th>
                <th>성공</th>
                <th>실패</th>
                <th>성공률</th>
                <th>받은 항목</th>
                <th>마지막 호출</th>
              </tr>
            </thead>
            <tbody>
              {data.apis.map((a) => (
                <tr key={a.api}>
                  <th>{a.api}</th>
                  <td>{numText(a.calls)}</td>
                  <td>{numText(a.ok)}</td>
                  <td className={a.failed ? "is-negative" : ""}>{numText(a.failed)}</td>
                  <td>{a.calls ? ((a.ok * 100) / a.calls).toFixed(1) : "—"}%</td>
                  <td>{numText(a.items)}</td>
                  <td>{a.lastAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <div className="admin-two">
        <section className="admin-panel">
          <h2>최근 실패</h2>
          {!data.failures.length && <p className="muted">실패한 호출이 없어요.</p>}
          <ul className="log-list">
            {data.failures.map((r) => (
              <li key={r.id}>
                <StatusCode code={r.status} />
                <span>
                  {r.api}
                  {r.game ? ` · ${r.game}` : r.appid ? ` · ${r.appid}` : ""}
                  <small className="muted">
                    {" "}
                    · {r.at}
                    {r.error ? ` · ${r.error}` : ""}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <section className="admin-panel">
          <h2>최근 호출 30건</h2>
          <ul className="log-list">
            {data.recent.map((r) => (
              <li key={r.id}>
                <StatusCode code={r.status} />
                <span>
                  {r.api}
                  {r.game ? ` · ${r.game}` : ""}
                  <small className="muted">
                    {" "}
                    · {r.at} · {r.items}건
                  </small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}

function SampleBar({ value, target, tone }) {
  const pct = Math.min(100, (value / target) * 100);
  return (
    <span className="sample-bar" title={`${value} / ${target}`}>
      <span className={`sample-fill ${tone}`} style={{ width: `${pct}%` }} />
      <b>{value}</b>
    </span>
  );
}

function Games() {
  const { data, error } = useAdmin("games");
  const [onlyIssues, setOnlyIssues] = useState(false);
  if (!data) return <Loading error={error} />;
  const games = onlyIssues ? data.games.filter((g) => g.issues.length) : data.games;
  const withIssues = data.games.filter((g) => g.issues.length).length;
  return (
    <section className="admin-panel">
      <div className="admin-panel-head">
        <h2>게임별 수집 상태</h2>
        <label className="toggle">
          <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
          확인이 필요한 게임만 ({withIssues})
        </label>
      </div>
      <p className="muted">표본 목표: 게임당 추천 {data.target} · 비추천 {data.target}</p>
      <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>순위</th>
              <th>게임</th>
              <th>추천 표본</th>
              <th>비추천 표본</th>
              <th>키워드 행</th>
              <th>찜</th>
              <th>마지막 리뷰</th>
              <th>정보 갱신</th>
              <th>확인할 점</th>
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id}>
                <td>{g.rank ?? "—"}</td>
                <th>
                  {g.title}
                  <small className="muted"> · {g.id}</small>
                </th>
                <td>
                  <SampleBar value={g.pos} target={data.target} tone="is-positive" />
                </td>
                <td>
                  <SampleBar value={g.neg} target={data.target} tone="is-negative" />
                </td>
                <td>{numText(g.keywordRows)}</td>
                <td>{numText(g.wished)}</td>
                <td>{g.lastReviewAt ?? "—"}</td>
                <td>{g.updatedAt}</td>
                <td>
                  {g.issues.length ? (
                    <span className="issue-chips">
                      {g.issues.map((i) => (
                        <span key={i}>{i}</span>
                      ))}
                    </span>
                  ) : (
                    <span className="ok-chip">
                      <Icon name="check" size={13} /> 정상
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Members() {
  const { data, error } = useAdmin("members");
  if (!data) return <Loading error={error} />;
  return (
    <>
      <div className="admin-two">
        <section className="admin-panel">
          <h2>최근 30일 가입</h2>
          {data.signups.length ? (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={data.signups}>
                <CartesianGrid stroke="#29455b" vertical={false} />
                <XAxis dataKey="day" tick={axis} />
                <YAxis tick={axis} allowDecimals={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(103,193,245,.08)" }} />
                <Bar dataKey="members" name="가입" fill="#67c1f5" radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="muted">최근 30일 가입이 없어요.</p>
          )}
        </section>
        <section className="admin-panel">
          <h2>많이 찜한 게임</h2>
          {data.topWished.length ? (
            <ResponsiveContainer width="100%" height={Math.max(160, data.topWished.length * 30 + 30)}>
              <BarChart data={data.topWished} layout="vertical" margin={{ left: 8, right: 16 }}>
                <CartesianGrid stroke="#29455b" horizontal={false} />
                <XAxis type="number" tick={axis} allowDecimals={false} />
                <YAxis type="category" dataKey="title" width={130} tick={axis} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgba(255,123,138,.08)" }} />
                <Bar dataKey="wished" name="찜" fill="#ff7b8a" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="muted">아직 찜한 게임이 없어요.</p>
          )}
        </section>
      </div>
      <section className="admin-panel">
        <h2>회원 (최근 가입 50명)</h2>
        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>번호</th>
                <th>닉네임</th>
                <th>이메일</th>
                <th>가입</th>
                <th>찜</th>
                <th>로그인 세션</th>
              </tr>
            </thead>
            <tbody>
              {data.members.map((m) => (
                <tr key={m.id}>
                  <td>{m.id}</td>
                  <th>{m.nickname}</th>
                  <td>{m.email}</td>
                  <td>{m.createdAt}</td>
                  <td>{m.wished}</td>
                  <td>{m.sessions ? <span className="ok-chip">{m.sessions}개</span> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function KeywordChart({ title, rows, color }) {
  return (
    <section className="admin-panel">
      <h2>{title}</h2>
      {rows.length ? (
        <ResponsiveContainer width="100%" height={rows.length * 28 + 40}>
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 16 }}>
            <CartesianGrid stroke="#29455b" horizontal={false} />
            <XAxis type="number" tick={axis} allowDecimals={false} />
            <YAxis type="category" dataKey="word" width={80} tick={axis} />
            <Tooltip
              contentStyle={tooltipStyle}
              cursor={{ fill: "rgba(103,193,245,.08)" }}
              formatter={(v, name, p) => [`리뷰 ${v}건 · 게임 ${p.payload.games}개`, "등장"]}
            />
            <Bar dataKey="reviews" fill={color} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <p className="muted">키워드 집계가 없어요. keywords:aggregate를 실행하세요.</p>
      )}
    </section>
  );
}

function Keywords() {
  const { data, error } = useAdmin("keywords");
  if (!data) return <Loading error={error} />;
  return (
    <div className="admin-two">
      <KeywordChart title="추천 리뷰 전체 상위 키워드" rows={data.pos} color="#67c1f5" />
      <KeywordChart title="비추천 리뷰 전체 상위 키워드" rows={data.neg} color="#ff7b8a" />
    </div>
  );
}
