"use client";
import React, { useState } from "react";
import { ArrowRight, Heart, MessageCircle, VideoOff } from "lucide-react";
import { stylesFor, styleName, money } from "../../lib/catalog.mjs";
import { priceFor, isTerminal } from "../../lib/demo-policy.mjs";
import { hostPhoto } from "../../lib/presentation.mjs";
import { SessionOptions, EligibilityFields } from "./booking-options";
import { expName } from "./shared";
export default function ProfileDialog({
  host: h,
  preferences,
  s,
  busy,
  act,
  onFavorite,
  isAvailable,
  setModal,
  openFlow,
  close,
}) {
  const [choice, setChoice] = useState(() => {
    const experience = h.experiences.includes(preferences?.experience)
      ? preferences.experience
      : h.experiences[0];
    return {
      experience,
      style: stylesFor(experience).some((x) => x.id === preferences?.style)
        ? preferences.style
        : null,
      duration: preferences?.duration || 15,
      format: h.formats.includes(preferences?.format)
        ? preferences.format
        : h.formats[0],
      language: h.languages.includes(preferences?.language)
        ? preferences.language
        : h.languages[0],
    };
  });
  const [consent, setConsent] = useState({
    adult: false,
    us: false,
    terms: false,
  });
  const reviews = (s?.bookings || []).filter(
    (b) => b.hostId === h.id && b.status === "COMPLETED" && b.rating,
  );
  const current = s?.bookings.find((b) => !isTerminal(b.status));
  async function reserve(e) {
    e.preventDefault();
    if (!s) {
      setModal({ type: "signin" });
      return;
    }
    if (!s.eligible && !(await act("eligibility", consent))) return;
    const response = await act("hold", { ...choice, hostId: h.id });
    if (response)
      openFlow(
        response.state.bookings.find((b) => b.id === response.result.bookingId),
      );
  }
  return (
    <div className="profile-grid">
      <div className="profile-portrait">
        <img src={hostPhoto(h.id)} alt={`${h.name}, fictional demo host`} />
        <span className={`availability ${isAvailable(h) ? "" : "offline"}`}>
          <i />
          {isAvailable(h) ? "Available in this demo" : "Unavailable"}
        </span>
        <span className="portrait-label">Fictional host · Stock portrait</span>
      </div>
      <div className="profile-body">
        <span className="eyebrow">A LITTLE PERSONALITY GOES A LONG WAY</span>
        <h3 className="profile-name">
          {h.name}
          <span>{h.pronouns}</span>
          <button
            className={`icon-btn ${s?.favorites.includes(h.id) ? "saved" : ""}`}
            aria-label={`${s?.favorites.includes(h.id) ? "Unsave" : "Save"} ${h.name}`}
            aria-pressed={!!s?.favorites.includes(h.id)}
            onClick={() => onFavorite(h)}
          >
            <Heart
              fill={s?.favorites.includes(h.id) ? "currentColor" : "none"}
              size={21}
            />
          </button>
        </h3>
        <p className="profile-tagline">{h.headline}</p>
        <p>{h.conversationStyle}.</p>
        <div className="tags">
          {h.interests.map((x) => (
            <span key={x}>{x}</span>
          ))}
        </div>
        <div className="written-intro">
          <span>
            <VideoOff size={17} />
            Sample written introduction
          </span>
          <p>“{h.bio}”</p>
          <small>
            A future verified host could upload a 20–30-second clip here. This
            fictional profile has no recorded video.
          </small>
        </div>
        <div className="profile-meta">
          <span>
            <MessageCircle size={15} />
            {h.languages.join(" & ")}
          </span>
          <span>{h.formats.join(" + ")} demo</span>
          <span>
            {reviews.length
              ? `${reviews.length} demo reviews`
              : "New · no verified reviews"}
          </span>
        </div>
        <p className="demo-caption">
          Offers {h.experiences.map(expName).join(" · ")}. No real host is
          connected.
        </p>
        {reviews.length > 0 && (
          <details className="demo-reviews">
            <summary>Reviews from this demo workspace</summary>
            {reviews.map((b) => (
              <p key={b.id}>
                {b.rating}/5{b.review ? ` — ${b.review}` : ""}
              </p>
            ))}
            <small>
              These are simulation entries, not verified customer reviews.
            </small>
          </details>
        )}
        <form onSubmit={reserve}>
          <div className="profile-divider" />
          <label className="field-label">
            Your experience
            <select
              value={choice.experience}
              onChange={(e) =>
                setChoice({
                  ...choice,
                  experience: e.target.value,
                  style: null,
                })
              }
            >
              {h.experiences.map((id) => (
                <option key={id} value={id}>
                  {expName(id)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Conversation style (optional)
            <select
              value={choice.style || ""}
              onChange={(e) =>
                setChoice({ ...choice, style: e.target.value || null })
              }
            >
              <option value="">Let it flow</option>
              {stylesFor(choice.experience).map((style) => (
                <option key={style.id} value={style.id}>
                  {styleName(style.id)}
                </option>
              ))}
            </select>
          </label>
          <SessionOptions
            preferences={choice}
            onChange={setChoice}
            formats={h.formats}
            languages={h.languages}
          />
          {!s?.eligible && (
            <EligibilityFields value={consent} onChange={setConsent} />
          )}
          {current ? (
            <div className="notice">
              You have a moment in progress.
              <button type="button" onClick={() => openFlow(current)}>
                Continue it
              </button>
            </div>
          ) : (
            <button
              className="primary full"
              disabled={
                busy ||
                !isAvailable(h) ||
                (!s?.eligible && !Object.values(consent).every(Boolean))
              }
            >
              Request {h.name} · {money(priceFor(choice.duration))} demo
              <ArrowRight size={17} />
            </button>
          )}
          <p className="microcopy">
            Host confirmation comes first. Checkout is always simulated.
          </p>
        </form>
        <div className="profile-safety">
          <button onClick={() => setModal({ type: "report", host: h })}>
            Report profile
          </button>
          <button
            onClick={async () => {
              if (!s) {
                setModal({ type: "signin" });
                return;
              }
              if (
                await act(
                  "block",
                  { hostId: h.id },
                  `${h.name} is blocked in your workspace.`,
                )
              )
                close();
            }}
          >
            Block host
          </button>
        </div>
      </div>
    </div>
  );
}
