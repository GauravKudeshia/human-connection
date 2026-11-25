import { hosts, stylesFor } from "./catalog.mjs";
import {
  DEMO_RUNTIME,
  DEMO_CAPABILITIES,
  isTerminal,
  priceFor,
  hasPendingReviews,
} from "./demo-policy.mjs";
import { hostAvailable, rankMatches } from "./matching.mjs";
import { activities, activityRounds } from "./activities.mjs";
import { fingerprint } from "./fingerprint.mjs";
import {
  applyDemoInvite,
  demoGuestCanReport,
  expireDemoInvite,
  isDemoInviteAction,
} from "./demo-invitations.mjs";

export class DomainError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
const fail = (code, message, status) => {
  throw new DomainError(code, message, status);
};
function need(condition, message) {
  if (!condition) fail("INVALID_STATE", message);
}
function short(value, max = 2000) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail("VALIDATION", "Please provide a valid response.", 400);
  return value.trim();
}
function host(id) {
  return (
    hosts.find((h) => h.id === id) || fail("NOT_FOUND", "Host not found.", 404)
  );
}
function booking(s, id) {
  return (
    s.bookings.find((b) => b.id === id) ||
    fail("NOT_FOUND", "This session could not be found.", 404)
  );
}
function assertDemo(runtime) {
  if (runtime.mode !== "demo")
    fail(
      "DEMO_ONLY",
      "This simulator cannot run production payments, calls or operations.",
      403,
    );
  need(
    Number.isInteger(runtime.joinDeadlineMs) &&
      runtime.joinDeadlineMs > 0 &&
      runtime.joinDeadlineMs <= 1_800_000,
    "Invalid demo join deadline configuration.",
  );
}
export function initialState() {
  return {
    schema: 1,
    mode: "demo",
    eligible: false,
    closed: false,
    favorites: [],
    blocks: [],
    bookings: [],
    reports: [],
    refunds: [],
    feedback: [],
    applications: [],
    journals: [],
    audit: [],
    idempotency: {},
    resetRequests: {},
    matching: { counts: {}, lastAssigned: {} },
    operations: { staffed: true, providerHealthy: true },
    hostOnline: Object.fromEntries(hosts.map((h) => [h.id, true])),
  };
}
// Additive migration: keep existing sessions, financial history, preferences and schema-1 storage.
function normalize(s) {
  if (s.mode && s.mode !== "demo")
    fail("DEMO_ONLY", "Only fictional demo workspaces are supported.", 403);
  s.mode = "demo";
  s.feedback ||= [];
  s.resetRequests ||= {};
  s.matching ||= { counts: {}, lastAssigned: {} };
  for (const record of Object.values(s.idempotency || {})) {
    if (record.fingerprint?.startsWith("{"))
      record.fingerprint = fingerprint(record.fingerprint);
  }
  // Older builds permitted failure ratings. Retain their content as separate service feedback.
  for (const b of s.bookings)
    if ((b.rating || b.comfortRating) && b.status !== "COMPLETED") {
      if (!s.feedback.some((f) => f.bookingId === b.id))
        s.feedback.push({
          id: crypto.randomUUID(),
          bookingId: b.id,
          kind: "service-failure",
          text: b.review || "Legacy feedback on an undelivered session.",
          legacyRating: b.rating,
          createdAt: b.endedAt || b.createdAt,
        });
      delete b.rating;
      delete b.comfortRating;
      delete b.review;
    }
  return s;
}
export const available = hostAvailable;
const line = (account, debit = 0, credit = 0) => ({ account, debit, credit });
function journal(s, event, lines, now) {
  if (s.journals.some((j) => j.event === event)) return;
  if (
    lines.some(
      (l) =>
        !Number.isSafeInteger(l.debit) ||
        !Number.isSafeInteger(l.credit) ||
        l.debit < 0 ||
        l.credit < 0,
    ) ||
    lines.reduce((n, l) => n + l.debit - l.credit, 0) !== 0
  )
    fail("UNBALANCED", "Journal is not balanced", 500);
  s.journals.push({
    id: crypto.randomUUID(),
    event,
    currency: "USD",
    simulated: true,
    createdAt: now,
    lines,
  });
}
function audit(s, action, subjectId, now, details = {}) {
  s.audit.unshift({
    id: crypto.randomUUID(),
    action,
    subjectId,
    simulated: true,
    createdAt: now,
    ...details,
  });
}
function removeProfileContent(s, now) {
  s.eligible = false;
  s.favorites = [];
  s.applications = [];
  s.feedback = [];
  for (const r of s.reports) {
    r.reason = "Removed on demo account closure";
    delete r.note;
  }
  for (const r of s.refunds) {
    r.reason = "Removed on demo account closure";
    delete r.resolution;
  }
  for (const b of s.bookings) {
    b.review = "";
    delete b.comfortRating;
    delete b.valueFeedback;
    delete b.qualityFeedback;
    delete b.refundFeedback;
    delete b.refundReason;
    delete b.invitation;
  }
  for (const event of s.audit) {
    if (event.reason) {
      delete event.reason;
      event.reasonRemovedAt = now;
    }
  }
}
function reversePayment(s, b, now, reason) {
  if (b.payment !== "SIMULATED_SUCCEEDED") return;
  const delivered = s.journals.some((j) => j.event === "delivered:" + b.id);
  const share = Math.round(b.totalCents * 0.7);
  journal(
    s,
    "refund:" + b.id,
    delivered
      ? [
          line("host_base_payable", share),
          line("platform_revenue", b.totalCents - share),
          line("processor_clearing", 0, b.totalCents),
        ]
      : [
          line("service_liability", b.totalCents),
          line("processor_clearing", 0, b.totalCents),
        ],
    now,
  );
  b.payment = "SIMULATED_REFUNDED";
  b.refundedAt = now;
  b.refundReason = reason;
  if (b.tipCents && !b.tipRefunded) {
    journal(
      s,
      "tip-refund:" + b.id,
      [
        line("host_tip_payable", b.tipCents),
        line("processor_clearing", 0, b.tipCents),
      ],
      now,
    );
    b.tipRefunded = true;
  }
}
function requestRefund(s, b, reason, now) {
  if (!s.refunds.some((r) => r.bookingId === b.id))
    s.refunds.unshift({
      id: crypto.randomUUID(),
      bookingId: b.id,
      reason,
      status: "OPEN",
      createdAt: now,
    });
}
function finish(s, b, status, now) {
  if (isTerminal(b.status)) return;
  const end = Math.min(now, b.deadline ?? now);
  b.overlapSeconds = Math.min(
    b.duration * 60,
    (b.overlapSeconds || 0) +
      (b.overlapStartedAt != null
        ? Math.max(0, Math.floor((end - b.overlapStartedAt) / 1000))
        : 0),
  );
  b.overlapStartedAt = null;
  b.status = status;
  b.endedAt = end;
  expireDemoInvite(b, now);
  if (status === "COMPLETED") {
    const share = Math.round(b.totalCents * 0.7);
    journal(
      s,
      "delivered:" + b.id,
      [
        line("service_liability", b.totalCents),
        line("host_base_payable", 0, share),
        line("platform_revenue", 0, b.totalCents - share),
      ],
      now,
    );
  }
  if (status === "PARTIAL_DELIVERY" || status === "FAILED_SERVICE")
    requestRefund(
      s,
      b,
      status === "PARTIAL_DELIVERY"
        ? "Session ended before full demo delivery."
        : "Simulated service interrupted.",
      now,
    );
}
export function expire(state, now = Date.now(), runtime = DEMO_RUNTIME) {
  assertDemo(runtime);
  const s = normalize(state);
  for (const b of s.bookings) {
    if (
      ["HOST_REQUESTED", "HOST_ACCEPTED"].includes(b.status) &&
      b.expiresAt <= now
    ) {
      b.status = "EXPIRED";
      b.endedAt = now;
      audit(s, "reservation-expired", b.id, now);
    }
    if (b.status === "READY") {
      // V1.2 READY records acquire the same bounded policy on their next read.
      b.joinDeadlineAt ??= (b.paidAt ?? b.createdAt) + runtime.joinDeadlineMs;
      if (b.joinDeadlineAt <= now) {
        b.status = "EXPIRED";
        b.endedAt = now;
        b.customerMessage =
          "The join window ended before you entered. Your demo payment was fully reversed and the host is available for a new request.";
        reversePayment(s, b, now, "Demo join deadline expired");
        requestRefund(s, b, "Automatic demo no-join reversal.", now);
        const r = s.refunds.find((r) => r.bookingId === b.id);
        r.status = "REFUNDED";
        r.resolution = "Full automatic reversal under demo no-join policy.";
        r.resolvedAt = now;
        audit(s, "paid-reservation-expired", b.id, now);
      }
    }
    if (["LIVE", "RECONNECTING"].includes(b.status) && b.deadline <= now) {
      const delivered =
        (b.overlapSeconds || 0) +
        (b.overlapStartedAt != null
          ? Math.max(0, Math.floor((b.deadline - b.overlapStartedAt) / 1000))
          : 0);
      finish(
        s,
        b,
        delivered >= b.duration * 60 ? "COMPLETED" : "PARTIAL_DELIVERY",
        now,
      );
    }
    expireDemoInvite(b, now);
  }
  return s;
}
function reserve(s, payload, now) {
  need(s.eligible, "Confirm eligibility before requesting a host.");
  need(
    s.operations.staffed,
    "New sessions are paused while safety coverage is unavailable.",
  );
  need(
    s.operations.providerHealthy,
    "New sessions are paused while the call provider is unavailable.",
  );
  const h = host(payload.hostId);
  need(
    available(s, h),
    "This host is no longer available. Choose another host.",
  );
  need(
    !s.bookings.some((b) => !isTerminal(b.status)),
    "Finish or cancel your current request before starting another.",
  );
  need([15, 30].includes(payload.duration), "Choose 15 or 30 minutes.");
  need(
    h.formats.includes(payload.format),
    "This host does not offer that format.",
  );
  need(
    h.experiences.includes(payload.experience),
    "Choose an experience this host offers.",
  );
  const language = payload.language ?? "English",
    style = payload.style || null;
  need(
    h.languages.includes(language),
    "This host does not offer that language.",
  );
  need(
    !style || stylesFor(payload.experience).some((s) => s.id === style),
    "Choose a style for this experience.",
  );
  const b = {
    id: crypto.randomUUID(),
    hostId: h.id,
    experience: payload.experience,
    style,
    language,
    format: payload.format,
    duration: payload.duration,
    totalCents: priceFor(payload.duration),
    currency: "USD",
    policyVersion: "demo-1.3",
    status: "HOST_REQUESTED",
    payment: "UNPAID",
    createdAt: now,
    expiresAt: now + 30000,
    overlapSeconds: 0,
  };
  s.bookings.unshift(b);
  s.matching.counts[h.id] = (s.matching.counts[h.id] || 0) + 1;
  s.matching.lastAssigned[h.id] = now;
  return b;
}
export function applyAction(
  previous,
  action,
  payload = {},
  key,
  now = Date.now(),
  runtime = DEMO_RUNTIME,
) {
  assertDemo(runtime);
  if (!key || typeof key !== "string" || key.length > 128)
    fail("IDEMPOTENCY_REQUIRED", "An idempotency key is required.", 400);
  if (
    typeof action !== "string" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    fail("VALIDATION", "Invalid action payload.", 400);
  const s = expire(structuredClone(previous), now, runtime);
  const digest = fingerprint(JSON.stringify({ action, payload }));
  const replay = Object.hasOwn(s.resetRequests, key)
    ? s.resetRequests[key]
    : Object.hasOwn(s.idempotency, key) && s.idempotency[key];
  if (replay) {
    if (replay.fingerprint !== digest)
      fail(
        "KEY_REUSED",
        "This request key was already used for a different action.",
      );
    return { state: s, result: replay.result, replayed: true };
  }
  if (s.closed && !["reset", "case-action", "refund-resolve"].includes(action))
    fail("ACCOUNT_CLOSED", "This demo account is closed.", 403);
  let result = {};
  let decision = {};
  switch (action) {
    case "eligibility":
      need(
        payload.adult === true && payload.terms === true,
        "Confirm you are 18 or older and accept the demo terms.",
      );
      s.eligible = true;
      break;
    case "favorite":
      host(payload.hostId);
      need(
        !s.blocks.includes(payload.hostId),
        "Unblock this host before saving them.",
      );
      s.favorites = s.favorites.includes(payload.hostId)
        ? s.favorites.filter((id) => id !== payload.hostId)
        : [...s.favorites, payload.hostId];
      break;
    case "hold":
      result = { bookingId: reserve(s, payload, now).id };
      break;
    case "match": {
      const ranked = rankMatches(s, payload);
      if (!ranked.matches.length) fail("NO_MATCH", ranked.reason);
      const chosen = ranked.matches[0];
      const b = reserve(s, { ...payload, hostId: chosen.host.id }, now);
      b.matchReason = chosen.reason;
      b.matchedByDemo = true;
      result = { bookingId: b.id };
      break;
    }
    case "accept": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "HOST_REQUESTED",
        "This request is no longer available.",
      );
      b.status = "HOST_ACCEPTED";
      b.expiresAt = now + 180000;
      break;
    }
    case "decline": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "HOST_REQUESTED",
        "This request is no longer available.",
      );
      b.status = "DECLINED";
      b.endedAt = now;
      break;
    }
    case "checkout": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "HOST_ACCEPTED",
        "The host must accept and the reservation must still be valid.",
      );
      need(
        s.operations.staffed && s.operations.providerHealthy,
        "New sessions are currently paused.",
      );
      need(!s.blocks.includes(b.hostId), "This host is blocked.");
      b.payment = "SIMULATED_SUCCEEDED";
      b.status = "READY";
      b.paidAt = now;
      b.joinDeadlineAt = now + runtime.joinDeadlineMs;
      journal(
        s,
        "charged:" + b.id,
        [
          line("processor_clearing", b.totalCents),
          line("service_liability", 0, b.totalCents),
        ],
        now,
      );
      break;
    }
    case "cancel": {
      const b = booking(s, payload.bookingId);
      need(
        ["HOST_REQUESTED", "HOST_ACCEPTED", "READY"].includes(b.status),
        "This request cannot be cancelled.",
      );
      b.status = "CANCELLED";
      b.endedAt = now;
      reversePayment(s, b, now, "Cancelled before joining");
      break;
    }
    case "join": {
      const b = booking(s, payload.bookingId);
      need(
        !s.blocks.includes(b.hostId) && s.eligible,
        "Access is not available.",
      );
      need(
        b.status === "READY" && b.payment === "SIMULATED_SUCCEEDED",
        "A confirmed demo checkout is required within the join window.",
      );
      need(
        s.operations.staffed && s.operations.providerHealthy,
        "Calls are currently unavailable.",
      );
      b.status = "LIVE";
      b.startedAt = now;
      b.overlapStartedAt = now;
      b.deadline = now + b.duration * 60000;
      break;
    }
    case "disconnect": {
      const b = booking(s, payload.bookingId);
      need(b.status === "LIVE", "This session is not live.");
      b.overlapSeconds += Math.max(
        0,
        Math.floor((now - b.overlapStartedAt) / 1000),
      );
      b.overlapStartedAt = null;
      b.status = "RECONNECTING";
      break;
    }
    case "reconnect": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "RECONNECTING" && !s.blocks.includes(b.hostId),
        "This session cannot reconnect.",
      );
      need(
        s.operations.providerHealthy && s.operations.staffed,
        "Calls are currently unavailable.",
      );
      b.status = "LIVE";
      b.overlapStartedAt = now;
      break;
    }
    case "leave": {
      const b = booking(s, payload.bookingId);
      need(
        ["LIVE", "RECONNECTING"].includes(b.status),
        "This session has already ended.",
      );
      finish(s, b, "PARTIAL_DELIVERY", now);
      break;
    }
    case "complete-demo": {
      const b = booking(s, payload.bookingId);
      need(b.status === "LIVE", "This session is not live.");
      b.overlapSeconds = b.duration * 60;
      b.overlapStartedAt = null;
      b.completionSource = "explicit-demo-shortcut";
      finish(s, b, "COMPLETED", now);
      break;
    }
    case "select-activity": {
      const b = booking(s, payload.bookingId);
      need(
        ["READY", "LIVE", "RECONNECTING"].includes(b.status),
        "Activities are available while preparing or inside the demo room.",
      );
      need(
        payload.activityId === null ||
          activities.some(
            (a) => a.id === payload.activityId && a.experience === b.experience,
          ),
        "Choose a sample activity for this experience.",
      );
      b.activityId = payload.activityId;
      b.activityProgress = {
        promptIndex: 0,
        answerRevealed: false,
        completed: false,
        revision: (b.activityProgress?.revision || 0) + 1,
      };
      break;
    }
    case "activity-action": {
      const b = booking(s, payload.bookingId);
      need(
        ["READY", "LIVE", "RECONNECTING"].includes(b.status),
        "Activities are available while preparing or inside the demo room.",
      );
      const activity = activities.find(
        (item) => item.id === b.activityId && item.experience === b.experience,
      );
      need(
        activity && payload.activityId === activity.id,
        "Choose the current activity before changing its prompt.",
      );
      const progress = b.activityProgress || {
        promptIndex: 0,
        answerRevealed: false,
        completed: false,
        revision: 0,
      };
      need(
        payload.revision === progress.revision,
        "This activity has changed. Use the current prompt.",
      );
      need(
        ["next", "reveal", "hide", "complete", "restart"].includes(
          payload.command,
        ),
        "Choose a valid activity action.",
      );
      need(
        !progress.completed || payload.command === "restart",
        "This activity is complete. Restart it or choose another card.",
      );
      const rounds = activityRounds(activity);
      if (payload.command === "next") {
        need(
          progress.promptIndex + 1 < rounds.length,
          "This is the final prompt.",
        );
        progress.promptIndex++;
        progress.answerRevealed = false;
      }
      if (["reveal", "hide"].includes(payload.command)) {
        need(
          !!rounds[progress.promptIndex].answer,
          "This prompt has no written answer.",
        );
        progress.answerRevealed = payload.command === "reveal";
      }
      if (payload.command === "complete") progress.completed = true;
      if (payload.command === "restart") {
        progress.promptIndex = 0;
        progress.answerRevealed = false;
        progress.completed = false;
      }
      progress.revision++;
      b.activityProgress = progress;
      break;
    }
    case "worth-it": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "COMPLETED" && b.payment !== "UNPAID",
        "Value feedback is available after a completed paid demo session.",
      );
      need(
        ["yes", "no", "skipped"].includes(payload.answer),
        "Choose yes, no or skip.",
      );
      need(
        payload.details === undefined ||
          (typeof payload.details === "string" &&
            payload.details.length <= 1000),
        "Value feedback must be 1,000 characters or fewer.",
      );
      b.valueFeedback = {
        answer: payload.answer,
        details:
          payload.answer === "skipped" ? "" : payload.details?.trim() || "",
        createdAt: b.valueFeedback?.createdAt || now,
        updatedAt: now,
        simulated: true,
      };
      break;
    }
    case "quality-feedback": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "COMPLETED" && b.payment !== "UNPAID",
        "Private quality feedback is available after a completed paid demo session.",
      );
      b.qualityFeedback = {
        text: short(payload.text, 1000),
        createdAt: b.qualityFeedback?.createdAt || now,
        updatedAt: now,
        simulated: true,
      };
      break;
    }
    case "rate": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "COMPLETED" && b.payment !== "UNPAID",
        "Only completed, delivered demo sessions can receive host ratings.",
      );
      need(
        Number.isInteger(payload.rating) &&
          payload.rating >= 1 &&
          payload.rating <= 5 &&
          (payload.comfortRating === undefined ||
            (Number.isInteger(payload.comfortRating) &&
              payload.comfortRating >= 1 &&
              payload.comfortRating <= 5)),
        "Choose ratings from one to five.",
      );
      need(
        payload.review === undefined ||
          (typeof payload.review === "string" && payload.review.length <= 1000),
        "Reviews must be 1,000 characters or fewer.",
      );
      b.rating = payload.rating;
      if (payload.comfortRating !== undefined)
        b.comfortRating = payload.comfortRating;
      b.review = payload.review?.trim() || "";
      b.reviewUpdatedAt = now;
      break;
    }
    case "service-feedback": {
      const b = booking(s, payload.bookingId);
      need(
        isTerminal(b.status) && b.status !== "COMPLETED",
        "Service-failure feedback is for an undelivered or interrupted session.",
      );
      const text = short(payload.text, 1000),
        f = s.feedback.find((f) => f.bookingId === b.id);
      if (f) {
        f.text = text;
        f.updatedAt = now;
      } else
        s.feedback.push({
          id: crypto.randomUUID(),
          bookingId: b.id,
          kind: "service-failure",
          text,
          createdAt: now,
        });
      break;
    }
    case "refund-feedback": {
      const b = booking(s, payload.bookingId);
      need(
        b.payment === "SIMULATED_REFUNDED",
        "Refund feedback is available after a simulated refund.",
      );
      b.refundFeedback = { text: short(payload.text, 1000), updatedAt: now };
      break;
    }
    case "tip": {
      const b = booking(s, payload.bookingId);
      need(
        b.status === "COMPLETED" && b.payment === "SIMULATED_SUCCEEDED",
        "Tips are available after a completed paid session.",
      );
      need(now - b.endedAt < 86400000, "The 24-hour tipping window has ended.");
      need(!b.tipCents, "A tip has already been confirmed for this session.");
      need(
        Number.isInteger(payload.cents) &&
          payload.cents >= 100 &&
          payload.cents <= 5000,
        "Custom tips must be between $1 and $50.",
      );
      b.tipCents = payload.cents;
      journal(
        s,
        "tip:" + b.id,
        [
          line("processor_clearing", payload.cents),
          line("host_tip_payable", 0, payload.cents),
        ],
        now,
      );
      break;
    }
    case "report":
    case "invite-guest-report": {
      const guestReport = action === "invite-guest-report";
      const b = guestReport || payload.bookingId ? booking(s, payload.bookingId) : null;
      if (guestReport)
        need(demoGuestCanReport(b), "An admitted guest can report a concern.");
      const hostId = guestReport ? b.hostId : payload.hostId;
      host(hostId);
      need(
        !b || b.hostId === hostId,
        "The reported host must match the selected session.",
      );
      need(
        payload.urgent === undefined || typeof payload.urgent === "boolean",
        "Choose a valid urgency.",
      );
      const r = {
        id: crypto.randomUUID(),
        hostId,
        bookingId: b?.id || null,
        reason: short(payload.reason),
        urgent: !!payload.urgent,
        status: "OPEN",
        createdAt: now,
        ...(guestReport ? { fromDemoGuest: true } : {}),
      };
      s.reports.unshift(r);
      result = { caseId: r.id };
      if (payload.urgent && b && ["LIVE", "RECONNECTING"].includes(b.status))
        finish(s, b, "PARTIAL_DELIVERY", now);
      break;
    }
    case "block":
      host(payload.hostId);
      if (!s.blocks.includes(payload.hostId)) s.blocks.push(payload.hostId);
      s.favorites = s.favorites.filter((id) => id !== payload.hostId);
      for (const b of s.bookings.filter(
        (b) => b.hostId === payload.hostId && !isTerminal(b.status),
      )) {
        if (["LIVE", "RECONNECTING"].includes(b.status))
          finish(s, b, "PARTIAL_DELIVERY", now);
        else {
          b.status = "CANCELLED";
          b.endedAt = now;
          reversePayment(s, b, now, "Host blocked before joining");
        }
      }
      break;
    case "unblock":
      host(payload.hostId);
      s.blocks = s.blocks.filter((id) => id !== payload.hostId);
      break;
    case "refund-request": {
      const b = booking(s, payload.bookingId);
      need(
        b.payment === "SIMULATED_SUCCEEDED",
        "There is no refundable demo payment.",
      );
      need(
        isTerminal(b.status),
        "End the session before requesting a refund review.",
      );
      need(
        !s.refunds.some((r) => r.bookingId === b.id),
        "A review already exists for this session.",
      );
      requestRefund(s, b, short(payload.reason), now);
      break;
    }
    case "presence":
      host(payload.hostId);
      need(
        typeof payload.online === "boolean",
        "Choose an availability state.",
      );
      s.hostOnline[payload.hostId] = payload.online;
      break;
    case "operations":
      need(
        ["staffed", "providerHealthy"].includes(payload.setting) &&
          typeof payload.value === "boolean",
        "Invalid operations setting.",
      );
      s.operations[payload.setting] = payload.value;
      if (!payload.value)
        for (const b of s.bookings)
          if (["LIVE", "RECONNECTING"].includes(b.status))
            finish(s, b, "FAILED_SERVICE", now);
      break;
    case "case-action": {
      const r = s.reports.find((r) => r.id === payload.caseId);
      need(r, "Case not found.");
      need(r.status !== "CLOSED", "This case is already closed.");
      need(
        ["ASSIGNED", "ESCALATED", "CLOSED"].includes(payload.status),
        "Invalid case status.",
      );
      decision = {
        previousStatus: r.status,
        decision: payload.status,
        reason: short(payload.reason),
        subjectType: "case",
      };
      r.status = payload.status;
      r.note = decision.reason;
      break;
    }
    case "refund-resolve": {
      const r = s.refunds.find((r) => r.id === payload.refundId);
      need(r && r.status === "OPEN", "This refund request is no longer open.");
      const b = booking(s, r.bookingId);
      need(
        isTerminal(b.status),
        "End the session before resolving its refund.",
      );
      need(
        b.payment === "SIMULATED_SUCCEEDED",
        "This payment has already been refunded.",
      );
      r.resolution = short(payload.reason);
      decision = {
        previousStatus: r.status,
        decision: "REFUNDED",
        reason: r.resolution,
        subjectType: "refund",
      };
      r.status = "REFUNDED";
      r.resolvedAt = now;
      reversePayment(s, b, now, r.resolution);
      break;
    }
    case "apply":
      need(payload.adult === true, "Applicants must be at least 18.");
      need(!s.applications.length, "You already have a demo application.");
      s.applications.push({
        id: crypto.randomUUID(),
        name: short(payload.name, 100),
        bio: short(payload.bio, 1000),
        status: "PENDING_REVIEW",
        createdAt: now,
      });
      result = { applicationId: s.applications.at(-1).id };
      break;
    case "application-decision": {
      const a = s.applications.find((a) => a.id === payload.applicationId);
      need(a, "Application not found.");
      need(
        ["TRAINING_REQUIRED", "DECLINED"].includes(payload.status),
        "Select a valid decision.",
      );
      need(
        a.status === "PENDING_REVIEW",
        "This application has already been reviewed.",
      );
      decision = {
        previousStatus: a.status,
        decision: payload.status,
        reason: short(payload.reason),
        subjectType: "application",
      };
      a.status = payload.status;
      a.reason = decision.reason;
      break;
    }
    case "close-account":
      need(
        !s.bookings.some((b) => !isTerminal(b.status)),
        "End or cancel your active session before closing the account.",
      );
      need(
        !hasPendingReviews(s),
        "Resolve your open safety cases and refund reviews in Operations before closing the account.",
      );
      s.closed = true;
      removeProfileContent(s, now);
      break;
    case "reset": {
      const resetRequests = s.resetRequests;
      Object.assign(s, initialState(), { resetRequests });
      result = { reset: true };
      break;
    }
    default:
      if (isDemoInviteAction(action)) {
        const b = booking(s, payload.bookingId);
        result = applyDemoInvite(b, action, payload, now, need);
        break;
      }
      fail(
        "NOT_FOUND",
        "Unknown demo action. Production provider operations are not implemented.",
        404,
      );
  }
  audit(
    s,
    action,
    payload.refundId ||
      payload.applicationId ||
      payload.caseId ||
      result.caseId ||
      result.applicationId ||
      payload.bookingId ||
      payload.hostId ||
      result.bookingId ||
      null,
    now,
    decision,
  );
  // Older closed workspaces can finish their outstanding reviews before final redaction.
  if (s.closed && !hasPendingReviews(s)) removeProfileContent(s, now);
  const replayResult =
    action === "invite-issue"
      ? { invitationStatus: result.invitationStatus, expiresAt: result.expiresAt }
      : result;
  // Define an own property so even '__proto__' is a harmless opaque replay key.
  Object.defineProperty(
    action === "reset" ? s.resetRequests : s.idempotency,
    key,
    {
      value: { fingerprint: digest, result: replayResult },
      enumerable: true,
      writable: true,
      configurable: true,
    },
  );
  return { state: s, result };
}
export function summarize(s, now = Date.now()) {
  const clean = expire(structuredClone(s), now);
  delete clean.idempotency;
  delete clean.resetRequests;
  for (const booking of clean.bookings)
    if (booking.invitation) delete booking.invitation.tokenDigest;
  return { ...clean, serverNow: now, ...DEMO_CAPABILITIES };
}

export function valueFeedbackSummary(bookings, from = 0, until = Infinity) {
  const eligible = bookings.filter(
    (item) =>
      item.status === "COMPLETED" &&
      item.payment !== "UNPAID" &&
      item.endedAt >= from &&
      item.endedAt < until,
  );
  const answered = eligible.filter((item) =>
    ["yes", "no"].includes(item.valueFeedback?.answer),
  );
  return {
    eligible: eligible.length,
    answered: answered.length,
    yes: answered.filter((item) => item.valueFeedback.answer === "yes").length,
    skipped: eligible.filter((item) => item.valueFeedback?.answer === "skipped")
      .length,
  };
}
