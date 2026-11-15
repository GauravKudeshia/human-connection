const encoder = new TextEncoder();
function configured(condition, message) {
  if (!condition) throw new Error(message);
}
async function jsonResponse(response) {
  if (!response.ok) {
    const error = new Error(
      "The external provider could not complete this request.",
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}
/** @param {{secretKey?: string, fetcher?: typeof fetch}} [options] */
export function createStripeSandbox({ secretKey, fetcher = fetch } = {}) {
  configured(
    typeof secretKey === "string" && secretKey.startsWith("sk_test_"),
    "Configure a Stripe sandbox secret key. Live payment credentials are disabled.",
  );
  async function request(path, fields, key) {
    configured(
      typeof key === "string" && key.length > 0 && key.length <= 128,
      "A provider idempotency key is required.",
    );
    const response = await fetcher("https://api.stripe.com/v1/" + path, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: "Bearer " + secretKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Idempotency-Key": key,
      },
      body: new URLSearchParams(fields),
    });
    const object = await jsonResponse(response);
    configured(
      object.livemode === false,
      "Provider returned a live object. Sandbox processing stopped.",
    );
    return object;
  }
  return {
    mode: "sandbox",
    async createIntent({ bookingId, quote }, key) {
      configured(
        typeof bookingId === "string" &&
          bookingId.length > 0 &&
          quote?.currency === "USD" &&
          Number.isSafeInteger(quote.totalCents) &&
          quote.totalCents > 0,
        "A server-authoritative quote is required.",
      );
      return request(
        "payment_intents",
        {
          amount: String(quote.totalCents),
          currency: "usd",
          "payment_method_types[]": "card",
          "metadata[booking_id]": bookingId,
          "metadata[quote_id]": quote.id,
          "metadata[price_policy]": quote.version,
        },
        key,
      );
    },
    async createTipIntent({ bookingId, tipId, amountCents }, key) {
      configured(
        Number.isSafeInteger(amountCents) &&
          amountCents >= 100 &&
          amountCents <= 10000,
        "Tip principal must be between $1 and $100.",
      );
      return request(
        "payment_intents",
        {
          amount: String(amountCents),
          currency: "usd",
          "payment_method_types[]": "card",
          "metadata[booking_id]": bookingId,
          "metadata[tip_id]": tipId,
          "metadata[kind]": "tip",
        },
        key,
      );
    },
    async refund({ paymentIntentId, amountCents }, key) {
      configured(
        typeof paymentIntentId === "string" &&
          /^pi_[a-zA-Z0-9_]+$/.test(paymentIntentId) &&
          Number.isSafeInteger(amountCents) &&
          amountCents > 0,
        "A valid payment and integer refund amount are required.",
      );
      return request(
        "refunds",
        { payment_intent: paymentIntentId, amount: String(amountCents) },
        key,
      );
    },
    async retrieveIntent(paymentIntentId) {
      configured(
        typeof paymentIntentId === "string" &&
          /^pi_[a-zA-Z0-9_]+$/.test(paymentIntentId),
        "Invalid provider payment.",
      );
      const object = await jsonResponse(
        await fetcher(
          "https://api.stripe.com/v1/payment_intents/" +
            paymentIntentId +
            "?expand[]=latest_charge.balance_transaction",
          {
            headers: { Authorization: "Bearer " + secretKey },
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          },
        ),
      );
      configured(
        object.livemode === false,
        "Live provider objects are disabled.",
      );
      return object;
    },
  };
}
export async function verifyStripeWebhook(
  raw,
  signature,
  secret,
  now = Date.now(),
) {
  configured(
    typeof raw === "string" &&
      encoder.encode(raw).length <= 262_144 &&
      typeof secret === "string" &&
      secret.startsWith("whsec_") &&
      typeof signature === "string" &&
      signature.length <= 4096,
    "Webhook verification is unavailable.",
  );
  const fields = signature.split(",").map((field) => field.trim().split("="));
  const timestamps = fields.filter(([key]) => key === "t");
  const stamp = timestamps.length === 1 ? timestamps[0][1] : "";
  const time = Number(stamp);
  configured(
    /^\d+$/.test(stamp) &&
      Number.isSafeInteger(time) &&
      Math.abs(now / 1000 - time) <= 300,
    "Webhook timestamp is outside the accepted window.",
  );
  const signatures = fields.filter(
    ([key, value]) => key === "v1" && /^[a-fA-F0-9]{64}$/.test(value),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let valid = false;
  for (const [, hex] of signatures) {
    const bytes = Uint8Array.from(hex.match(/../g), (part) =>
      parseInt(part, 16),
    );
    if (
      await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        encoder.encode(stamp + "." + raw),
      )
    )
      valid = true;
  }
  configured(valid, "Webhook signature did not verify.");
  const event = JSON.parse(raw);
  configured(
    event &&
      typeof event.id === "string" &&
      event.id.length <= 128 &&
      typeof event.type === "string" &&
      event.livemode === false &&
      event.data?.object &&
      typeof event.data.object === "object",
    "Only valid sandbox payment events are accepted.",
  );
  return event;
}
/** @param {{apiKey?: string, allowTestRooms?: boolean, fetcher?: typeof fetch}} [options] */
export function createDailyTestProvider({
  apiKey,
  allowTestRooms = false,
  fetcher = fetch,
} = {}) {
  configured(
    allowTestRooms === true && typeof apiKey === "string" && apiKey.length > 0,
    "Configure an explicitly authorized Daily test account before provisioning rooms.",
  );
  async function request(path, body, method = "POST") {
    return jsonResponse(
      await fetcher("https://api.daily.co/v1/" + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }
  return {
    async createRoom({ bookingId, expiresAt, format }, now = Date.now()) {
      configured(
        typeof bookingId === "string" &&
          /^[a-zA-Z0-9-]{1,64}$/.test(bookingId) &&
          ["audio", "video"].includes(format) &&
          Number.isSafeInteger(expiresAt) &&
          expiresAt > now &&
          expiresAt - now <= 3_600_000,
        "Invalid private room request.",
      );
      const fields = {
        name: "hc-test-" + bookingId,
        privacy: "private",
        properties: {
          exp: Math.floor(expiresAt / 1000),
          max_participants: 2,
          eject_at_room_exp: true,
          enable_transcription_storage: false,
          enable_chat: false,
          start_video_off: format === "audio",
          enforce_unique_user_ids: true,
        },
      };
      try {
        return await request("rooms", fields);
      } catch (error) {
        if (error.status !== 400 && error.status !== 409) throw error;
        const existing = await request("rooms/" + fields.name, null, "GET");
        configured(
          existing.name === fields.name && existing.privacy === "private",
          "The existing room does not match this private reservation.",
        );
        return existing;
      }
    },
    async participantToken({ roomName, actorId, expiresAt }, now = Date.now()) {
      configured(
        typeof roomName === "string" &&
          /^hc-test-[a-zA-Z0-9-]{1,64}$/.test(roomName) &&
          typeof actorId === "string" &&
          actorId.length > 0 &&
          actorId.length <= 36 &&
          Number.isSafeInteger(expiresAt) &&
          expiresAt > now &&
          expiresAt - now <= 3_600_000,
        "Invalid private participant grant.",
      );
      return request("meeting-tokens", {
        properties: {
          room_name: roomName,
          user_id: actorId,
          is_owner: false,
          exp: Math.floor(expiresAt / 1000),
          eject_at_token_exp: true,
          enable_recording_ui: false,
          start_cloud_recording: false,
          auto_start_transcription: false,
          enable_screenshare: false,
        },
      });
    },
    async deleteRoom(roomName) {
      configured(
        /^hc-test-[a-zA-Z0-9-]{1,64}$/.test(roomName),
        "Invalid private room.",
      );
      try {
        return await request("rooms/" + roomName, null, "DELETE");
      } catch (error) {
        if (error.status === 404) return { deleted: true };
        throw error;
      }
    },
  };
}

// Daily signs timestamp + "." + raw JSON with its base64-decoded HMAC secret.
// https://docs.daily.co/reference/rest-api/webhooks
export async function verifyDailyWebhook(
  raw,
  signature,
  timestamp,
  secret,
  now = Date.now(),
) {
  configured(
    typeof raw === "string" &&
      encoder.encode(raw).length <= 262144 &&
      typeof signature === "string" &&
      signature.length <= 256 &&
      typeof timestamp === "string" &&
      /^\d+(\.\d+)?$/.test(timestamp) &&
      Math.abs(now / 1000 - Number(timestamp)) <= 300 &&
      typeof secret === "string" &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(secret),
    "Daily webhook verification is unavailable.",
  );
  let secretBytes, signatureBytes;
  try {
    secretBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
    signatureBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    throw new Error("Invalid Daily webhook signature encoding.");
  }
  configured(
    secretBytes.length >= 32 && signatureBytes.length === 32,
    "Invalid Daily signing material.",
  );
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  configured(
    await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      encoder.encode(timestamp + "." + raw),
    ),
    "Daily webhook signature did not verify.",
  );
  const event = JSON.parse(raw);
  if (event?.test === "test") return { test: true };
  configured(
    event &&
      typeof event.id === "string" &&
      event.id.length <= 256 &&
      typeof event.type === "string" &&
      Number.isFinite(event.event_ts) &&
      event.payload &&
      typeof event.payload === "object",
    "Invalid Daily event.",
  );
  return event;
}
