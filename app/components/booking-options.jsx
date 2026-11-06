"use client";
import React, { useState } from "react";
import { ArrowRight, Headphones, Video } from "lucide-react";
import { money } from "../../lib/catalog.mjs";
import { priceFor } from "../../lib/demo-policy.mjs";
import { Modal } from "./shared";

export function SessionOptions({
  preferences,
  onChange,
  formats = ["audio", "video"],
  languages = ["English", "Spanish"],
}) {
  return (
    <div className="session-options">
      <fieldset>
        <legend>How much time is yours?</legend>
        <div className="segmented">
          {[15, 30].map((n) => (
            <button
              type="button"
              key={n}
              aria-pressed={preferences.duration === n}
              className={preferences.duration === n ? "active" : ""}
              onClick={() => onChange({ ...preferences, duration: n })}
            >
              <strong>{n} min</strong>
              <span>{money(priceFor(n))} demo</span>
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>How would you like to connect?</legend>
        <div className="segmented">
          {formats.map((format) => (
            <button
              type="button"
              key={format}
              aria-pressed={preferences.format === format}
              className={preferences.format === format ? "active" : ""}
              onClick={() => onChange({ ...preferences, format })}
            >
              {format === "audio" ? (
                <Headphones size={18} />
              ) : (
                <Video size={18} />
              )}
              <span>{format === "audio" ? "Audio" : "Video"}</span>
            </button>
          ))}
        </div>
      </fieldset>
      <label className="field-label">
        Conversation language
        <select
          value={preferences.language}
          onChange={(e) =>
            onChange({ ...preferences, language: e.target.value })
          }
        >
          {languages.map((l) => (
            <option key={l}>{l}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
export function EligibilityFields({ value, onChange }) {
  return (
    <fieldset className="eligibility">
      <legend>Before your first demo moment</legend>
      <p>
        For the proposed adults-only, U.S. service. Use fictional details
        throughout this preview.
      </p>
      {[
        ["adult", "I am 18 or older."],
        ["us", "I am currently in the United States."],
        [
          "terms",
          "I understand this is a platonic entertainment demo, not therapy, dating or crisis care. No real payment or call will occur.",
        ],
      ].map(([key, label]) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={value[key]}
            onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}
export function EligibilityDialog({ close, busy, onReady }) {
  const [value, setValue] = useState({ adult: false, us: false, terms: false });
  return (
    <Modal title="Before your first moment" close={close}>
      <form
        className="modal-content"
        onSubmit={(e) => {
          e.preventDefault();
          onReady(value);
        }}
      >
        <EligibilityFields value={value} onChange={setValue} />
        <button
          className="primary full"
          disabled={busy || !Object.values(value).every(Boolean)}
        >
          Find my fictional match <ArrowRight size={17} />
        </button>
        <p className="microcopy">
          No signup or payment card. This acknowledgement applies only to the
          demo.
        </p>
      </form>
    </Modal>
  );
}
