"use client";
import React from "react";
import { ArrowUpRight, Check } from "lucide-react";
import { experiences } from "../../lib/catalog.mjs";
import { momentPhoto } from "../../lib/presentation.mjs";

const captions = {
  laugh: "Funny stories & playful banter",
  hear: "Space to talk about your day",
  distract: "Trivia, stories & games",
};

export default function ExperienceBoard({ selected, onChoose }) {
  return (
    <div
      className="moment-board"
      role="group"
      aria-label="Choose an experience"
    >
      {experiences.map(({ id, name }) => {
        const current = selected === id;
        return (
          <button
            key={id}
            type="button"
            className={`moment-tile moment-tile-${id}`}
            onClick={() => onChoose(id)}
            aria-pressed={selected === undefined ? undefined : current}
          >
            <img
              src={momentPhoto(id)}
              alt=""
              width="640"
              height="640"
              fetchPriority={id === "laugh" ? "high" : "auto"}
            />
            <span className="moment-tile-copy">
              <span className="moment-tile-title">{name}</span>
              <span className="moment-tile-description">{captions[id]}</span>
            </span>
            <span className="moment-tile-arrow" aria-hidden="true">
              {current ? <Check size={18} /> : <ArrowUpRight size={18} />}
            </span>
          </button>
        );
      })}
    </div>
  );
}
