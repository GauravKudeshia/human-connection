import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { EncryptJWT, jwtDecrypt } from "jose";
import { createGuestInvitations, guestKey, requireGuestInvitations } from "./guest-invitations.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";
import { boundedJson } from "./http-handlers.mjs";

const cookieName = "__Host-hc-stage-guest";
const reportCookieName = "__Host-hc-stage-guest-report";
const reportCookieType = "hc-staging-guest-report";
const reportGraceSeconds = 3600;
const quotas = {
  wait: [120, 12, 0],
  status: [1200, 180, 60],
  "report-status": [1200, 180, 60],
  report: [120, 24, 8],
  leave: [120, 24, 8],
};
const privateHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
function cookieNameFor(scope, prefix = cookieName) {
  return scope && /^[a-f0-9]{48}$/.test(scope) ? prefix + "-" + scope : null;
}
function bindingCookie(request, name, legacyName = cookieName) {
  const cookies = request.headers.get("cookie")?.split(";").map((value) => value.trim()) || [];
  const valueFor = (key) => cookies.find((value) => value.startsWith(key + "="))?.slice(key.length + 1);
  // Old preview links may still have a single legacy cookie until their original deadline.
  return name ? valueFor(name) || (legacyName ? valueFor(legacyName) : undefined) : undefined;
}

function reportCookieKey(config) {
  return guestKey(config.MARKETPLACE_SESSION_SECRET, "report-cookie");
}

async function sealReportCookie(scope, binding, maxAge, config, clock) {
  return new EncryptJWT({ scope, binding })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: reportCookieType })
    .setExpirationTime(Math.floor(clock() / 1000) + maxAge)
    .encrypt(reportCookieKey(config));
}

async function openReportCookie(value, scope, config, clock) {
  if (value.length > 512) return undefined;
  try {
    const { payload } = await jwtDecrypt(value, reportCookieKey(config), {
      typ: reportCookieType,
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
      currentDate: new Date(clock()),
      requiredClaims: ["exp"],
    });
    if (payload.scope === scope && cookieNameFor(payload.binding)) return payload.binding;
  } catch {
    // A malformed, expired, or replaced report cookie grants no access.
  }
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
    const scopedReportName = cookieNameFor(scope, reportCookieName);
    const reportCookie = bindingCookie(request, scopedReportName, null);
    const reportStatus = request.method === "GET" && new URL(request.url).searchParams.get("resource") === "report-status";
    let reporting = reportStatus;
    let authenticatedReportCookie = false;
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
      const invitations = createGuestInvitations(db, { clock, signingSecret: config.MARKETPLACE_SESSION_SECRET });
      function quota(action, credential = binding) {
        // Malformed bindings are rejected by the invitation service without using D1.
        if (scopedCookieName && cookieNameFor(credential))
          return checkGuestQuota(db, request, config, clock, action, credential);
      }
      async function reportBinding() {
        if (!reportCookie) return binding;
        const credential = await openReportCookie(reportCookie, scope, config, clock);
        authenticatedReportCookie = Boolean(credential);
        return credential;
      }
      if (request.method === "GET") {
        if (reportStatus) {
          const credential = await reportBinding();
          await quota("report-status", credential);
          const data = await invitations.reportAccess(scope, credential, { allowGrace: authenticatedReportCookie });
          return Response.json({ data }, { headers: privateHeaders });
        }
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
        const { data, binding, maxAge } = await invitations.claim(body.token, body.terms, body.retryProof);
        const reportMaxAge = maxAge + reportGraceSeconds;
        const reportCredential = await sealReportCookie(data.scope, binding, reportMaxAge, config, clock);
        const headers = new Headers(privateHeaders);
        headers.append("Set-Cookie", cookie(cookieNameFor(data.scope), binding, maxAge));
        headers.append("Set-Cookie", cookie(cookieNameFor(data.scope, reportCookieName), reportCredential, reportMaxAge));
        return Response.json({ data }, { headers });
      }
      if (body?.action === "leave") {
        await quota("leave");
        const data = await invitations.leave(scope, binding);
        return Response.json({ data }, {
          headers: { ...privateHeaders, "Set-Cookie": cookie(scopedCookieName, "", 0) },
        });
      }
      if (body?.action === "report") {
        reporting = true;
        const credential = await reportBinding();
        await quota("report", credential);
        const data = await invitations.report(scope, credential, body.category, { allowGrace: authenticatedReportCookie });
        return Response.json({ data }, { headers: privateHeaders });
      }
      need(false, "VALIDATION", "Choose an available guest action.", 400);
    } catch (error) {
      const known = error instanceof MarketplaceError;
      const headers = { ...privateHeaders };
      if (known && error.status === 429) headers["Retry-After"] = "60";
      if (known && ["INVITATION_UNAVAILABLE", "GUEST_PREVIEW_DISABLED"].includes(error.code)) {
        if (reporting && reportCookie && (!authenticatedReportCookie || error.code === "GUEST_PREVIEW_DISABLED"))
          headers["Set-Cookie"] = cookie(scopedReportName, "", 0);
        if (!reporting && binding) headers["Set-Cookie"] = cookie(scopedCookieName, "", 0);
      }
      return Response.json({
        error: {
          code: known ? error.code : "INTERNAL_ERROR",
          message: known ? error.message : "The demo guest service is unavailable.",
        },
      }, { status: known ? error.status : 500, headers });
    }
  };
}
