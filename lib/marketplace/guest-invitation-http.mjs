import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { createGuestInvitations, guestKey, requireGuestInvitations } from "./guest-invitations.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";
import { boundedJson } from "./http-handlers.mjs";

const cookieName = "__Host-hc-stage-guest";
const quotas = {
  wait: [120, 12, 0],
  status: [1200, 180, 60],
  report: [120, 24, 8],
  leave: [120, 24, 8],
};
const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
function cookieNameFor(scope) {
  return scope && /^[a-f0-9]{48}$/.test(scope) ? cookieName + "-" + scope : null;
}
function bindingCookie(request, name) {
  const cookies = request.headers.get("cookie")?.split(";").map((value) => value.trim()) || [];
  const valueFor = (key) => cookies.find((value) => value.startsWith(key + "="))?.slice(key.length + 1);
  // Old preview links may still have a single legacy cookie until their original deadline.
  return name ? valueFor(name) || valueFor(cookieName) : undefined;
}
function cookie(name, binding, maxAge) {
  return name + "=" + binding +
    "; Path=/; Max-Age=" + maxAge + "; Secure; HttpOnly; SameSite=Strict";
}

async function checkGuestQuota(db, request, config, clock, action, binding = null) {
  const window = Math.floor(clock() / 60_000);
  const [globalLimit, sourceLimit, bindingLimit] = quotas[action];
  // Only an edge request supplies trusted address metadata for the per-source quota.
  const address = request.cf && request.headers.get("CF-Connecting-IP");
  function quotaKey(kind, value) {
    if (!value) return null;
    return createHmac("sha256", guestKey(config.MARKETPLACE_SESSION_SECRET, "request-quota"))
      .update(JSON.stringify([action, kind, window, value])).digest("hex");
  }
  const source = quotaKey("source", address && isIP(address) ? address : null);
  const bound = quotaKey("binding", binding);
  const { results } = await db.prepare(
    `WITH requested(bucket,request_limit) AS (VALUES (?,?),(?,?),(?,?)),
     admitted AS MATERIALIZED (
       SELECT bucket FROM requested WHERE bucket IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM requested candidate JOIN mp_demo_guest_claim_quota quota ON quota.bucket=candidate.bucket
         WHERE quota.window=? AND quota.count>=candidate.request_limit
       )
     )
     INSERT INTO mp_demo_guest_claim_quota(bucket,window,count)
     SELECT bucket,?,1 FROM admitted WHERE 1
     ON CONFLICT(bucket,window) DO UPDATE SET count=count+1 RETURNING bucket`,
  ).bind(action, globalLimit, source, sourceLimit, bound, bindingLimit, window, window).all();
  need(results.length > 0, "RATE_LIMITED", "Too many guest requests. Try again shortly.", 429);
}

export function createGuestInvitationHttp({ storage, clock = Date.now }) {
  return async function handle(request) {
    const scope = request.headers.get("x-hc-guest-scope");
    const scopedCookieName = cookieNameFor(scope);
    const binding = bindingCookie(request, scopedCookieName);
    try {
      need(["GET", "POST"].includes(request.method),
        "METHOD_NOT_ALLOWED", "This method is unavailable.", 405);
      if (request.method === "POST")
        need(
          request.headers.get("origin") === new URL(request.url).origin,
          "ORIGIN_DENIED", "This request origin is unavailable.", 403,
        );
      const { config, db } = await storage();
      requireGuestInvitations(config);
      const invitations = createGuestInvitations(db, { clock });
      function quota(action) {
        // Malformed bindings are rejected by the invitation service without using D1.
        if (scopedCookieName && cookieNameFor(binding))
          return checkGuestQuota(db, request, config, clock, action, binding);
      }
      if (request.method === "GET") {
        await quota("status");
        const data = await invitations.guestState(scope, binding);
        const finished = !["GUEST_WAITING", "GUEST_ADMITTED"].includes(data.status);
        return Response.json({ data }, { headers: finished && scopedCookieName
          ? { ...privateHeaders, "Set-Cookie": cookie(scopedCookieName, "", 0) }
          : privateHeaders });
      }
      const body = await boundedJson(request, 1024);
      if (body?.action === "wait") {
        await checkGuestQuota(db, request, config, clock, "wait");
        const { data, binding, maxAge } = await invitations.claim(body.token, body.terms);
        return Response.json({ data }, {
          headers: { ...privateHeaders, "Set-Cookie": cookie(cookieNameFor(data.scope), binding, maxAge) },
        });
      }
      if (body?.action === "leave") {
        await quota("leave");
        const data = await invitations.leave(scope, binding);
        return Response.json({ data }, {
          headers: { ...privateHeaders, "Set-Cookie": cookie(scopedCookieName, "", 0) },
        });
      }
      if (body?.action === "report") {
        await quota("report");
        const data = await invitations.report(scope, binding, body.category);
        return Response.json({ data }, { headers: privateHeaders });
      }
      need(false, "VALIDATION", "Choose an available guest action.", 400);
    } catch (error) {
      const known = error instanceof MarketplaceError;
      const headers = { ...privateHeaders };
      if (known && error.status === 429) headers["Retry-After"] = "60";
      if (known && ["INVITATION_UNAVAILABLE", "GUEST_PREVIEW_DISABLED"].includes(error.code) && binding)
        headers["Set-Cookie"] = cookie(scopedCookieName, "", 0);
      return Response.json({
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "The demo guest service is unavailable.",
        },
      }, { status: known ? error.status : 500, headers });
    }
  };
}
