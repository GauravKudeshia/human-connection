import test from "node:test";
import assert from "node:assert/strict";
import { makeBrowserRequest } from "../pages/transport.mjs";
import { recommendStyle } from "../lib/style-recommendation.mjs";
const storage = () => {
  const map = new Map();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  };
};
test("public preview lets a guest complete a demo checkout and tip with no backend; state survives reload and is isolated by tab", async () => {
  const store = storage(),
    key = "demo",
    request = makeBrowserRequest(store, key);
  const run = async (action, payload) => {
    const r = await request("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, payload }),
    });
    const d = await r.json();
    assert.equal(r.status, 200, d.error?.message);
    return d;
  };
  await run("eligibility", { adult: true, us: true, terms: true });
  const hold = await run("hold", {
    hostId: "maya",
    experience: "hear",
    style: "just-listen",
    format: "audio",
    duration: 15,
  });
  const b = { bookingId: hold.result.bookingId };
  for (const action of ["accept", "checkout", "join", "complete-demo"])
    await run(action, b);
  await run("tip", { ...b, cents: 500 });
  await run("rate", { ...b, rating: 5 });
  const saved = await (
    await makeBrowserRequest(store, key)("/api/state")
  ).json();
  assert.equal(saved.bookings[0].tipCents, 500);
  assert.equal(saved.journals.length, 3);
  assert.equal(saved.viewer.name, "Demo guest");
  assert.deepEqual(recommendStyle("hear", saved.bookings), { style: "just-listen", reason: "liked" });
  const otherTab = await (await makeBrowserRequest(storage(), key)("/api/state")).json();
  assert.equal(otherTab.bookings.length, 0);
  assert.equal(recommendStyle("hear", otherTab.bookings).reason, "starter");
});

test("a mid-session storage failure preserves the last saved workspace and requires explicit temporary recovery", async () => {
  const backing = storage();
  let failure = false;
  const adapter = {
    getItem: backing.getItem,
    setItem: (key, value) => {
      if (failure) throw new DOMException("Full", "QuotaExceededError");
      backing.setItem(key, value);
    },
  };
  const request = makeBrowserRequest(adapter, "recovery");
  const send = (action, payload = {}, id = crypto.randomUUID()) =>
    request("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": id },
      body: JSON.stringify({ action, payload }),
    });
  assert.equal((await send("favorite", { hostId: "maya" })).status, 200);
  failure = true;
  const rejected = await send("favorite", { hostId: "maya" }, "toggle");
  assert.equal(rejected.status, 507);
  assert.equal((await rejected.json()).error.code, "STORAGE_UNAVAILABLE");
  const blocked = await (await request("/api/state")).json();
  assert.equal(blocked.storageStatus, "blocked");
  assert.deepEqual(blocked.favorites, ["maya"]);
  await send("continue-in-memory");
  const result = await (
    await send("favorite", { hostId: "maya" }, "toggle")
  ).json();
  assert.equal(result.state.storageStatus, "temporary");
  assert.deepEqual(result.state.favorites, []);
  assert.deepEqual(
    (await (await send("favorite", { hostId: "maya" }, "toggle")).json()).state
      .favorites,
    [],
  );
  assert.deepEqual(
    (await (await makeBrowserRequest(backing, "recovery")("/api/state")).json())
      .favorites,
    ["maya"],
  );
});
test("storage reads denied after a successful save recover the acknowledged workspace", async () => {
  const backing = storage();
  let denied = false;
  const request = makeBrowserRequest(
    {
      getItem: (key) => {
        if (denied) throw new Error("Access denied");
        return backing.getItem(key);
      },
      setItem: backing.setItem,
    },
    "denied",
  );
  const send = (action, payload = {}) =>
    request("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ action, payload }),
    });
  await send("favorite", { hostId: "maya" });
  denied = true;
  const blocked = await (await request("/api/state")).json();
  assert.deepEqual(blocked.favorites, ["maya"]);
  assert.equal(blocked.storageStatus, "blocked");
  await send("continue-in-memory");
  assert.deepEqual(
    (await (await send("favorite", { hostId: "james" })).json()).state
      .favorites,
    ["maya", "james"],
  );
});
test("malformed saved state can be explicitly recovered without overwriting its stored contents", async () => {
  const backing = storage();
  backing.setItem("broken", "{");
  const request = makeBrowserRequest(backing, "broken");
  assert.equal(
    (await (await request("/api/state")).json()).storageStatus,
    "blocked",
  );
  const recovered = await request("/api/action", {
    method: "POST",
    body: JSON.stringify({ action: "continue-in-memory" }),
  });
  assert.equal((await recovered.json()).state.storageStatus, "temporary");
  assert.equal(backing.getItem("broken"), "{");
});
test("reset redelivery after transport recreation preserves subsequent favorites", async () => {
  const backing = storage();
  let request = makeBrowserRequest(backing, "reset");
  const send = (action, payload, key) =>
    request("/api/action", {
      method: "POST",
      headers: { "Idempotency-Key": key },
      body: JSON.stringify({ action, payload }),
    });
  await send("reset", {}, "reset-once");
  await send("favorite", { hostId: "maya" }, "save-maya");
  request = makeBrowserRequest(backing, "reset");
  const replay = await (await send("reset", {}, "reset-once")).json();
  assert.deepEqual(replay.state.favorites, ["maya"]);
});
