import { EncryptJWT, jwtDecrypt } from "jose";
import {
  verifyAccessToken,
  verifyIdToken,
  identityFromClaims,
} from "./auth.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";

const cookieName = "hc_beta_session";
const transactionCookie = "hc_beta_oauth";
const encode = (bytes) => Buffer.from(bytes).toString("base64url");
const random = () => encode(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (text) =>
  encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
function origin(config) {
  let url;
  try {
    url = new URL(config.MARKETPLACE_APP_ORIGIN);
  } catch {
    throw new MarketplaceError(
      "AUTH_NOT_CONFIGURED",
      "Configure the staging application origin.",
      503,
    );
  }
  need(
    url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)),
    "AUTH_NOT_CONFIGURED",
    "Use HTTPS for the staging application.",
    503,
  );
  need(
    url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password,
    "AUTH_NOT_CONFIGURED",
    "The staging origin must contain only the scheme and host.",
    503,
  );
  return url.origin;
}
function key(config) {
  let bytes;
  try {
    bytes = Buffer.from(config.MARKETPLACE_SESSION_SECRET, "base64");
  } catch {
    bytes = new Uint8Array();
  }
  need(
    bytes.length === 32,
    "AUTH_NOT_CONFIGURED",
    "Configure a 32-byte encoded session encryption secret.",
    503,
  );
  return bytes;
}
export function browserAuthConfigured(config) {
  try {
    origin(config);
    key(config);
    return (
      config.HC_MARKETPLACE_ENABLED === "true" &&
      config.MARKETPLACE_MODE === "staging" &&
      !!config.MARKETPLACE_DB &&
      !!config.MARKETPLACE_AUTH_ISSUER &&
      !!config.MARKETPLACE_AUTH_CLIENT_ID &&
      !!config.MARKETPLACE_AUTH_JWKS_URL
    );
  } catch {
    return false;
  }
}
function cookies(request) {
  return Object.fromEntries(
    (request.headers.get("cookie") || "")
      .split(";")
      .map((s) => s.trim().split(/=(.*)/s).slice(0, 2)),
  );
}
function cookie(name, value, config, maxAge) {
  return (
    name +
    "=" +
    value +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    maxAge +
    (origin(config).startsWith("https:") ? "; Secure" : "")
  );
}
async function seal(data, config, purpose, expiresAt, now) {
  return new EncryptJWT(data)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuer(origin(config))
    .setAudience(purpose)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .encrypt(key(config));
}
async function unseal(token, config, purpose, now) {
  need(
    typeof token === "string" && token.length <= 8192,
    "UNAUTHENTICATED",
    "Sign in to your account.",
    401,
  );
  try {
    return (
      await jwtDecrypt(token, key(config), {
        issuer: origin(config),
        audience: purpose,
        currentDate: new Date(now),
      })
    ).payload;
  } catch {
    throw new MarketplaceError(
      "UNAUTHENTICATED",
      "Your sign-in session has expired.",
      401,
    );
  }
}
async function discover(config, fetcher) {
  const issuer = new URL(config.MARKETPLACE_AUTH_ISSUER);
  need(
    issuer.protocol === "https:" && !issuer.username && !issuer.password,
    "AUTH_NOT_CONFIGURED",
    "The identity provider requires HTTPS.",
    503,
  );
  const response = await fetcher(
    issuer.href.replace(/\/$/, "") + "/.well-known/openid-configuration",
    { redirect: "error", signal: AbortSignal.timeout(5000) },
  );
  need(
    response.ok,
    "AUTH_UNAVAILABLE",
    "The identity provider is unavailable.",
    503,
  );
  const data = await response.json();
  need(
    data.issuer === issuer.href,
    "AUTH_NOT_CONFIGURED",
    "The identity issuer did not match.",
    503,
  );
  for (const field of ["authorization_endpoint", "token_endpoint"]) {
    const endpoint = new URL(data[field]);
    need(
      endpoint.protocol === "https:" &&
        !endpoint.username &&
        !endpoint.password,
      "AUTH_NOT_CONFIGURED",
      "Identity endpoints require HTTPS.",
      503,
    );
  }
  return data;
}
export function createBrowserAuth(
  db,
  config,
  { fetcher = fetch, clock = Date.now } = {},
) {
  const sql = (query, ...args) => db.prepare(query).bind(...args);
  async function identity(request) {
    if (request.headers.has("authorization"))
      return verifyAccessToken(request, config, { fetcher, now: clock() });
    const payload = await unseal(
      cookies(request)[cookieName],
      config,
      "session",
      clock(),
    );
    const session = await sql(
      "SELECT subject,expires_at,revoked_at FROM mp_auth_sessions WHERE id=?",
      payload.sid,
    ).first();
    need(
      session &&
        !session.revoked_at &&
        session.expires_at > clock() &&
        session.subject === payload.sub,
      "UNAUTHENTICATED",
      "Sign in to your account.",
      401,
    );
    return identityFromClaims(payload, clock());
  }
  async function login(request) {
    need(
      browserAuthConfigured({ ...config, MARKETPLACE_DB: db }),
      "AUTH_NOT_CONFIGURED",
      "Staging sign-in is not configured.",
      503,
    );
    need(
      new URL(request.url).origin === origin(config),
      "ORIGIN_DENIED",
      "The sign-in origin is invalid.",
      403,
    );
    const metadata = await discover(config, fetcher),
      now = clock();
    const id = random(),
      binding = random(),
      nonce = random(),
      verifier = random(),
      expires = now + 600000;
    const encrypted = await seal(
      { verifier, nonce },
      config,
      "pkce",
      expires,
      now,
    );
    await sql(
      "INSERT INTO mp_auth_transactions(id,nonce_hash,verifier_cipher,cookie_hash,return_to,expires_at,created_at) VALUES(?,?,?,?,?,?,?)",
      id,
      await hash(nonce),
      encrypted,
      await hash(binding),
      "/beta",
      expires,
      now,
    ).run();
    const url = new URL(metadata.authorization_endpoint);
    const params = new URL(request.url).searchParams;
    for (const [name, value] of Object.entries({
      client_id: config.MARKETPLACE_AUTH_CLIENT_ID,
      response_type: "code",
      scope: "openid profile email",
      redirect_uri: origin(config) + "/api/marketplace/auth/callback",
      state: id,
      nonce,
      code_challenge: await hash(verifier),
      code_challenge_method: "S256",
    }))
      url.searchParams.set(name, value);
    if (params.get("step_up") === "1") {
      url.searchParams.set("max_age", "0");
      url.searchParams.set(
        "acr_values",
        config.MARKETPLACE_AUTH_MFA_ACR ||
          "http://schemas.openid.net/pape/policies/2007/06/multi-factor",
      );
    }
    if (params.get("signup") === "1")
      url.searchParams.set("screen_hint", "signup");
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.href,
        "Set-Cookie": cookie(
          transactionCookie,
          await seal({ id, binding }, config, "oauth", expires, now),
          config,
          600,
        ),
        "Cache-Control": "no-store",
      },
    });
  }
  async function callback(request) {
    need(
      new URL(request.url).origin === origin(config),
      "ORIGIN_DENIED",
      "The callback origin is invalid.",
      403,
    );
    const params = new URL(request.url).searchParams,
      now = clock();
    const browser = await unseal(
      cookies(request)[transactionCookie],
      config,
      "oauth",
      now,
    );
    need(
      params.get("state") === browser.id && !params.has("error"),
      "UNAUTHENTICATED",
      "Sign-in did not complete.",
      401,
    );
    const tx = await sql(
      "SELECT * FROM mp_auth_transactions WHERE id=?",
      browser.id,
    ).first();
    need(
      tx &&
        !tx.consumed_at &&
        tx.expires_at > now &&
        tx.cookie_hash === (await hash(browser.binding)),
      "UNAUTHENTICATED",
      "The sign-in transaction is invalid or expired.",
      401,
    );
    const secret = await unseal(tx.verifier_cipher, config, "pkce", now);
    need(
      (await hash(secret.nonce)) === tx.nonce_hash,
      "UNAUTHENTICATED",
      "The sign-in transaction did not match.",
      401,
    );
    const consumed = await sql(
      "UPDATE mp_auth_transactions SET consumed_at=? WHERE id=? AND consumed_at IS NULL",
      now,
      tx.id,
    ).run();
    need(
      consumed.meta.changes === 1,
      "UNAUTHENTICATED",
      "Start a new sign-in.",
      401,
    );
    const code = params.get("code");
    need(
      typeof code === "string" && code.length > 0 && code.length < 4096,
      "UNAUTHENTICATED",
      "The authorization code is missing.",
      401,
    );
    const metadata = await discover(config, fetcher);
    const fields = {
      grant_type: "authorization_code",
      client_id: config.MARKETPLACE_AUTH_CLIENT_ID,
      code,
      code_verifier: secret.verifier,
      redirect_uri: origin(config) + "/api/marketplace/auth/callback",
    };
    if (config.MARKETPLACE_AUTH_CLIENT_SECRET)
      fields.client_secret = config.MARKETPLACE_AUTH_CLIENT_SECRET;
    const response = await fetcher(metadata.token_endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
    need(
      response.ok,
      "UNAUTHENTICATED",
      "The identity provider did not complete sign-in.",
      401,
    );
    const tokens = await response.json();
    const claims = await verifyIdToken(tokens.id_token, config, {
      nonce: secret.nonce,
      fetcher,
      now,
    });
    const expiresAt = Math.min(claims.exp * 1000, now + 3600000),
      sid = random();
    await sql(
      "INSERT INTO mp_auth_sessions(id,subject,expires_at,created_at) VALUES(?,?,?,?)",
      sid,
      claims.sub,
      expiresAt,
      now,
    ).run();
    const session = await seal(
      {
        sid,
        sub: claims.sub,
        name: claims.name,
        amr: claims.amr,
        auth_time: claims.auth_time,
      },
      config,
      "session",
      expiresAt,
      now,
    );
    const headers = new Headers({
      Location: origin(config) + tx.return_to,
      "Cache-Control": "no-store",
    });
    headers.append(
      "Set-Cookie",
      cookie(cookieName, session, config, Math.floor((expiresAt - now) / 1000)),
    );
    headers.append("Set-Cookie", cookie(transactionCookie, "", config, 0));
    return new Response(null, { status: 302, headers });
  }
  async function logout(request) {
    need(
      request.headers.get("origin") === origin(config),
      "ORIGIN_DENIED",
      "The request origin is invalid.",
      403,
    );
    try {
      const payload = await unseal(
        cookies(request)[cookieName],
        config,
        "session",
        clock(),
      );
      await sql(
        "UPDATE mp_auth_sessions SET revoked_at=? WHERE id=?",
        clock(),
        payload.sid,
      ).run();
    } catch (error) {
      if (error.status !== 401) throw error;
    }
    return Response.json(
      { signedOut: true },
      {
        headers: {
          "Set-Cookie": cookie(cookieName, "", config, 0),
          "Cache-Control": "no-store",
        },
      },
    );
  }
  return { identity, login, callback, logout };
}
