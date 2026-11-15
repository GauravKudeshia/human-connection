"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { experiences, stylesFor } from "../../lib/catalog.mjs";
import { createBetaApi, human, money } from "./beta-api.mjs";
import { HostWorkspace, OperationsWorkspace, useResource } from "./beta-panels";
import BetaSession from "./beta-session";
import { ClosureReceipt, PrivacyAccount, VisitConsent } from "./beta-additions";

const defaults = {
  experience: "laugh",
  style: null,
  duration: 15,
  format: "video",
  language: "English",
};
const staffRoles = ["admin", "host_reviewer", "safety", "finance"];
export default function BetaApp({ request = fetch } = {}) {
  const [session, setSession] = useState(null);
  const [me, setMe] = useState(null);
  const [view, setView] = useState("choose");
  const [preferences, setPreferences] = useState(defaults);
  const [selected, setSelected] = useState(null);
  const [hosts, setHosts] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [measureVisit, setMeasureVisit] = useState(false);
  const lock = useRef(false);
  const main = useRef(null);
  function clearIdentity() {
    setSession({ authenticated: false, configured: true });
    setMe(null);
    setSelected(null);
    setHosts(null);
    setView("choose");
    setNotice("");
  }
  const [api] = useState(() => createBetaApi(request, clearIdentity));
  const refresh = useCallback(async () => {
    const identity = await api.read("me");
    setMe(identity);
    setRevision((value) => value + 1);
  }, [api]);
  useEffect(() => {
    let active = true;
    api
      .session()
      .then(async (next) => {
        if (!active) return;
        setSession(next);
        if (next.authenticated) {
          const returned = new URL(location.href);
          const bookingId = returned.searchParams.get("booking");
          if (bookingId) setSelected({ id: bookingId });
          for (const parameter of [
            "payment_intent",
            "payment_intent_client_secret",
            "redirect_status",
          ])
            returned.searchParams.delete(parameter);
          history.replaceState(
            null,
            "",
            returned.pathname + returned.search + returned.hash,
          );
          await refresh();
        }
      })
      .catch((issue) => active && setError(issue.message));
    return () => {
      active = false;
    };
  }, [api, refresh]);
  useEffect(() => {
    if (!session?.authenticated || view === "account") return;
    const timer = setInterval(() => {
      void refresh().catch((issue) => setError(issue.message));
    }, 10000);
    return () => clearInterval(timer);
  }, [session?.authenticated, refresh, view]);
  useEffect(() => {
    main.current?.focus();
  }, [view, selected?.id]);
  async function run(action, payload, message) {
    if (lock.current) return null;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.act(action, payload);
      if (message) setNotice(message);
      await refresh();
      return result;
    } catch (issue) {
      setError(issue.message);
      return null;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  function navigate(next) {
    setView(next);
    setSelected(null);
    setError("");
    setNotice("");
  }
  function repeat(booking) {
    setPreferences({
      experience: booking.experience,
      style: booking.quote?.style || null,
      duration: booking.duration,
      format: booking.format,
      language: booking.language,
    });
    navigate("choose");
  }
  const roles = me?.roles || [];
  const configured = session?.configured === true;
  const signedIn = session?.authenticated === true && me;
  return (
    <div className="beta-shell">
      <a className="beta-skip" href="#beta-main">
        Skip to content
      </a>
      <header className="beta-header">
        <Link className="beta-brand" href="/beta">
          human
          <br />
          connection<span>.</span>
        </Link>
        {signedIn && (
          <nav aria-label="Your workspace">
            <button
              aria-current={view === "choose" ? "page" : undefined}
              onClick={() => navigate("choose")}
            >
              Find a moment
            </button>
            <button
              aria-current={view === "history" ? "page" : undefined}
              onClick={() => navigate("history")}
            >
              My sessions
            </button>
            <button
              aria-current={view === "saved" ? "page" : undefined}
              onClick={() => navigate("saved")}
            >
              Saved hosts
            </button>
            <button
              aria-current={view === "account" ? "page" : undefined}
              onClick={() => navigate("account")}
            >
              Account
            </button>
            <button
              aria-current={view === "host" ? "page" : undefined}
              onClick={() => navigate("host")}
            >
              {roles.includes("host") ? "Host studio" : "Become a host"}
            </button>
            {roles.some((role) => staffRoles.includes(role)) && (
              <button
                aria-current={view === "operations" ? "page" : undefined}
                onClick={() => navigate("operations")}
              >
                Operations
              </button>
            )}
          </nav>
        )}
        {session?.authenticated && (
          <button
            className="beta-text"
            disabled={busy}
            onClick={async () => {
              const signingOut = api.logout();
              clearIdentity();
              try {
                await signingOut;
              } catch {
                setError(
                  "Your page has been cleared. Sign-out could not be confirmed by the server. Reload and try signing out again.",
                );
              }
            }}
          >
            Sign out
          </button>
        )}
      </header>
      <p className="beta-notice">
        Staging workspace · Test payments only · Live host service is disabled
      </p>
      <div className="beta-service-note">
        Controlled beta workspace · Live service availability depends on
        approved hosts and configured providers.
      </div>
      <main id="beta-main" tabIndex={-1} ref={main}>
        {error && (
          <div className="beta-alert" role="alert">
            <span>{error}</span>
            <button onClick={() => setError("")} aria-label="Dismiss error">
              ×
            </button>
          </div>
        )}
        {notice && (
          <p className="beta-notice" role="status">
            {notice}
          </p>
        )}
        {!session || (session.authenticated && !me && !error) ? (
          <section className="beta-card" aria-busy="true">
            <h1>Opening your space…</h1>
            <p>Your account and permissions are being checked.</p>
          </section>
        ) : !signedIn ? (
          <section className="beta-welcome">
            <div>
              <p className="beta-eyebrow">SHORT, HOSTED HUMAN EXPERIENCES</p>
              <h1>
                A little human time,
                <br />
                <em>chosen by you.</em>
              </h1>
              <p>
                Share a laugh, talk about your day, or take a playful detour
                with a host who fits your chosen experience.
              </p>
              {configured ? (
                <>
                  <button
                    className="beta-primary"
                    onClick={() =>
                      location.assign(
                        new URL("/api/marketplace/auth/login", location.origin)
                          .href,
                      )
                    }
                  >
                    Sign in or create an account
                  </button>
                  <p className="beta-small">
                    Your sign-in provider also handles account recovery. Adults
                    18+, U.S. only.
                  </p>
                </>
              ) : (
                <>
                  <p className="beta-notice">
                    The account service is awaiting configuration. You can
                    explore the interactive demo while this workspace is
                    prepared.
                  </p>
                  <Link className="beta-primary" href="/">
                    Explore the demo
                  </Link>
                </>
              )}
            </div>
            <div className="beta-scene">
              <Image
                unoptimized
                src="/moments/laugh.webp"
                alt="Two people sharing a laugh"
                width={640}
                height={640}
              />
              <span>Make room for a good moment.</span>
            </div>
          </section>
        ) : selected ? (
          <BetaSession
            api={api}
            run={run}
            busy={busy}
            me={me}
            bookingId={selected.id}
            revision={revision}
            onBack={() => setSelected(null)}
            onRepeat={repeat}
            onOpen={setSelected}
            publicConfig={session.publicConfig || session}
          />
        ) : (
          <>
            {view === "choose" && (
              <CustomerChoice
                api={api}
                run={run}
                me={me}
                preferences={preferences}
                onChange={setPreferences}
                hosts={hosts}
                setHosts={setHosts}
                busy={busy}
                revision={revision}
                onSelect={setSelected}
                onExperienceSelected={() => {
                  if (measureVisit)
                    void request("/api/marketplace/visitor", {
                      method: "POST",
                      credentials: "same-origin",
                      headers: {
                        "Content-Type": "application/json",
                        "Idempotency-Key": crypto.randomUUID(),
                      },
                      body: JSON.stringify({ action: "select" }),
                    }).catch(() => {});
                }}
              />
            )}
            {view === "history" && (
              <BookingHistory
                api={api}
                revision={revision}
                onSelect={setSelected}
                onRepeat={repeat}
              />
            )}
            {view === "account" && <PrivacyAccount api={api} />}
            {view === "saved" && (
              <SavedHosts
                api={api}
                revision={revision}
                run={run}
                busy={busy}
                onChoose={(host) => {
                  setHosts([host]);
                  navigate("choose");
                }}
              />
            )}
            {view === "host" && (
              <HostWorkspace
                api={api}
                run={run}
                busy={busy}
                revision={revision}
                me={me}
                onSelect={setSelected}
              />
            )}
            {view === "operations" && (
              <OperationsWorkspace
                api={api}
                run={run}
                busy={busy}
                revision={revision}
                roles={roles}
              />
            )}
          </>
        )}
      </main>
      <footer className="beta-footer">
        <span>Adults 18+ · U.S. · Platonic, non-clinical experiences</span>
        <Link href="/">Interactive demo</Link>
        <span>
          Private calls use participant access. Recording is off by default.
        </span>
      </footer>
      <ClosureReceipt request={request} />
      {configured && (
        <VisitConsent request={request} onChange={setMeasureVisit} />
      )}
    </div>
  );
}
function CustomerChoice({
  api,
  run,
  me,
  preferences,
  onChange,
  hosts,
  setHosts,
  busy,
  revision,
  onSelect,
  onExperienceSelected,
}) {
  const { data: eligibility, error: eligibilityError } = useResource(
    api,
    "eligibility",
    null,
    revision,
  );
  const [consent, setConsent] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [noMatch, setNoMatch] = useState(false);
  const choicesRef = useRef(null);
  const eligible = me.eligible === true || eligibility?.eligible === true;
  const change = (next) => {
    onChange(next);
    setHosts(null);
    setNoMatch(false);
  };
  async function findHosts() {
    setSearching(true);
    setSearchError("");
    try {
      const result = await api.read("hosts", null, {
        ...preferences,
        style: preferences.style || "",
      });
      setHosts(result);
      setNoMatch(!result.length);
    } catch (issue) {
      setSearchError(issue.message);
    } finally {
      setSearching(false);
    }
  }
  async function reserve(hostId) {
    const result = await run("reserve", {
      ...preferences,
      ...(hostId ? { hostId } : {}),
    });
    if (result?.booking) onSelect(result.booking);
  }
  return (
    <section>
      <p className="beta-eyebrow">YOUR MOMENT, YOUR WAY</p>
      <h1>What do you feel like?</h1>
      <div
        className="beta-experience-grid"
        ref={choicesRef}
        tabIndex={-1}
        aria-label="Choose your experience"
      >
        {experiences.map((experience) => (
          <button
            className={
              "beta-experience " +
              (preferences.experience === experience.id ? "selected" : "")
            }
            aria-pressed={preferences.experience === experience.id}
            key={experience.id}
            onClick={() => {
              change({
                ...preferences,
                experience: experience.id,
                style: null,
              });
              onExperienceSelected?.();
              void api
                .act("track", {
                  name: "experience_selected",
                  experience: experience.id,
                })
                .catch(() => {});
            }}
          >
            <Image
              unoptimized
              src={"/moments/" + experience.id + ".webp"}
              alt=""
              width={640}
              height={640}
            />
            <span>
              <strong>{experience.name}</strong>
              <small>{experience.note}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="beta-choice-layout">
        <form
          className="beta-card"
          onSubmit={(event) => event.preventDefault()}
        >
          <h2>Make it your kind of time.</h2>
          <label>
            Conversation style
            <select
              value={preferences.style || ""}
              onChange={(event) =>
                change({ ...preferences, style: event.target.value || null })
              }
            >
              <option value="">Let it flow</option>
              {stylesFor(preferences.experience).map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name}
                </option>
              ))}
            </select>
          </label>
          <div className="beta-form-grid">
            <label>
              Time
              <select
                value={preferences.duration}
                onChange={(event) =>
                  change({
                    ...preferences,
                    duration: Number(event.target.value),
                  })
                }
              >
                <option value={15}>15 minutes</option>
                <option value={30}>30 minutes</option>
              </select>
            </label>
            <label>
              Format
              <select
                value={preferences.format}
                onChange={(event) =>
                  change({ ...preferences, format: event.target.value })
                }
              >
                <option value="video">Video</option>
                <option value="audio">Audio</option>
              </select>
            </label>
            <label>
              Language
              <select
                value={preferences.language}
                onChange={(event) =>
                  change({ ...preferences, language: event.target.value })
                }
              >
                <option>English</option>
                <option>Spanish</option>
              </select>
            </label>
          </div>
          <p className="beta-small">
            Beta prices start at $10 for 15 minutes and $18 for 30 minutes. Your
            accepted quote confirms the total before checkout.
          </p>
        </form>
        <div className="beta-card beta-choice-summary">
          <h2>
            {
              experiences.find(
                (experience) => experience.id === preferences.experience,
              )?.name
            }
          </h2>
          <p>
            {preferences.duration} minutes · {human(preferences.format)} ·{" "}
            {preferences.language}
          </p>
          {!eligible && (
            <div className="beta-eligibility">
              <h3>Before your first moment</h3>
              <label className="beta-checkbox">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  I am 18 or older, currently in the United States, and accept
                  the adults-only, platonic, non-clinical beta boundaries.
                </span>
              </label>
              <button
                className="beta-secondary"
                disabled={busy || !consent}
                onClick={() =>
                  run(
                    "customer-eligibility",
                    {
                      adult: true,
                      us: true,
                      accepted: true,
                      policyVersion: "beta-2026-11",
                    },
                    "Your eligibility acknowledgement is saved.",
                  )
                }
              >
                Save acknowledgement
              </button>
              {eligibilityError && (
                <p className="beta-small">{eligibilityError}</p>
              )}
            </div>
          )}
          <button
            className="beta-primary"
            disabled={busy || !eligible}
            onClick={() => reserve()}
          >
            Match me now
          </button>
          <button
            className="beta-secondary"
            disabled={searching || busy || !eligible}
            onClick={findHosts}
          >
            {searching ? "Checking availability…" : "I’ll choose a host"}
          </button>
          <p className="beta-small">
            Searching and host declines create no charge. Availability is
            checked again when a request is reserved.
          </p>
        </div>
      </div>
      {searchError && (
        <p className="beta-alert" role="alert">
          {searchError}
        </p>
      )}
      {noMatch && (
        <div className="beta-card" role="status">
          <h2>No host fits just now.</h2>
          <p>
            Try a different style, format or experience. Your language remains
            selected.
          </p>
          <button
            className="beta-secondary"
            onClick={() => {
              change({ ...preferences, style: null });
              choicesRef.current?.focus();
              choicesRef.current?.scrollIntoView({
                block: "center",
                behavior: "instant",
              });
            }}
          >
            Adjust my choices
          </button>
          <button className="beta-text" onClick={findHosts}>
            Check again
          </button>
        </div>
      )}
      {hosts?.length > 0 && (
        <section aria-label="Available hosts">
          <h2>Meet your kind of company.</h2>
          <div className="beta-host-grid">
            {hosts.map((host) => (
              <article className="beta-card" key={host.user_id}>
                {host.photo && (
                  <Image
                    unoptimized
                    className="beta-profile-photo"
                    src={
                      "/api/marketplace/media?kind=photo&id=" +
                      encodeURIComponent(host.photo.id)
                    }
                    alt={host.photo.alt_text}
                    width={160}
                    height={160}
                  />
                )}
                <h3>{host.display_name}</h3>
                {host.identityVerified && (
                  <p className="beta-small">
                    Identity verified · Experience reviewed
                  </p>
                )}
                <p>{host.biography}</p>
                {host.statistics && (
                  <p className="beta-small">
                    {host.statistics.delivered} delivered sessions ·{" "}
                    {host.statistics.ratings
                      ? Number(host.statistics.averageRating).toFixed(1) +
                        " / 5 from " +
                        host.statistics.ratings +
                        " ratings"
                      : "No public ratings yet"}
                    {host.repeatGuest ? " · You’ve met before" : ""}
                  </p>
                )}
                {host.intro && (
                  <div className="beta-introduction">
                    <p>Host introduction</p>
                    {host.intro.content_type.startsWith("video/") ? (
                      <video
                        controls
                        preload="none"
                        src={
                          "/api/marketplace/media?id=" +
                          encodeURIComponent(host.intro.id)
                        }
                      />
                    ) : (
                      <audio
                        controls
                        preload="none"
                        src={
                          "/api/marketplace/media?id=" +
                          encodeURIComponent(host.intro.id)
                        }
                      />
                    )}
                    <details>
                      <summary>Read the introduction</summary>
                      <p>{host.intro.transcript}</p>
                    </details>
                  </div>
                )}
                <p className="beta-small">
                  {parseList(host.languages).join(" · ")} ·{" "}
                  {parseList(host.formats).map(human).join(" · ")}
                </p>
                <button
                  className="beta-primary"
                  disabled={busy}
                  onClick={() => reserve(host.user_id)}
                >
                  Request {host.display_name}
                </button>
                <button
                  className="beta-text"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "favourite",
                      { hostId: host.user_id, saved: true },
                      "Host saved.",
                    )
                  }
                >
                  Save host
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
export function parseList(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value || "[]");
  } catch {
    return [];
  }
}
function BookingHistory({ api, revision, onSelect, onRepeat }) {
  const { data, error, loading } = useResource(api, "bookings", null, revision);
  return (
    <section>
      <p className="beta-eyebrow">YOUR HUMAN TIME</p>
      <h1>My sessions</h1>
      {error && <p className="beta-alert">{error}</p>}
      {loading && !data && <p>Loading your sessions…</p>}
      {data?.length === 0 && (
        <p className="beta-card">Your first moment is still ahead.</p>
      )}
      <div className="beta-booking-list">
        {data?.map((booking) => (
          <article className="beta-card beta-booking-row" key={booking.id}>
            <div>
              <span className="beta-status">{human(booking.status)}</span>
              <h2>
                {
                  experiences.find((item) => item.id === booking.experience)
                    ?.name
                }
              </h2>
              <p>
                {new Date(booking.created_at).toLocaleString()} ·{" "}
                {booking.duration} minutes · {human(booking.format)}
              </p>
              <strong>{money(booking.amount_cents)}</strong>
            </div>
            <div className="beta-actions">
              <button
                className="beta-primary"
                onClick={() => onSelect(booking)}
              >
                Session details
              </button>
              {[
                "COMPLETED",
                "CANCELLED",
                "PARTIAL_DELIVERY",
                "FAILED_SERVICE",
                "SAFETY_ENDED",
                "EXPIRED",
                "DECLINED",
              ].includes(booking.status) && (
                <button
                  className="beta-secondary"
                  onClick={() => onRepeat(booking)}
                >
                  Repeat experience
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
function SavedHosts({ api, revision, run, busy, onChoose }) {
  const { data, error } = useResource(api, "favourites", null, revision);
  return (
    <section>
      <h1>Your saved hosts</h1>
      {error && <p className="beta-alert">{error}</p>}
      {!data?.length && !error && (
        <p className="beta-card">
          Save a host after a good moment so you can find them again.
        </p>
      )}
      <div className="beta-host-grid">
        {data?.map((host) => (
          <article className="beta-card" key={host.user_id || host.host_id}>
            <h2>{host.display_name}</h2>
            <p>{host.biography}</p>
            <button
              className="beta-primary"
              onClick={() =>
                onChoose({ ...host, user_id: host.user_id || host.host_id })
              }
            >
              Choose a moment
            </button>
            <button
              className="beta-text"
              disabled={busy}
              onClick={() =>
                run(
                  "favourite",
                  { hostId: host.user_id || host.host_id, saved: false },
                  "Host removed from saved.",
                )
              }
            >
              Remove saved host
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
