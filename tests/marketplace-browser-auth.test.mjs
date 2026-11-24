import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createBrowserAuth } from "../lib/marketplace/browser-auth.mjs";
import { sqliteD1 } from "./marketplace-db.mjs";
const start = 1_800_000_000_000;
const pair = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(pair.publicKey)),
  kid: "tenant",
  use: "sig",
  alg: "RS256",
};
async function fixture() {
  const db = sqliteD1();
  let now = start,
    nonce,
    challenge,
    tokenCalls = 0,
    wrongNonce = false;
  const config = {
    HC_MARKETPLACE_ENABLED: "true",
    MARKETPLACE_MODE: "staging",
    MARKETPLACE_DB: db,
    MARKETPLACE_APP_ORIGIN: "https://hc.example.test",
    MARKETPLACE_AUTH_ISSUER: "https://identity.example.test/",
    MARKETPLACE_AUTH_CLIENT_ID: "client",
    MARKETPLACE_AUTH_AUDIENCE: "api",
    MARKETPLACE_AUTH_JWKS_URL: "https://identity.example.test/jwks",
    MARKETPLACE_SESSION_SECRET: Buffer.alloc(32, 7).toString("base64"),
  };
  const fetcher = async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer: config.MARKETPLACE_AUTH_ISSUER,
        authorization_endpoint: "https://identity.example.test/authorize",
        token_endpoint: "https://identity.example.test/token",
      });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    assert.equal(url, "https://identity.example.test/token");
    tokenCalls++;
    const fields = options.body;
    const actual = Buffer.from(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(fields.get("code_verifier")),
      ),
    ).toString("base64url");
    assert.equal(actual, challenge);
    assert.equal(
      fields.get("redirect_uri"),
      "https://hc.example.test/api/marketplace/auth/callback",
    );
    const idToken = await new SignJWT({
      email_verified: true,
      name: "Test member",
      nonce: wrongNonce ? "wrong" : nonce,
      amr: ["mfa"],
      auth_time: start / 1000,
    })
      .setProtectedHeader({ alg: "RS256", kid: "tenant" })
      .setIssuer(config.MARKETPLACE_AUTH_ISSUER)
      .setAudience("client")
      .setSubject("test-member")
      .setExpirationTime(start / 1000 + 3600)
      .sign(pair.privateKey);
    return Response.json({
      id_token: idToken,
      access_token: "unused-test-access-token",
    });
  };
  const auth = createBrowserAuth(db, config, { fetcher, clock: () => now });
  async function login(query = "step_up=1", expectMfa = true) {
    const response = await auth.login(
      new Request(
        "https://hc.example.test/api/marketplace/auth/login?" + query,
      ),
    );
    const url = new URL(response.headers.get("location"));
    nonce = url.searchParams.get("nonce");
    challenge = url.searchParams.get("code_challenge");
    assert.equal(url.searchParams.get("max_age"), expectMfa ? "0" : null);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const cookie = response.headers.get("set-cookie").split(";")[0];
    return { state: url.searchParams.get("state"), cookie };
  }
  const callback = ({ state, cookie }) =>
    auth.callback(
      new Request(
        "https://hc.example.test/api/marketplace/auth/callback?code=test-code&state=" +
          state,
        { headers: { Cookie: cookie } },
      ),
    );
  return {
    db,
    auth,
    config,
    login,
    callback,
    advance(ms) {
      now += ms;
    },
    wrongNonce() {
      wrongNonce = true;
    },
    calls: () => tokenCalls,
  };
}

test("separate workspaces return only to fixed same-origin pages and staff requests MFA", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const host = await f.callback(await f.login("workspace=host&return_to=https://other.test/", false));
  assert.equal(host.headers.get("location"), "https://hc.example.test/host/login");
  const staff = await f.callback(await f.login("workspace=staff"));
  assert.equal(staff.headers.get("location"), "https://hc.example.test/admin/login");
  await assert.rejects(
    () =>
      f.auth.login(new Request("https://hc.example.test/api/marketplace/auth/login?workspace=//other.test")),
    { status: 400 },
  );
});
test("browser login uses PKCE and a single-use nonce, then issues an encrypted revocable HttpOnly session", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  const tx = await f.login(),
    response = await f.callback(tx);
  const sessionCookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("hc_beta_session="));
  assert.match(sessionCookie, /HttpOnly/);
  assert.match(sessionCookie, /Secure/);
  assert.match(sessionCookie, /SameSite=Lax/);
  assert.equal(sessionCookie.includes("test-member"), false);
  const request = new Request("https://hc.example.test/api/marketplace", {
    headers: { Cookie: sessionCookie.split(";")[0] },
  });
  assert.equal((await f.auth.identity(request)).subject, "test-member");
  assert.equal((await f.auth.identity(request)).stepUp, true);
  await assert.rejects(
    () => f.callback(tx),
    (e) => e.status === 401,
  );
  assert.equal(f.calls(), 1);
  f.advance(601000);
  assert.equal((await f.auth.identity(request)).stepUp, false);
  const logout = new Request(
    "https://hc.example.test/api/marketplace/auth/logout",
    {
      method: "POST",
      headers: { Cookie: sessionCookie, Origin: "https://hc.example.test" },
    },
  );
  await f.auth.logout(logout);
  await assert.rejects(
    () => f.auth.identity(request),
    (e) => e.status === 401,
  );
});
test("callback state, browser binding, nonce and expiry are checked before a session is granted", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  let tx = await f.login();
  await assert.rejects(
    () => f.callback({ ...tx, state: "wrong" }),
    (e) => e.status === 401,
  );
  assert.equal(f.calls(), 0);
  await assert.rejects(
    () => f.callback({ ...tx, cookie: "hc_beta_oauth=invalid" }),
    (e) => e.status === 401,
  );
  f.wrongNonce();
  await assert.rejects(
    () => f.callback(tx),
    (e) => e.status === 401,
  );
  tx = await f.login();
  f.advance(601000);
  await assert.rejects(
    () => f.callback(tx),
    (e) => e.status === 401,
  );
});
test("sign-out rejects a foreign origin and missing auth configuration fails closed", async (t) => {
  const f = await fixture();
  t.after(() => f.db.close());
  await assert.rejects(
    () =>
      f.auth.logout(
        new Request("https://hc.example.test/api/marketplace/auth/logout", {
          method: "POST",
          headers: { Origin: "https://other.example.test" },
        }),
      ),
    (e) => e.status === 403,
  );
  const auth = createBrowserAuth(f.db, {});
  await assert.rejects(
    () => auth.login(new Request("https://hc.example.test")),
    (e) => e.status === 503,
  );
});
