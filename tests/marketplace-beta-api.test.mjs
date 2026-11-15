import test from "node:test";
import assert from "node:assert/strict";
import { createBetaApi } from "../app/beta/beta-api.mjs";

test("account suspension clears cached customer data while ordinary permission denials preserve sign-in", async () => {
  let cleared = 0;
  const api = createBetaApi(
    async () =>
      Response.json(
        {
          error: {
            code: "ACCOUNT_UNAVAILABLE",
            message: "Account unavailable",
          },
        },
        { status: 403 },
      ),
    () => cleared++,
  );
  await assert.rejects(() => api.read("me"));
  assert.equal(cleared, 1);
  const limited = createBetaApi(
    async () =>
      Response.json(
        {
          error: { code: "FORBIDDEN", message: "Finance permission required" },
        },
        { status: 403 },
      ),
    () => cleared++,
  );
  await assert.rejects(() => limited.read("refunds"));
  assert.equal(cleared, 1);
});

test("beta API uses same-origin cookies and encodes owned-resource requests", async () => {
  const calls = [];
  const api = createBetaApi(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ data: { id: "booking" } });
  });
  assert.deepEqual(await api.read("booking", "a b", { language: "Spanish" }), {
    id: "booking",
  });
  const query = new URL("https://hc.test" + calls[0].url).searchParams;
  assert.equal(query.get("id"), "a b");
  assert.equal(query.get("language"), "Spanish");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(calls[0].options.headers, undefined);
});
test("a failed network response preserves the exact mutation key for a retry", async () => {
  const calls = [];
  let fail = true;
  const api = createBetaApi(async (url, options) => {
    calls.push(options);
    if (fail) {
      fail = false;
      throw new Error("Connection interrupted");
    }
    return Response.json({ result: { saved: true } });
  });
  await assert.rejects(() =>
    api.act("favourite", { hostId: "host", saved: true }),
  );
  assert.deepEqual(
    await api.act("favourite", { hostId: "host", saved: true }),
    { saved: true },
  );
  assert.equal(
    calls[0].headers["Idempotency-Key"],
    calls[1].headers["Idempotency-Key"],
  );
  await api.act("favourite", { hostId: "host", saved: true });
  assert.notEqual(
    calls[1].headers["Idempotency-Key"],
    calls[2].headers["Idempotency-Key"],
  );
});
test("an explicit validation failure starts a fresh corrected request", async () => {
  const calls = [];
  const api = createBetaApi(async (url, options) => {
    calls.push(options);
    if (calls.length === 1)
      return Response.json(
        { error: { code: "VALIDATION", message: "Choose an experience" } },
        { status: 400 },
      );
    return Response.json({ result: { saved: true } });
  });
  await assert.rejects(
    () => api.act("reserve", { experience: "laugh" }),
    (issue) => issue.status === 400 && issue.code === "VALIDATION",
  );
  await api.act("reserve", { experience: "laugh" });
  assert.notEqual(
    calls[0].headers["Idempotency-Key"],
    calls[1].headers["Idempotency-Key"],
  );
});
test("authentication loss clears the consumer before an unreadable error is surfaced", async () => {
  let revoked = false;
  const api = createBetaApi(
    async () => new Response("Session expired", { status: 401 }),
    () => {
      revoked = true;
    },
  );
  await assert.rejects(() => api.read("booking", "b"));
  assert.equal(revoked, true);
});
