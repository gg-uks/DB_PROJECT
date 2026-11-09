/**
 * 마이페이지 (#/mypage)
 *   GET /api/me/summary · GET /api/me/wishlist · PATCH /api/me/profile · POST /api/me/password · DELETE /api/me
 */
import React, { useEffect, useState } from "react";
import { api, apiSend, Icon, won, numText } from "../lib.jsx";

export default function MyPage({ user, wishlist, onRemoveWish, onOpenGame, onUserChange, onDeleted, onLogin, notify, showAlert }) {
  const [tab, setTab] = useState("wishlist");
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    if (!user) return;
    api("/me/summary").then(setSummary).catch(() => setSummary(null));
  }, [user, wishlist]);

  if (!user) {
    return (
      <main className="page">
        <a className="page-back" href="#/">
          <Icon name="back" size={16} /> 스토어로 돌아가기
        </a>
        <section className="page-empty">
          <span className="page-empty-icon">
            <Icon name="user" size={36} />
          </span>
          <h1>로그인이 필요해요</h1>
          <p className="muted">마이페이지에서 찜한 게임과 계정 정보를 관리할 수 있어요.</p>
          <button type="button" className="primary" onClick={onLogin}>
            로그인하기
          </button>
        </section>
      </main>
    );
  }

  const saved = summary ? summary.totalInitial - summary.totalPrice : 0;
  const maxGenre = Math.max(1, ...(summary?.genres ?? []).map((g) => g.games));

  return (
    <main className="page">
      <a className="page-back" href="#/">
        <Icon name="back" size={16} /> 스토어로 돌아가기
      </a>

      <section className="profile-hero">
        <div className="profile-avatar" aria-hidden="true">
          {user.nickname.slice(0, 1)}
        </div>
        <div className="profile-text">
          <p className="eyebrow">MY PAGE</p>
          <h1>
            {user.nickname}
            {user.isAdmin && (
              <span className="role-badge">
                <Icon name="shield" size={13} /> 관리자
              </span>
            )}
          </h1>
          <p className="muted">
            {user.email} · 가입일 {summary?.joinedAt ?? user.joinedAt ?? "—"}
            {summary?.days ? ` · PLAYLOG와 함께한 지 ${summary.days}일째` : ""}
          </p>
        </div>
      </section>

      <section className="stat-cards" aria-label="내 찜 요약">
        <div>
          <Icon name="heart" size={18} />
          <small>찜한 게임</small>
          <strong>{numText(summary?.wished ?? wishlist.length)}</strong>
        </div>
        <div>
          <Icon name="tag" size={18} />
          <small>지금 할인 중</small>
          <strong>{numText(summary?.onSale ?? 0)}</strong>
        </div>
        <div>
          <Icon name="check" size={18} />
          <small>찜 목록 총액</small>
          <strong>{summary ? won(summary.totalPrice) : "—"}</strong>
          {saved > 0 && <em>정가보다 {won(saved)} 절약</em>}
        </div>
        <div>
          <Icon name="user" size={18} />
          <small>찜한 게임 평균 긍정률</small>
          <strong>{summary?.avgPositive != null ? `${summary.avgPositive}%` : "—"}</strong>
        </div>
      </section>

      {summary?.genres?.length > 0 && (
        <section className="taste-genres" aria-labelledby="taste-title">
          <h2 id="taste-title">내 찜 목록의 장르</h2>
          <ul>
            {summary.genres.map((g) => (
              <li key={g.name}>
                <span>{g.name}</span>
                <span className="taste-track">
                  <span style={{ width: `${(g.games / maxGenre) * 100}%` }} />
                </span>
                <b>{g.games}</b>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="page-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "wishlist"} onClick={() => setTab("wishlist")}>
          <Icon name="heart" size={15} /> 찜 목록
        </button>
        <button role="tab" aria-selected={tab === "account"} onClick={() => setTab("account")}>
          <Icon name="user" size={15} /> 계정 설정
        </button>
      </div>

      {tab === "wishlist" ? (
        <WishlistGrid wishlist={wishlist} onOpenGame={onOpenGame} onRemoveWish={onRemoveWish} />
      ) : (
        <AccountSettings user={user} onUserChange={onUserChange} onDeleted={onDeleted} notify={notify} showAlert={showAlert} />
      )}
    </main>
  );
}

function WishImage({ src }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <span className="wish-card-noimg">이미지 없음</span>;
  return <img src={src} alt="" onError={() => setFailed(true)} />;
}

function WishlistGrid({ wishlist, onOpenGame, onRemoveWish }) {
  if (!wishlist.length) {
    return (
      <section className="page-empty is-small">
        <span className="page-empty-icon">
          <Icon name="heart" size={30} />
        </span>
        <h2>아직 찜한 게임이 없어요</h2>
        <p className="muted">게임 상세에서 찜하기를 누르면 여기에 모여요.</p>
        <a className="primary" href="#/">
          게임 둘러보기
        </a>
      </section>
    );
  }
  return (
    <ul className="wish-grid">
      {wishlist.map((g) => (
        <li key={g.id}>
          <button type="button" className="wish-card" onClick={() => onOpenGame(g.id)}>
            <WishImage src={g.image} />
            <span className="wish-card-body">
              <strong>{g.title}</strong>
              <span className="wish-card-price">
                {g.discountPct > 0 && <span className="discount">-{g.discountPct}%</span>}
                {g.isFree ? "무료" : g.finalPrice != null ? won(g.finalPrice) : "가격 정보 없음"}
              </span>
              <small className="muted">
                {g.koPositivePct != null ? `긍정 ${g.koPositivePct}% · ` : ""}
                {new Date(g.addedAt).toLocaleDateString("ko-KR")}에 찜함
              </small>
            </span>
          </button>
          <button
            type="button"
            className="wish-card-remove"
            aria-label={`${g.title} 찜 삭제`}
            title="찜 삭제"
            onClick={() => onRemoveWish(g.id)}
          >
            <Icon name="trash" size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}

function AccountSettings({ user, onUserChange, onDeleted, notify, showAlert }) {
  const [nickname, setNickname] = useState(user.nickname);
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "" });
  const [deletePw, setDeletePw] = useState("");
  const [busy, setBusy] = useState("");

  async function run(key, task) {
    setBusy(key);
    try {
      await task();
    } catch (e) {
      showAlert({ tone: "error", title: "처리하지 못했어요", message: e.message });
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="settings">
      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault();
          run("nickname", async () => {
            const { user: next } = await apiSend("PATCH", "/me/profile", { nickname });
            onUserChange(next);
            notify({ message: "닉네임을 바꿨어요.", icon: "check" });
          });
        }}
      >
        <h3>닉네임</h3>
        <p className="muted">사이트에 보이는 이름이에요. 2~20자.</p>
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} minLength={2} maxLength={20} required />
        <button className="primary" disabled={busy === "nickname" || nickname.trim() === user.nickname}>
          {busy === "nickname" ? "저장 중…" : "저장"}
        </button>
      </form>

      <form
        className="settings-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (pw.newPassword !== pw.confirm) {
            showAlert({ tone: "error", title: "새 비밀번호가 달라요", message: "새 비밀번호와 확인이 같은지 확인해주세요." });
            return;
          }
          run("password", async () => {
            await apiSend("POST", "/me/password", { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
            setPw({ currentPassword: "", newPassword: "", confirm: "" });
            showAlert({ title: "비밀번호를 바꿨어요", message: "다른 기기에서 로그인한 세션은 모두 로그아웃됐어요." });
          });
        }}
      >
        <h3>비밀번호 변경</h3>
        <p className="muted">bcrypt 해시로 저장돼요. 8~72자.</p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="현재 비밀번호"
          value={pw.currentPassword}
          onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="새 비밀번호"
          minLength={8}
          maxLength={72}
          value={pw.newPassword}
          onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="새 비밀번호 확인"
          value={pw.confirm}
          onChange={(e) => setPw({ ...pw, confirm: e.target.value })}
          required
        />
        <button className="primary" disabled={busy === "password"}>
          {busy === "password" ? "변경 중…" : "비밀번호 변경"}
        </button>
      </form>

      <form
        className="settings-card is-danger"
        onSubmit={(e) => {
          e.preventDefault();
          showAlert({
            tone: "error",
            title: "정말 탈퇴할까요?",
            message: "찜 목록과 로그인 정보가 모두 지워지고 되돌릴 수 없어요.",
            secondary: { label: "취소" },
            primary: {
              label: "탈퇴하기",
              onClick: () =>
                run("delete", async () => {
                  await apiSend("DELETE", "/me", { password: deletePw });
                  onDeleted();
                }),
            },
          });
        }}
      >
        <h3>회원 탈퇴</h3>
        <p className="muted">MEMBER에서 삭제되고, 찜 목록(WISHLIST)과 세션은 ON DELETE CASCADE로 함께 지워져요.</p>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="비밀번호 확인"
          value={deletePw}
          onChange={(e) => setDeletePw(e.target.value)}
          required
        />
        <button className="danger" disabled={busy === "delete"}>
          {busy === "delete" ? "처리 중…" : "탈퇴하기"}
        </button>
      </form>
    </div>
  );
}
