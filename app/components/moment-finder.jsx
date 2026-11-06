"use client";
import React, { useRef, useEffect } from "react";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { stylesFor, styleName, money } from "../../lib/catalog.mjs";
import { priceFor } from "../../lib/demo-policy.mjs";
import { ExperienceChoices } from "./landing";
import { SessionOptions } from "./booking-options";
import { expName } from "./shared";
export default function MomentFinder({
  preferences,
  onChange,
  step,
  setStep,
  onHome,
  onBrowse,
  onMatch,
  busy,
  error,
}) {
  const heading = useRef(null);
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
              "Choose a conversation style, or leave room for a surprise.",
              "Set your preferences. We’ll find a fictional host who fits.",
            ][step]
          }
        </p>
      </div>
      {step === 0 && (
        <ExperienceChoices
          selected={preferences.experience}
          onChoose={(experience) => {
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
          <div className="style-grid">
            {stylesFor(preferences.experience).map((s, i) => (
              <button
                key={s.id}
                className={`style-card ${preferences.style === s.id ? "chosen" : ""}`}
                aria-pressed={preferences.style === s.id}
                onClick={() => onChange({ ...preferences, style: s.id })}
              >
                <span className="style-number">0{i + 1}</span>
                <h2>{s.name}</h2>
                <p>{s.note}</p>
                {preferences.style === s.id && (
                  <span className="selection-word">Selected</span>
                )}
              </button>
            ))}
          </div>
          <div className="journey-actions">
            <button
              className="text-btn"
              onClick={() => {
                onChange({ ...preferences, style: null });
                setStep(2);
              }}
            >
              Skip · let it flow
            </button>
            <button className="primary" onClick={() => setStep(2)}>
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
          <button className="secondary" onClick={() => setStep(2)}>
            Adjust my choices
          </button>
          <button className="text-btn" onClick={onBrowse}>
            Explore hosts
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
