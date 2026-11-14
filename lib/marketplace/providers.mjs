const encoder = new TextEncoder();
function configured(condition, message) {
  if (!condition) throw new Error(message);
}
async function jsonResponse(response) {
  if (!response.ok)
    throw new Error("The external provider could not complete this request.");
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
          "https://api.stripe.com/v1/payment_intents/" + paymentIntentId,
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
      return request("rooms", {
        name: "hc-test-" + bookingId,
        privacy: "private",
        properties: {
          exp: Math.floor(expiresAt / 1000),
          max_participants: 2,
          eject_at_room_exp: true,
          enable_transcription_storage: false,
          enable_chat: false,
          start_video_off: format === "audio",
        },
      });
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
      return request("rooms/" + roomName, null, "DELETE");
    },
  };
}
