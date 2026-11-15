import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
import { MarketplaceError, requireCondition } from "./errors.mjs";

async function verifyJwt(
  token,
  config,
  audience,
  { fetcher = fetch, now = Date.now() } = {},
) {
  const issuer = config.MARKETPLACE_AUTH_ISSUER;
  const jwks = config.MARKETPLACE_AUTH_JWKS_URL;
  requireCondition(
    issuer && audience && jwks,
    "AUTH_NOT_CONFIGURED",
    "Staging authentication is not configured.",
    503,
  );
  let url;
  try {
    url = new URL(jwks);
    requireCondition(
      new URL(issuer).protocol === "https:" &&
        url.protocol === "https:" &&
        !url.username &&
        !url.password,
      "AUTH_NOT_CONFIGURED",
      "Authentication requires HTTPS.",
      503,
    );
  } catch {
    throw new MarketplaceError(
      "AUTH_NOT_CONFIGURED",
      "Authentication endpoints are invalid.",
      503,
    );
  }
  requireCondition(
    typeof token === "string" && token.length > 0 && token.length <= 8192,
    "UNAUTHENTICATED",
    "A valid sign-in token is required.",
    401,
  );
  try {
    const keys = createRemoteJWKSet(url, {
      [customFetch]: fetcher,
      timeoutDuration: 5000,
    });
    const { payload } = await jwtVerify(token, keys, {
      algorithms: ["RS256"],
      issuer,
      audience,
      currentDate: new Date(now),
      requiredClaims: ["exp", "sub"],
      clockTolerance: 0,
    });
    requireCondition(
      typeof payload.sub === "string" &&
        payload.sub.length <= 255 &&
        payload.email_verified === true,
      "UNAUTHENTICATED",
      "Verify your account email before signing in.",
      401,
    );
    return payload;
  } catch (error) {
    if (error instanceof MarketplaceError) throw error;
    if (
      error.code === "ERR_JWKS_TIMEOUT" ||
      error instanceof TypeError ||
      error.message === "unavailable"
    )
      throw new MarketplaceError(
        "AUTH_UNAVAILABLE",
        "Authentication could not be verified.",
        503,
      );
    throw new MarketplaceError(
      "UNAUTHENTICATED",
      "The sign-in token is invalid or expired.",
      401,
    );
  }
}
export function identityFromClaims(claims, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  return {
    subject: claims.sub,
    displayName:
      typeof claims.name === "string" ? claims.name.slice(0, 100) : "Member",
    stepUp:
      Array.isArray(claims.amr) &&
      claims.amr.includes("mfa") &&
      Number.isSafeInteger(claims.auth_time) &&
      claims.auth_time <= seconds + 30 &&
      claims.auth_time >= seconds - 600,
  };
}
export async function verifyAccessToken(request, config, options = {}) {
  const authorization = request.headers.get("authorization") || "";
  requireCondition(
    authorization.startsWith("Bearer "),
    "UNAUTHENTICATED",
    "Sign in to your account.",
    401,
  );
  const claims = await verifyJwt(
    authorization.slice(7),
    config,
    config.MARKETPLACE_AUTH_AUDIENCE,
    options,
  );
  return identityFromClaims(claims, options.now);
}
export async function verifyIdToken(token, config, { nonce, ...options } = {}) {
  const claims = await verifyJwt(
    token,
    config,
    config.MARKETPLACE_AUTH_CLIENT_ID,
    options,
  );
  requireCondition(
    typeof nonce === "string" && claims.nonce === nonce,
    "UNAUTHENTICATED",
    "The sign-in transaction did not match.",
    401,
  );
  if (Array.isArray(claims.aud) && claims.aud.length > 1)
    requireCondition(
      claims.azp === config.MARKETPLACE_AUTH_CLIENT_ID,
      "UNAUTHENTICATED",
      "The authorized identity client did not match.",
      401,
    );
  return claims;
}
