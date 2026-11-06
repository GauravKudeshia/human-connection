"use client";
import React from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Heart,
  MessageCircle,
  Sparkles,
} from "lucide-react";
import { experiences } from "../../lib/catalog.mjs";
import { hostPhoto } from "../../lib/presentation.mjs";
import { expIcon } from "./shared";
export function ExperienceChoices({ selected, onChoose }) {
  return (
    <div className="experience-grid">
      {experiences.map((e) => {
        const Icon = expIcon[e.id];
        return (
          <button
            key={e.id}
            className={`experience ${e.color} ${selected === e.id ? "chosen" : ""}`}
            aria-pressed={selected === e.id}
            onClick={() => onChoose(e.id)}
          >
            <span className="experience-top">
              <span className="experience-icon">
                <Icon size={27} />
              </span>
              <ArrowUpRight size={22} />
            </span>
            <h3>{e.name}</h3>
            <p>{e.note}</p>
            <span className="experience-label">
              {e.id === "laugh"
                ? "Stories, banter & a little silliness"
                : e.id === "hear"
                  ? "Your day, at your pace"
                  : "Curiosity, games & unexpected turns"}
            </span>
          </button>
        );
      })}
    </div>
  );
}
export default function Landing({ onStart, onChoose, onBrowse, onHelp }) {
  return (
    <>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="tiny-sun">✳</span>A LITTLE HUMAN TIME
          </span>
          <h1>
            A rough day?
            <br />A real conversation
            <br />
            <em>might help.</em>
          </h1>
          <p>
            Find someone to laugh with, talk to, or take your mind somewhere
            new.
          </p>
          <div className="hero-actions">
            <button className="primary" onClick={onStart}>
              Find My Moment <ArrowRight size={19} />
            </button>
            <button className="text-btn" onClick={onBrowse}>
              Explore Hosts <ArrowUpRight size={17} />
            </button>
          </div>
          <div className="hero-foot">
            <span>15 or 30 minutes</span>
            <span>One-to-one</span>
            <span>Adults 18+</span>
          </div>
        </div>
        <div
          className="hero-art"
          aria-label="Fictional profiles illustrating the proposed human-host experience"
        >
          <div className="art-orbit" />
          <span className="art-spark">✳</span>
          <div className="polaroid p-one">
            <img
              src={hostPhoto("james")}
              alt="Stock portrait for fictional host James"
            />
            <span>bring your sense of humor ↗</span>
          </div>
          <div className="polaroid p-two">
            <img
              src={hostPhoto("maya")}
              alt="Stock portrait for fictional host Maya"
            />
            <span>or just bring yourself ♡</span>
          </div>
          <span className="art-caption">
            Fictional demo hosts · Stock portraits
          </span>
        </div>
      </section>
      <section className="experiences-section">
        <div className="section-top">
          <div>
            <span className="eyebrow">START WITH WHAT YOU FEEL LIKE</span>
            <h2>What kind of moment is yours?</h2>
          </div>
          <span>No perfect words needed.</span>
        </div>
        <ExperienceChoices onChoose={onChoose} />
      </section>
      <section className="human-difference">
        <div className="difference-intro">
          <span className="eyebrow">A CONVERSATION WITH YOU AT THE CENTER</span>
          <h2>
            Good company.
            <br />
            <em>Your kind of company.</em>
          </h2>
          <p>
            The idea is simple: choose an experience, meet a vetted human host,
            and make the time your own.
          </p>
        </div>
        <div className="difference-points">
          {[
            [
              MessageCircle,
              "A real back-and-forth",
              "A host who can follow your story, join your joke, or take a game somewhere unexpected.",
            ],
            [
              Sparkles,
              "Something to do together",
              "Story prompts, playful questions, or just room to talk. Activities are always optional.",
            ],
            [
              Heart,
              "A little more certainty",
              "Choose the style and price first. In the live service, host confirmation and clear boundaries would come before checkout.",
            ],
          ].map(([Icon, title, text]) => (
            <div key={title}>
              <span>
                <Icon size={21} />
              </span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
      <section className="demo-explainer">
        <span className="demo-chip">TRY THE IDEA</span>
        <h2>A full journey, without a real call.</h2>
        <p>
          This interactive preview uses fictional hosts, local demo availability
          and simulated payments. No one receives your requests or reports. No
          signup or card is needed.
        </p>
        <div className="demo-steps">
          <span>
            <b>01</b>Choose your moment
          </span>
          <span>
            <b>02</b>Try a fictional match
          </span>
          <span>
            <b>03</b>Explore sample activities
          </span>
        </div>
      </section>
      <section className="promise-strip">
        <div>
          <Heart size={23} />
          <span>
            <strong>Friendly company, with clear boundaries.</strong>
            <small>
              Platonic entertainment for adults. Not therapy, dating, or crisis
              care.
            </small>
          </span>
        </div>
        <button onClick={onHelp}>
          Safety & your control <ArrowUpRight size={17} />
        </button>
      </section>
    </>
  );
}
