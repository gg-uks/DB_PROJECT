import React, { useEffect, useRef, useState } from "react";

export default function AuthModal({ mode, onClose, onModeChange, onSuccess, onSignedUp, initialEmail = "" }) {
  const dialogRef = useRef(null);

  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const isSignup = mode === "signup";

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();

    return () => dialog.close();
  }, []);

  useEffect(() => {
    setPassword("");
    setError("");
    setMessage("");
  }, [mode]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      const body = isSignup
        ? { email: email.trim(), password, nickname: nickname.trim() }
        : { email: email.trim(), password };

      const response = await fetch(
        `/api/auth/${isSignup ? "signup" : "login"}`,
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        }
      );

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(
          data.error || "요청에 실패했습니다. 잠시 후 다시 시도해주세요."
        );
      }

      if (isSignup) {
        // 회원가입 후 자동 로그인하지 않음 → 화면 가운데 알림창(AlertDialog)으로 안내하고 로그인으로 이어짐
        onSignedUp?.({ email: email.trim(), nickname: nickname.trim() });
      } else {
        // 백엔드 로그인 응답 형식: { user: { id, email, nickname } }
        if (!data.user) {
          throw new Error("로그인 응답에 회원 정보가 없습니다.");
        }

        onSuccess?.(data.user);
        onClose();
      }
    } catch (err) {
      setError(
        err instanceof TypeError ? "서버에 연결할 수 없습니다." : err.message
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="auth-dialog"
      aria-labelledby="auth-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!loading) onClose();
      }}
    >
      <button
        type="button"
        className="auth-close"
        aria-label="닫기"
        onClick={onClose}
        disabled={loading}
      >
        ✕
      </button>

      <p className="eyebrow">WELCOME TO PLAYLOG</p>

      <h2 id="auth-title">{isSignup ? "회원가입" : "로그인"}</h2>

      <p className="auth-description">
        좋아하는 게임을 저장하고 내 취향에 맞는 게임을 찾아보세요.
      </p>

      <form className="auth-form" onSubmit={handleSubmit}>
        {isSignup && (
          <label>
            닉네임
            <input
              autoFocus
              type="text"
              autoComplete="nickname"
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              minLength={2}
              maxLength={20}
              required
              disabled={loading}
              placeholder="2~20자"
            />
          </label>
        )}

        <label>
          이메일
          <input
            autoFocus={!isSignup}
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            maxLength={100}
            required
            disabled={loading}
            placeholder="example@email.com"
          />
        </label>

        <label>
          비밀번호
          <input
            type="password"
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={isSignup ? 8 : undefined}
            maxLength={72}
            required
            disabled={loading}
            placeholder={isSignup ? "8자 이상 입력" : "비밀번호 입력"}
          />
        </label>

        {error && (
          <p className="auth-error" role="alert">
            {error}
          </p>
        )}

        {message && (
          <p className="auth-message" role="status">
            {message}
          </p>
        )}

        <button
          type="submit"
          className="primary auth-submit"
          disabled={loading}
        >
          {loading ? "처리 중…" : isSignup ? "회원가입" : "로그인"}
        </button>
      </form>

      <div className="auth-switch">
        <span>{isSignup ? "이미 계정이 있나요?" : "아직 계정이 없나요?"}</span>

        <button
          type="button"
          disabled={loading}
          onClick={() => onModeChange(isSignup ? "login" : "signup")}
        >
          {isSignup ? "로그인" : "회원가입"}
        </button>
      </div>
    </dialog>
  );
}
