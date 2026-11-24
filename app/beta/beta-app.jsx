"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  bookableExperiences,
  bookableStylesFor,
  experienceChoices,
  experiences,
} from "../../lib/catalog.mjs";
import { styleRecommendationMessages } from "../../lib/style-recommendation.mjs";
import {
  languageName,
  languageProficiency,
  normalizeLanguageTag,
  readHostLanguages,
} from "../../lib/conversation-languages.mjs";
import { createBetaApi, human, money } from "./beta-api.mjs";
import { HostWorkspace, OperationsWorkspace, useResource } from "./beta-panels";
import BetaSession from "./beta-session";
import {
  ClosureReceipt,
  PrivacyAccount,
  ReviewScores,
  VisitConsent,
  WrittenReviews,
} from "./beta-additions";

const defaults = {
  experience: null,
  style: null,
  duration: 15,
  format: "video",
  language: "en",
};
const staffRoles = ["admin", "host_reviewer", "safety", "finance"];
const workspaceViews = { customer: "choose", host: "host", staff: "operations" };
const independentActions = new Set(["end-session", "report", "block"]);
const activeBookings = new Set(["REQUESTED", "ACCEPTED", "READY", "LIVE"]);

function storeBookingInUrl(bookingId) {
  const url = new URL(location.href);
  if (bookingId) url.searchParams.set("booking", bookingId);
  else url.searchParams.delete("booking");
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
}

export default function BetaApp({ request = fetch, workspace = "customer" } = {}) {
  const [session, setSession] = useState(null);
  const [me, setMe] = useState(null);
  const [view, setView] = useState(workspaceViews[workspace]);
  const [preferences, setPreferences] = useState(defaults);
  const [selected, setSelected] = useState(null);
  const [preferredHost, setPreferredHost] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [measureVisit, setMeasureVisit] = useState(false);
  const lock = useRef(false);
  const independent = useRef(new Set());
  const identityRequests = useRef(0);
  const main = useRef(null);
  function clearIdentity() {
    setSession({ authenticated: false, configured: true });
    setMe(null);
    setSelected(null);
    storeBookingInUrl(null);
    setPreferredHost(null);
    setView(workspaceViews[workspace]);
    setNotice("");
  }
  const [api] = useState(() => createBetaApi(request, clearIdentity));
  const refresh = useCallback(async () => {
    const version = ++identityRequests.current;
    const identity = await api.read("me");
    if (version === identityRequests.current) setMe(identity);
  }, [api]);
  const openBooking = useCallback((booking) => {
    setSelected(booking);
    storeBookingInUrl(booking?.id);
  }, []);
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
            history.state,
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
  const hostAvailable = me?.hostAvailable === true;
  useEffect(() => {
    if (!hostAvailable) return;
    let current = true;
    let renewing = false;
    async function renew() {
      if (renewing) return;
      renewing = true;
      try {
        const presence = await api.act("heartbeat", {
          available: true,
          renew: true,
        });
        if (current && !presence?.available) await refresh();
      } catch {
        // The server's lease expires if the tab cannot renew it.
      } finally {
        renewing = false;
      }
    }
    const timer = setInterval(renew, 15000);
    document.addEventListener("visibilitychange", renewWhenVisible);
    function renewWhenVisible() {
      if (document.visibilityState === "visible") void renew();
    }
    return () => {
      current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", renewWhenVisible);
    };
  }, [api, hostAvailable, refresh]);
  useEffect(() => {
    main.current?.focus();
  }, [view, selected?.id]);
  async function run(action, payload, message, { onError } = {}) {
    const priority = independentActions.has(action);
    const actionKey = action + "|" + (payload?.bookingId || "");
    if (priority) {
      if (independent.current.has(actionKey)) return null;
      independent.current.add(actionKey);
    } else {
      if (lock.current) return null;
      lock.current = true;
      setBusy(true);
    }
    setError("");
    try {
      const result = await api.act(action, payload);
      if (message) setNotice(message);
      if (action === "heartbeat" && typeof result?.available === "boolean")
        setMe((current) =>
          current ? { ...current, hostAvailable: result.available } : current,
        );
      setRevision((value) => value + 1);
      void refresh().catch((issue) => setError(issue.message));
      return result;
    } catch (issue) {
      if (!onError?.(issue)) setError(issue.message);
      return null;
    } finally {
      if (priority) independent.current.delete(actionKey);
      else {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  function navigate(next) {
    setView(next);
    openBooking(null);
    setPreferredHost(null);
    setError("");
    setNotice("");
  }
  function repeat(booking) {
    const experience = bookableExperiences.find(
      ({ id }) => id === booking.experience,
    );
    const style =
      experience &&
      bookableStylesFor(experience.id).find(
        ({ id }) => id === booking.quote?.style,
      );
    setPreferences({
      experience: experience?.id ?? null,
      style: style?.id ?? null,
      duration: booking.duration,
      format: booking.format,
      language: booking.language,
    });
    navigate("choose");
  }
  const roles = me?.roles || [];
  const configured = session?.configured === true;
  const signedIn = session?.authenticated === true && me;
  const staffAccess = roles.some((role) => staffRoles.includes(role));
  const staffWorkspace = workspace === "staff";
  const signIn = "/api/marketplace/auth/login?workspace=" + workspace;
  if (staffWorkspace && signedIn && (!staffAccess || !me.staffStepUp))
    return (
      <main className="beta-shell">
        <section className="beta-card">
          <h1>Staff workspace</h1>
          <p>
            {staffAccess
              ? "A recent multi-factor sign-in is required."
              : "This account has no staff permissions."}
          </p>
          {staffAccess && (
            <a className="beta-primary" href={signIn}>Verify your sign-in</a>
          )}
          <Link className="beta-secondary" href="/beta">Customer workspace</Link>
        </section>
      </main>
    );
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
              aria-current={view === "updates" ? "page" : undefined}
              onClick={() => navigate("updates")}
            >
              Updates
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
            {staffAccess && (
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
        {signedIn && hostAvailable && (view !== "host" || selected) && (
          <HostRequestBanner
            api={api}
            revision={revision}
            hostId={me.id}
            openId={selected?.id}
            onOpen={openBooking}
          />
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
                {staffWorkspace
                  ? "Staff sign-in"
                  : workspace === "host"
                    ? "Host studio"
                    : <>A little human time,<br /><em>chosen by you.</em></>}
              </h1>
              <p>
                {staffWorkspace
                  ? "Use your assigned staff account and multi-factor sign-in."
                  : workspace === "host"
                    ? "Sign in to apply or manage your hosting workspace."
                    : "Choose a laugh, a listening ear, or a playful break with a human host."}
              </p>
              {configured ? (
                <>
                  <button
                    className="beta-primary"
                    onClick={() =>
                      location.assign(
                        new URL(signIn, location.origin).href,
                      )
                    }
                  >
                    {staffWorkspace ? "Staff sign-in" : "Sign in or create an account"}
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
            key={selected.id}
            api={api}
            run={run}
            busy={busy}
            me={me}
            bookingId={selected.id}
            revision={revision}
            onBack={() => openBooking(null)}
            onRepeat={repeat}
            onOpen={openBooking}
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
                preferredHost={preferredHost}
                onClearPreferredHost={() => setPreferredHost(null)}
                busy={busy}
                revision={revision}
                onSelect={openBooking}
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
                onSelect={openBooking}
                onRepeat={repeat}
              />
            )}
            {view === "account" && <PrivacyAccount api={api} />}
            {view === "updates" && (
              <PersonalUpdates
                api={api}
                revision={revision}
                onOpen={openBooking}
              />
            )}
            {view === "saved" && (
              <SavedHosts
                api={api}
                revision={revision}
                run={run}
                busy={busy}
                onChoose={(host) => {
                  navigate("choose");
                  setPreferredHost(host);
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
                onSelect={openBooking}
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
        {workspace === "customer" && <Link href="/host/login">Become a host</Link>}
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
  preferredHost,
  onClearPreferredHost,
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
  const {
    data: languages,
    error: languageError,
    loading: loadingLanguages,
  } = useResource(
    api,
    "languages",
    null,
    revision,
    {
      ...(preferences.experience ? { experience: preferences.experience } : {}),
      format: preferences.format,
      ...(preferredHost ? { hostId: preferredHost.user_id } : {}),
    },
    12000,
  );
  const [consent, setConsent] = useState(false);
  const [hosts, setHosts] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [noMatch, setNoMatch] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState(null);
  const [suggestionNotice, setSuggestionNotice] = useState("");
  const choicesRef = useRef(null);
  const previousExperience = useRef(preferences.experience);
  const searchVersion = useRef(0);
  const suggestionVersion = useRef(0);
  const experience = bookableExperiences.find(
    ({ id }) => id === preferences.experience,
  );
  const styles = experience ? bookableStylesFor(experience.id) : [];
  const selectedStyle = styles.find(({ id }) => id === preferences.style);
  const preferredLanguage = normalizeLanguageTag(preferences.language);
  const selectedLanguage = languages?.find(
    ({ tag }) => tag === preferredLanguage,
  );
  const canMatchLanguage = selectedLanguage?.availableNow === true;
  const eligible = me.eligible === true || eligibility?.eligible === true;
  const canRequest =
    eligible &&
    canMatchLanguage &&
    !searching &&
    !suggesting &&
    !busy;
  useEffect(
    () => () => {
      suggestionVersion.current++;
    },
    [],
  );
  useEffect(() => {
    if (previousExperience.current === preferences.experience) return;
    previousExperience.current = preferences.experience;
    choicesRef.current?.focus();
  }, [preferences.experience]);
  function resetSearch() {
    searchVersion.current++;
    setSearching(false);
    setHosts(null);
    setNoMatch(false);
    setSearchError("");
  }
  function change(next) {
    onChange(next);
    resetSearch();
  }
  function clearSuggestion() {
    suggestionVersion.current++;
    setSuggesting(false);
    setSuggestion(null);
    setSuggestionNotice("");
  }
  function trackChoice(name, experienceId) {
    void api.act("track", { name, experience: experienceId }).catch(() => {});
  }
  function selectExperience(experienceId) {
    clearSuggestion();
    change({ ...preferences, experience: experienceId, style: null });
    if (experienceId) {
      onExperienceSelected?.();
      trackChoice("experience_selected", experienceId);
    }
  }
  async function suggestStyle(requestedExperience) {
    const version = ++suggestionVersion.current;
    setSuggesting(true);
    setSuggestionNotice("Finding a style…");
    resetSearch();
    try {
      const pick = await api.read("style-recommendation", null, {
        experience: requestedExperience,
      });
      if (version !== suggestionVersion.current) return;
      const pickedExperience = bookableExperiences.find(
        ({ id }) => id === pick?.experience,
      );
      const style =
        pickedExperience &&
        bookableStylesFor(pickedExperience.id).find(({ id }) => id === pick?.style);
      if (!style || pickedExperience.id !== requestedExperience) {
        setSuggestionNotice(styleRecommendationMessages["no-fit"]);
        return;
      }
      onChange((current) => ({
        ...current,
        experience: pickedExperience.id,
        style: style.id,
      }));
      setSuggestion(style.id);
      trackChoice("style_selected", pickedExperience.id);
      setSuggestionNotice(
        [`Try ${style.name}.`, styleRecommendationMessages[pick.reason]]
          .filter(Boolean)
          .join(" "),
      );
    } catch {
      if (version === suggestionVersion.current)
        setSuggestionNotice("Surprise Me is unavailable. Try again or choose a style.");
    } finally {
      if (version === suggestionVersion.current) setSuggesting(false);
    }
  }
  async function findHosts() {
    if (!canRequest) return;
    trackChoice("browse_hosts_opened", experience.id);
    const version = ++searchVersion.current;
    setSearching(true);
    setSearchError("");
    setNoMatch(false);
    setHosts(null);
    try {
      const result = await api.read("hosts", null, {
        ...preferences,
        style: preferences.style || "",
        ...(preferredHost ? { hostId: preferredHost.user_id } : {}),
      });
      if (version !== searchVersion.current) return;
      const matches = preferredHost
        ? result.filter((host) => host.user_id === preferredHost.user_id)
        : result;
      setHosts(matches);
      setNoMatch(!matches.length);
    } catch (issue) {
      if (version === searchVersion.current) setSearchError(issue.message);
    } finally {
      if (version === searchVersion.current) setSearching(false);
    }
  }
  async function reserve(hostId) {
    if (!canRequest) return;
    resetSearch();
    const version = searchVersion.current;
    const result = await run(
      "reserve",
      { ...preferences, ...(hostId ? { hostId } : {}) },
      undefined,
      {
        onError(issue) {
          if (issue.code !== "NO_MATCH") return false;
          if (version === searchVersion.current) setNoMatch(true);
          return true;
        },
      },
    );
    if (result?.booking) onSelect(result.booking);
  }
  if (!experience)
    return (
      <section>
        <h1 ref={choicesRef} tabIndex={-1}>
          What do you feel like?
        </h1>
        <div
          className="beta-experience-grid"
          role="group"
          aria-label="Experience choices"
        >
          {experienceChoices.map((choice) => (
            <button
              className="beta-experience"
              key={choice.id}
              type="button"
              onClick={() => selectExperience(choice.id)}
            >
              <Image
                unoptimized
                src={"/moments/" + choice.id + ".webp"}
                alt=""
                width={640}
                height={640}
              />
              <span>
                <strong>{choice.name}</strong>
                <small>{choice.note}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="beta-style-result beta-small" role="status">
          {suggestionNotice}
        </p>
      </section>
    );
  return (
    <section>
      <h1
        ref={choicesRef}
        tabIndex={-1}
        aria-describedby={suggestionNotice ? "beta-style-recommendation" : undefined}
      >
        {experience.name}
      </h1>
      <button
        className="beta-text"
        type="button"
        onClick={() => selectExperience(null)}
      >
        Change experience
      </button>
      <div className="beta-choice-layout">
        <form
          className="beta-card"
          onSubmit={(event) => event.preventDefault()}
        >
          <h2>Make it your kind of time.</h2>
          {preferredHost && (
            <div className="beta-notice">
              Looking for {preferredHost.display_name}
              <button
                type="button"
                className="beta-text"
                onClick={() => {
                  onClearPreferredHost();
                  resetSearch();
                }}
              >
                Search all hosts
              </button>
            </div>
          )}
          <fieldset className="beta-style-picker">
            <legend>Conversation style (optional)</legend>
            <div className="beta-style-options">
              {styles.map((style) => (
                <button
                  className="beta-style-choice"
                  type="button"
                  key={style.id}
                  aria-pressed={selectedStyle?.id === style.id && !suggestion}
                  onClick={() => {
                    clearSuggestion();
                    const next = selectedStyle?.id === style.id && !suggestion
                      ? null
                      : style.id;
                    change({ ...preferences, style: next });
                    if (next) trackChoice("style_selected", experience.id);
                  }}
                >
                  <strong>{style.name}</strong>
                  <span>{style.note}</span>
                </button>
              ))}
              <button
                className="beta-style-choice beta-style-surprise"
                type="button"
                aria-pressed={Boolean(suggestion)}
                aria-label="Surprise Me"
                aria-describedby="beta-style-surprise-note"
                disabled={suggesting}
                onClick={() => suggestStyle(experience.id)}
              >
                <strong>Surprise Me</strong>
                <span id="beta-style-surprise-note">
                  Suggest a style from your past completed sessions and feedback.
                </span>
              </button>
            </div>
            <p
              id="beta-style-recommendation"
              className="beta-style-result beta-small"
              role="status"
            >
              {suggestionNotice}
            </p>
          </fieldset>
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
              Conversation language
              <select
                value={selectedLanguage?.tag || ""}
                disabled={loadingLanguages || !languages?.length}
                aria-describedby="beta-language-status"
                onChange={(event) => {
                  change({ ...preferences, language: event.target.value });
                  trackChoice("language_filter_applied", experience.id);
                }}
              >
                <option value="" disabled>
                  {loadingLanguages ? "Checking languages…" : "Choose a language"}
                </option>
                {languages?.map(({ tag, label, availableNow }) => (
                  <option key={tag} value={tag}>
                    {label}
                    {availableNow ? "" : " · unavailable now"}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="beta-small">
            Conversation language matches you with a host. The beta interface
            and shared prompts are in English.
          </p>
          <div id="beta-language-status" className="beta-small" role="status">
            {languageError ||
              (languages?.length === 0
                ? "Approved hosts haven’t listed a language for these choices yet."
                : selectedLanguage && !canMatchLanguage
                  ? "Hosts who speak this language are unavailable right now."
                  : "")}
          </div>
        </form>
        <div className="beta-card beta-choice-summary">
          <h2>Your session details</h2>
          <p>
            {preferences.duration} minutes · {human(preferences.format)} ·{" "}
            {selectedLanguage?.label || "Choose a language"}
          </p>
          <p className="beta-small">
            {selectedStyle?.name ?? "Conversation style is optional."}
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
            disabled={!canRequest}
            onClick={preferredHost ? findHosts : () => reserve()}
          >
            {preferredHost
              ? searching
                ? "Checking availability…"
                : "Check saved host availability"
              : "Match me now"}
          </button>
          {!preferredHost && (
            <button
              className="beta-secondary"
              disabled={!canRequest}
              onClick={findHosts}
            >
              {searching ? "Checking availability…" : "I’ll choose a host"}
            </button>
          )}
          <p className="beta-small">
            Test prices start at $10 for 15 minutes and $18 for 30 minutes. You’ll
            see the total after a host accepts. Searching and declines create
            no charge.
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
            {preferredHost
              ? `${preferredHost.display_name} is unavailable for these choices. You can search all hosts or check again later.`
              : "Keep your choices and check again later, or try a different format, language or experience."}
          </p>
          <button
            className="beta-secondary"
            onClick={() => {
              choicesRef.current?.focus();
              choicesRef.current?.scrollIntoView({
                block: "center",
                behavior: "instant",
              });
            }}
          >
            Adjust my choices
          </button>
          <button className="beta-text" disabled={!canRequest} onClick={findHosts}>
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
                  <>
                    <p className="beta-small">
                      {host.statistics.delivered} delivered sessions
                      {host.repeatGuest ? " · You’ve met before" : ""}
                    </p>
                    <ReviewScores statistics={host.statistics} />
                    <WrittenReviews reviews={host.writtenReviews} />
                  </>
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
                  {readHostLanguages(host.languages)
                    .map(({ tag, proficiency }) =>
                      proficiency
                        ? `${languageName(tag)} (${languageProficiency[proficiency]})`
                        : languageName(tag),
                    )
                    .join(" · ")}{" "}
                  ·{" "}
                  {parseList(host.formats).map(human).join(" · ")}
                </p>
                <button
                  className="beta-primary"
                  disabled={!canRequest}
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
                {activeBookings.has(booking.status)
                  ? "Resume session"
                  : booking.review_saved
                    ? "View session review"
                    : booking.review_eligible
                      ? "Review this session"
                      : "Session details"}
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
                  {bookableExperiences.some(({ id }) => id === booking.experience)
                    ? "Repeat experience"
                    : "Find a new moment"}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function HostRequestBanner({ api, revision, hostId, openId, onOpen }) {
  const { data } = useResource(api, "bookings", null, revision, undefined, 4000);
  const request = data?.find(
    (entry) => entry.status === "REQUESTED" && entry.host_id === hostId,
  );
  if (!request || request.id === openId) return null;
  return (
    <div className="beta-service-note">
      <span role="status">You have a new session request.</span>{" "}
      <button className="beta-text" onClick={() => onOpen(request)}>
        View request
      </button>
    </div>
  );
}

const updateLabels = {
  host_request: "New session request",
  accept: "Session request accepted",
  decline: "Session request declined",
  cancel: "Session cancelled",
  booking_expired: "Session request or quote expired",
  session_ready: "Ready to join",
  payment_confirmed: "Test payment confirmed",
  refund_approved: "Refund approved",
  refund_declined: "Refund request declined",
  refund_confirmed: "Test refund confirmed",
  tip_refund_confirmed: "Test tip refund confirmed",
  host_verification: "Host verification updated",
  operations_alert: "Staff alert",
};

function PersonalUpdates({ api, revision, onOpen }) {
  const notifications = useResource(api, "notifications", null, revision);
  const reports = useResource(api, "my-reports", null, revision);
  const appeals = useResource(api, "my-appeals", null, revision);
  return (
    <section>
      <h1>Your updates</h1>
      <UpdateList
        title="Booking and account"
        resource={notifications}
        empty="New booking and account updates will appear here."
      >
        {(item) => (
          <>
            <strong>{updateLabels[item.kind] || human(item.kind)}</strong>
            {item.booking_id && (
              <button
                className="beta-text"
                onClick={() => onOpen({ id: item.booking_id })}
              >
                View session
              </button>
            )}
          </>
        )}
      </UpdateList>
      <UpdateList
        title="Safety reports"
        resource={reports}
        empty="You have no submitted safety reports."
      >
        {(item) => (
          <>
            <strong>{human(item.category)}</strong>
            <span className="beta-status">{human(item.status)}</span>
          </>
        )}
      </UpdateList>
      {(appeals.data?.length > 0 || appeals.error) && (
        <UpdateList title="Host appeals" resource={appeals}>
          {(item) => (
            <>
              <span className="beta-status">{human(item.status)}</span>
              <p>{item.reason}</p>
              {item.resolution && <p>{item.resolution}</p>}
            </>
          )}
        </UpdateList>
      )}
    </section>
  );
}

function UpdateList({ title, resource, empty, children }) {
  const { data, error, loading } = resource;
  return (
    <section className="beta-card">
      <h2>{title}</h2>
      {error && <p className="beta-alert" role="alert">{error}</p>}
      {loading && <p>Loading updates…</p>}
      {data?.length === 0 && <p>{empty}</p>}
      {data?.length > 0 && (
        <ul className="beta-booking-list">
          {data.map((item) => (
            <li className="beta-booking-row" key={item.id}>
              <div>{children(item)}</div>
              <time
                className="beta-small"
                dateTime={new Date(item.created_at).toISOString()}
              >
                {new Date(item.created_at).toLocaleString()}
              </time>
            </li>
          ))}
        </ul>
      )}
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
