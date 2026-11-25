"use client";

import React, { useId, useState } from "react";
import { languageName } from "../../lib/conversation-languages.mjs";
import { human, money } from "./beta-api.mjs";
import { useResource } from "./beta-resource";

const dateInZone = (at, timeZone) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(at);

const timeInZone = (at, timeZone) =>
  new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone,
  }).format(at);

export function ScheduledChooser({ api, run, busy, revision, preferences, hostId, query, onViewHost }) {
  const { data, error, loading } = useResource(api, "schedule-slots", null, revision, {
    ...preferences,
    ...(hostId ? { hostId } : {}),
    ...(query ? { query } : {}),
  });
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <h2 id={heading}>Book for later</h2>
      <p className="beta-small">
        Times are shown in your device’s time zone. Reserve a time for free. Sandbox checkout opens
        when your host accepts your request after you check in.
      </p>
      {error && <p className="beta-alert" role="alert">{error}</p>}
      {loading && !data && <p role="status">Checking scheduled availability…</p>}
      {data?.slots.length === 0 && (
        <p className="beta-card">No scheduled times fit these choices. Try a different format, language or duration.</p>
      )}
      <div className="beta-booking-list">
        {data?.slots.map((slot) => (
          <article className="beta-card beta-booking-row" key={slot.id}>
            <div>
              <h3>{slot.hostName}</h3>
              <p>{dateInZone(slot.startsAt)}</p>
              <p>{preferences.duration} minutes · {money(slot.priceCents)} test price</p>
              {onViewHost && <p className="beta-host-result-summary beta-wrap">{slot.biography}</p>}
              <p className="beta-small">{languageName(preferences.language)} · {human(preferences.format)}</p>
            </div>
            <div className="beta-actions">
              {onViewHost && (
                <button
                  type="button"
                  className="beta-secondary"
                  aria-label={`View profile for ${slot.hostName}`}
                  onClick={() => onViewHost(slot.hostId)}
                >
                  View profile
                </button>
              )}
              <button
                className="beta-primary"
                disabled={busy}
                aria-label={`Schedule ${slot.hostName} for ${dateInZone(slot.startsAt)}`}
                onClick={() => run(
                  "schedule-reserve",
                  {
                    ...preferences,
                    slotId: slot.id,
                    expectedPriceCents: slot.priceCents,
                    expectedCurrency: slot.currency,
                  },
                  "Time reserved. Find it under My sessions to check in.",
                )}
              >
                Schedule
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ScheduledReservations({ api, run, busy, revision, onSelect, hostView = false }) {
  const { data, error, loading } = useResource(
    api, "scheduled-reservations", hostView ? "host" : null, revision,
  );
  const heading = useId();
  return (
    <section aria-labelledby={heading}>
      <div className="beta-row-heading">
        <h2 id={heading}>{hostView ? "Upcoming scheduled sessions" : "Scheduled sessions"}</h2>
      </div>
      {error && <p className="beta-alert" role="alert">{error}</p>}
      {loading && !data && <p role="status">Checking your scheduled sessions…</p>}
      {data?.reservations.length === 0 && <p className="beta-small">No scheduled sessions yet.</p>}
      {hostView && data?.reservations.some(({ status }) => status === "SCHEDULED") && (
        <p className="beta-small">Keep Host Studio open and turn on immediate requests during check-in.</p>
      )}
      <div className="beta-booking-list">
        {data?.reservations.map((item) => (
          <article className="beta-card beta-booking-row" key={item.id}>
            <div>
              <p className="beta-status">{human(item.status)}</p>
              <h3>{hostView ? item.customerName : item.hostName}</h3>
              <p>{dateInZone(item.startsAt)}</p>
              <p>{item.duration} minutes · {human(item.format)} · {languageName(item.language)} · {money(item.priceCents)} test price</p>
              {item.status === "SCHEDULED" && (
                <p className="beta-small">
                  Check-in {dateInZone(item.checkInFrom)} to {timeInZone(item.checkInUntil)}
                </p>
              )}
            </div>
            <div className="beta-actions">
              {!hostView && item.status === "SCHEDULED" && (
                <button
                  className="beta-primary"
                  disabled={busy || !item.mayCheckIn}
                  onClick={async () => {
                    const result = await run("schedule-check-in", { reservationId: item.id });
                    if (result?.booking) onSelect(result.booking);
                  }}
                >
                  Check in
                </button>
              )}
              {item.bookingId && (
                <button className="beta-secondary" onClick={() => onSelect({ id: item.bookingId })}>
                  Open session
                </button>
              )}
              {item.status === "SCHEDULED" && (
                <button
                  className="beta-secondary"
                  disabled={busy}
                  onClick={() => run("schedule-cancel", { reservationId: item.id }, "Scheduled session cancelled.")}
                >
                  Cancel scheduled session
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

const initialWindow = (timeZone) => ({
  startsLocal: "",
  endsLocal: "",
  timeZone,
  startOccurrence: "",
  endOccurrence: "",
});

export function HostSchedule({ api, run, busy, revision }) {
  const { data, error } = useResource(api, "host-schedule", null, revision);
  const [window, setWindow] = useState(() => initialWindow(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"));
  const zones = useId();
  const field = (name) => ({
    value: window[name],
    onChange: (event) => setWindow({ ...window, [name]: event.target.value }),
  });
  return (
    <section className="beta-card">
      <h2>Scheduled availability</h2>
      <p className="beta-small">
        Add a window in your time zone. Leave room for check-in and checkout in addition to the conversation.
      </p>
      {error && <p className="beta-alert" role="alert">{error}</p>}
      <form onSubmit={async (event) => {
        event.preventDefault();
        const result = await run("schedule-block-save", window, "Availability added.");
        if (result) setWindow(initialWindow(window.timeZone));
      }}>
        <div className="beta-form-grid">
          <label>
            Start time
            <input type="datetime-local" required {...field("startsLocal")} />
          </label>
          <label>
            End time
            <input type="datetime-local" required {...field("endsLocal")} />
          </label>
          <label>
            Time zone
            <input type="text" required maxLength={100} list={zones} {...field("timeZone")} />
            <datalist id={zones}>
              {["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu", "UTC"].map((zone) =>
                <option value={zone} key={zone} />,
              )}
            </datalist>
          </label>
        </div>
        <details>
          <summary>When clocks move back</summary>
          <div className="beta-form-grid">
            <label>
              Repeated start time
              <select {...field("startOccurrence")}>
                <option value="">Ask if ambiguous</option>
                <option value="earlier">First occurrence</option>
                <option value="later">Second occurrence</option>
              </select>
            </label>
            <label>
              Repeated end time
              <select {...field("endOccurrence")}>
                <option value="">Ask if ambiguous</option>
                <option value="earlier">First occurrence</option>
                <option value="later">Second occurrence</option>
              </select>
            </label>
          </div>
        </details>
        <div className="beta-actions">
          <button className="beta-primary" disabled={busy}>Add availability</button>
        </div>
      </form>
      <ul className="beta-booking-list">
        {data?.blocks.map((block) => (
          <li className="beta-booking-row" key={block.id}>
            <p>
              {dateInZone(block.startsAt, block.timeZone)} to {dateInZone(block.endsAt, block.timeZone)}
            </p>
            <button
              className="beta-secondary"
              disabled={busy}
              onClick={() => run("schedule-block-remove", { blockId: block.id }, "Availability removed.")}
            >
              Remove window
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
