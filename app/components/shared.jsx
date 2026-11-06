"use client";
import React, { useEffect, useRef } from "react";
import {
  X,
  MessageCircle,
  Lock,
  Smile,
  Headphones,
  Sparkles,
} from "lucide-react";
import { experiences } from "../../lib/catalog.mjs";
import { browserDemo } from "../../lib/presentation.mjs";
export const expIcon = { laugh: Smile, hear: Headphones, distract: Sparkles };
export const expName = (id) => experiences.find((e) => e.id === id)?.name;
export const human = (s) =>
  s
    ?.toLowerCase()
    .replaceAll("_", " ")
    .replace(/^./, (s) => s.toUpperCase());
export const date = (n) =>
  new Date(n).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const fmtTime = (seconds) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, "0")}`;
export function Mark() {
  return (
    <svg viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <ellipse cx="17" cy="22" rx="9" ry="14" transform="rotate(-30 17 22)" />
      <ellipse cx="27" cy="22" rx="9" ry="14" transform="rotate(30 27 22)" />
    </svg>
  );
}
export function Modal({ title, children, close, wide = false }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current,
      opener = document.activeElement;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={title}
      className={wide ? "modal wide" : "modal"}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="modal-top">
        <h2>{title}</h2>
        <button className="icon-btn" aria-label="Close dialog" onClick={close}>
          <X size={21} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({ icon: Icon = MessageCircle, title, children, action }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={30} />
      </span>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function SignIn() {
  if (browserDemo)
    return (
      <p className="notice">
        Opening your local demo workspace. Reload if it does not appear.
      </p>
    );
  return (
    <div className="notice">
      <Lock size={18} />
      <span>Sign in to use your private demo workspace.</span>
      <a
        className="primary"
        href="/signin-with-chatgpt?return_to=/"
        target="_top"
      >
        Sign in
      </a>
    </div>
  );
}
export function PageHeading({ eyebrow, title, children }) {
  return (
    <div className="page-heading">
      <span className="eyebrow">{eyebrow}</span>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}
