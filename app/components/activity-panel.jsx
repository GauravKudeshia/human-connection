"use client";
import React from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { activitiesFor, suggestedActivity } from "../../lib/activities.mjs";
export default function ActivityPanel({ booking, act, busy }) {
  const cards = activitiesFor(booking.experience),
    selected = cards.find((a) => a.id === booking.activityId),
    suggested = suggestedActivity(booking);
  return (
    <section className="activity-panel" aria-label="Sample session activities">
      <div className="activity-heading">
        <span className="eyebrow">
          <Sparkles size={17} />
          SOMETHING TO START WITH
        </span>
        <h2>Let’s try a little detour.</h2>
        <p>
          Optional sample activities. Choose a card, or simply let the
          conversation flow.
        </p>
      </div>
      <div className="activity-options">
        {cards.map((a) => (
          <button
            key={a.id}
            aria-pressed={selected?.id === a.id}
            className={selected?.id === a.id ? "selected" : ""}
            disabled={busy}
            onClick={() =>
              act("select-activity", {
                bookingId: booking.id,
                activityId: a.id,
              })
            }
          >
            <span>
              {a.title}
              {a.id === suggested?.id && booking.style && (
                <small>Suggested for your style</small>
              )}
            </span>
            <ArrowRight size={16} />
          </button>
        ))}
      </div>
      {selected ? (
        <article className="activity-card" key={selected.id} aria-live="polite">
          <span>SAMPLE CARD</span>
          <h3>{selected.title}</h3>
          <p>{selected.prompt}</p>
          {selected.answer && (
            <details>
              <summary>Reveal answer</summary>
              <p>{selected.answer}</p>
            </details>
          )}
          <small>{selected.note}</small>
        </article>
      ) : (
        <div className="activity-rest">
          <p>
            No activity selected. A real conversation would be yours to shape.
          </p>
        </div>
      )}
      <button
        className="text-btn"
        disabled={busy}
        onClick={() =>
          act("select-activity", { bookingId: booking.id, activityId: null })
        }
      >
        Skip activities · just talk
      </button>
      <p className="demo-caption">
        These controls demonstrate a shared activity panel. No host sees or
        responds to your choices in this demo.
      </p>
    </section>
  );
}
