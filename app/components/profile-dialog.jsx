"use client";
import React, { useState } from "react";
import { ArrowRight, Heart, MessageCircle, VideoOff } from "lucide-react";
import {
  bookableExperiences,
  bookableStylesFor,
  money,
} from "../../lib/catalog.mjs";
import { priceFor, isTerminal } from "../../lib/demo-policy.mjs";
import { hostPhoto } from "../../lib/presentation.mjs";
import { SessionOptions, EligibilityFields } from "./booking-options";
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
  const offers = bookableExperiences.filter(({ id }) =>
    h.experiences.includes(id),
  );
  const expertise = offers
    .flatMap(({ id }) => bookableStylesFor(id))
    .filter(({ id }) => h.styles.includes(id));
  const [choice, setChoice] = useState(() => {
    const experience = offers.some(({ id }) => id === preferences?.experience)
      ? preferences.experience
      : offers[0]?.id;
    const styles = bookableStylesFor(experience);
    return {
      experience,
      style: styles.some((x) => x.id === preferences?.style)
        ? preferences.style
        : styles[0]?.id,
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
    terms: false,
  });
  const reviews = (s?.bookings || []).filter(
    (b) => b.hostId === h.id && b.status === "COMPLETED" && b.rating,
  );
  const current = s?.bookings.find((b) => !isTerminal(b.status));
  async function reserve(e) {
    e.preventDefault();
    if (!offers.length || !choice.style) return;
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
        {expertise.length > 0 && (
          <div className="profile-expertise">
            <h4>Conversation styles to explore</h4>
            <div className="tags">
              {expertise.map(({ id, name }) => (
                <span key={id}>{name}</span>
              ))}
            </div>
            <p className="demo-caption">
              Sample profile preferences. Experience approval and auditions apply
              to future real hosts.
            </p>
          </div>
        )}
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
          {offers.length
            ? `Offers ${offers.map(({ name }) => name).join(" · ")} in this demo.`
            : "This profile is unavailable for new demo sessions."}
        </p>
        {reviews.length > 0 && (
          <details className="demo-reviews">
            <summary>Reviews from this demo workspace</summary>
            {reviews.map((b) => (
              <div key={b.id}>
                <p>Conversation Quality · {b.rating} / 5</p>
                {b.comfortRating && <p>Comfort &amp; Respect · {b.comfortRating} / 5</p>}
                {b.review && <p>{b.review}</p>}
              </div>
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
              value={choice.experience || ""}
              disabled={!offers.length}
              onChange={(e) =>
                setChoice({
                  ...choice,
                  experience: e.target.value,
                  style: bookableStylesFor(e.target.value)[0]?.id,
                })
              }
            >
              {offers.map(({ id, name }) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            Conversation style
            <select
              value={choice.style || ""}
              disabled={!offers.length}
              onChange={(e) =>
                setChoice({ ...choice, style: e.target.value })
              }
            >
              {bookableStylesFor(choice.experience).map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name}
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
                !choice.style ||
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
