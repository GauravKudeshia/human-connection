import { createGuestInvitations } from "./guest-invitations.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";
import { boundedJson } from "./http-handlers.mjs";

const cookieName = "__Host-hc-stage-guest";
const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
function bindingCookie(request) {
  return request.headers.get("cookie")
    ?.split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
}
function cookie(binding, maxAge) {
  return cookieName + "=" + binding +
    "; Path=/; Max-Age=" + maxAge + "; Secure; HttpOnly; SameSite=Strict";
}

export function createGuestInvitationHttp({ storage, clock = Date.now }) {
  return async function handle(request) {
    try {
      need(["GET", "POST"].includes(request.method),
        "METHOD_NOT_ALLOWED", "This method is unavailable.", 405);
      if (request.method === "POST")
        need(
          request.headers.get("origin") === new URL(request.url).origin,
          "ORIGIN_DENIED", "This request origin is unavailable.", 403,
        );
      const { db } = await storage();
      const invitations = createGuestInvitations(db, { clock });
      const scope = request.headers.get("x-hc-guest-scope");
      const binding = bindingCookie(request);
      if (request.method === "GET") {
        const data = await invitations.guestState(scope, binding);
        return Response.json({ data }, { headers: privateHeaders });
      }
      const body = await boundedJson(request, 1024);
      if (body?.action === "wait") {
        const { data, binding, maxAge } = await invitations.claim(body.token, body.terms);
        return Response.json({ data }, {
          headers: { ...privateHeaders, "Set-Cookie": cookie(binding, maxAge) },
        });
      }
      if (body?.action === "leave") {
        const data = await invitations.leave(scope, binding);
        return Response.json({ data }, {
          headers: { ...privateHeaders, "Set-Cookie": cookie("", 0) },
        });
      }
      if (body?.action === "report") {
        const data = await invitations.report(scope, binding, body.category);
        return Response.json({ data }, { headers: privateHeaders });
      }
      need(false, "VALIDATION", "Choose an available guest action.", 400);
    } catch (error) {
      const known = error instanceof MarketplaceError;
      return Response.json({
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "The demo guest service is unavailable.",
        },
      }, { status: known ? error.status : 500, headers: privateHeaders });
    }
  };
}
