"use client";

import React, { useState } from "react";
import { useResource } from "./beta-panels";

const descriptions = {
  HOST_PENDING: "Waiting for the host’s approval.",
  HOST_APPROVED: "The host approved one guest. You can create a link now.",
  HOST_DECLINED: "The host declined the request.",
  ISSUED: "The invitation is ready. Share it privately with one friend.",
  GUEST_WAITING: "A guest is waiting. Confirm it’s your intended friend before admitting them.",
  GUEST_ADMITTED: "The guest was admitted to the simulated guest experience.",
  CUSTOMER_DECLINED: "Admission was declined.",
  REVOKED: "This invitation was cancelled.",
  GUEST_REMOVED: "The guest was removed.",
  GUEST_LEFT: "The guest left.",
  EXPIRED: "The invitation expired.",
  SESSION_ENDED: "The session ended and the guest invitation closed.",
};

export default function BetaInvite({ api, run, busy, booking, customer, revision }) {
  const { data, error, loading } = useResource(
    api,
    "guest-invitation",
    booking.id,
    revision,
    undefined,
    3000,
  );
  const [issuedLink, setIssuedLink] = useState(null);
  const [copyMessage, setCopyMessage] = useState("");
  const status = data?.status;
  const link = status === "ISSUED" && issuedLink?.bookingId === booking.id ? issuedLink.url : "";

  async function act(action) {
    const result = await run("guest-invite-" + action, { bookingId: booking.id });
    if (!result) return;
    setCopyMessage("");
    if (result.invitationToken) {
      const url = new URL("/beta/guest", location.origin);
      url.hash = new URLSearchParams({ invite: result.invitationToken }).toString();
      setIssuedLink({ bookingId: booking.id, url: url.href });
    } else if (["cancel", "remove", "decline", "withdraw"].includes(action)) {
      setIssuedLink(null);
    }
  }

  const controls = [];
  if (customer) {
    if (status === "NOT_REQUESTED")
      controls.push(["request", "Ask the host to invite a friend"]);
    if (status === "HOST_APPROVED")
      controls.push(["issue", "Create guest link"]);
    if (status === "ISSUED" && !link)
      controls.push(["issue", "Recover or replace unused link"]);
    if (status === "GUEST_WAITING") {
      controls.push(["admit", "Admit guest"], ["decline", "Decline admission"]);
    }
  } else if (status === "HOST_PENDING") {
    controls.push(["host-approve", "Approve invitation"], ["host-decline", "Decline invitation"]);
  }
  if (customer && status === "GUEST_ADMITTED")
    controls.push(["remove", "Remove guest"]);
  if (customer && ["HOST_PENDING", "HOST_APPROVED", "ISSUED", "GUEST_WAITING"].includes(status))
    controls.push(["cancel", "Cancel invitation"]);
  if (!customer && ["HOST_APPROVED", "ISSUED", "GUEST_WAITING", "GUEST_ADMITTED"].includes(status))
    controls.push(["withdraw", "Withdraw invitation"]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopyMessage("Guest link copied.");
    } catch {
      setCopyMessage("Select the link field to copy the link manually.");
    }
  }

  return (
    <section className="beta-card">
      <h2>Invite a friend</h2>
      <p>One guest. Your current price and session timer stay the same.</p>
      <p className="beta-small">The sandbox tests consent and waiting-room admission. Guest audio and video are disabled.</p>
      {loading && <p>Checking invitation status…</p>}
      {error && <p role="alert">{error}</p>}
      <p role="status">{descriptions[status]}</p>
      <div className="beta-actions">
        {controls.map(([action, label]) => (
          <button key={action} className="beta-secondary" disabled={busy} onClick={() => act(action)}>
            {label}
          </button>
        ))}
      </div>
      {customer && status === "ISSUED" && (
        link ? (
          <>
            <label>
              Guest link
              <input readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <div className="beta-actions">
              <a className="beta-primary" href={"sms:?body=" + encodeURIComponent(link)}>Text Message</a>
              <a className="beta-secondary" href={"mailto:?subject=Human%20Connection%20guest%20invitation&body=" + encodeURIComponent(link)}>Email</a>
              <button className="beta-secondary" onClick={copy}>Copy link</button>
            </div>
            <p role="status">{copyMessage}</p>
          </>
        ) : (
          <p className="beta-small">Use your saved link or replace it before your guest arrives.</p>
        )
      )}
    </section>
  );
}
