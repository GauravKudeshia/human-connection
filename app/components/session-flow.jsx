"use client";
import React, { useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Heart,
  Star,
  Receipt,
  Radio,
  CheckCircle2,
  Video,
  VideoOff,
  Headphones,
  Mic,
  MicOff,
  PhoneOff,
  RefreshCw,
  Flag,
} from "lucide-react";
import { hosts, money, styleName } from "../../lib/catalog.mjs";
import { isTerminal } from "../../lib/demo-policy.mjs";
import { hostPhoto } from "../../lib/presentation.mjs";
import { expName, human, fmtTime } from "./shared";
import ActivityPanel from "./activity-panel";

function ReviewAndTip({ b, now, busy, act, navigate }) {
  const [rating, setRating] = useState(b.rating || 0),
    [review, setReview] = useState(b.review || ""),
    [tip, setTip] = useState(null),
    [custom, setCustom] = useState("");
  const tipCents = tip === "custom" ? Math.round(Number(custom) * 100) : tip;
  const validTip =
    Number.isInteger(tipCents) && tipCents >= 100 && tipCents <= 5000;
  const expired = now - b.endedAt >= 86400000;
  return (
    <>
      <section className="review-panel">
        <h2>{b.rating ? "Your demo host review" : "Try a host review"}</h2>
        <p>
          This completed simulation can receive a demo rating. It is not a
          verified review of a real host.
        </p>
        <div className="stars" role="group" aria-label="Demo host rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              aria-label={`Rate ${n} star${n > 1 ? "s" : ""}`}
              aria-pressed={rating === n}
              onClick={() => setRating(n)}
            >
              <Star fill={n <= rating ? "currentColor" : "none"} size={28} />
            </button>
          ))}
        </div>
        <label className="field-label">
          Optional demo review
          <textarea
            placeholder="Use fictional feedback only."
            maxLength={1000}
            value={review}
            onChange={(e) => setReview(e.target.value)}
          />
        </label>
        <button
          className="secondary"
          disabled={!rating || busy}
          onClick={() =>
            act(
              "rate",
              { bookingId: b.id, rating, review },
              "Your demo review is saved.",
            )
          }
        >
          {b.rating ? "Update demo review" : "Save demo review"}
        </button>
      </section>
      <section className="tip-panel">
        <div className="tip-heading">
          <Heart size={24} />
          <div>
            <h2>A little extra thank you?</h2>
            <p>
              Always optional. The demo credits 100% of tip principal to the
              host.
            </p>
          </div>
        </div>
        {b.tipCents ? (
          <p className="notice success">
            <CheckCircle2 size={18} />
            {money(b.tipCents)} demo tip{" "}
            {b.tipRefunded ? "fully refunded" : "confirmed"}. No real payment.
          </p>
        ) : b.payment === "SIMULATED_REFUNDED" ? (
          <p className="notice">
            This demo payment was refunded. Tipping is unavailable.
          </p>
        ) : expired ? (
          <p className="notice">The 24-hour demo tipping window has ended.</p>
        ) : (
          <>
            <div
              className="tip-options"
              role="group"
              aria-label="Optional demo tip"
            >
              {[200, 500, 1000].map((c) => (
                <button
                  key={c}
                  className={tip === c ? "chosen" : ""}
                  aria-pressed={tip === c}
                  onClick={() => setTip(c)}
                >
                  {money(c)}
                </button>
              ))}
              <button
                className={tip === "custom" ? "chosen" : ""}
                aria-pressed={tip === "custom"}
                onClick={() => setTip("custom")}
              >
                Custom
              </button>
            </div>
            {tip === "custom" && (
              <label className="field-label">
                Custom tip ($1–$50)
                <input
                  type="number"
                  min="1"
                  max="50"
                  step="0.01"
                  inputMode="decimal"
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="5.00"
                />
                {custom && !validTip && (
                  <span className="inline-error">
                    Enter an amount from $1 to $50.
                  </span>
                )}
              </label>
            )}
            <div className="tip-actions">
              <button className="secondary" onClick={() => navigate("history")}>
                No thanks
              </button>
              <button
                className="primary"
                disabled={!validTip || busy}
                onClick={() =>
                  act(
                    "tip",
                    { bookingId: b.id, cents: tipCents },
                    "Demo tip confirmed. No real charge.",
                  )
                }
              >
                Confirm {validTip ? money(tipCents) : ""} demo tip
              </button>
            </div>
          </>
        )}
        <p className="microcopy">
          Nothing is selected or charged automatically.
        </p>
      </section>
    </>
  );
}
function FailureFeedback({ b, s, busy, act }) {
  const existing = s.feedback?.find((f) => f.bookingId === b.id);
  const [text, setText] = useState(existing?.text || "");
  return (
    <section className="review-panel">
      <h2>Something didn’t go to plan?</h2>
      <p>
        This session wasn’t fully delivered. Service feedback stays separate
        from host ratings and refund feedback.
      </p>
      <label className="field-label">
        Demo service-failure feedback
        <textarea
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Use fictional details only."
        />
      </label>
      <button
        className="secondary"
        disabled={busy || !text.trim()}
        onClick={() =>
          act(
            "service-feedback",
            { bookingId: b.id, text },
            "Service feedback saved separately from host ratings.",
          )
        }
      >
        Save service feedback
      </button>
    </section>
  );
}
export default function SessionFlow({
  b,
  s,
  now,
  busy,
  act,
  setModal,
  navigate,
}) {
  const h = hosts.find((h) => h.id === b.hostId),
    complete = b.status === "COMPLETED";
  const [muted, setMuted] = useState(false);
  if (["LIVE", "RECONNECTING"].includes(b.status))
    return (
      <section className="call-page">
        <div className="call-heading">
          <span className="eyebrow">
            {expName(b.experience)} · {styleName(b.style)}
          </span>
          <span className="call-timer" aria-label="Demo time remaining">
            <Clock size={17} />
            {fmtTime((b.deadline - now) / 1000)}
          </span>
        </div>
        <div className="demo-notice">
          <Radio size={18} />
          <span>
            Simulated room. No person is connected. Camera and microphone stay
            off; nothing is recorded.
          </span>
        </div>
        <div className="room-grid">
          <div className="room-main">
            <div className="room-placeholder">
              <span className="room-orbit">
                <MessageIcon />
              </span>
              <span className="eyebrow">A PLACE FOR HUMAN CONVERSATION</span>
              <h1>
                {b.status === "RECONNECTING"
                  ? "A pause, not a new clock."
                  : "Your conversation. Your pace."}
              </h1>
              <p>
                {b.status === "RECONNECTING"
                  ? "Try reconnecting below. The original deadline stays in place. Interrupted delivery goes to refund review."
                  : "In the live service, you and a real host would meet here. For now, explore the controls and optional activity cards."}
              </p>
              <span className="room-label">
                <VideoOff size={16} />
                Demo room · no live participants
              </span>
            </div>
            <div className="room-person">
              <img src={hostPhoto(h.id)} alt="" />
              <div>
                <strong>{h.name} · fictional profile</strong>
                <span>
                  {b.duration} min · {human(b.format)} ·{" "}
                  {b.language || "English"}
                </span>
              </div>
              <button
                className="text-btn"
                onClick={() =>
                  setModal({ type: "report", host: h, booking: b })
                }
              >
                <Flag size={16} />
                Report
              </button>
              <button
                className="text-btn"
                disabled={busy}
                onClick={() =>
                  act(
                    "block",
                    { hostId: h.id },
                    "Host blocked and demo session ended.",
                  )
                }
              >
                Block
              </button>
            </div>
            <div className="call-controls">
              <button
                className={`control ${muted ? "off" : ""}`}
                aria-pressed={muted}
                onClick={() => setMuted(!muted)}
              >
                {muted ? <MicOff /> : <Mic />}
                <span>{muted ? "Unmute" : "Mute"} demo</span>
              </button>
              <button
                className="control danger"
                disabled={busy}
                onClick={() => act("leave", { bookingId: b.id })}
              >
                <PhoneOff />
                <span>Leave now</span>
              </button>
              <button
                className="control"
                disabled={busy}
                onClick={() =>
                  act(
                    b.status === "RECONNECTING" ? "reconnect" : "disconnect",
                    { bookingId: b.id },
                  )
                }
              >
                <RefreshCw />
                <span>
                  {b.status === "RECONNECTING" ? "Reconnect" : "Test reconnect"}
                </span>
              </button>
            </div>
            <p className="microcopy">
              Mute is a UI demonstration; no microphone is active.
            </p>
            <div className="demo-call-end">
              <p>Ready to explore what comes after?</p>
              <button
                className="secondary"
                disabled={busy || b.status !== "LIVE"}
                onClick={() => act("complete-demo", { bookingId: b.id })}
              >
                Finish demo session <ArrowRight size={17} />
              </button>
            </div>
          </div>
          <ActivityPanel booking={b} act={act} busy={busy} />
        </div>
      </section>
    );
  if (isTerminal(b.status))
    return (
      <section className="post-session">
        <span className="post-icon">
          <Heart size={30} />
        </span>
        <span className="eyebrow">
          {complete
            ? "THE NEXT PART OF THE DEMO"
            : "YOUR DEMO SESSION HAS ENDED"}
        </span>
        <h1>{complete ? "That’s a wrap on the demo." : human(b.status)}</h1>
        <p>
          {b.customerMessage ||
            (complete
              ? "Try a review, an optional tip, or another moment. No real conversation or payment took place."
              : "You’re out of the room. Your session details and any refund review are below.")}
        </p>
        {complete ? (
          <ReviewAndTip
            b={b}
            now={now}
            busy={busy}
            act={act}
            navigate={navigate}
          />
        ) : (
          <FailureFeedback b={b} s={s} busy={busy} act={act} />
        )}
        <div className="post-actions">
          <button
            className="secondary"
            onClick={() => setModal({ type: "receipt", booking: b })}
          >
            <Receipt size={17} />
            Receipt & refunds
          </button>
          <button
            className="secondary"
            aria-pressed={s.favorites.includes(h.id)}
            disabled={busy || s.blocks.includes(h.id)}
            onClick={() => act("favorite", { hostId: h.id })}
          >
            <Heart size={17} />
            {s.favorites.includes(h.id) ? "Saved host" : "Save host"}
          </button>
          <button
            className="primary"
            onClick={() =>
              setModal({ type: "profile", host: h, preferences: b })
            }
          >
            Rebook {h.name} <ArrowRight size={17} />
          </button>
        </div>
        <button className="text-btn roomy" onClick={() => navigate("discover")}>
          Find another moment
        </button>
      </section>
    );
  const requested = b.status === "HOST_REQUESTED",
    accepted = b.status === "HOST_ACCEPTED",
    deadline = b.status === "READY" ? b.joinDeadlineAt : b.expiresAt;
  return (
    <section className="booking-page">
      <button className="text-btn" onClick={() => navigate("moment")}>
        <ArrowLeft size={17} />
        Back to your choices
      </button>
      <div className="booking-intro">
        <span className="eyebrow">
          {b.matchedByDemo ? "YOUR FICTIONAL MATCH" : "YOUR NEXT DEMO MOMENT"}
        </span>
        <h1>
          {requested
            ? `A moment with ${h.name}.`
            : accepted
              ? "Your demo host has confirmed."
              : "A little space, ready for you."}
        </h1>
        <p>
          {requested
            ? "Try the host-confirmation step below. Nothing is charged before acceptance."
            : accepted
              ? "Review your choices and the exact demo total."
              : "Enter before the join window ends. If you don’t, your demo payment is fully reversed."}
        </p>
      </div>
      <div className="booking-grid">
        <div className="booking-person">
          <img src={hostPhoto(h.id)} alt={`${h.name}, fictional demo host`} />
          <h2>{h.name}</h2>
          <p>{h.headline}</p>
          <div className="tags">
            {h.tags.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          {b.matchReason && (
            <div className="match-explanation">
              <strong>Why this demo match?</strong>
              <p>{b.matchReason}</p>
            </div>
          )}
          <span className="demo-caption">
            Fictional profile. Availability and matching exist only in your
            workspace.
          </span>
        </div>
        <div className="checkout-card">
          <h2>Your moment</h2>
          <dl>
            {[
              ["Experience", expName(b.experience)],
              ["Style", styleName(b.style)],
              ["Duration", `${b.duration} minutes`],
              ["Format", human(b.format)],
              ["Language", b.language || "English"],
              ["Demo taxes & fees", "$0"],
              ["Demo total", money(b.totalCents)],
            ].map(([label, value]) => (
              <div
                key={label}
                className={label === "Demo total" ? "total" : ""}
              >
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="reservation-clock">
            <Clock size={17} />
            {requested
              ? "Host response"
              : accepted
                ? "Checkout hold"
                : "Join window"}
            : {fmtTime((deadline - now) / 1000)}
          </p>
          {requested ? (
            <>
              <div className="notice">
                No host receives this request. You control the fictional
                response.
              </div>
              <button
                className="primary full"
                disabled={busy || deadline <= now}
                onClick={() => act("accept", { bookingId: b.id })}
              >
                Simulate host acceptance <ArrowRight size={17} />
              </button>
              <button
                className="secondary full"
                disabled={busy || deadline <= now}
                onClick={() => act("decline", { bookingId: b.id })}
              >
                Simulate decline
              </button>
            </>
          ) : accepted ? (
            <>
              <p className="policy-note">
                Demo policy 1.3: cancel before joining for a full reversal.
                After checkout, you have three minutes to join. If that window
                expires, the host is released and the demo payment is fully
                reversed. Early exits and service failures go to review.
              </p>
              <button
                className="primary full"
                disabled={busy || deadline <= now}
                onClick={() => act("checkout", { bookingId: b.id })}
              >
                Confirm {money(b.totalCents)} demo checkout
              </button>
              <p className="microcopy">
                No card, real charge or automatic tip.
              </p>
            </>
          ) : (
            <>
              <div className="notice success">
                <CheckCircle2 size={18} />
                Demo payment confirmed.
              </div>
              <button
                className="primary full"
                disabled={busy || deadline <= now}
                onClick={() => act("join", { bookingId: b.id })}
              >
                {b.format === "video" ? (
                  <Video size={18} />
                ) : (
                  <Headphones size={18} />
                )}
                Enter simulated room
              </button>
              <p className="microcopy">
                No live host. Camera and microphone stay off.
              </p>
            </>
          )}
          {deadline <= now && (
            <p role="status" className="inline-error">
              This window has ended. The server or local demo will apply the
              expiry before any action.
            </p>
          )}
          <button
            className="text-btn cancel-request"
            disabled={busy}
            onClick={() =>
              act("cancel", { bookingId: b.id }, "Demo request cancelled.")
            }
          >
            Cancel{" "}
            {b.status === "READY" ? "and reverse demo payment" : "request"}
          </button>
        </div>
      </div>
      {b.status === "READY" && (
        <div className="preparation">
          <ActivityPanel booking={b} act={act} busy={busy} />
        </div>
      )}
    </section>
  );
}
function MessageIcon() {
  return <span aria-hidden="true">“</span>;
}
