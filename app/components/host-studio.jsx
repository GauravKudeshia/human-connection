"use client";
import React, { useState } from "react";
import { Plus, Lock } from "lucide-react";
import { hosts, money } from "../../lib/catalog.mjs";
import { hostPhoto } from "../../lib/presentation.mjs";
import { PageHeading, expName, human, fmtTime, SignIn } from "./shared";
export default function HostStudio({ s, now, act, busy, setModal }) {
  const [hostId, setHostId] = useState("maya");
  const h = hosts.find((h) => h.id === hostId);
  const bookings = s?.bookings.filter((b) => b.hostId === hostId) || [];
  return (
    <>
      <PageHeading
        eyebrow="FICTIONAL ROLE PREVIEW"
        title="Good company starts with you."
      >
        Try a host’s requests, availability and earnings in this demo workspace.
      </PageHeading>
      <div className="portal-toolbar">
        <label className="field-label">
          Demo host
          <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary"
          onClick={() => setModal({ type: "apply" })}
        >
          <Plus size={17} />
          Try host application
        </button>
      </div>
      {!s ? (
        <SignIn />
      ) : (
        <>
          <div className="host-studio-profile">
            <img src={hostPhoto(hostId)} alt="" />
            <div>
              <h2>{h.name}’s studio</h2>
              <p>
                Fictional profile · no identity verification or payout account
              </p>
            </div>
            <button
              className={`toggle ${s.hostOnline[hostId] ? "on" : ""}`}
              role="switch"
              aria-label={`${h.name} demo availability`}
              aria-checked={s.hostOnline[hostId]}
              disabled={busy}
              onClick={() =>
                act("presence", { hostId, online: !s.hostOnline[hostId] })
              }
            >
              <span />
              {s.hostOnline[hostId] ? "Available" : "Offline"}
            </button>
          </div>
          <div className="stats-grid">
            {[
              [
                "Demo completions",
                bookings.filter((b) => b.status === "COMPLETED").length,
              ],
              [
                "Net base earnings",
                money(
                  bookings
                    .filter(
                      (b) =>
                        b.status === "COMPLETED" &&
                        b.payment === "SIMULATED_SUCCEEDED",
                    )
                    .reduce((a, b) => a + Math.round(b.totalCents * 0.7), 0),
                ),
              ],
              [
                "Net tips · 100% principal",
                money(
                  bookings
                    .filter((b) => !b.tipRefunded)
                    .reduce((a, b) => a + (b.tipCents || 0), 0),
                ),
              ],
              ["Transferred", "$0"],
            ].map(([label, value]) => (
              <div className="stat" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small>Simulated activity only</small>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Incoming demo requests</h2>
            {bookings
              .filter((b) => b.status === "HOST_REQUESTED")
              .map((b) => (
                <div className="request-row" key={b.id}>
                  <span>
                    {expName(b.experience)} · {b.duration} min ·{" "}
                    {human(b.format)}
                    <small>
                      Expires in {fmtTime((b.expiresAt - now) / 1000)}
                    </small>
                  </span>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        "decline",
                        { bookingId: b.id },
                        "Demo request declined.",
                      )
                    }
                  >
                    Decline
                  </button>
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        "accept",
                        { bookingId: b.id },
                        "Demo request accepted.",
                      )
                    }
                  >
                    Accept
                  </button>
                </div>
              ))}
            {!bookings.some((b) => b.status === "HOST_REQUESTED") && (
              <p className="muted roomy">
                No pending requests. This toggle controls only your fictional
                workspace.
              </p>
            )}
          </div>
          <div className="notice">
            <Lock size={18} />
            <span>
              Training, verification and payout readiness are not implemented.
              No application grants real host access. All role previews are
              available to this workspace’s owner.
            </span>
          </div>
        </>
      )}
    </>
  );
}
