"use client";

import Image from "next/image";
import React, { useEffect, useRef, useState } from "react";
import { styleName } from "../../lib/catalog.mjs";
import {
  languageName,
  languageProficiency,
  normalizeLanguageTag,
  readHostLanguages,
} from "../../lib/conversation-languages.mjs";
import { BETA_PRICE_POLICY } from "../../lib/marketplace/pricing.mjs";
import { ReviewScores, WrittenReviews } from "./beta-additions";
import { human, money } from "./beta-api.mjs";
import HostIntroduction from "./beta-host-introduction";
import { ScheduledChooser } from "./beta-schedule";

const rates = Object.entries(BETA_PRICE_POLICY.prices);

function storedList(input) {
  try {
    const value = typeof input === "string" ? JSON.parse(input) : input;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function HostPortrait({ host }) {
  if (!host.photo) return null;
  return (
    <Image
      unoptimized
      className="beta-profile-photo"
      src={"/api/marketplace/media?kind=photo&id=" + encodeURIComponent(host.photo.id)}
      alt={host.photo.alt_text}
      width={160}
      height={160}
    />
  );
}

function HostProfile({ host, preferences, immediate, canRequest, onClose, onRequest, schedule }) {
  const dialogRef = useRef(null);
  const bookingRef = useRef(null);
  const [bookingStatus, setBookingStatus] = useState(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  const languages = readHostLanguages(host.languages);
  const styles = storedList(host.styles).map(styleName).join(" · ");
  const interests = storedList(host.interests);
  const publishedCount = host.statistics?.publishedReviews ?? host.writtenReviews?.length ?? 0;
  async function reserveFutureTime(action, payload, message) {
    setBookingStatus(null);
    const result = await schedule.run(action, payload, message, {
      onError(issue) {
        setBookingStatus({ message: issue.message, error: true });
        return true;
      },
    });
    if (result?.reservation) setBookingStatus({ message });
    return result;
  }
  return (
    <dialog
      className="beta-host-profile beta-card"
      ref={dialogRef}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      aria-labelledby="beta-host-profile-name"
    >
      <div className="beta-host-profile-close">
        <button type="button" className="beta-secondary" onClick={onClose}>Close profile</button>
      </div>
      <div className="beta-host-profile-layout">
        <div className="beta-host-profile-about">
          <HostPortrait host={host} />
          <h2 id="beta-host-profile-name">{host.display_name}</h2>
          {host.identityVerified && <p className="beta-small">Identity verified · Experience reviewed</p>}
          <button
            type="button"
            className="beta-secondary beta-profile-booking-jump"
            onClick={() => bookingRef.current?.focus()}
          >
            See booking options
          </button>
          <h3>About {host.display_name}</h3>
          <p className="beta-wrap">{host.biography}</p>
          <HostIntroduction intro={host.intro} />
          <h3>Conversation preferences</h3>
          <dl className="beta-host-facts">
            {interests.length > 0 && <div><dt>Topics and interests</dt><dd>{interests.join(" · ")}</dd></div>}
            <div><dt>Styles</dt><dd>{styles || "No preferred styles listed"}</dd></div>
            <div>
              <dt>Spoken languages</dt>
              <dd>{languages.map(({ tag, proficiency }) => (
                proficiency ? `${languageName(tag)} (${languageProficiency[proficiency]})` : languageName(tag)
              )).join(" · ")}</dd>
            </div>
            <div><dt>Formats</dt><dd>{storedList(host.formats).map(human).join(" · ")}</dd></div>
          </dl>
          {host.statistics && (
            <>
              <h3>Ratings &amp; reviews</h3>
              <p className="beta-small">
                Verified feedback from paid, completed sessions. {host.statistics.delivered} delivered sessions.
              </p>
              <ReviewScores statistics={host.statistics} />
              {host.writtenReviews?.length ? (
                <>
                  <p className="beta-small">
                    {publishedCount} published written {publishedCount === 1 ? "review" : "reviews"}.
                    {publishedCount > host.writtenReviews.length && ` Showing the ${host.writtenReviews.length} most recent.`}
                  </p>
                  <WrittenReviews reviews={host.writtenReviews} />
                </>
              ) : (
                <p className="beta-small">No published written reviews yet.</p>
              )}
            </>
          )}
        </div>
        <section className="beta-card beta-host-booking" aria-label="Book this host" tabIndex={-1} ref={bookingRef}>
          <h3>Book a test session</h3>
          <p>{preferences.duration} minutes · {human(preferences.format)} · {languageName(preferences.language)}</p>
          <p><strong>{money(BETA_PRICE_POLICY.prices[preferences.duration])}</strong></p>
          {immediate && (
            <>
              <p className="beta-small">Availability is checked again when you request. The host confirms before test checkout.</p>
              <button type="button" className="beta-primary" disabled={!canRequest} onClick={() => onRequest(host.user_id)}>
                Request {host.display_name} now
              </button>
            </>
          )}
          {bookingStatus && (
            <p className={bookingStatus.error ? "beta-alert" : "beta-notice"} role={bookingStatus.error ? "alert" : "status"}>
              {bookingStatus.message}
            </p>
          )}
          <ScheduledChooser {...schedule} run={reserveFutureTime} preferences={preferences} hostId={host.user_id} />
        </section>
      </div>
    </dialog>
  );
}

function ResultCard({ host, duration, disabled, busy, onView, onReserve, onSave }) {
  const interests = storedList(host.interests);
  const styles = storedList(host.styles).map(styleName);
  const formats = storedList(host.formats).map(human).join(" · ");
  return (
    <article className="beta-card beta-host-result">
      <HostPortrait host={host} />
      <h3>{host.display_name}</h3>
      <p className="beta-small">Available now{host.identityVerified ? " · Identity verified" : ""}</p>
      {host.repeatGuest && <p className="beta-small">You’ve met before</p>}
      <p className="beta-host-result-summary beta-wrap">{host.biography}</p>
      {(interests.length > 0 || styles.length > 0) && (
        <p className="beta-small beta-wrap">{(interests.length ? interests : styles).slice(0, 3).join(" · ")}</p>
      )}
      <p className="beta-small">
        {readHostLanguages(host.languages).map(({ tag }) => languageName(tag)).join(" · ")}
        {formats && " · " + formats}
      </p>
      {host.statistics && <ReviewScores statistics={host.statistics} />}
      <p><strong>{money(BETA_PRICE_POLICY.prices[duration])}</strong> / {duration} min · Test price</p>
      <div className="beta-actions">
        <button type="button" className="beta-secondary" aria-label={`View profile for ${host.display_name}`} onClick={() => onView(host)}>
          View profile
        </button>
        <button type="button" className="beta-primary" disabled={disabled} onClick={() => onReserve(host.user_id)}>
          Request {host.display_name}
        </button>
        <button type="button" className="beta-text" disabled={busy} onClick={() => onSave(host.user_id)}>
          Save host
        </button>
      </div>
    </article>
  );
}

function DiscoveryFilters({ draft, setDraft, onApply, currentMax }) {
  const details = useRef(null);
  function close() {
    details.current.open = false;
    details.current.querySelector("summary")?.focus();
  }
  return (
    <details className="beta-discovery-filters" ref={details}>
      <summary>Price and duration{currentMax ? ` · Up to ${money(currentMax)}` : ""}</summary>
      <div className="beta-discovery-filter-fields">
        <label>
          Duration
          <select value={draft.duration} onChange={(event) => setDraft({ ...draft, duration: Number(event.target.value) })}>
            {rates.map(([duration, price]) => (
              <option key={duration} value={duration}>{duration} minutes · {money(price)}</option>
            ))}
          </select>
        </label>
        <label>
          Maximum test price
          <select value={draft.max} onChange={(event) => setDraft({ ...draft, max: Number(event.target.value) })}>
            <option value={0}>Any price</option>
            {rates.map(([, price]) => <option key={price} value={price}>{money(price)} or less</option>)}
          </select>
        </label>
        <label>
          Format
          <select value={draft.format} onChange={(event) => setDraft({ ...draft, format: event.target.value })}>
            <option value="video">Video</option>
            <option value="audio">Audio</option>
          </select>
        </label>
      </div>
      <div className="beta-actions">
        <button className="beta-secondary" type="button" onClick={() => { onApply(draft); close(); }}>Apply filters</button>
        <button className="beta-text" type="button" onClick={() => { onApply({ duration: 15, max: 0, format: "video" }); close(); }}>Clear filters</button>
        <button className="beta-text" type="button" onClick={close}>Close filters</button>
      </div>
    </details>
  );
}

export default function BetaHostDiscovery({
  api, run, busy, revision, hosts, searching, error, preferences, languages,
  preferredHost, canRequest, onSearch, onTrack, onReserve,
}) {
  const [period, setPeriod] = useState("now");
  const [typedQuery, setTypedQuery] = useState("");
  const [query, setQuery] = useState("");
  const [profile, setProfile] = useState(null);
  const [profileMessage, setProfileMessage] = useState(null);
  const [max, setMax] = useState(0);
  const [draft, setDraft] = useState({ duration: preferences.duration, format: preferences.format, max: 0 });
  const heading = useRef(null);
  const searchForm = useRef(null);
  const futureControl = useRef(null);
  const profileRequest = useRef({ version: 0 });
  const schedule = { api, run, busy, revision };
  const sessionPrice = BETA_PRICE_POLICY.prices[preferences.duration];
  const priceFits = !max || sessionPrice <= max;
  const requestedLanguage = normalizeLanguageTag(preferences.language) || "";
  useEffect(() => {
    heading.current?.focus();
    const request = profileRequest.current;
    return () => { request.version++; };
  }, []);
  function search(text, next = preferences, nextPeriod = period) {
    profileRequest.current.version++;
    setProfileMessage(null);
    const trimmed = text.trim();
    setQuery(trimmed);
    onSearch(next, trimmed, nextPeriod);
  }
  function applyFilters(values) {
    setDraft(values);
    setMax(values.max);
    if (values.duration !== preferences.duration) onTrack("duration_selected");
    if (values.format !== preferences.format) onTrack("format_selected");
    search(query, { ...preferences, duration: values.duration, format: values.format });
  }
  function selectPeriod(next) {
    if (period === next) return;
    setPeriod(next);
    onTrack("availability_filter_applied");
    search(query, preferences, next);
  }
  function submitSearch(event) {
    event.preventDefault();
    onTrack("host_search_submitted");
    search(typedQuery);
  }
  function clearSearch() {
    setTypedQuery("");
    search("");
    searchForm.current?.focus();
  }
  function checkFutureFromEmpty() {
    selectPeriod("later");
    futureControl.current?.focus();
  }
  function retrySearch() {
    search(query);
    searchForm.current?.focus();
  }
  function showProfile(host, immediate) {
    profileRequest.current.version++;
    setProfileMessage(null);
    setProfile({ host, immediate });
    onTrack("host_viewed");
  }
  async function viewScheduledProfile(hostId) {
    const request = profileRequest.current;
    const version = ++request.version;
    setProfileMessage({ message: "Opening the host profile…" });
    try {
      const host = await api.read("scheduled-host-profile", hostId, {
        ...preferences,
        style: preferences.style || "",
      });
      if (version === request.version) showProfile(host, false);
    } catch (issue) {
      if (version === request.version)
        setProfileMessage({ message: issue.message, error: true });
    }
  }
  return (
    <section className="beta-discovery" aria-labelledby="beta-discovery-heading">
      <h2 id="beta-discovery-heading" tabIndex={-1} ref={heading}>
        Find someone to talk to
      </h2>
      <div className="beta-card beta-discovery-controls">
        <form role="search" aria-label="Find a host" onSubmit={submitSearch}>
          <label>
            Search by host name or topic
            <input
              ref={searchForm}
              type="search"
              value={typedQuery}
              maxLength={100}
              onChange={(event) => setTypedQuery(event.target.value)}
            />
          </label>
          <button className="beta-secondary" type="submit">Search</button>
          {query && (
            <button className="beta-text" type="button" onClick={clearSearch}>
              Clear search
            </button>
          )}
        </form>
        <label>
          Conversation language
          <select
            value={requestedLanguage}
            onChange={(event) => search(query, { ...preferences, language: event.target.value })}
          >
            {!languages?.some(({ tag }) => tag === requestedLanguage) && (
              <option value={requestedLanguage} disabled>
                {languageName(requestedLanguage) || "Choose a language"}
              </option>
            )}
            {languages?.map(({ tag, label }) => (
              <option key={tag} value={tag}>{label}</option>
            ))}
          </select>
        </label>
        <div role="group" aria-label="Availability" className="beta-discovery-period">
          {[["now", "Available now"], ["later", "Book for later"]].map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="beta-secondary"
              ref={id === "later" ? futureControl : undefined}
              aria-pressed={period === id}
              onClick={() => selectPeriod(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <DiscoveryFilters
          draft={draft}
          setDraft={setDraft}
          onApply={applyFilters}
          currentMax={max}
        />
      </div>
      {profileMessage && (
        <p className={profileMessage.error ? "beta-alert" : "beta-small"} role={profileMessage.error ? "alert" : "status"}>
          {profileMessage.message}
        </p>
      )}
      {!priceFits ? (
        <p className="beta-card" role="status">
          A {preferences.duration}-minute session costs {money(sessionPrice)}.
          Choose a shorter session or change your maximum test price.
        </p>
      ) : period === "later" ? (
        <ScheduledChooser
          {...schedule}
          preferences={preferences}
          hostId={preferredHost?.user_id}
          query={query}
          onViewHost={viewScheduledProfile}
        />
      ) : (
        <>
          {error && (
            <div className="beta-alert">
              <p role="alert">{error}</p>
              <button className="beta-secondary" type="button" onClick={retrySearch}>Retry search</button>
            </div>
          )}
          <p role="status" className="beta-small">
            {searching ? "Checking host availability…" : hosts && `${hosts.length} available ${hosts.length === 1 ? "host" : "hosts"}`}
          </p>
          {!searching && hosts?.length === 0 && (
            <div className="beta-card">
              <h3>No available hosts fit these choices</h3>
              <p>Keep {languageName(preferences.language)} and check for future times, or change your search.</p>
              <button className="beta-secondary" type="button" onClick={checkFutureFromEmpty}>Check future times</button>
              <button className="beta-text" type="button" onClick={retrySearch}>Check again</button>
            </div>
          )}
          <div className="beta-host-grid" aria-busy={searching}>
            {hosts?.map((host) => (
              <ResultCard
                key={host.user_id}
                host={host}
                duration={preferences.duration}
                busy={busy}
                disabled={!canRequest}
                onView={(host) => showProfile(host, true)}
                onReserve={onReserve}
                onSave={(hostId) => run("favourite", { hostId, saved: true }, "Host saved.")}
              />
            ))}
          </div>
        </>
      )}
      {profile && (
        <HostProfile
          host={profile.host}
          immediate={profile.immediate}
          preferences={preferences}
          canRequest={canRequest}
          onClose={() => setProfile(null)}
          onRequest={(hostId) => { setProfile(null); onReserve(hostId); }}
          schedule={schedule}
        />
      )}
    </section>
  );
}
