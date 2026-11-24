import { isTerminal } from "./demo-policy.mjs";
import { fingerprint } from "./fingerprint.mjs";

const linkLifetimeMs = 3 * 60_000;
const terminal = new Set([
  "HOST_DECLINED",
  "CUSTOMER_DECLINED",
  "REVOKED",
  "GUEST_REMOVED",
  "GUEST_LEFT",
  "EXPIRED",
  "SESSION_ENDED",
]);
const awaitingGuest = ["ISSUED", "GUEST_OPENED", "GUEST_WAITING", "GUEST_ADMITTED"];
const cancellable = ["HOST_PENDING", "HOST_APPROVED", ...awaitingGuest];
const guestInRoom = ["GUEST_CONNECTED", "GUEST_DISCONNECTED"];
const transitions = {
  "invite-request": { from: [undefined], to: "HOST_PENDING" },
  "invite-host-approve": { from: ["HOST_PENDING"], to: "HOST_APPROVED" },
  "invite-host-decline": { from: ["HOST_PENDING"], to: "HOST_DECLINED" },
  "invite-issue": { from: ["HOST_APPROVED", "ISSUED"], to: "ISSUED" },
  "invite-guest-open": { from: ["ISSUED"], to: "GUEST_OPENED" },
  "invite-guest-consent": { from: ["GUEST_OPENED"], to: "GUEST_WAITING" },
  "invite-admit": { from: ["GUEST_WAITING"], to: "GUEST_ADMITTED" },
  "invite-customer-decline": { from: ["GUEST_WAITING"], to: "CUSTOMER_DECLINED", duringReconnect: true },
  "invite-guest-join": { from: ["GUEST_ADMITTED"], to: "GUEST_CONNECTED" },
  "invite-guest-disconnect": { from: ["GUEST_CONNECTED"], to: "GUEST_DISCONNECTED" },
  "invite-guest-reconnect": { from: ["GUEST_DISCONNECTED"], to: "GUEST_CONNECTED" },
  "invite-guest-leave": { from: guestInRoom, to: "GUEST_LEFT", duringReconnect: true },
  "invite-remove": { from: ["GUEST_ADMITTED", ...guestInRoom], to: "GUEST_REMOVED", duringReconnect: true },
  "invite-host-withdraw": { from: [...cancellable, ...guestInRoom], to: "REVOKED", duringReconnect: true },
  "invite-cancel": { from: cancellable, to: "REVOKED", duringReconnect: true },
};

export const isDemoInviteAction = (action) => Object.hasOwn(transitions, action);
export const demoGuestCanReport = (booking) =>
  guestInRoom.includes(booking.invitation?.status) &&
  ["LIVE", "RECONNECTING"].includes(booking.status) &&
  booking.payment === "SIMULATED_SUCCEEDED";

function setStatus(invitation, status, now) {
  invitation.status = status;
  invitation.updatedAt = now;
  if (status !== "ISSUED") delete invitation.tokenDigest;
}

export function expireDemoInvite(booking, now) {
  const invitation = booking.invitation;
  if (!invitation || terminal.has(invitation.status)) return;
  if (isTerminal(booking.status)) {
    setStatus(invitation, "SESSION_ENDED", now);
  } else if (awaitingGuest.includes(invitation.status) && now >= invitation.expiresAt) {
    setStatus(invitation, "EXPIRED", now);
  }
}

function tokenDigest(bookingId, token) {
  return fingerprint(bookingId + ":" + token);
}

export function applyDemoInvite(booking, action, payload, now, need) {
  const { from, to, duringReconnect } = transitions[action];
  need(
    booking.payment === "SIMULATED_SUCCEEDED" &&
      now < booking.deadline &&
      (booking.status === "LIVE" ||
        (duringReconnect && booking.status === "RECONNECTING")),
    "An active paid demo room is required for this invitation action.",
  );
  need(
    from.includes(booking.invitation?.status),
    "This action is unavailable at the current invitation step.",
  );
  const invitation = (booking.invitation ??= {});
  const result = { invitationStatus: to };
  if (action === "invite-issue") {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    invitation.tokenDigest = tokenDigest(booking.id, token);
    invitation.expiresAt ??= Math.min(now + linkLifetimeMs, booking.deadline);
    result.invitationToken = token;
    result.expiresAt = invitation.expiresAt;
  } else if (action === "invite-guest-open") {
    const { token } = payload;
    need(
      typeof token === "string" &&
        /^[0-9a-f]{48}$/.test(token) &&
        tokenDigest(booking.id, token) === invitation.tokenDigest,
      "This invitation does not belong to this room or is no longer valid.",
    );
  } else if (action === "invite-guest-consent") {
    need(
      payload.adult === true && payload.us === true && payload.terms === true,
      "Confirm the demo guest age, location and participation terms.",
    );
    invitation.guestTermsVersion = "demo-1.3";
  }
  setStatus(invitation, to, now);
  return result;
}
