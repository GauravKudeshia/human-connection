"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import { experiences, styleName, stylesFor } from "../../lib/catalog.mjs";
import {
  languageName,
  languageProficiency,
  maxHostLanguages,
  normalizeLanguageTag,
  readHostLanguages,
} from "../../lib/conversation-languages.mjs";
import { BETA_PRICE_POLICY } from "../../lib/marketplace/pricing.mjs";
import { maxIntroCaptionBytes } from "../../lib/marketplace/intro-captions.mjs";
import { human, money } from "./beta-api.mjs";
import HostIntroduction from "./beta-host-introduction";
import {
  HostQuality,
  ProfilePhotoUpload,
  TransferWorkspace,
  PhotoReview,
  PrivacyReview,
} from "./beta-additions";

import { useResource } from "./beta-resource";
import { HostSchedule, ScheduledReservations } from "./beta-schedule";

export { useResource } from "./beta-resource";

export function HostWorkspace({ api, run, busy, revision, me, onSelect }) {
  const available = me.hostAvailable === true;
  const {
    data: application,
    loading: applicationLoading,
    error,
  } = useResource(
    api,
    "application",
    null,
    revision,
  );
  const {
    data: bookings,
    error: bookingsError,
    loading: bookingsLoading,
  } = useResource(
    api,
    "bookings",
    null,
    revision,
    undefined,
    available ? 4000 : 8000,
  );
  const { data: intros } = useResource(api, "my-intros", null, revision);
  const { data: earnings } = useResource(api, "host-earnings", null, revision);
  const {
    data: draft,
    error: draftError,
    loading: draftLoading,
  } = useResource(api, "host-draft", null, revision);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const [uploadNotice, setUploadNotice] = useState("");
  const [transcript, setTranscript] = useState("");
  const [consent, setConsent] = useState(false);
  const introSubmission = useRef(null);
  const [appeal, setAppeal] = useState("");
  const isHost = me.roles.includes("host");
  const approved = isHost && application?.status === "APPROVED";
  const canApply =
    !application || ["DRAFT", "REJECTED"].includes(application.status);
  const hostBookings = bookings?.filter((booking) => booking.host_id === me.id) || [];
  const openBookings = hostBookings.filter((booking) =>
    hostOpenStates.has(booking.status),
  );
  const historyBookings = hostBookings.filter(
    (booking) => !hostOpenStates.has(booking.status),
  );
  function changeAvailability(next) {
    return run(
      "heartbeat",
      { available: next },
      next ? "Availability is on." : "Availability is off.",
    );
  }
  async function upload(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.clip.files[0];
    const durationSeconds = Number(form.elements.duration.value);
    const captionFile = form.elements.captions.files[0];
    const captionLanguage = normalizeLanguageTag(form.elements.captionLanguage.value);
    if (
      !file ||
      file.size > 8 * 1024 * 1024 ||
      ![
        "audio/mpeg",
        "audio/mp4",
        "audio/ogg",
        "audio/webm",
        "video/mp4",
        "video/webm",
      ].includes(file.type)
    ) {
      setUploadError("Choose a supported audio or video clip under 8 MB.");
      return;
    }
    if (captionFile && (!file.type.startsWith("video/") || !captionLanguage || captionFile.size > maxIntroCaptionBytes)) {
      setUploadError("For video captions, choose a WebVTT file under 16 KiB and enter its language code.");
      return;
    }
    const fields = [file, captionFile, captionLanguage, durationSeconds, transcript, consent];
    const previous = introSubmission.current;
    const key = previous?.fields.every((value, index) => value === fields[index]) ? previous.key : crypto.randomUUID();
    introSubmission.current = { key, fields };
    setUploading(true);
    setUploadError("");
    setUploadNotice("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 8192)
        binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
      const response = await fetch("/api/marketplace/media", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          contentType: file.type,
          transcript,
          consent,
          durationSeconds,
          base64: btoa(binary),
          ...(captionFile ? { captions: { language: captionLanguage, text: await captionFile.text() } } : {}),
        }),
      });
      const body = await response.json();
      if (body.error?.code === "UPLOAD_FAILED" || body.result?.status === "FAILED") {
        introSubmission.current = null;
        throw new Error("The introduction could not be stored. Try the upload again.");
      }
      if (!response.ok)
        throw new Error(
          body.error?.message || "Your introduction could not be uploaded.",
        );
      introSubmission.current = null;
      form.reset();
      setConsent(false);
      setTranscript("");
      setUploadNotice("Your introduction is submitted for review.");
    } catch (issue) {
      setUploadError(issue.message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <section>
      <h1>{isHost ? "Host studio" : "Become a host"}</h1>
      {!isHost && (
        <p>
          Apply for the experiences you can deliver. Identity checks and an
          experience review are required before paid bookings.
        </p>
      )}
      {error && (
        <p className="beta-alert" role="alert">
          {error}
        </p>
      )}
      {approved && (
        <section className="beta-card">
          <h2>Availability</h2>
          <p>
            Keep the beta open to receive requests. Availability also requires
            current verification and experience certification.
          </p>
          <div className="beta-actions">
            <button
              role="switch"
              aria-checked={available}
              className={available ? "beta-primary" : "beta-secondary"}
              disabled={busy}
              onClick={() => changeAvailability(!available)}
            >
              Accept immediate requests
            </button>
            <span className="beta-status" aria-hidden="true">
              {available ? "Availability on" : "Availability off"}
            </span>
          </div>
        </section>
      )}
      {isHost && (
        <section aria-labelledby="beta-host-requests">
          <h2 id="beta-host-requests">Requests and active sessions</h2>
          {bookingsError && (
            <p className="beta-alert" role="alert">
              Could not refresh requests. {bookingsError}
            </p>
          )}
          {openBookings.length ? (
            <HostBookings
              bookings={openBookings}
              run={run}
              busy={busy}
              onSelect={onSelect}
            />
          ) : !bookingsError && (
            <p className="beta-small" role="status">
              {bookingsLoading
                ? "Loading requests…"
                : "New requests appear here when you are available."}
            </p>
          )}
        </section>
      )}
      {approved && (
        <>
          <ScheduledReservations
            api={api}
            run={run}
            busy={busy}
            revision={revision}
            onSelect={onSelect}
            hostView
          />
          <HostSchedule api={api} run={run} busy={busy} revision={revision} />
        </>
      )}
      {earnings && (
        <div className="beta-card">
          <h2>Recorded earnings</h2>
          <p>
            Base earnings {money(earnings.baseCents)} · Tip principal{" "}
            {money(earnings.tipCents)}
          </p>
          <p className="beta-small">
            These amounts come from the staging journal. Payout activation
            requires the approved merchant setup.
          </p>
        </div>
      )}
      {isHost && <HostQuality api={api} revision={revision} />}
      {approved && (
        <HostProfileSettings
          api={api}
          profile={application}
          busy={busy}
          run={run}
        />
      )}
      {application && (
        <article className="beta-card">
          <span className="beta-status">
            {applicationLabels[application.status] || human(application.status)}
          </span>
          <h2>{application.display_name}</h2>
          <p>{application.biography}</p>
          {application.review_reason && (
            <p className="beta-notice">
              Reviewer feedback · {application.review_reason}
            </p>
          )}
        </article>
      )}
      {canApply && (applicationLoading || draftLoading) && (
        <p role="status">Loading your application…</p>
      )}
      {canApply && draftError && (
        <p className="beta-alert" role="alert">
          {draftError}
        </p>
      )}
      {canApply && (
        <HostApplicationEntry
          key={me.id}
          run={run}
          busy={busy}
          application={application}
          draft={draft}
          ready={!applicationLoading && !draftLoading && !error && !draftError}
        />
      )}
      {application && <ProfilePhotoUpload api={api} revision={revision} />}
      {application && (
        <section className="beta-card">
          <h2>Your introduction</h2>
          <p>
            A short, 15–30-second introduction helps guests hear your style.
            Include an accurate transcript.
          </p>
          {intros?.[0] && (
            <p className="beta-status">
              Introduction · {human(intros[0].status)}
            </p>
          )}
          <form onSubmit={upload}>
            <label>
              Audio or video clip
              <input
                name="clip"
                type="file"
                accept="audio/mpeg,audio/mp4,audio/ogg,audio/webm,video/mp4,video/webm"
                required
              />
            </label>
            <label>
              Clip duration in seconds
              <input
                name="duration"
                type="number"
                min="15"
                max="30"
                required
              />
            </label>
            <label>
              Transcript
              <textarea
                value={transcript}
                onChange={(event) => setTranscript(event.target.value)}
                maxLength={2000}
                required
              />
            </label>
            <fieldset>
              <legend>Video captions</legend>
              <p className="beta-small">Guests can play a video after its timed captions pass review. An approved video without captions is shown as text.</p>
              <div className="beta-form-grid">
                <label>
                  WebVTT caption file
                  <input type="file" name="captions" accept=".vtt,text/vtt" />
                </label>
                <label>
                  Caption language code
                  <input type="text" name="captionLanguage" placeholder="en or hi" maxLength={64} />
                </label>
              </div>
            </fieldset>
            <label className="beta-checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(event) => setConsent(event.target.checked)}
              />
              <span>
                I created this introduction or have permission to publish it. I consent to using the clip,
                transcript and any captions on my host profile after approval.
              </span>
            </label>
            <button
              className="beta-primary"
              disabled={busy || uploading || !consent || !transcript.trim()}
            >
              {uploading ? "Uploading…" : "Submit introduction"}
            </button>
          </form>
          {uploadError && (
            <p className="beta-alert" role="alert">
              {uploadError}
            </p>
          )}
          {uploadNotice && (
            <p className="beta-notice" role="status">
              {uploadNotice}
            </p>
          )}
        </section>
      )}
      {application &&
        ["REJECTED", "SUSPENDED"].includes(application.status) && (
          <form
            className="beta-card"
            onSubmit={async (event) => {
              event.preventDefault();
              if (
                await run(
                  "host-appeal",
                  { reason: appeal },
                  "Your appeal is awaiting review.",
                )
              )
                setAppeal("");
            }}
          >
            <h2>Ask for another review</h2>
            <label>
              Appeal explanation
              <textarea
                value={appeal}
                onChange={(event) => setAppeal(event.target.value)}
                maxLength={2000}
                required
              />
            </label>
            <button
              className="beta-secondary"
              disabled={busy || !appeal.trim()}
            >
              Submit appeal
            </button>
          </form>
        )}
      {isHost && historyBookings.length > 0 && (
        <details className="beta-card">
          <summary>Past hosted sessions</summary>
          <HostBookings
            bookings={historyBookings}
            run={run}
            busy={busy}
            onSelect={onSelect}
          />
        </details>
      )}
    </section>
  );
}

const hostOpenStates = new Set(["REQUESTED", "ACCEPTED", "READY", "LIVE"]);
const applicationLabels = {
  SUBMITTED: "Application received",
  IDENTITY_PENDING: "Identity verification pending",
  REVIEW_PENDING: "Pending review",
};

function HostBookings({ bookings, run, busy, onSelect }) {
  return (
    <div className="beta-booking-list">
      {bookings.map((booking) => (
        <article className="beta-card beta-booking-row" key={booking.id}>
          <div>
            <span className="beta-status">{human(booking.status)}</span>
            <h3>{experiences.find(({ id }) => id === booking.experience)?.name}</h3>
            <p>
              {booking.duration} minutes · {human(booking.format)} ·{" "}
              {languageName(booking.language) || booking.language}
            </p>
          </div>
          <div className="beta-actions">
            {booking.status === "REQUESTED" && (
              <>
                <button
                  className="beta-primary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "accept",
                      { bookingId: booking.id },
                      "Request accepted.",
                    )
                  }
                >
                  Accept request
                </button>
                <button
                  className="beta-secondary"
                  disabled={busy}
                  onClick={() =>
                    run(
                      "decline",
                      { bookingId: booking.id },
                      "Request declined.",
                    )
                  }
                >
                  Decline
                </button>
              </>
            )}
            <button className="beta-text" onClick={() => onSelect(booking)}>
              Open session
            </button>
          </div>
        </article>
      ))}
    </div>
  );
}

function LanguageFields({ languages, onChange, disabled }) {
  const [input, setInput] = useState("");
  const [proficiency, setProficiency] = useState("");
  const [message, setMessage] = useState("");
  const examplesId = useId();
  function addLanguage() {
    const tag = normalizeLanguageTag(input);
    if (!tag) {
      setMessage("Enter a recognized language code, such as hi for Hindi.");
      return;
    }
    const previous = languages.find((entry) => entry.tag === tag);
    if (!previous && languages.length >= maxHostLanguages) {
      setMessage(`Select up to ${maxHostLanguages} languages.`);
      return;
    }
    onChange([
      ...languages.filter((entry) => entry.tag !== tag),
      { tag, proficiency: proficiency || null },
    ]);
    setInput("");
    setProficiency("");
    setMessage(previous ? "Speaking proficiency updated." : "Language added.");
  }
  return (
    <fieldset disabled={disabled}>
      <legend>Languages you can host in</legend>
      <p className="beta-small">
        Add each language you are comfortable hosting in. Guests can see your
        self-reported proficiency.
      </p>
      <div className="beta-form-grid">
        <label>
          Language code
          <input
            value={input}
            maxLength={64}
            list={examplesId}
            placeholder="For example, hi or es-MX"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                addLanguage();
              }
            }}
          />
        </label>
        <datalist id={examplesId}>
          {["en", "hi", "bn", "es", "ar", "fr"].map((tag) => (
            <option key={tag} value={tag}>{languageName(tag)}</option>
          ))}
        </datalist>
        <label>
          Speaking proficiency
          <select
            value={proficiency}
            onChange={(event) => setProficiency(event.target.value)}
          >
            <option value="">Optional</option>
            {Object.entries(languageProficiency).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </label>
      </div>
      <button
        type="button"
        className="beta-secondary"
        disabled={!input.trim()}
        onClick={addLanguage}
      >
        Add or update language
      </button>
      <p className="beta-small" role="status">
        {message}
      </p>
      <ul>
        {languages.map(({ tag, proficiency: level }) => (
          <li key={tag}>
            {languageName(tag)}
            {level ? ` · ${languageProficiency[level]}` : ""}{" "}
            <button
              type="button"
              className="beta-text"
              aria-label={`Remove ${languageName(tag)}`}
              onClick={() => {
                onChange(languages.filter((entry) => entry.tag !== tag));
                setMessage("Language removed.");
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

function HostProfileFields({ name, setName, bio, setBio, topics, setTopics }) {
  return (
    <>
      <div className="beta-form-grid">
        <label>
          Public display name
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required />
        </label>
        <label>
          Biography
          <textarea value={bio} onChange={(event) => setBio(event.target.value)} maxLength={1000} required />
        </label>
      </div>
      <label>
        Conversation topics (optional)
        <input value={topics} onChange={(event) => setTopics(event.target.value)} maxLength={335} />
        <span className="beta-small">Separate up to eight topics with commas. Keep each topic to 40 characters.</span>
      </label>
    </>
  );
}

function HostStyleFields({ styles, onChange }) {
  return (
    <fieldset>
      <legend>Conversation styles</legend>
      <div className="beta-form-grid">
        {experiences.map((experience) => (
          <div key={experience.id}>
            <h4>{experience.name}</h4>
            {stylesFor(experience.id).map((style) => (
              <label className="beta-checkbox" key={style.id}>
                <input type="checkbox" checked={styles.includes(style.id)} onChange={() => onChange(toggleChoice(styles, style.id))} />
                {style.name}
              </label>
            ))}
          </div>
        ))}
      </div>
    </fieldset>
  );
}

function HostFormatFields({ formats, onChange }) {
  return (
    <fieldset>
      <legend>Formats you offer</legend>
      {["audio", "video"].map((format) => (
        <label className="beta-checkbox" key={format}>
          <input type="checkbox" checked={formats.includes(format)} onChange={() => onChange(toggleChoice(formats, format))} />
          {human(format)}
        </label>
      ))}
    </fieldset>
  );
}

const toggleChoice = (list, item) =>
  list.includes(item) ? list.filter((value) => value !== item) : [...list, item];
const splitTopics = (value) => value.split(",").map((topic) => topic.trim()).filter(Boolean);

function HostProfileSettings({ api, profile, busy, run }) {
  const [name, setName] = useState(profile.display_name);
  const [bio, setBio] = useState(profile.biography);
  const [topics, setTopics] = useState(() => applicationChoices(null, profile.interests, []).join(", "));
  const [languages, setLanguages] = useState(() => readHostLanguages(profile.languages));
  const [formats, setFormats] = useState(() => applicationChoices(null, profile.formats, []));
  const [styles, setStyles] = useState(() => applicationChoices(null, profile.styles, []));
  const [version, setVersion] = useState(profile.updated_at);
  const [requiresReload, setRequiresReload] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState("");
  const conflict = requiresReload || profile.updated_at > version;
  async function loadLatest() {
    setReloading(true);
    setReloadError("");
    try {
      const latest = await api.read("application");
      if (latest?.status !== "APPROVED" || latest.updated_at <= version)
        throw new Error("The updated profile could not be loaded. Try again.");
      setName(latest.display_name);
      setBio(latest.biography);
      setTopics(applicationChoices(null, latest.interests, []).join(", "));
      setLanguages(readHostLanguages(latest.languages));
      setFormats(applicationChoices(null, latest.formats, []));
      setStyles(applicationChoices(null, latest.styles, []));
      setVersion(latest.updated_at);
      setRequiresReload(false);
    } catch (issue) {
      setReloadError(issue.message);
    } finally {
      setReloading(false);
    }
  }
  return (
    <form
      className="beta-card"
      onSubmit={async (event) => {
        event.preventDefault();
        if (conflict || reloading) return;
        const result = await run(
          "host-profile-edit",
          {
            displayName: name, biography: bio, interests: splitTopics(topics),
            languages, formats, styles, version,
          },
          "Your host profile was updated.",
          {
            onError(issue) {
              if (issue.code !== "PROFILE_CHANGED") return false;
              setRequiresReload(true);
              return true;
            },
          },
        );
        if (result?.saved) setVersion(result.version);
      }}
    >
      <h2>Edit your host profile</h2>
      <p>These details help guests decide whether your conversations are a good fit.</p>
      {conflict && (
        <div className="beta-notice">
          <p role="status">The saved profile changed. Your unsaved edits are still here. Loading the latest profile will replace the fields below.</p>
          <button type="button" className="beta-secondary" disabled={busy || reloading} onClick={loadLatest}>
            {reloading ? "Loading profile…" : "Load latest profile"}
          </button>
          {reloadError && <p role="alert">{reloadError}</p>}
        </div>
      )}
      <fieldset disabled={busy || reloading}>
        <legend>Public host details</legend>
        <HostProfileFields {...{ name, setName, bio, setBio, topics, setTopics }} />
        <LanguageFields languages={languages} onChange={setLanguages} disabled={busy} />
        <HostFormatFields formats={formats} onChange={setFormats} />
        <HostStyleFields styles={styles} onChange={setStyles} />
        <button className="beta-primary" disabled={conflict || !languages.length || !formats.length}>
          Save profile
        </button>
      </fieldset>
    </form>
  );
}

function HostApplicationEntry({ ready, application, draft, ...props }) {
  const [seed, setSeed] = useState(null);
  // Seed after the first successful read. Later draft saves and polling
  // failures must not reset the current stage or unsaved form values.
  if (!seed && ready) setSeed({ application, draft });
  return seed && (
    <HostApplication
      {...seed}
      {...props}
      hasDraft={Boolean(draft || seed.draft)}
      busy={props.busy || !ready}
    />
  );
}

const applicationSteps = [
  "Eligibility",
  "Profile and interests",
  "Languages",
  "Formats and availability",
  "Test prices",
  "Conduct and consent",
  "Review application",
];

function applicationChoices(draftValues, profileValues, fallback) {
  if (Array.isArray(draftValues)) return draftValues;
  try {
    const parsed = JSON.parse(profileValues || "null");
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function HostApplication({ run, busy, application, draft, hasDraft }) {
  const [step, setStep] = useState(0);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [name, setName] = useState(
    draft?.displayName ?? application?.display_name ?? "",
  );
  const [bio, setBio] = useState(draft?.biography ?? application?.biography ?? "");
  const [topics, setTopics] = useState(() =>
    applicationChoices(draft?.interests, application?.interests, []).join(", "),
  );
  const [languages, setLanguages] = useState(() =>
    readHostLanguages(draft?.languages ?? application?.languages ?? []),
  );
  const [formats, setFormats] = useState(() =>
    applicationChoices(draft?.formats, application?.formats, ["video"]),
  );
  const [styles, setStyles] = useState(() =>
    applicationChoices(draft?.styles, application?.styles, []),
  );
  const [accepted, setAccepted] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const progressId = useId();
  const heading = useRef(null);
  const previousStep = useRef(step);
  useEffect(() => {
    if (previousStep.current === step) return;
    previousStep.current = step;
    heading.current?.focus();
  }, [step]);

  const choices = { displayName: name, biography: bio, interests: splitTopics(topics), languages, formats, styles };
  const complete = [
    ageConfirmed,
    Boolean(name.trim() && bio.trim()),
    languages.length > 0,
    formats.length > 0,
    true,
    accepted,
    true,
  ];
  const lastStep = applicationSteps.length - 1;

  const locked = busy || submitted;
  async function advance(event) {
    event.preventDefault();
    if (locked || !complete[step]) return;
    if (step < lastStep) {
      setStep(step + 1);
      return;
    }
    const incomplete = complete.indexOf(false);
    if (incomplete !== -1) {
      setStep(incomplete);
      return;
    }
    const result = await run(
      "host-submit",
      {
        ...choices,
        adult: ageConfirmed,
        policyVersion: "beta-2026-11",
        trainingVersion: "beta-2026-11",
      },
      "Your host application is submitted.",
    );
    if (result) setSubmitted(true);
  }

  return (
    <form className="beta-card" onSubmit={advance}>
      <h2>Your hosting application</h2>
      <p id={progressId} className="beta-small">
        Step {step + 1} of {applicationSteps.length}{hasDraft ? " · Draft" : ""}
      </p>
      <progress
        className="beta-application-progress"
        aria-label="Application progress"
        value={step + 1}
        max={applicationSteps.length}
      />
      <h3 ref={heading} tabIndex={-1} aria-describedby={progressId}>
        {applicationSteps[step]}
      </h3>
      {step === 0 && (
        <>
          <p>Use your existing account. Hosts must be 18 or older. U.S. eligibility and identity are reviewed before approval.</p>
          <label className="beta-checkbox">
            <input
              type="checkbox"
              checked={ageConfirmed}
              onChange={(event) => setAgeConfirmed(event.target.checked)}
            />
            <span>I am 18 or older.</span>
          </label>
        </>
      )}
      {step === 1 && (
        <>
          <HostProfileFields {...{ name, setName, bio, setBio, topics, setTopics }} />
          <p className="beta-small">After submitting, upload a profile photo and short introduction from your host studio.</p>
          <HostStyleFields styles={styles} onChange={setStyles} />
        </>
      )}
      {step === 2 && (
        <LanguageFields languages={languages} onChange={setLanguages} disabled={busy} />
      )}
      {step === 3 && (
        <>
          <p>Choose at least one format. Once approved, use the availability switch in your studio to receive immediate requests.</p>
          <HostFormatFields formats={formats} onChange={setFormats} />
        </>
      )}
      {step === 4 && (
        <>
          <p>
            The sandbox rate is {money(BETA_PRICE_POLICY.prices[15])} for 15
            minutes and {money(BETA_PRICE_POLICY.prices[30])} for 30 minutes.
          </p>
          <p className="beta-small">The staging journal records simulated earnings. Live host earnings and payouts require an approved merchant setup.</p>
        </>
      )}
      {step === 5 && (
        <>
          <p>Respect guest privacy and keep conversations platonic and non-clinical. Identity and experience reviews are part of approval.</p>
          <label className="beta-checkbox">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>I acknowledge the beta training and policy boundaries.</span>
          </label>
          <p className="beta-small">A saved draft keeps your profile choices. Confirm eligibility and consent again when you return.</p>
        </>
      )}
      {step === lastStep && (
        <dl>
          <dt>Display name</dt>
          <dd className="beta-wrap">{name}</dd>
          <dt>Biography</dt>
          <dd className="beta-wrap">{bio}</dd>
          {choices.interests.length > 0 && (
            <>
              <dt>Conversation topics</dt>
              <dd className="beta-wrap">{choices.interests.join(", ")}</dd>
            </>
          )}
          <dt>Languages</dt>
          <dd>{languages.map(({ tag }) => languageName(tag)).join(" · ")}</dd>
          <dt>Formats</dt>
          <dd>{formats.map(human).join(" · ")}</dd>
          {styles.length > 0 && (
            <>
              <dt>Conversation style interests</dt>
              <dd>{styles.map(styleName).join(" · ")}</dd>
            </>
          )}
        </dl>
      )}
      <div className="beta-actions">
        {step > 0 && (
          <button
            type="button"
            className="beta-secondary"
            disabled={locked}
            onClick={() => setStep(step - 1)}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className="beta-secondary"
          disabled={locked}
          onClick={() => run("host-draft", choices, "Application draft saved.")}
        >
          Save draft
        </button>
        <button className="beta-primary" disabled={locked || !complete[step]}>
          {step === lastStep ? "Submit application" : "Continue"}
        </button>
      </div>
    </form>
  );
}
function GuestReport({ record, run, busy }) {
  const [disposition, setDisposition] = useState("reviewed");
  const bookingId = record.booking_id;
  return (
    <article className="beta-card">
      <h2>{human(record.category)}</h2>
      <p>Sandbox guest report · {new Date(record.createdAt).toLocaleString()}</p>
      <p className="beta-small">Booking {bookingId}</p>
      <p className="beta-small">
        {record.status === "ESCALATED" ? "Follow-up required" : record.status === "ASSIGNED" && record.assignedToMe
          ? "Assigned to you"
          : human(record.status)}
        {record.disposition ? ` · ${record.disposition.replaceAll("-", " ")}` : ""}
      </p>
      {record.status === "OPEN" && (
        <button
          className="beta-secondary"
          disabled={busy}
          onClick={() => run("demo-guest-report-assign", { bookingId }, "Guest report assigned to you.")}
        >
          Assign to me
        </button>
      )}
      {record.canReassign && (
        <button
          className="beta-secondary"
          disabled={busy}
          onClick={() => run("demo-guest-report-reassign", { bookingId, assignedAt: record.assignedAt }, "Guest report reassigned to you.")}
        >
          Take over report
        </button>
      )}
      {["ASSIGNED", "ESCALATED"].includes(record.status) && record.assignedToMe && (
        <form onSubmit={(event) => {
          event.preventDefault();
          run(
            "demo-guest-report-resolve",
            { bookingId, disposition },
            disposition === "reviewed" ? "Guest report closed." : "Guest report marked for follow-up.",
          );
        }}>
          <label>
            Review outcome
            <select value={disposition} onChange={(event) => setDisposition(event.target.value)}>
              <option value="reviewed">Reviewed and ready to close</option>
              <option value="follow-up-required">Keep open for follow-up</option>
            </select>
          </label>
          <button className="beta-primary" disabled={busy}>Record outcome</button>
        </form>
      )}
    </article>
  );
}

export function OperationsWorkspace({ api, run, busy, revision, roles }) {
  const tabs = [];
  if (roles.some((role) => ["host_reviewer", "admin"].includes(role)))
    tabs.push(
      ["applications", "Host reviews"],
      ["intros", "Introductions"],
      ["photos", "Profile photos"],
      ["appeals", "Appeals"],
      ["review-moderation", "Pending reviews"],
      ["review-published", "Published reviews"],
    );
  if (roles.some((role) => ["safety", "admin"].includes(role)))
    tabs.push(
      ["safety", "Safety"],
      ["demo-guest-reports", "Guest test reports"],
      ["safety-history", "Closed cases"],
      ["accounts", "Account status"],
      ["alerts", "Operational alerts"],
    );
  if (roles.some((role) => ["finance", "admin"].includes(role)))
    tabs.push(
      ["refunds", "Refunds"],
      ["financial-exceptions", "Payment exceptions"],
      ["transfers", "Sandbox transfers"],
    );
  if (roles.includes("admin"))
    tabs.push(
      ["analytics", "Analytics"],
      ["privacy", "Privacy requests"],
      ["booking-oversight", "Bookings"],
      ["availability", "Host availability"],
    );
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(0);
  const [from, setFrom] = useState(() =>
    new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
  );
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const resource = tabs.some(([key]) => key === selected)
    ? selected
    : tabs[0]?.[0];
  const isSafety = ["safety", "safety-history", "demo-guest-reports"].includes(resource);
  const isWrittenReview =
    resource === "review-moderation" || resource === "review-published";
  const isPaged = isSafety || isWrittenReview;
  const { data, error, loading } = useResource(
    api,
    resource || "me",
    null,
    revision,
    resource === "analytics"
      ? {
          from: Date.parse(from + "T00:00:00Z"),
          to: Date.parse(to + "T00:00:00Z") + 86400000,
        }
      : isPaged
        ? { page }
        : undefined,
  );
  return (
    <section>
      <p className="beta-eyebrow">AUTHORIZED STAFF WORKSPACE</p>
      <h1>Care behind every moment.</h1>
      <p>Sensitive actions require a recent multi-factor sign-in.</p>
      <div className="beta-tabs" role="group" aria-label="Operations sections">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            aria-pressed={resource === key}
            onClick={() => {
              setSelected(key);
              setPage(0);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="beta-alert">
          <span>{error}</span>
          <button
            className="beta-text"
            onClick={() =>
              location.assign(
                new URL(
                  "/api/marketplace/auth/login?step_up=1",
                  location.origin,
                ).href,
              )
            }
          >
            Verify your sign-in
          </button>
        </div>
      )}
      {loading && !data && <p>Loading the queue…</p>}
      {resource === "analytics" && (
        <div className="beta-form-grid">
          <label>
            From date, UTC
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            To date, UTC
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
      )}
      {resource === "financial-exceptions" && data && (
        <div className="beta-card">
          <h2>Provider reconciliation</h2>
          {data.jobs?.map((job) => (
            <div key={job.id}>
              <p>
                {human(job.kind)} · {human(job.status)} · {job.attempts}{" "}
                attempts
              </p>
              <button
                className="beta-secondary"
                disabled={busy}
                onClick={() =>
                  run(
                    "reconcile",
                    { paymentId: job.payment_id },
                    "Provider payment checked.",
                  )
                }
              >
                Reconcile payment
              </button>
            </div>
          ))}
          {data.disputes?.map((dispute) => (
            <p key={dispute.provider_id}>
              Dispute {human(dispute.status)} · {money(dispute.amount_cents)}
            </p>
          ))}
          {!data.jobs?.length && !data.disputes?.length && (
            <p>No recorded payment exceptions.</p>
          )}
        </div>
      )}
      {Array.isArray(data) && !data.length && (
        <p className="beta-card">
          {resource === "safety-history"
            ? "There are no closed cases on this page."
            : resource === "review-published"
              ? "There are no published reviews on this page."
              : "There is nothing waiting on this page."}
        </p>
      )}
      {resource === "analytics" && data && <AnalyticsSummary data={data} />}
      {resource === "transfers" && data && (
        <TransferWorkspace data={data} run={run} busy={busy} />
      )}
      {Array.isArray(data) &&
        data.map((record) =>
          isWrittenReview ? (
            <ReviewModeration
              key={record.bookingId + ":" + record.textVersion}
              record={record}
              run={run}
              busy={busy}
            />
          ) : resource === "demo-guest-reports" ? (
            <GuestReport key={record.booking_id} record={record} run={run} busy={busy} />
          ) : resource === "photos" ? (
            <PhotoReview
              key={record.id}
              record={record}
              run={run}
              busy={busy}
            />
          ) : resource === "privacy" ? (
            <PrivacyReview
              key={record.id}
              record={record}
              run={run}
              busy={busy}
            />
          ) : (
            <StaffRecord
              key={record.id || record.user_id}
              resource={resource}
              record={record}
              run={run}
              busy={busy}
            />
          ),
        )}
      {isPaged && (page > 0 || data?.length === 100) && (
        <div
          className="beta-actions"
          aria-label={isSafety ? "Safety case pages" : "Written review pages"}
        >
          <button
            className="beta-secondary"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            {isSafety ? "Previous cases" : "Previous reviews"}
          </button>
          <span>Page {page + 1}</span>
          <button
            className="beta-secondary"
            disabled={data?.length !== 100 || page >= 10000}
            onClick={() => setPage(page + 1)}
          >
            {isSafety ? "Next cases" : "Next reviews"}
          </button>
        </div>
      )}
    </section>
  );
}
function ReviewModeration({ record, run, busy }) {
  function decide(publicationStatus) {
    return run(
      "review-publication",
      {
        bookingId: record.bookingId,
        textVersion: record.textVersion,
        publicationStatus,
      },
      publicationStatus === "APPROVED" ? "Written review approved." : "Written review hidden.",
    );
  }
  return (
    <article className="beta-card">
      <h2>{record.publicationStatus === "PENDING" ? "Awaiting review" : "Approved written review"}</h2>
      <blockquote>{record.reviewText}</blockquote>
      <p className="beta-small">
        Check for names, private conversation details and abusive content before
        sharing. This decision applies to the written review.
      </p>
      <div className="beta-actions">
        {record.publicationStatus === "PENDING" && (
          <button className="beta-secondary" disabled={busy} onClick={() => decide("APPROVED")}>
            Approve for sharing
          </button>
        )}
        <button className="beta-secondary" disabled={busy} onClick={() => decide("HIDDEN")}>
          Hide written review
        </button>
      </div>
    </article>
  );
}

function StaffRecord({ resource, record, run, busy }) {
  const [reason, setReason] = useState("");
  const [experience, setExperience] = useState("laugh");
  const [expiry, setExpiry] = useState(() =>
    new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10),
  );
  const [durationConfirmed, setDurationConfirmed] = useState(false);
  const [captionsConfirmed, setCaptionsConfirmed] = useState(false);
  const [identityReference, setIdentityReference] = useState("");
  const [payoutReference, setPayoutReference] = useState("");
  const [certificationStatus, setCertificationStatus] = useState("APPROVED");
  const [refundAmount, setRefundAmount] = useState("");
  let decisions = [];
  if (resource === "applications")
    decisions = [
      ["IDENTITY_PENDING", "Request identity review"],
      ["REVIEW_PENDING", "Review experience"],
      ["APPROVED", "Approve profile"],
      ["REJECTED", "Reject"],
      ["SUSPENDED", "Suspend"],
    ];
  if (resource === "safety" && record.status !== "CLOSED")
    decisions = [
      ["ASSIGNED", "Assign to me"],
      ["ESCALATED", "Escalate"],
      ["CLOSED", "Close case"],
    ];
  if (resource === "refunds" && record.status === "OPEN")
    decisions = [
      ["APPROVED", "Approve refund"],
      ["REJECTED", "Decline refund"],
    ];
  if (resource === "intros" && record.status !== "APPROVED")
    decisions = [
      ["APPROVED", "Approve introduction"],
      ["REJECTED", "Reject introduction"],
    ];
  if (resource === "appeals" && record.status === "OPEN")
    decisions = [
      ["APPROVED", "Reopen review"],
      ["REJECTED", "Reject appeal"],
    ];
  if (resource === "accounts" && record.status !== "CLOSED")
    decisions =
      record.status === "ACTIVE"
        ? [["SUSPENDED", "Suspend account"]]
        : [["ACTIVE", "Reinstate account (administrator)"]];
  function decide(status) {
    if (resource === "accounts")
      return run(
        "account-status",
        { userId: record.id, status, reason },
        "Account status updated.",
      );
    if (resource === "applications")
      return run(
        "host-review",
        { hostId: record.user_id, status, reason },
        "Host review saved.",
      );
    if (resource === "safety")
      return run(
        "case-decision",
        { caseId: record.id, status, reason },
        "Case decision saved.",
      );
    if (resource === "refunds")
      return run(
        "refund-decision",
        {
          refundId: record.id,
          status,
          reason,
          ...(refundAmount
            ? { amountCents: Math.round(Number(refundAmount) * 100) }
            : {}),
        },
        "Refund decision saved.",
      );
    if (resource === "intros")
      return run(
        "host-intro-review",
        { introId: record.id, decision: status, reason, durationConfirmed, captionsConfirmed },
        "Introduction review saved.",
      );
    return run(
      "appeal-decision",
      { appealId: record.id, decision: status, reason },
      "Appeal decision saved.",
    );
  }
  return (
    <article className="beta-card">
      <div className="beta-row-heading">
        <h2>
          {record.display_name ||
            record.category ||
            (resource === "refunds" ? "Refund review" : human(resource))}
        </h2>
        <span className="beta-status">{human(record.status)}</span>
      </div>
      {record.created_at && (
        <p className="beta-small">
          {new Date(record.created_at).toLocaleString()}
        </p>
      )}
      {record.severity && (
        <p>
          <strong>{human(record.severity)}</strong>
        </p>
      )}
      {resource === "booking-oversight" && (
        <p>
          {record.experience} · {record.duration} minutes ·{" "}
          {money(record.amount_cents)} · Customer {record.customer_id} · Host{" "}
          {record.host_id}
        </p>
      )}
      {resource === "availability" && (
        <p>
          {record.available ? "Availability enabled" : "Unavailable"} · Last
          heartbeat{" "}
          {record.last_seen_at
            ? new Date(record.last_seen_at).toLocaleString()
            : "not recorded"}
          . Matching also requires current eligibility and a recent heartbeat.
        </p>
      )}
      {resource !== "intros" && (
        <p>{record.biography || record.narrative || record.reason || record.transcript}</p>
      )}
      {resource === "intros" && (
        <>
          <HostIntroduction intro={record} review />
          <label className="beta-checkbox">
            <input
              type="checkbox"
              checked={durationConfirmed}
              onChange={(event) => setDurationConfirmed(event.target.checked)}
            />
            I played this clip and confirmed its 15–30-second duration.
          </label>
          {record.caption_language ? (
            <label className="beta-checkbox">
              <input
                type="checkbox"
                checked={captionsConfirmed}
                onChange={(event) => setCaptionsConfirmed(event.target.checked)}
              />
              The spoken audio and relevant sounds match the timed captions.
            </label>
          ) : record.content_type.startsWith("video/") && (
            <p className="beta-small">Approval makes the transcript visible on the host profile. Video playback requires reviewed captions.</p>
          )}
        </>
      )}
      {decisions.length > 0 && (
        <>
          {resource === "refunds" && (
            <label>
              Refund amount, USD (blank for full remaining)
              <input
                type="number"
                min="0.01"
                step="0.01"
                max={
                  record.remaining_cents
                    ? record.remaining_cents / 100
                    : undefined
                }
                value={refundAmount}
                onChange={(event) => setRefundAmount(event.target.value)}
              />
            </label>
          )}
          <label>
            Decision explanation
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              required
            />
          </label>
          <div className="beta-actions">
            {decisions.map(([status, label]) => (
              <button
                className="beta-secondary"
                key={status}
                disabled={
                  busy ||
                  !reason.trim() ||
                  status === record.status ||
                  (resource === "intros" &&
                    status === "APPROVED" &&
                    (!durationConfirmed || (record.caption_language && !captionsConfirmed)))
                }
                onClick={() => decide(status)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      {resource === "refunds" && record.status === "APPROVED" && (
        <>
          <p className="beta-small">
            This refund is approved for submission. Completion is confirmed by
            the signed provider callback.
          </p>
          <button
            className="beta-primary"
            disabled={busy}
            onClick={() =>
              run(
                "refund-dispatch",
                { refundId: record.id },
                "Refund submitted. Awaiting provider confirmation.",
              )
            }
          >
            Submit approved sandbox refund
          </button>
        </>
      )}
      {resource === "refunds" &&
        record.payment_status === "REFUNDED" &&
        record.tip_status === "CAPTURED" && (
          <button
            className="beta-secondary"
            disabled={busy}
            onClick={() =>
              run(
                "tip-refund",
                { bookingId: record.booking_id },
                "Remaining sandbox tip refund submitted for confirmation.",
              )
            }
          >
            Refund remaining tip principal ({money(record.tip_remaining_cents)})
          </button>
        )}
      {resource === "applications" && (
        <form
          className="beta-certification"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              "host-verification-review",
              { hostId: record.user_id, identityReference, payoutReference },
              "Provider verification references were checked.",
            );
          }}
        >
          <h3>Check provider eligibility evidence</h3>
          <p className="beta-small">
            The server checks the configured verification session and connected
            payout account. Both must belong to this host. Store provider
            references only.
          </p>
          <div className="beta-form-grid">
            <label>
              Identity verification session reference
              <input
                value={identityReference}
                onChange={(event) => setIdentityReference(event.target.value)}
                maxLength={128}
                placeholder="vs_…"
                required
              />
            </label>
            <label>
              Connected payout account reference
              <input
                value={payoutReference}
                onChange={(event) => setPayoutReference(event.target.value)}
                maxLength={128}
                placeholder="acct_…"
                required
              />
            </label>
          </div>
          <button
            className="beta-secondary"
            disabled={
              busy || !identityReference.trim() || !payoutReference.trim()
            }
          >
            Verify provider evidence
          </button>
        </form>
      )}
      {resource === "applications" && record.status === "APPROVED" && (
        <form
          className="beta-certification"
          onSubmit={(event) => {
            event.preventDefault();
            run(
              "certify",
              {
                hostId: record.user_id,
                experience,
                status: certificationStatus,
                rubric: reason,
                expiresAt: new Date(expiry + "T23:59:59Z").getTime(),
              },
              "Experience certification saved.",
            );
          }}
        >
          <h3>Experience certification</h3>
          <div className="beta-form-grid">
            <label>
              Experience
              <select
                value={experience}
                onChange={(event) => setExperience(event.target.value)}
              >
                {experiences.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Decision
              <select
                value={certificationStatus}
                onChange={(event) => setCertificationStatus(event.target.value)}
              >
                <option value="APPROVED">Approve</option>
                <option value="REVOKED">Revoke</option>
              </select>
            </label>
            <label>
              Re-evaluation date
              <input
                type="date"
                value={expiry}
                onChange={(event) => setExpiry(event.target.value)}
                required
              />
            </label>
          </div>
          <label>
            Audition rubric and reviewer feedback
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={2000}
              required
            />
          </label>
          <button className="beta-primary" disabled={busy || !reason.trim()}>
            Save certification decision
          </button>
        </form>
      )}
    </article>
  );
}
function AnalyticsSummary({ data }) {
  const counts = data.counts || {},
    worth = data.rates?.worthIt || {};
  return (
    <div className="beta-card">
      <h2>Recorded experience outcomes</h2>
      <p className="beta-small">{data.definitions?.cohort}</p>
      <dl className="beta-metrics">
        <div>
          <dt>Requested sessions</dt>
          <dd>{counts.requested || 0}</dd>
        </div>
        <div>
          <dt>Completed sessions</dt>
          <dd>{counts.completed || 0}</dd>
        </div>
        <div>
          <dt>Worth-it responses</dt>
          <dd>
            {worth.numerator || 0} yes / {worth.denominator || 0} answered
          </dd>
        </div>
      </dl>
      {data.rates && (
        <dl className="beta-metrics">
          {Object.entries(data.rates).map(([name, value]) => (
            <div key={name}>
              <dt>{human(name)}</dt>
              <dd>
                {value.numerator} / {value.denominator}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {data.financial && (
        <dl className="beta-metrics">
          {Object.entries(data.financial).map(([name, value]) =>
            typeof value !== "number" ? null : (
              <div key={name}>
                <dt>
                  {human(name.replace(/Cents$/, "").replace(/([A-Z])/g, " $1"))}
                </dt>
                <dd>{money(value)}</dd>
              </div>
            ),
          )}
        </dl>
      )}
      {data.financial?.deliveredContribution && (
        <p>
          Contribution per delivered session:{" "}
          {data.financial.deliveredContribution.centsPerSession === null
            ? "No delivered sessions in this window"
            : money(data.financial.deliveredContribution.centsPerSession)}{" "}
          · {data.financial.deliveredContribution.denominator} delivered
          sessions
        </p>
      )}
      {data.matching && (
        <p>
          Accepted-host wait: median{" "}
          {data.matching.medianMs === null
            ? "unmeasured"
            : (data.matching.medianMs / 1000).toFixed(1) + "s"}
          , p95{" "}
          {data.matching.p95Ms === null
            ? "unmeasured"
            : (data.matching.p95Ms / 1000).toFixed(1) + "s"}{" "}
          · {data.matching.latencySamples} accepted attempts
        </p>
      )}
      {data.retention && (
        <dl className="beta-metrics">
          {Object.entries(data.retention).map(([name, value]) => (
            <div key={name}>
              <dt>{value.horizonDays}-day repeat purchase</dt>
              <dd>
                {value.numerator} / {value.denominator} mature customers ·{" "}
                {value.immatureCustomers} awaiting maturity
              </dd>
            </div>
          ))}
        </dl>
      )}
      {data.hostUtilization && (
        <p>
          Observed host utilization:{" "}
          {data.hostUtilization.rate === null
            ? "unmeasured"
            : (100 * data.hostUtilization.rate).toFixed(1) + "%"}{" "}
          · {Math.round(data.hostUtilization.busyMs / 1000)} busy seconds /{" "}
          {Math.round(data.hostUtilization.availableMs / 1000)} observed
          available seconds
        </p>
      )}
      {data.visitorCoverage && (
        <p className="beta-small">
          Visitor conversion covers consenting visits only.{" "}
          {data.visitorCoverage.completeWindow
            ? "The reporting window is within retained coverage."
            : "This window has incomplete visit coverage."}
        </p>
      )}
      <p className="beta-small">
        Counts describe recorded staging events. Only answered value questions
        contribute to the value denominator.
      </p>
      {data.metrics && (
        <dl className="beta-metrics">
          {Object.entries(data.metrics).map(([key, value]) => (
            <div key={key}>
              <dt>{human(key)}</dt>
              <dd>
                {typeof value === "object" ? JSON.stringify(value) : value}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
