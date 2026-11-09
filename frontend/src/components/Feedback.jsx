/**
 * 알림 UI
 *   AlertDialog : 화면 가운데 알림창 (회원가입 완료 · 탈퇴 확인 같은 중요한 안내)
 *   Toasts      : 화면 아래 잠깐 떴다 사라지는 짧은 알림 (찜 추가 · 로그아웃 등)
 */
import React, { useEffect, useRef } from "react";
import { Icon } from "../lib.jsx";

export function AlertDialog({ alert, onClose }) {
  const primaryRef = useRef(null);
  useEffect(() => {
    primaryRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tone = alert.tone ?? "success";
  return (
    <div className="alert-overlay" onClick={onClose}>
      <div
        className={`alert-card is-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="alert-title"
        aria-describedby="alert-message"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="alert-icon">
          <Icon name={tone === "error" ? "alert" : "check"} size={30} />
        </span>
        <h2 id="alert-title">{alert.title}</h2>
        <p id="alert-message">{alert.message}</p>
        <div className="alert-actions">
          {alert.secondary && (
            <button type="button" className="alert-secondary" onClick={() => { onClose(); alert.secondary.onClick?.(); }}>
              {alert.secondary.label}
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className="alert-primary"
            onClick={() => {
              onClose();
              alert.primary?.onClick?.();
            }}
          >
            {alert.primary?.label ?? "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts({ toasts }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast is-${t.tone ?? "info"}`}>
          {t.icon && <Icon name={t.icon} size={16} filled={t.icon === "heart"} />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
