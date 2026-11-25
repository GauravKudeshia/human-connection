"use client";

import React, { useRef, useState } from "react";
import { fmtTime } from "./shared";

const descriptions = {
  HOST_PENDING: "Waiting for the host to approve.",
  HOST_DECLINED: "The host declined the invitation request.",
  HOST_APPROVED: "The host approved one demo guest.",
  ISSUED: "The temporary demo link is ready.",
  GUEST_OPENED: "The guest is reviewing the participation terms.",
  GUEST_WAITING: "The guest is waiting for the customer to admit them.",
  GUEST_ADMITTED: "The customer admitted the guest. The guest can now enter.",
  GUEST_CONNECTED: "The guest is in the simulated room.",
  GUEST_DISCONNECTED: "The guest's simulated connection is paused.",
  CUSTOMER_DECLINED: "The customer declined admission.",
  GUEST_LEFT: "The guest left the simulated room.",
  GUEST_REMOVED: "The guest was removed from the simulated room.",
  REVOKED: "The invitation was withdrawn.",
  EXPIRED: "The invitation expired.",
  SESSION_ENDED: "The demo session has ended.",
};

const pending = ["HOST_PENDING", "HOST_APPROVED", "ISSUED", "GUEST_OPENED", "GUEST_WAITING", "GUEST_ADMITTED"];
const guestRoom = ["GUEST_CONNECTED", "GUEST_DISCONNECTED"];
const linkPrefix = "#demo-friend=";

function tokenFromFragment() {
  if (typeof window === "undefined" || !location.hash.startsWith(linkPrefix)) return "";
  const token = location.hash.slice(linkPrefix.length);
  return /^[0-9a-f]{48}$/.test(token) ? token : "";
}

function linkFor(token) {
  if (!token || typeof window === "undefined") return "";
  const link = new URL(location.href);
  link.search = "";
  link.hash = linkPrefix + token;
  return link.href;
}

export default function InviteFriend({ booking, now, busy, act }) {
  const [issuedToken, setIssuedToken] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [consent, setConsent] = useState(false);
  const [micOff, setMicOff] = useState(true);
  const [cameraOff, setCameraOff] = useState(true);
  const [reason, setReason] = useState("");
  const linkInput = useRef(null);
  const invite = booking.invitation;
  const linkExpired = invite?.expiresAt <= now && pending.includes(invite.status);
  const status = linkExpired ? "EXPIRED" : invite?.status;
  const live = booking.status === "LIVE" && now < booking.deadline;
  const roleToken = issuedToken || tokenFromFragment();
  const demoLink = status === "ISSUED" ? linkFor(roleToken) : "";

  const run = (action, data = {}, message) =>
    act(action, { bookingId: booking.id, ...data }, message);

  function control(label, action, { allowPaused = false } = {}) {
    return (
      <button
        type="button"
        className="secondary"
        disabled={busy || (!live && !allowPaused)}
        onClick={() => run(action)}
      >
        {label}
      </button>
    );
  }

  async function issueLink() {
    const response = await run("invite-issue");
    if (response?.result?.invitationToken) {
      setIssuedToken(response.result.invitationToken);
      setCopyNotice("");
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(demoLink);
      setCopyNotice("Demo link copied. Use it in this tab.");
    } catch {
      linkInput.current?.focus();
      linkInput.current?.select();
      setCopyNotice("Link selected. Use your browser’s copy command.");
    }
  }

  async function openGuest(event) {
    event.preventDefault();
    if (busy || !live) return;
    const result = await run("invite-guest-open", { token: roleToken });
    if (result) {
      setIssuedToken("");
      setCopyNotice("");
      if (tokenFromFragment())
        history.replaceState(history.state, "", location.pathname + location.search);
    }
  }

  return (
    <section className="review-panel" aria-labelledby="invite-friend-title">
      <h2 id="invite-friend-title">Participants</h2>
      <p>
        Simulate inviting one guest in this tab. You control all three roles.
        The price and session timer stay the same.
      </p>
      {status && <p role="status">{descriptions[status]}</p>}
      {!status && control("Invite a Friend", "invite-request")}
      {status === "HOST_PENDING" && (
        <div className="button-row">
          {control("Host: Approve guest request", "invite-host-approve")}
          {control("Host: Decline guest request", "invite-host-decline")}
        </div>
      )}
      {["HOST_APPROVED", "ISSUED"].includes(status) && (
        <button type="button" className="secondary" disabled={busy || !live} onClick={issueLink}>
          {status === "ISSUED" ? "Replace demo link" : "Create demo link"}
        </button>
      )}
      {demoLink && (
        <>
          <label className="field-label">
            Temporary same-tab demo link
            <input ref={linkInput} type="url" readOnly value={demoLink} />
          </label>
          <p className="microcopy">
            Keep the demo in this tab. Use the guest preview to try the link and
            waiting room without contacting anyone. This link expires in{" "}
            {fmtTime((invite.expiresAt - now) / 1000)}.
          </p>
          <div className="button-row">
            <button type="button" className="secondary" onClick={copyLink}>
              Copy demo link
            </button>
            <a
              className="text-btn"
              href={demoLink}
              aria-disabled={busy || !live}
              onClick={openGuest}
            >
              Open guest preview
            </a>
          </div>
          {copyNotice && <p className="microcopy" role="status">{copyNotice}</p>}
        </>
      )}
      {status === "GUEST_OPENED" && (
        <>
          <p>
            Guest preview for adults 18 and older. Join the existing
            session at no additional cost. Keep the conversation platonic,
            respectful and free of recording.
          </p>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />{" "}
            I am 18 or older and accept these demo terms.
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy || !live || !consent}
            onClick={() => run("invite-guest-consent", { adult: true, terms: true })}
          >
            Guest: Enter waiting room
          </button>
        </>
      )}
      {status === "GUEST_WAITING" && (
        <div className="button-row">
          {control("Customer: Admit guest", "invite-admit")}
          {control("Customer: Decline admission", "invite-customer-decline", { allowPaused: true })}
        </div>
      )}
      {status === "GUEST_ADMITTED" && control("Guest: Enter demo room", "invite-guest-join")}
      {guestRoom.includes(status) && (
        <>
          {status === "GUEST_CONNECTED" ? (
            <div className="button-row" role="group" aria-label="Guest demo controls">
              <button type="button" className="secondary" aria-pressed={micOff} onClick={() => setMicOff(!micOff)}>
                Demo guest mic off
              </button>
              {booking.format === "video" && (
                <button type="button" className="secondary" aria-pressed={cameraOff} onClick={() => setCameraOff(!cameraOff)}>
                  Demo guest camera off
                </button>
              )}
              {control("Test guest disconnect", "invite-guest-disconnect")}
            </div>
          ) : control("Reconnect demo guest", "invite-guest-reconnect")}
          <div className="button-row">
            {control("Guest: Leave", "invite-guest-leave", { allowPaused: true })}
            {control("Customer: Remove guest", "invite-remove", { allowPaused: true })}
          </div>
          <details>
            <summary>Guest safety report</summary>
            <p>Use fictional details. The report stays in this demo workspace.</p>
            <label className="field-label">
              Your concern
              <textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} />
            </label>
            <button
              type="button"
              className="secondary"
              disabled={busy || !reason.trim()}
              onClick={async () => {
                if (await run("invite-guest-report", { reason }, "Demo guest report saved."))
                  setReason("");
              }}
            >
              Save demo guest report
            </button>
          </details>
        </>
      )}
      <div className="button-row">
        {pending.includes(status) && control("Customer: Cancel invitation", "invite-cancel", { allowPaused: true })}
        {(pending.includes(status) && status !== "HOST_PENDING" || guestRoom.includes(status)) &&
          control("Host: Withdraw approval", "invite-host-withdraw", { allowPaused: true })}
      </div>
    </section>
  );
}
