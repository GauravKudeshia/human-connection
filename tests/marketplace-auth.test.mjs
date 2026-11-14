import test from "node:test";
import assert from "node:assert/strict";
import { verifyAccessToken } from "../lib/marketplace/auth.mjs";
const now = 1_800_000_000_000;
const config = {
  MARKETPLACE_AUTH_ISSUER: "https://identity.example.test/",
  MARKETPLACE_AUTH_AUDIENCE: "hc-staging",
  MARKETPLACE_AUTH_JWKS_URL: "https://identity.example.test/jwks",
};
const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
  kid: "test-key",
  use: "sig",
  alg: "RS256",
};
const fetcher = async () => Response.json({ keys: [jwk] });
const encode = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
async function request(overrides = {}) {
  const header = encode({ alg: "RS256", kid: "test-key" });
  const body = encode({
    iss: config.MARKETPLACE_AUTH_ISSUER,
    aud: config.MARKETPLACE_AUTH_AUDIENCE,
    sub: "test-customer",
    email_verified: true,
    exp: now / 1000 + 300,
    ...overrides,
  });
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(header + "." + body),
    ),
  ).toString("base64url");
  return new Request("https://hc.example.test/api/marketplace", {
    headers: {
      Authorization: "Bearer " + header + "." + body + "." + signature,
    },
  });
}
test("managed access tokens require configured issuer, audience, signature, email verification and expiry", async () => {
  const verified = await verifyAccessToken(await request(), config, {
    fetcher,
    now,
  });
  assert.equal(verified.subject, "test-customer");
  assert.equal(verified.stepUp, false);
  for (const claims of [
    { iss: "https://other.example.test/" },
    { aud: "other-api" },
    { exp: now / 1000 },
    { email_verified: false },
    { nbf: now / 1000 + 1 },
  ])
    await assert.rejects(
      () =>
        request(claims).then((r) =>
          verifyAccessToken(r, config, { fetcher, now }),
        ),
      (e) => e.status === 401,
    );
  await assert.rejects(
    () =>
      verifyAccessToken(
        new Request("https://hc.example.test", {
          headers: { "oai-authenticated-user-id": "test-customer" },
        }),
        config,
        { fetcher, now },
      ),
    (e) => e.status === 401,
  );
  await assert.rejects(
    () => request().then((r) => verifyAccessToken(r, {}, { fetcher, now })),
    (e) => e.status === 503,
  );
});
test("step-up requires signed recent MFA and provider role claims are never granted", async () => {
  const fresh = await verifyAccessToken(
    await request({ amr: ["mfa"], auth_time: now / 1000, roles: ["admin"] }),
    config,
    { fetcher, now },
  );
  assert.equal(fresh.stepUp, true);
  assert.equal(fresh.roles, undefined);
  const old = await verifyAccessToken(
    await request({ amr: ["mfa"], auth_time: now / 1000 - 601 }),
    config,
    { fetcher, now },
  );
  assert.equal(old.stepUp, false);
  const keyFailure = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(
    () =>
      request().then((r) =>
        verifyAccessToken(r, config, { fetcher: keyFailure, now }),
      ),
    (e) => e.status === 503,
  );
});
