"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

const storageKey = "hc-staging-guest-scope";
const statusCopy = {
  GUEST_WAITING: "You’re in the waiting room. The customer must approve entry.",
  GUEST_ADMITTED: "The customer admitted you to the guest preview.",
  CUSTOMER_DECLINED: "The customer declined admission.",
  GUEST_REMOVED: "The customer has removed the guest.",
  GUEST_LEFT: "You’ve left the guest preview.",
  REVOKED: "The invitation was withdrawn.",
  EXPIRED: "The invitation expired.",
  SESSION_ENDED: "The session has ended.",
};
const canLeave = ["GUEST_WAITING", "GUEST_ADMITTED"];

function readFragment() {
  return new URLSearchParams(location.hash.slice(1)).get("invite");
}
function restoreScope() {
  try {
    return sessionStorage.getItem(storageKey) || "";
  } catch {
    return "";
  }
}
function saveScope(scope) {
  try {
    if (scope) sessionStorage.setItem(storageKey, scope);
    else sessionStorage.removeItem(storageKey);
  } catch {
    // The current preview can still use its in-memory scope.
  }
}

async function guestRequest(scope, body, { signal, fetcher }) {
  const response = await fetcher("/api/marketplace/demo-guest", {
    credentials: "same-origin",
    cache: "no-store",
    method: body ? "POST" : "GET",
    headers: {
      ...(scope ? { "X-HC-Guest-Scope": scope } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message || "The guest preview is unavailable.");
  return result.data;
}

export default function GuestPreview({ fetcher = fetch }) {
  const [state, setState] = useState(null);
  const [scope, setScope] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [category, setCategory] = useState("");
  const inPreview = canLeave.includes(state?.status);

  useEffect(() => {
    if (readFragment()) return;
    const saved = restoreScope();
    if (!saved) return;
    const controller = new AbortController();
    async function reconnect() {
      try {
        const data = await guestRequest(saved, null, { signal: controller.signal, fetcher });
        if (controller.signal.aborted) return;
        setScope(saved);
        setState(data);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      }
    }
    void reconnect();
    return () => controller.abort();
  }, [fetcher]);

  useEffect(() => {
    if (!scope || !inPreview || busy) return;
    const controller = new AbortController();
    let timer;
    async function refresh() {
      try {
        const data = await guestRequest(scope, null, { signal: controller.signal, fetcher });
        if (!controller.signal.aborted) {
          setState(data);
          setError("");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure.message);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
      }
    }
    timer = setTimeout(refresh, 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [scope, inPreview, busy, fetcher]);

  async function submit(action) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = { action };
      if (action === "wait") {
        body.token = readFragment();
        if (!body.token) throw new Error("Open the invitation link shared by the customer.");
        body.terms = { adult: accepted, us: accepted, accepted };
      } else if (action === "report") body.category = category;
      const data = await guestRequest(scope, body, { fetcher });
      if (action === "wait") {
        saveScope(data.scope);
        setScope(data.scope);
        setState(data);
        history.replaceState(history.state, "", location.pathname + location.search);
      } else if (action === "leave") {
        saveScope("");
        setScope("");
        setState(data);
      } else {
        setNotice("Your test report was recorded for staging review.");
      }
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="beta-shell">
      <section className="beta-card" aria-labelledby="guest-title">
        <p className="beta-notice">Staging guest preview · simulated entry</p>
        <h1 id="guest-title">{inPreview ? "Your guest preview" : "Join as a demo guest"}</h1>
        <p>One invited guest may join at no extra cost. The original session time stays the same.</p>
        {error && <p className="beta-alert" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {state && <p role="status">{statusCopy[state.status]}</p>}
        {!state && (
          <>
            <p>Adults 18+ in the United States. Keep the conversation platonic, respectful, and free of recording.</p>
            <label className="beta-checkbox">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>I meet the age and location requirements and accept these demo terms.</span>
            </label>
            <button type="button" className="beta-primary" disabled={busy || !accepted} onClick={() => submit("wait")}>
              Enter waiting room
            </button>
          </>
        )}
        {state?.status === "GUEST_ADMITTED" && (
          <>
            <p>The guest preview keeps camera and microphone off.</p>
            <details>
              <summary>Report a safety concern</summary>
              <p>Choose a test category. Avoid entering private conversation details.</p>
              <label>
                Concern category
                <select value={category} onChange={(event) => setCategory(event.target.value)}>
                  <option value="">Choose a category</option>
                  <option value="conduct">Conduct</option>
                  <option value="privacy">Privacy</option>
                  <option value="safety">Safety</option>
                </select>
              </label>
              <button type="button" className="beta-secondary" disabled={busy || !category} onClick={() => submit("report")}>
                Save test report
              </button>
            </details>
          </>
        )}
        {inPreview ? (
          <button type="button" className="beta-secondary" disabled={busy} onClick={() => submit("leave")}>
            Leave guest preview
          </button>
        ) : (
          <Link href="/">Explore Human Connection</Link>
        )}
      </section>
    </main>
  );
}
