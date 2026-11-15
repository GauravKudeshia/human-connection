// Local integration journeys: real router/services/SQLite with fictional identities and signed provider fixtures.
// No network request, provider account, actual payment or stranger call is used by this suite.
import test from "node:test";
import assert from "node:assert/strict";
import { marketplaceFixture } from "./marketplace-fixture.mjs";
import { createMarketplaceHttp } from "../lib/marketplace/http-router.mjs";
import { createPaymentService } from "../lib/marketplace/finance.mjs";
import { createSessionService } from "../lib/marketplace/sessions.mjs";
import {
  verifyStripeWebhook,
  verifyDailyWebhook,
} from "../lib/marketplace/providers.mjs";
import { MarketplaceError } from "../lib/marketplace/errors.mjs";

const start = 1_800_000_000_000;
async function fixture(t, { hostCount = 2 } = {}) {
  let now = start;
  const clock = () => now,
    f = await marketplaceFixture({ hostCount, clock });
  t.after(() => f.db.close());
  const calls = [],
    logs = [],
    intents = new Map(),
    actors = new WeakMap();
  const payment = {
    mode: "sandbox",
    async createIntent({ bookingId, quote }, key) {
      calls.push({ kind: "intent", key });
      if (!intents.has(key))
        intents.set(key, {
          id: "pi_" + bookingId.replace(/-/g, "_"),
          livemode: false,
          amount: quote.totalCents,
          currency: quote.currency.toLowerCase(),
          client_secret: "local-fixture-secret",
        });
      return intents.get(key);
    },
  };
  const video = {
    async createRoom({ bookingId }) {
      calls.push({ kind: "room", bookingId });
      return {
        name: "hc-test-" + bookingId,
        url: "https://fixture.daily.co/hc-test-" + bookingId,
        privacy: "private",
      };
    },
    async participantToken({ actorId }) {
      return { token: "local-fixture-token:" + actorId };
    },
    async deleteRoom(name) {
      calls.push({ kind: "cleanup", name });
    },
  };
  const config = {},
    providers = { payment, video };
  const context = (actor) => ({
    db: f.db,
    service: f.service,
    actor,
    config,
    providers,
    clock,
  });
  const handle = createMarketplaceHttp({
    clock,
    logger: (entry) => logs.push(entry),
    contextFor: async (request) => {
      const actor = actors.get(request);
      if (!actor)
        throw new MarketplaceError(
          "UNAUTHENTICATED",
          "A trusted fixture session is required.",
          401,
        );
      return context(actor);
    },
  });
  async function request(
    actor,
    {
      action,
      payload = {},
      resource,
      id,
      filter = {},
      key = crypto.randomUUID(),
      headers = {},
    } = {},
  ) {
    const url = new URL("https://local.invalid/api/marketplace");
    if (resource) url.searchParams.set("resource", resource);
    if (id) url.searchParams.set("id", id);
    for (const [name, value] of Object.entries(filter))
      if (value !== undefined) url.searchParams.set(name, String(value));
    const req = new Request(url, {
      method: action ? "POST" : "GET",
      headers: {
        ...(action
          ? {
              "Content-Type": "application/json",
              Origin: url.origin,
              "Idempotency-Key": key,
            }
          : {}),
        ...headers,
      },
      ...(action ? { body: JSON.stringify({ action, payload }) } : {}),
    });
    if (actor) actors.set(req, actor);
    const response = await handle(req),
      body = await response.json();
    return { response, body, value: action ? body.result : body.data };
  }
  async function ok(actor, options) {
    const result = await request(actor, options);
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.equal(
      result.response.headers.get("x-request-id"),
      result.body.requestId,
    );
    return result.value;
  }
  const pay = createPaymentService(f.db, { clock, provider: payment }),
    sessions = createSessionService(f.db, { clock, videoProvider: video });
  async function signedStripe(event) {
    const raw = JSON.stringify(event),
      secret = "whsec_local_journey_fixture",
      timestamp = String(now / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(timestamp + "." + raw),
      ),
    ).toString("hex");
    return pay.ingest(
      await verifyStripeWebhook(
        raw,
        "t=" + timestamp + ",v1=" + signature,
        secret,
        now,
      ),
    );
  }
  async function signedDaily(
    booking,
    type,
    actor,
    { joined = now, duration, session = booking.id + ":" + actor.id } = {},
  ) {
    const event = {
      id: crypto.randomUUID(),
      type,
      event_ts: now / 1000,
      payload: {
        room: "hc-test-" + booking.id,
        user_id: actor.id,
        session_id: session,
        joined_at: joined / 1000,
        ...(duration === undefined ? {} : { duration: duration / 1000 }),
      },
    };
    const raw = JSON.stringify(event),
      secret = Buffer.alloc(32, 7),
      timestamp = String(now / 1000);
    const key = await crypto.subtle.importKey(
      "raw",
      secret,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = Buffer.from(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(timestamp + "." + raw),
      ),
    ).toString("base64");
    return sessions.ingest(
      await verifyDailyWebhook(
        raw,
        signature,
        timestamp,
        secret.toString("base64"),
        now,
      ),
    );
  }
  async function reserve(
    experience = "laugh",
    customer = f.customer,
    host = f.hosts[0],
  ) {
    const style = {
      laugh: "funny-stories",
      hear: "just-listen",
      distract: "trivia-questions",
    }[experience];
    const choice = { ...f.choice, experience, style, hostId: host.id };
    const result = await ok(customer, { action: "reserve", payload: choice });
    assert.equal(result.booking.status, "REQUESTED");
    return result.booking;
  }
  async function acceptAndPay(
    booking,
    customer = f.customer,
    host = f.hosts[0],
  ) {
    await ok(host, { action: "accept", payload: { bookingId: booking.id } });
    const checkout = await ok(customer, {
      action: "checkout",
      payload: { bookingId: booking.id },
    });
    await signedStripe({
      id: "capture_" + booking.id,
      type: "payment_intent.succeeded",
      livemode: false,
      data: {
        object: {
          id: checkout.providerId,
          amount: booking.amount_cents,
          amount_received: booking.amount_cents,
          currency: "usd",
          metadata: { booking_id: booking.id },
        },
      },
    });
    const saved = await ok(customer, { resource: "booking", id: booking.id });
    assert.equal(saved.status, "READY");
    return { booking: saved, checkout };
  }
  async function join(booking, customer = f.customer, host = f.hosts[0]) {
    for (const actor of [customer, host]) {
      const grant = await ok(actor, {
        action: "room-token",
        payload: { bookingId: booking.id },
      });
      assert.equal(grant.bookingId, booking.id);
      await signedDaily(booking, "participant.joined", actor);
    }
    assert.equal(
      (await ok(customer, { resource: "session", id: booking.id })).status,
      "LIVE",
    );
  }
  return {
    ...f,
    request,
    ok,
    logs,
    calls,
    reserve,
    acceptAndPay,
    join,
    signedStripe,
    signedDaily,
    pay,
    sessions,
    now: clock,
    setNow: (time) => {
      now = time;
    },
  };
}

for (const [experience, activityId] of [
  ["laugh", "laugh-improv"],
  ["hear", "hear-listen"],
  ["distract", "distract-trivia"],
])
  test(
    "local authenticated journey: " +
      experience +
      " → match → sandbox fixture payment → shared activity → feedback",
    async (t) => {
      const f = await fixture(t);
      const hosts = await f.ok(f.customer, {
        resource: "hosts",
        filter: { ...f.choice, experience, style: undefined },
      });
      assert.ok(hosts.some((host) => host.user_id === f.hosts[0].id));
      const booking = await f.reserve(experience);
      await f.acceptAndPay(booking);
      await f.join(booking);
      const selected = await f.ok(f.customer, {
        action: "activity",
        payload: {
          bookingId: booking.id,
          operation: "select",
          activityId,
          revision: 0,
        },
      });
      const hostState = await f.ok(f.hosts[0], {
        resource: "activity",
        id: booking.id,
      });
      assert.equal(hostState.activity_id, activityId);
      assert.equal(hostState.revision, selected.activity.revision);
      if (experience === "distract") {
        await f.ok(f.hosts[0], {
          action: "activity",
          payload: {
            bookingId: booking.id,
            operation: "reveal",
            revision: hostState.revision,
          },
        });
        assert.equal(
          (await f.ok(f.customer, { resource: "activity", id: booking.id }))
            .answer_revealed,
          1,
        );
      }
      const joined = f.now();
      f.setNow(joined + 900000);
      // Both provider intervals must close before delivery receives financial credit.
      for (const actor of [f.customer, f.hosts[0]])
        await f.signedDaily(booking, "participant.left", actor, {
          joined,
          duration: 900000,
        });
      assert.equal(
        (await f.ok(f.customer, { resource: "booking", id: booking.id }))
          .status,
        "COMPLETED",
      );
      await f.ok(f.customer, {
        action: "review",
        payload: {
          bookingId: booking.id,
          rating: 5,
          worthIt: true,
          privateFeedback: "Fictional test feedback",
        },
      });
      await f.ok(f.customer, {
        action: "favourite",
        payload: { hostId: f.hosts[0].id, saved: true },
      });
      assert.equal(
        (await f.ok(f.customer, { resource: "favourites" }))[0].user_id,
        f.hosts[0].id,
      );
      const receipt = await f.ok(f.customer, {
        resource: "receipt",
        id: booking.id,
      });
      assert.equal(receipt.receipt.net, 1000);
      assert.equal(receipt.receipt.baseRefund, 0);
      await f.ok(f.hosts[0], {
        action: "heartbeat",
        payload: { available: true },
      });
      const rebook = await f.reserve(experience);
      assert.equal(rebook.host_id, f.hosts[0].id);
      assert.equal(
        f.db.sqlite
          .prepare(
            "SELECT SUM(debit_cents-credit_cents) net FROM mp_ledger_entries",
          )
          .get().net,
        0,
      );
      assert.equal(
        JSON.stringify(f.logs).includes("local-fixture-secret"),
        false,
      );
      assert.equal(
        JSON.stringify(f.logs).includes("Fictional test feedback"),
        false,
      );
    },
  );

test("two independent local HTTP customers compete for one authoritative host claim", async (t) => {
  const f = await fixture(t, { hostCount: 1 });
  const results = await Promise.all(
    [f.customer, f.other].map((actor) =>
      f.request(actor, {
        action: "reserve",
        payload: { ...f.choice, hostId: f.hosts[0].id },
      }),
    ),
  );
  assert.equal(results.filter((x) => x.response.status === 200).length, 1);
  assert.equal(results.filter((x) => x.response.status === 409).length, 1);
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_host_claims").get().n,
    1,
  );
  assert.equal(f.calls.filter((x) => x.kind === "intent").length, 0);
});

test("host decline and request expiry recover without opening checkout or charging", async (t) => {
  const f = await fixture(t);
  const declined = await f.reserve();
  await f.ok(f.hosts[0], {
    action: "decline",
    payload: { bookingId: declined.id },
  });
  assert.equal(
    (
      await f.request(f.customer, {
        action: "checkout",
        payload: { bookingId: declined.id },
      })
    ).response.status,
    409,
  );
  const expiring = await f.reserve();
  f.setNow(expiring.expires_at + 1);
  assert.equal(
    (await f.ok(f.customer, { resource: "booking", id: expiring.id })).status,
    "EXPIRED",
  );
  assert.equal(
    (
      await f.request(f.customer, {
        action: "checkout",
        payload: { bookingId: expiring.id },
      })
    ).response.status,
    409,
  );
  assert.equal(f.calls.filter((x) => x.kind === "intent").length, 0);
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_ledger_entries").get().n,
    0,
  );
});

test("captured payment without either participant joining enters failed delivery and refundable review", async (t) => {
  const f = await fixture(t),
    booking = await f.reserve();
  const paid = await f.acceptAndPay(booking);
  f.setNow(paid.booking.expires_at + 1);
  const state = await f.ok(f.customer, { resource: "session", id: booking.id });
  assert.equal(state.status, "FAILED_SERVICE");
  assert.equal(
    f.db.sqlite
      .prepare("SELECT status FROM mp_refunds WHERE booking_id=?")
      .get(booking.id).status,
    "OPEN",
  );
  assert.equal(
    f.db.sqlite.prepare("SELECT COUNT(*) n FROM mp_host_claims").get().n,
    0,
  );
  assert.equal(
    (
      await f.request(f.customer, {
        action: "review",
        payload: { bookingId: booking.id, rating: 5 },
      })
    ).response.status,
    409,
  );
});

test("an authorized room without confirmed attendance also fails delivery at the original deadline", async (t) => {
  const f = await fixture(t),
    booking = await f.reserve();
  const paid = await f.acceptAndPay(booking);
  await f.ok(f.customer, {
    action: "room-token",
    payload: { bookingId: booking.id },
  });
  f.setNow(paid.booking.expires_at + 1);
  assert.equal(
    (await f.ok(f.customer, { resource: "session", id: booking.id })).status,
    "FAILED_SERVICE",
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT overlap_ms FROM mp_session_timing WHERE booking_id=?")
      .get(booking.id).overlap_ms,
    0,
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT status FROM mp_video_rooms WHERE booking_id=?")
      .get(booking.id).status,
    "CLOSED",
  );
});

test("urgent in-session report persists, closes independently, blocks future matching and restricts staff data", async (t) => {
  const f = await fixture(t),
    booking = await f.reserve();
  await f.acceptAndPay(booking);
  await f.join(booking);
  await f.ok(f.customer, {
    action: "report",
    payload: {
      bookingId: booking.id,
      category: "harassment",
      urgent: true,
      reason: "Fictional local report evidence",
    },
  });
  assert.equal(
    (await f.ok(f.customer, { resource: "session", id: booking.id })).status,
    "SAFETY_ENDED",
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT status FROM mp_video_rooms WHERE booking_id=?")
      .get(booking.id).status,
    "CLOSED",
  );
  assert.equal((await f.ok(f.admin, { resource: "safety" })).length, 1);
  assert.equal(
    (await f.request(f.other, { resource: "safety" })).response.status,
    403,
  );
  assert.equal(
    (await f.request(f.other, { resource: "receipt", id: booking.id })).response
      .status,
    404,
  );
  await f.ok(f.customer, {
    action: "block",
    payload: { userId: f.hosts[0].id },
  });
  await f.ok(f.hosts[0], { action: "heartbeat", payload: { available: true } });
  assert.equal(
    (
      await f.request(f.customer, {
        action: "reserve",
        payload: { ...f.choice, hostId: f.hosts[0].id },
      })
    ).response.status,
    409,
  );
  assert.equal(
    JSON.stringify(f.logs).includes("Fictional local report evidence"),
    false,
  );
});

test("signed duplicate and out-of-order provider fixtures preserve one capture, attendance and allocation", async (t) => {
  const f = await fixture(t),
    booking = await f.reserve();
  await f.ok(f.hosts[0], {
    action: "accept",
    payload: { bookingId: booking.id },
  });
  const checkout = await f.ok(f.customer, {
    action: "checkout",
    payload: { bookingId: booking.id },
  });
  const callback = (id, type) => ({
    id,
    type,
    livemode: false,
    data: {
      object: {
        id: checkout.providerId,
        amount: 1000,
        amount_received: 1000,
        currency: "usd",
      },
    },
  });
  await f.signedStripe(
    callback("early_failed", "payment_intent.payment_failed"),
  );
  const capture = callback("success", "payment_intent.succeeded");
  await f.signedStripe(capture);
  await f.signedStripe(capture);
  await f.signedStripe(
    callback("late_failed", "payment_intent.payment_failed"),
  );
  assert.equal(
    (await f.ok(f.customer, { resource: "booking", id: booking.id })).status,
    "READY",
  );
  await f.ok(f.customer, {
    action: "room-token",
    payload: { bookingId: booking.id },
  });
  const joined = f.now();
  f.setNow(joined + 900000);
  for (const actor of [f.customer, f.hosts[0]]) {
    await f.signedDaily(booking, "participant.left", actor, {
      joined,
      duration: 900000,
    });
    await f.signedDaily(booking, "participant.left", actor, {
      joined,
      duration: 900000,
    });
  }
  await f.signedDaily(booking, "participant.joined", f.customer, { joined });
  assert.equal(
    (await f.ok(f.customer, { resource: "booking", id: booking.id })).status,
    "COMPLETED",
  );
  assert.equal(
    f.db.sqlite
      .prepare("SELECT COUNT(*) n FROM mp_session_presence WHERE booking_id=?")
      .get(booking.id).n,
    2,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM mp_ledger_entries WHERE event_id LIKE 'capture:%'",
      )
      .get().n,
    2,
  );
  assert.equal(
    f.db.sqlite
      .prepare(
        "SELECT COUNT(*) n FROM mp_ledger_entries WHERE event_id LIKE 'delivery:%'",
      )
      .get().n,
    3,
  );
});

test("local HTTP boundary ignores impersonating account headers and rejects cross-origin mutations", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request(null, {
        resource: "me",
        headers: { "x-user-id": f.admin.id, "x-role": "admin" },
      })
    ).response.status,
    401,
  );
  assert.equal(
    (
      await f.request(f.customer, {
        resource: "analytics",
        headers: { "x-user-id": f.admin.id, "x-role": "admin" },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await f.request(f.customer, {
        action: "reserve",
        payload: f.choice,
        headers: { origin: "https://untrusted.invalid" },
      })
    ).response.status,
    403,
  );
});
