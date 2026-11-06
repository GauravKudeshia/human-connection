"use client";
import React from "react";
import { ArrowUpRight, Heart, Headphones, Video } from "lucide-react";
import { hostPhoto } from "../../lib/presentation.mjs";
export default function HostCard({
  host: h,
  state,
  available,
  onOpen,
  onFavorite,
}) {
  const saved = state?.favorites.includes(h.id);
  const reviews = (state?.bookings || []).filter(
    (b) => b.hostId === h.id && b.status === "COMPLETED" && b.rating,
  );
  return (
    <article className="host-card">
      <button
        className="host-photo"
        onClick={() => onOpen(h)}
        aria-label={`Meet ${h.name}`}
      >
        <img
          src={hostPhoto(h.id)}
          alt={`${h.name}, fictional demo host`}
          loading="lazy"
        />
        <span className={`availability ${available ? "" : "offline"}`}>
          <i />
          {available ? "Available in this demo" : "Unavailable in this demo"}
        </span>
      </button>
      <button
        className={`save-btn ${saved ? "saved" : ""}`}
        aria-label={`${saved ? "Unsave" : "Save"} ${h.name}`}
        aria-pressed={!!saved}
        onClick={() => onFavorite(h)}
      >
        <Heart size={19} fill={saved ? "currentColor" : "none"} />
      </button>
      <div className="host-info">
        <div className="host-name">
          <h3>{h.name}</h3>
          <span className="new-host">
            {reviews.length
              ? `${reviews.length} demo review${reviews.length === 1 ? "" : "s"}`
              : "New"}
          </span>
        </div>
        <p>{h.headline}</p>
        <div className="tags">
          {h.tags.slice(0, 2).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
        <p className="host-format">
          <Headphones size={14} />
          {h.formats.includes("video") && <Video size={14} />}{" "}
          {h.languages.join(" · ")}
        </p>
        <div className="host-card-footer">
          <span>
            <strong>$10</strong>
            <small> / 15 min</small>
          </span>
          <button onClick={() => onOpen(h)}>
            Meet {h.name}
            <ArrowUpRight size={17} />
          </button>
        </div>
      </div>
    </article>
  );
}
