"use client";
import React from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import {
  activitiesFor,
  suggestedActivity,
  activityRounds,
} from "../../lib/activities.mjs";
export default function ActivityPanel({ booking, act, busy }) {
  const cards = activitiesFor(booking.experience),
    selected = cards.find((a) => a.id === booking.activityId),
    suggested = suggestedActivity(booking);
  const progress = booking.activityProgress || {
    promptIndex: 0,
    answerRevealed: false,
    completed: false,
    revision: 0,
  };
  const rounds = selected ? activityRounds(selected) : [];
  const round = rounds[progress.promptIndex] || rounds[0];
  const updateActivity = (command) =>
    act("activity-action", {
      bookingId: booking.id,
      activityId: selected.id,
      revision: progress.revision,
      command,
    });
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
          <span>
            Prompt {progress.promptIndex + 1} of {rounds.length}
          </span>
          <h3>{selected.title}</h3>
          {progress.completed ? (
            <>
              <p role="status">
                Activity complete. Choose another card or return to the
                conversation.
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => updateActivity("restart")}
              >
                Restart activity
              </button>
            </>
          ) : (
            <>
              <p>{round.prompt}</p>
              {round.answer && (
                <div>
                  <button
                    className="text-btn"
                    disabled={busy}
                    aria-expanded={progress.answerRevealed}
                    onClick={() =>
                      updateActivity(
                        progress.answerRevealed ? "hide" : "reveal",
                      )
                    }
                  >
                    {progress.answerRevealed ? "Hide answer" : "Reveal answer"}
                  </button>
                  {progress.answerRevealed && <p>{round.answer}</p>}
                </div>
              )}
              <small>{selected.note}</small>
              <div className="button-row">
                <button
                  className="secondary"
                  disabled={busy || progress.promptIndex + 1 >= rounds.length}
                  onClick={() => updateActivity("next")}
                >
                  Next prompt
                </button>
                <button
                  className="text-btn"
                  disabled={busy}
                  onClick={() => updateActivity("complete")}
                >
                  Complete activity
                </button>
              </div>
            </>
          )}
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
