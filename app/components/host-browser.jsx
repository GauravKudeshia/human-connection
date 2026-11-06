"use client";
import React from "react";
import { ArrowLeft, Search, Heart } from "lucide-react";
import { hosts, experiences } from "../../lib/catalog.mjs";
import { hostAvailable } from "../../lib/matching.mjs";
import HostCard from "./host-card";
import { PageHeading, Empty } from "./shared";
export default function HostBrowser({
  s,
  saved,
  filters,
  setFilters,
  onOpen,
  onFavorite,
  onBack,
  onClear,
}) {
  const visible = hosts.filter(
    (h) =>
      !s?.blocks.includes(h.id) &&
      (saved ? s?.favorites.includes(h.id) : hostAvailable(s, h)) &&
      (filters.experience === "all" ||
        h.experiences.includes(filters.experience)) &&
      (filters.format === "any" || h.formats.includes(filters.format)) &&
      (filters.language === "any" || h.languages.includes(filters.language)) &&
      `${h.name} ${h.tags.join(" ")} ${h.interests.join(" ")} ${h.headline}`
        .toLowerCase()
        .includes(filters.query.toLowerCase()),
  );
  return (
    <>
      <button className="text-btn browse-back" onClick={onBack}>
        <ArrowLeft size={17} />
        Back to my moment
      </button>
      <PageHeading
        eyebrow={
          saved ? "FAMILIAR FACES" : "A LITTLE PERSONALITY GOES A LONG WAY"
        }
        title={
          saved ? "Keep your favorites close." : "Meet your kind of company."
        }
      >
        Fictional profiles for exploring the idea. Availability is local to this
        demo, with no live hosts or verified customer reviews.
      </PageHeading>
      <div className="filter-bar">
        <div
          className="filter-tabs"
          role="group"
          aria-label="Filter by experience"
        >
          {[
            ["all", "All experiences"],
            ...experiences.map((e) => [e.id, e.name]),
          ].map(([id, name]) => (
            <button
              key={id}
              aria-pressed={filters.experience === id}
              className={filters.experience === id ? "active" : ""}
              onClick={() => setFilters({ ...filters, experience: id })}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="filter-selects">
          <label>
            Format
            <select
              value={filters.format}
              onChange={(e) =>
                setFilters({ ...filters, format: e.target.value })
              }
            >
              <option value="any">All formats</option>
              <option value="audio">Audio</option>
              <option value="video">Video</option>
            </select>
          </label>
          <label>
            Language
            <select
              value={filters.language}
              onChange={(e) =>
                setFilters({ ...filters, language: e.target.value })
              }
            >
              <option value="any">All languages</option>
              <option>English</option>
              <option>Spanish</option>
            </select>
          </label>
          <label className="search-host">
            <Search size={18} />
            <input
              aria-label="Search hosts"
              placeholder="A name or interest"
              value={filters.query}
              onChange={(e) =>
                setFilters({ ...filters, query: e.target.value })
              }
            />
          </label>
        </div>
      </div>
      <p className="results-count" role="status">
        {visible.length}{" "}
        {saved
          ? "saved fictional profiles"
          : "fictional hosts matching your choices"}
      </p>
      {visible.length ? (
        <div className="host-grid">
          {visible.map((h) => (
            <HostCard
              key={h.id}
              host={h}
              state={s}
              available={hostAvailable(s, h)}
              onOpen={onOpen}
              onFavorite={onFavorite}
            />
          ))}
        </div>
      ) : (
        <Empty
          icon={Heart}
          title={saved ? "No saved hosts match yet" : "No hosts fit just now"}
          action={
            <button className="secondary" onClick={onClear}>
              Clear filters & explore hosts
            </button>
          }
        >
          {saved
            ? "Save a host with the heart button, then find them here."
            : "Try a different format or language. Nothing has been charged. A host on an active request is temporarily unavailable."}
        </Empty>
      )}
    </>
  );
}
