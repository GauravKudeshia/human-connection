"use client";
import React, { useEffect, useRef, useState } from "react";
import { activities, activityRounds } from "../../lib/activities.mjs";
import { experiences } from "../../lib/catalog.mjs";
import { human, money } from "./beta-api.mjs";
import { useResource } from "./beta-panels";

export default function BetaSession({
  api,
  run,
  busy,
  me,
  bookingId,
  revision,
  onBack,
  onRepeat,
  onOpen,
  publicConfig,
}) {
  const {
    data: booking,
    error,
    loading,
  } = useResource(api, "booking", bookingId, revision);
  const { data: receipt, error: receiptError } = useResource(
    api,
    "receipt",
    bookingId,
    revision,
  );
  const [payment, setPayment] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState("conduct");
  const [urgent, setUrgent] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [rating, setRating] = useState("");
  const [worth, setWorth] = useState("");
  const [tip, setTip] = useState("");
  const [showRefund, setShowRefund] = useState(false);
  const [refundReason, setRefundReason] = useState("");
  const quote =
    typeof booking?.quote === "string"
      ? JSON.parse(booking.quote)
      : booking?.quote;
  const customer = booking?.customer_id === me.id;
  const terminal =
    booking &&
    [
      "COMPLETED",
      "CANCELLED",
      "DECLINED",
      "EXPIRED",
      "SAFETY_ENDED",
      "PARTIAL_DELIVERY",
      "FAILED_SERVICE",
    ].includes(booking.status);
  const completed = booking?.status === "COMPLETED";
  async function checkout() {
    const result = await run("checkout", { bookingId });
    if (result?.clientSecret) setPayment({ ...result, purpose: "base" });
  }
  async function submitTip() {
    const cents = Math.round(Number(tip) * 100);
    const result = await run("tip", { bookingId, cents });
    if (result?.clientSecret) setPayment({ ...result, purpose: "tip" });
  }
  return (
    <section>
      <button className="beta-text" onClick={onBack}>
        ← Back to your workspace
      </button>
      {loading && !booking && (
        <p className="beta-card">Loading your session…</p>
      )}
      {error && (
        <p className="beta-alert" role="alert">
          {error}
        </p>
      )}
      {booking && (
        <>
          <div className="beta-session-heading">
            <div>
              <p className="beta-eyebrow">{human(booking.status)}</p>
              <h1>
                {
                  experiences.find((item) => item.id === booking.experience)
                    ?.name
                }
              </h1>
              <p>
                {booking.duration} minutes · {human(booking.format)} ·{" "}
                {booking.language}
              </p>
            </div>
            <span className="beta-session-price">
              {money(booking.amount_cents)}
            </span>
          </div>
          {booking.status === "REQUESTED" && (
            <div className="beta-card">
              <h2>
                {customer
                  ? "Your host has your request."
                  : "A guest is waiting for your answer."}
              </h2>
              <p>
                A request expires automatically. Checkout opens after the host
                accepts.
              </p>
              {customer ? (
                <button
                  className="beta-secondary"
                  disabled={busy}
                  onClick={() =>
                    run("cancel", { bookingId }, "Request cancelled.")
                  }
                >
                  Cancel request
                </button>
              ) : (
                <div className="beta-actions">
                  <button
                    className="beta-primary"
                    disabled={busy}
                    onClick={() =>
                      run("accept", { bookingId }, "Request accepted.")
                    }
                  >
                    Accept request
                  </button>
                  <button
                    className="beta-secondary"
                    disabled={busy}
                    onClick={() =>
                      run("decline", { bookingId }, "Request declined.")
                    }
                  >
                    Decline request
                  </button>
                </div>
              )}
            </div>
          )}
          {booking.status === "ACCEPTED" && (
            <div className="beta-card">
              <h2>
                {customer
                  ? "Your moment is reserved."
                  : "Your guest is reviewing checkout."}
              </h2>
              <p>
                Reservation ends{" "}
                {new Date(booking.expires_at).toLocaleTimeString()}.
              </p>
              {quote && (
                <dl className="beta-quote">
                  <div>
                    <dt>Experience</dt>
                    <dd>
                      {
                        experiences.find((item) => item.id === quote.experience)
                          ?.name
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Base price</dt>
                    <dd>{money(quote.baseCents)}</dd>
                  </div>
                  <div>
                    <dt>Discount</dt>
                    <dd>{money(quote.discountCents)}</dd>
                  </div>
                  <div>
                    <dt>Tax</dt>
                    <dd>
                      {quote.taxStatus === "not-configured"
                        ? "Sandbox tax policy awaiting configuration"
                        : money(quote.taxCents)}
                    </dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>
                      {money(quote.totalCents)} {quote.currency}
                    </dd>
                  </div>
                </dl>
              )}
              {customer && (
                <>
                  <button
                    className="beta-primary"
                    disabled={busy}
                    onClick={checkout}
                  >
                    Open sandbox checkout
                  </button>
                  <p className="beta-small">
                    Payment is handled by the configured processor. The session
                    becomes ready after the server verifies payment. Tips are
                    optional after delivery.
                  </p>
                </>
              )}
              <button
                className="beta-text"
                disabled={busy}
                onClick={() =>
                  run("cancel", { bookingId }, "Reservation cancelled.")
                }
              >
                Cancel reservation
              </button>
            </div>
          )}
          {payment &&
            (payment.purpose === "tip" || booking.status === "ACCEPTED") && (
              <PaymentForm
                payment={payment}
                publishableKey={
                  payment.publishableKey || publicConfig?.stripePublishableKey
                }
                bookingId={bookingId}
                onClose={() => setPayment(null)}
              />
            )}
          {["READY", "LIVE"].includes(booking.status) && (
            <MediaSession
              api={api}
              run={run}
              busy={busy}
              booking={booking}
              me={me}
              revision={revision}
            />
          )}
          {terminal && (
            <div className="beta-card">
              <h2>
                {completed
                  ? "Thank you for making time."
                  : "This session has ended."}
              </h2>
              <p>
                {completed
                  ? "Your completed experience is ready for feedback."
                  : "Your receipt and support options remain available below. Interrupted or undelivered sessions are reviewed separately from host ratings."}
              </p>
              <div className="beta-actions">
                <button
                  className="beta-primary"
                  onClick={() => onRepeat({ ...booking, quote })}
                >
                  Repeat this experience
                </button>
                {customer && (
                  <>
                    <button
                      className="beta-secondary"
                      disabled={busy}
                      onClick={async () => {
                        const result = await run("reserve", {
                          hostId: booking.host_id,
                          experience: booking.experience,
                          style: quote?.style || null,
                          duration: booking.duration,
                          format: booking.format,
                          language: booking.language,
                        });
                        if (result?.booking) onOpen(result.booking);
                      }}
                    >
                      Request this host again
                    </button>
                    <button
                      className="beta-secondary"
                      disabled={busy}
                      onClick={() =>
                        run(
                          "favourite",
                          { hostId: booking.host_id, saved: true },
                          "Host saved.",
                        )
                      }
                    >
                      Save host
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
          {customer && completed && (
            <>
              <form
                className="beta-card"
                onSubmit={(event) => {
                  event.preventDefault();
                  run(
                    "review",
                    {
                      bookingId,
                      ...(rating ? { rating: Number(rating) } : {}),
                      ...(worth ? { worthIt: worth === "yes" } : {}),
                      ...(feedback.trim() ? { privateFeedback: feedback } : {}),
                    },
                    "Your session feedback is saved.",
                  );
                }}
              >
                <h2>How was your experience?</h2>
                <div className="beta-form-grid">
                  <label>
                    Public session rating
                    <select
                      value={rating}
                      onChange={(event) => setRating(event.target.value)}
                    >
                      <option value="">Skip public rating</option>
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n} {n === 1 ? "star" : "stars"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Was this experience worth what you paid?
                    <select
                      value={worth}
                      onChange={(event) => setWorth(event.target.value)}
                    >
                      <option value="">Skip this question</option>
                      <option value="yes">Yes</option>
                      <option value="no">No</option>
                    </select>
                  </label>
                </div>
                <label>
                  Private quality feedback
                  <textarea
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                    maxLength={1000}
                  />
                </label>
                <p className="beta-small">
                  Private quality feedback and the value answer are stored
                  separately from your public rating. Use Report for safety
                  concerns.
                </p>
                <button
                  className="beta-primary"
                  disabled={busy || (!rating && !worth && !feedback.trim())}
                >
                  Save feedback
                </button>
              </form>
              <div className="beta-card">
                <h2>An optional thank you</h2>
                <label>
                  Tip in USD
                  <input
                    type="number"
                    value={tip}
                    onChange={(event) => setTip(event.target.value)}
                    min="1"
                    max="100"
                    step="0.01"
                  />
                </label>
                <button
                  className="beta-secondary"
                  disabled={
                    busy || !tip || Number(tip) < 1 || Number(tip) > 100
                  }
                  onClick={submitTip}
                >
                  Open optional tip checkout
                </button>
                <p className="beta-small">
                  No tip is selected or charged automatically. Tip principal is
                  allocated to the host. Processing costs are recorded
                  separately.
                </p>
              </div>
            </>
          )}
          <section className="beta-card">
            <h2>Receipt and support</h2>
            {receiptError && <p>{receiptError}</p>}
            {receipt && <Receipt receipt={receipt} />}
            <div className="beta-actions">
              {customer && terminal && (
                <button
                  className="beta-secondary"
                  disabled={busy}
                  onClick={() => setShowRefund(!showRefund)}
                >
                  Request refund review
                </button>
              )}
              <button
                className="beta-secondary"
                onClick={() => setReporting(!reporting)}
              >
                Report a concern
              </button>
              <button
                className="beta-text"
                disabled={busy}
                onClick={() =>
                  run(
                    "block",
                    {
                      userId: customer ? booking.host_id : booking.customer_id,
                    },
                    "This account is blocked from future matching.",
                  )
                }
              >
                Block future matching
              </button>
            </div>
            {showRefund && (
              <form
                className="beta-report"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    await run(
                      "refund-request",
                      { bookingId, reason: refundReason },
                      "Your refund request is awaiting review.",
                    )
                  ) {
                    setShowRefund(false);
                    setRefundReason("");
                  }
                }}
              >
                <label>
                  Why are you requesting a refund review?
                  <textarea
                    value={refundReason}
                    onChange={(event) => setRefundReason(event.target.value)}
                    maxLength={2000}
                    required
                  />
                </label>
                <button
                  className="beta-secondary"
                  disabled={busy || !refundReason.trim()}
                >
                  Submit refund request
                </button>
              </form>
            )}
            {reporting && (
              <form
                className="beta-report"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (
                    await run(
                      "report",
                      { bookingId, category, reason, urgent },
                      "Your report is recorded.",
                    )
                  ) {
                    setReporting(false);
                    setReason("");
                  }
                }}
              >
                <p className="beta-small">
                  Reports are stored in this staging workspace. Operator
                  response depends on configured alert delivery and staffed
                  coverage.
                </p>
                <label>
                  Concern category
                  <select
                    value={category}
                    onChange={(event) => setCategory(event.target.value)}
                  >
                    {[
                      "conduct",
                      "harassment",
                      "scam",
                      "boundaries",
                      "other",
                    ].map((item) => (
                      <option key={item} value={item}>
                        {human(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  What happened?
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={2000}
                    required
                  />
                </label>
                <label className="beta-checkbox">
                  <input
                    type="checkbox"
                    checked={urgent}
                    onChange={(event) => setUrgent(event.target.checked)}
                  />
                  <span>Mark urgent and end any active session.</span>
                </label>
                <button
                  className="beta-primary"
                  disabled={busy || !reason.trim()}
                >
                  Submit report
                </button>
                <p className="beta-small">
                  Use local emergency services for immediate danger. Hosts
                  provide ordinary conversation and entertainment.
                </p>
              </form>
            )}
          </section>
        </>
      )}
    </section>
  );
}
function Receipt({ receipt }) {
  const totals = receipt.receipt || receipt;
  return (
    <dl className="beta-quote">
      <div>
        <dt>Base charge</dt>
        <dd>
          {money(totals.baseCharge ?? totals.baseCents ?? totals.amount_cents)}
        </dd>
      </div>
      <div>
        <dt>Tip</dt>
        <dd>{money(totals.tipCharge ?? totals.tipCents)}</dd>
      </div>
      <div>
        <dt>Refunded</dt>
        <dd>
          {money(
            (totals.baseRefund || totals.refundCents || 0) +
              (totals.tipRefund || 0),
          )}
        </dd>
      </div>
      <div>
        <dt>Net paid</dt>
        <dd>{money(totals.net ?? totals.netCents ?? 0)}</dd>
      </div>
    </dl>
  );
}
function MediaSession({ api, run, busy, booking, revision }) {
  const { data: session, error } = useResource(
    api,
    "session",
    booking.id,
    revision,
  );
  const [grant, setGrant] = useState(null);
  const [connection, setConnection] = useState("Ready to join");
  const [mediaError, setMediaError] = useState("");
  const [audioOff, setAudioOff] = useState(false);
  const [videoOff, setVideoOff] = useState(booking.format === "audio");
  const frameElement = useRef(null);
  const call = useRef(null);
  const runRef = useRef(run);
  useEffect(() => {
    runRef.current = run;
  }, [run]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!grant || !frameElement.current) return;
    let cancelled = false;
    async function join() {
      try {
        const { default: DailyIframe } = await import("@daily-co/daily-js");
        if (cancelled) return;
        const frame = DailyIframe.createFrame(frameElement.current, {
          showLeaveButton: true,
          iframeStyle: {
            width: "100%",
            height: "100%",
            border: "0",
            borderRadius: "16px",
          },
        });
        call.current = frame;
        frame.on("joining-meeting", () => {
          if (!cancelled) setConnection("Connecting");
        });
        frame.on("joined-meeting", () => {
          if (!cancelled) setConnection("Connected");
        });
        frame.on("left-meeting", () => {
          if (!cancelled) {
            setConnection("Disconnected");
            setGrant(null);
            void runRef.current(
              "end-session",
              { bookingId: booking.id },
              "You left the session.",
            );
          }
        });
        frame.on("network-connection", ({ event }) => {
          if (!cancelled)
            setConnection(
              event === "interrupted" ? "Reconnecting" : "Connected",
            );
        });
        frame.on("error", () => {
          if (!cancelled) {
            setConnection("Connection interrupted");
            setMediaError(
              "The room connection was interrupted. Try rejoining or end the session.",
            );
            setGrant(null);
          }
        });
        await frame.join({
          url: grant.roomUrl,
          token: grant.token,
          videoSource: booking.format !== "audio",
        });
      } catch {
        setMediaError(
          "The private room could not be opened. Check device permissions and try again.",
        );
        setGrant(null);
      }
    }
    void join();
    return () => {
      cancelled = true;
      if (call.current) {
        void call.current.destroy();
        call.current = null;
      }
    };
  }, [grant, booking.format, booking.id]);
  async function joinRoom() {
    setMediaError("");
    const result = await run("room-token", { bookingId: booking.id });
    if (result?.token && result.roomUrl) setGrant(result);
  }
  const seconds = session?.deadline
    ? Math.max(0, Math.ceil((session.deadline - now) / 1000))
    : null;
  const attended =
    session?.attendance?.filter((participant) => participant.present).length ||
    0;
  return (
    <section className="beta-card">
      <div className="beta-row-heading">
        <h2>Your private session</h2>
        <span className="beta-status" role="status">
          {connection}
          {seconds !== null
            ? " · " +
              Math.floor(seconds / 60) +
              ":" +
              String(seconds % 60).padStart(2, "0")
            : ""}
        </span>
      </div>
      {error && <p className="beta-alert">{error}</p>}
      {mediaError && (
        <p className="beta-alert" role="alert">
          {mediaError}
        </p>
      )}
      {!grant ? (
        <>
          <p>
            Join when you are ready. Camera and microphone permissions are
            requested by the private call provider.
          </p>
          <button className="beta-primary" disabled={busy} onClick={joinRoom}>
            Join private {booking.format} session
          </button>
        </>
      ) : (
        <div
          ref={frameElement}
          className="beta-video-frame"
          aria-label="Private call"
        />
      )}
      <p className="beta-small" role="status">
        {attended >= 2
          ? "Both participants have verified attendance."
          : "Waiting for server-verified participant attendance. Payment alone does not start delivered time."}
      </p>
      <div className="beta-actions">
        {grant && (
          <>
            <button
              className="beta-secondary"
              aria-pressed={audioOff}
              onClick={() => {
                const next = !audioOff;
                setAudioOff(next);
                void call.current?.setLocalAudio(!next);
              }}
            >
              {audioOff ? "Unmute microphone" : "Mute microphone"}
            </button>
            {booking.format === "video" && (
              <button
                className="beta-secondary"
                aria-pressed={videoOff}
                onClick={() => {
                  const next = !videoOff;
                  setVideoOff(next);
                  void call.current?.setLocalVideo(!next);
                }}
              >
                {videoOff ? "Turn camera on" : "Turn camera off"}
              </button>
            )}
          </>
        )}
        <button
          className="beta-danger"
          disabled={busy}
          onClick={() =>
            run(
              "end-session",
              { bookingId: booking.id },
              "Your session has ended.",
            )
          }
        >
          End session
        </button>
      </div>
      <SharedActivity
        api={api}
        run={run}
        busy={busy}
        booking={booking}
        revision={revision}
      />
    </section>
  );
}
function SharedActivity({ api, run, busy, booking, revision }) {
  const { data: state, error } = useResource(
    api,
    "activity",
    booking.id,
    revision,
  );
  const selected = activities.find((item) => item.id === state?.activity_id);
  const rounds = selected ? activityRounds(selected) : [];
  const round = rounds[state?.prompt_index || 0];
  const change = (operation, activityId) =>
    run("activity", {
      bookingId: booking.id,
      revision: state?.revision || 0,
      operation,
      ...(activityId ? { activityId } : {}),
    });
  if (booking.status !== "LIVE") return null;
  return (
    <section className="beta-shared-activity">
      <h3>A little shared detour</h3>
      <p className="beta-small">
        Both participants see the saved activity state. Participation is
        optional.
      </p>
      {error && <p className="beta-alert">{error}</p>}
      <div className="beta-activity-options">
        {activities
          .filter((item) => item.experience === booking.experience)
          .map((item) => (
            <button
              key={item.id}
              className="beta-secondary"
              disabled={busy}
              aria-pressed={state?.activity_id === item.id}
              onClick={() => change("select", item.id)}
            >
              {item.title}
            </button>
          ))}
      </div>
      {selected && round && (
        <div className="beta-prompt">
          <span className="beta-small">
            Prompt {(state.prompt_index || 0) + 1} of {rounds.length}
          </span>
          <p>{round.prompt}</p>
          {state.answer_revealed === 1 && round.answer && (
            <p>
              <strong>Answer</strong> · {round.answer}
            </p>
          )}
          <div className="beta-actions">
            {round.answer && !state.answer_revealed && (
              <button
                className="beta-secondary"
                disabled={busy || state.completed === 1}
                onClick={() => change("reveal")}
              >
                Reveal answer
              </button>
            )}
            {(state.prompt_index || 0) + 1 < rounds.length && (
              <button
                className="beta-secondary"
                disabled={busy || state.completed === 1}
                onClick={() => change("advance")}
              >
                Next prompt
              </button>
            )}
            <button
              className="beta-secondary"
              disabled={busy || state.completed === 1}
              onClick={() => change("complete")}
            >
              {state.completed === 1
                ? "Activity complete"
                : "Complete activity"}
            </button>
          </div>
        </div>
      )}
      {selected && (
        <button
          className="beta-text"
          disabled={busy}
          onClick={() => change("clear")}
        >
          Return to ordinary conversation
        </button>
      )}
    </section>
  );
}
let stripeScript;
async function loadStripe() {
  if (window.Stripe) return window.Stripe;
  if (!stripeScript)
    stripeScript = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://js.stripe.com/v3/";
      script.onload = () =>
        window.Stripe
          ? resolve(window.Stripe)
          : reject(new Error("Checkout could not load."));
      script.onerror = () => {
        stripeScript = null;
        reject(
          new Error(
            "Checkout could not load. Check your connection and retry.",
          ),
        );
      };
      document.head.appendChild(script);
    });
  return stripeScript;
}
function PaymentForm({ payment, publishableKey, bookingId, onClose }) {
  const element = useRef(null);
  const stripe = useRef(null);
  const elements = useRef(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const configurationError =
    typeof publishableKey !== "string" || !publishableKey.startsWith("pk_test_")
      ? "Sandbox checkout needs the configured processor’s public test key."
      : "";
  useEffect(() => {
    let active = true;
    let mounted;
    if (
      typeof publishableKey !== "string" ||
      !publishableKey.startsWith("pk_test_")
    ) {
      return;
    }
    loadStripe()
      .then((Stripe) => {
        if (!active) return;
        stripe.current = Stripe(publishableKey);
        elements.current = stripe.current.elements({
          clientSecret: payment.clientSecret,
          appearance: {
            theme: "stripe",
            variables: { colorPrimary: "#40553c", borderRadius: "8px" },
          },
        });
        mounted = elements.current.create("payment");
        mounted.on("ready", () => setReady(true));
        mounted.mount(element.current);
      })
      .catch((issue) => active && setError(issue.message));
    return () => {
      active = false;
      mounted?.destroy();
    };
  }, [payment.clientSecret, publishableKey]);
  async function confirm(event) {
    event.preventDefault();
    if (!stripe.current || !elements.current || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const result = await stripe.current.confirmPayment({
        elements: elements.current,
        confirmParams: {
          return_url:
            location.origin + "/beta?booking=" + encodeURIComponent(bookingId),
        },
        redirect: "if_required",
      });
      if (result.error)
        setError(result.error.message || "Payment could not be confirmed.");
      else setSubmitted(true);
    } catch {
      setError(
        "Checkout was interrupted. Your booking will update after provider confirmation.",
      );
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form className="beta-card" onSubmit={confirm}>
      <h2>Secure sandbox checkout</h2>
      <p className="beta-small">
        Use processor test payment details only. Your card details go directly
        to Stripe.
      </p>
      <div ref={element} />
      {(error || configurationError) && (
        <p className="beta-alert" role="alert">
          {error || configurationError}
        </p>
      )}
      {submitted ? (
        <p className="beta-notice" role="status">
          Payment submitted. Waiting for verified provider confirmation.
        </p>
      ) : (
        <button className="beta-primary" disabled={!ready || submitting}>
          {submitting ? "Confirming…" : "Confirm sandbox payment"}
        </button>
      )}
      <button className="beta-text" type="button" onClick={onClose}>
        Close checkout
      </button>
    </form>
  );
}
