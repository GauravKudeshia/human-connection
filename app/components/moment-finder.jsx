"use client";
import React, { useRef, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Sparkles } from "lucide-react";
import { stylesFor, styleName, money } from "../../lib/catalog.mjs";
import { priceFor } from "../../lib/demo-policy.mjs";
import {
  recommendStyle,
  styleRecommendationMessages,
} from "../../lib/style-recommendation.mjs";
import ExperienceBoard from "./experience-board";
import { SessionOptions } from "./booking-options";
import { expName } from "./shared";
export default function MomentFinder({
  preferences,
  history = [],
  onChange,
  step,
  setStep,
  onHome,
  onBrowse,
  onAdjust,
  onBrowseAlternatives,
  onMatch,
  busy,
  error,
}) {
  const heading = useRef(null);
  const [suggestion, setSuggestion] = useState(null);
  const styles = stylesFor(preferences.experience);
  const style = styles.find((item) => item.id === preferences.style);
  const currentSuggestion =
    suggestion?.experience === preferences.experience ? suggestion : null;
  const surpriseSelected = Boolean(
    style && currentSuggestion?.style === style.id,
  );

  function surpriseMe() {
    const result = recommendStyle(
      preferences.experience,
      history.map((booking) => ({
        experience: booking.experience,
        style: booking.style,
        status: booking.status,
        rating: booking.rating,
        worthIt:
          booking.valueFeedback?.answer === "yes"
            ? true
            : booking.valueFeedback?.answer === "no"
              ? false
              : null,
      })),
    );
    setSuggestion({ ...result, experience: preferences.experience });
    if (result.style) onChange({ ...preferences, style: result.style });
  }

  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  return (
    <section className="moment-finder">
      <div className="journey-top">
        <button
          className="text-btn"
          onClick={() => (step ? setStep(step - 1) : onHome())}
        >
          <ArrowLeft size={17} />
          Back
        </button>
        <ol className="journey-progress" aria-label="Find a moment progress">
          {["Experience", "Style", "Your time"].map((label, i) => (
            <li key={label} aria-current={step === i ? "step" : undefined}>
              <span>{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </div>
      <div className="journey-heading">
        <span className="eyebrow">YOUR MOMENT, YOUR WAY</span>
        <h1 ref={heading} tabIndex={-1}>
          {
            [
              "What do you feel like?",
              "How shall we spend it?",
              "A little time, just for you.",
            ][step]
          }
        </h1>
        <p>
          {
            [
              "Start with an experience. You can change your mind.",
              "Pick a conversation style or let us suggest one.",
              "Set your preferences. We’ll find a fictional host who fits.",
            ][step]
          }
        </p>
      </div>
      {step === 0 && (
        <ExperienceBoard
          selected={preferences.experience}
          onChoose={(experience) => {
            setSuggestion(null);
            onChange({ ...preferences, experience, style: null });
            setStep(1);
          }}
        />
      )}
      {step === 1 && (
        <>
          <p className="selected-experience">
            {expName(preferences.experience)}
          </p>
          <div className="style-grid" role="group" aria-label="Conversation style">
            {styles.map((item) => {
              const selected = !surpriseSelected && style?.id === item.id;
              return (
                <button
                  key={item.id}
                  className={`style-card ${selected ? "chosen" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setSuggestion(null);
                    onChange({ ...preferences, style: item.id });
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>{item.note}</span>
                  {selected && (
                    <Check
                      className="style-choice-check"
                      size={16}
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
            <button
              className={`style-card surprise-card ${surpriseSelected ? "chosen" : ""}`}
              aria-pressed={surpriseSelected}
              onClick={surpriseMe}
            >
              <strong>
                <Sparkles size={18} aria-hidden="true" /> Surprise Me
              </strong>
              <span>Suggest a style using past sessions in this demo.</span>
              {surpriseSelected && (
                <Check
                  className="style-choice-check"
                  size={16}
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
          <div role="status">
            {(surpriseSelected || currentSuggestion?.reason === "no-fit") && (
              <p className="style-suggestion">
                {surpriseSelected && <strong>{style.name}</strong>}{" "}
                {styleRecommendationMessages[currentSuggestion.reason]}
              </p>
            )}
          </div>
          <div className="journey-actions">
            <button
              className="primary"
              disabled={!style}
              onClick={() => setStep(2)}
            >
              Choose my time <ArrowRight size={17} />
            </button>
          </div>
        </>
      )}
      {step === 2 && (
        <div className="moment-details">
          <div className="moment-choice-panel">
            <SessionOptions preferences={preferences} onChange={onChange} />
          </div>
          <div className="moment-summary">
            <span className="eyebrow">HERE’S YOUR MOMENT</span>
            <h2>{expName(preferences.experience)}</h2>
            <p>
              {styleName(preferences.style)}
              <br />
              {preferences.duration} minutes · {preferences.format} ·{" "}
              {preferences.language}
            </p>
            <div className="moment-price">
              <strong>{money(priceFor(preferences.duration))}</strong>
              <span>
                simulated total
                <br />
                no real charge
              </span>
            </div>
            <button className="primary full" disabled={busy} onClick={onMatch}>
              <Sparkles size={18} />
              {busy ? "Finding your match…" : "Match Me Now"}
            </button>
            <button
              className="secondary full"
              disabled={busy}
              onClick={onBrowse}
            >
              I’ll choose a host <ArrowRight size={17} />
            </button>
            <p className="microcopy">
              Fictional matches in your workspace only. Host confirmation comes
              before demo checkout.
            </p>
          </div>
        </div>
      )}
      {error && (
        <div className="matching-empty" role="status">
          <h2>A different moment might fit.</h2>
          <p>{error}</p>
          <button className="secondary" onClick={onAdjust}>
            Adjust my choices
          </button>
          <button className="text-btn" onClick={onBrowseAlternatives}>
            See other experiences in {preferences.language}
          </button>
        </div>
      )}
      {step === 2 && (
        <details className="matching-note">
          <summary>How demo matching works</summary>
          <p>
            Experience, format, language, blocks and current reservations
            determine who is eligible. A host’s written style preferences rank
            first, followed by fewer requests and the longest time since their
            last request in your workspace. Name breaks any remaining tie. There
            is no shared global host pool, real availability guarantee or AI
            matching.
          </p>
        </details>
      )}
    </section>
  );
}
