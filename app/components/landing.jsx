"use client";
import React, { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Heart,
  Layers,
  RotateCw,
} from "lucide-react";
import { activities } from "../../lib/activities.mjs";
import { styleName } from "../../lib/catalog.mjs";
import { momentPhoto } from "../../lib/presentation.mjs";
import ExperienceBoard from "./experience-board";
import { expName } from "./shared";

const samples = ["laugh-banter", "hear-day", "distract-stories"].map((id) =>
  activities.find((activity) => activity.id === id),
);

function ConversationStarter({ onChoose }) {
  const [index, setIndex] = useState(0);
  const sample = samples[index];
  const name = expName(sample.experience);
  return (
    <section className="starter-section" aria-labelledby="starter-heading">
      <div className="starter-heading">
        <h2 id="starter-heading">Try a conversation starter</h2>
        <button
          type="button"
          className="starter-next"
          onClick={() =>
            setIndex((previous) => (previous + 1) % samples.length)
          }
        >
          <RotateCw size={16} aria-hidden="true" /> Next card
        </button>
      </div>
      <div className="starter-layout">
        <div className="starter-photo">
          <img
            src={momentPhoto("cards")}
            width="640"
            height="640"
            alt="Colorful conversation cards beside a cup of coffee"
            loading="lazy"
          />
        </div>
        <div className="starter-paper">
          <div aria-live="polite" aria-atomic="true">
            <p className="starter-category">
              <Layers size={16} aria-hidden="true" />
              {name} <span aria-hidden="true">·</span> {styleName(sample.style)}
            </p>
            <p className="starter-question">{sample.prompt}</p>
          </div>
          <button
            type="button"
            className="starter-choose"
            onClick={() => onChoose(sample.experience, sample.style)}
          >
            Try {styleName(sample.style)}{" "}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}

export default function Landing({ onStart, onChoose, onBrowse, onHelp }) {
  return (
    <>
      <section className="moment-hero" aria-labelledby="welcome-heading">
        <div className="welcome-copy">
          <p className="welcome-kicker">One-to-one conversations</p>
          <h1 id="welcome-heading">
            In the mood for <em>good company?</em>
          </h1>
          <p className="welcome-intro">
            Choose how you’d like to spend 15 or 30 minutes with a host. Share a
            laugh, talk through your day, or play a game together.
          </p>
        </div>
        <ExperienceBoard onChoose={onChoose} />
        <div className="welcome-actions">
          <button type="button" className="primary" onClick={onStart}>
            Find My Moment <ArrowRight size={17} aria-hidden="true" />
          </button>
          <button type="button" className="text-btn" onClick={onBrowse}>
            Explore Hosts <ArrowUpRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
      <ConversationStarter onChoose={onChoose} />
      <section className="promise-strip">
        <div>
          <Heart size={23} aria-hidden="true" />
          <span>
            <strong>Friendly company for adults 18+</strong>
            <small>
              Platonic entertainment. Therapy, dating and crisis care are
              outside the service.
            </small>
          </span>
        </div>
        <button type="button" onClick={onHelp}>
          Safety &amp; your control{" "}
          <ArrowUpRight size={17} aria-hidden="true" />
        </button>
      </section>
    </>
  );
}
