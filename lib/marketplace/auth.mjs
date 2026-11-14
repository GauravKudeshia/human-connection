import { MarketplaceError, requireCondition } from "./errors.mjs";

function decodePart(value) {
  requireCondition(
    typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value),
    "UNAUTHENTICATED",
    "A valid access token is required.",
    401,
  );
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
function jsonPart(value) {
  try {
    return JSON.parse(new TextDecoder().decode(decodePart(value)));
  } catch {
    throw new MarketplaceError(
      "UNAUTHENTICATED",
      "A valid access token is required.",
      401,
    );
  }
}
export async function verifyAccessToken(
  request,
  config,
  { fetcher = fetch, now = Date.now() } = {},
) {
  const issuer = config.MARKETPLACE_AUTH_ISSUER;
  const audience = config.MARKETPLACE_AUTH_AUDIENCE;
  const jwksUrl = config.MARKETPLACE_AUTH_JWKS_URL;
  requireCondition(
    issuer && audience && jwksUrl,
    "AUTH_NOT_CONFIGURED",
    "Staging authentication is not configured.",
    503,
  );
  let url;
  try {
    url = new URL(jwksUrl);
  } catch {
    throw new MarketplaceError(
      "AUTH_NOT_CONFIGURED",
      "The authentication key endpoint is invalid.",
      503,
    );
  }
  requireCondition(
    url.protocol === "https:" && !url.username && !url.password,
    "AUTH_NOT_CONFIGURED",
    "Authentication keys require HTTPS.",
    503,
  );
  const authorization = request.headers.get("authorization") || "";
  requireCondition(
    authorization.startsWith("Bearer ") && authorization.length <= 8192,
    "UNAUTHENTICATED",
    "Sign in with the configured identity provider.",
    401,
  );
  const token = authorization.slice(7);
  const parts = token.split(".");
  requireCondition(
    parts.length === 3,
    "UNAUTHENTICATED",
    "A valid access token is required.",
    401,
  );
  const header = jsonPart(parts[0]);
  const claims = jsonPart(parts[1]);
  requireCondition(
    header &&
      claims &&
      typeof header === "object" &&
      typeof claims === "object" &&
      !Array.isArray(header) &&
      !Array.isArray(claims),
    "UNAUTHENTICATED",
    "A valid access token is required.",
    401,
  );
  requireCondition(
    header.alg === "RS256" &&
      typeof header.kid === "string" &&
      header.kid.length <= 128,
    "UNAUTHENTICATED",
    "Unsupported access token.",
    401,
  );
  let response;
  try {
    response = await fetcher(url.href, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
  } catch {
    throw new MarketplaceError(
      "AUTH_UNAVAILABLE",
      "Authentication could not be verified.",
      503,
    );
  }
  requireCondition(
    response.ok,
    "AUTH_UNAVAILABLE",
    "Authentication keys are temporarily unavailable.",
    503,
  );
  let keys;
  try {
    keys = (await response.json()).keys;
  } catch {
    throw new MarketplaceError(
      "AUTH_UNAVAILABLE",
      "Authentication keys are invalid.",
      503,
    );
  }
  const key =
    Array.isArray(keys) &&
    keys.find(
      (candidate) =>
        candidate.kid === header.kid &&
        candidate.kty === "RSA" &&
        (!candidate.use || candidate.use === "sig") &&
        (!candidate.alg || candidate.alg === "RS256"),
    );
  requireCondition(
    key,
    "UNAUTHENTICATED",
    "This access token cannot be verified.",
    401,
  );
  let valid = false;
  try {
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      decodePart(parts[2]),
      new TextEncoder().encode(parts[0] + "." + parts[1]),
    );
  } catch {
    /* Malformed signatures and unsupported keys remain unauthenticated. */
  }
  const seconds = Math.floor(now / 1000);
  requireCondition(
    valid &&
      claims.iss === issuer &&
      (claims.aud === audience ||
        (Array.isArray(claims.aud) && claims.aud.includes(audience))) &&
      Number.isSafeInteger(claims.exp) &&
      claims.exp > seconds &&
      (claims.nbf === undefined ||
        (Number.isSafeInteger(claims.nbf) && claims.nbf <= seconds)) &&
      typeof claims.sub === "string" &&
      claims.sub.length > 0 &&
      claims.sub.length <= 255 &&
      claims.email_verified === true,
    "UNAUTHENTICATED",
    "The verified sign-in session is invalid or expired.",
    401,
  );
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
