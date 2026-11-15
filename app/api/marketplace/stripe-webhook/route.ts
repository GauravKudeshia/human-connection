import { env } from "cloudflare:workers";
import { recordProviderFailure } from "../../../../lib/marketplace/failure-alerts.mjs";
import { verifyStripeWebhook } from "../../../../lib/marketplace/providers.mjs";
import { createPaymentService } from "../../../../lib/marketplace/finance.mjs";
import { MarketplaceError } from "../../../../lib/marketplace/errors.mjs";

export async function POST(request: Request) {
  const config = env as unknown as Record<string, unknown>;
  if (
    config.HC_MARKETPLACE_ENABLED !== "true" ||
    config.MARKETPLACE_MODE !== "staging" ||
    !config.MARKETPLACE_DB ||
    typeof config.STRIPE_SANDBOX_WEBHOOK_SECRET !== "string"
  )
    return Response.json(
      {
        error: {
          code: "UNCONFIGURED",
          message: "Staging webhooks are unavailable.",
        },
      },
      { status: 503 },
    );
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json(
      { error: { message: "Webhook body required." } },
      { status: 400 },
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > 262144) {
      await reader.cancel();
      return Response.json(
        { error: { message: "Webhook is too large." } },
        { status: 413 },
      );
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let event;
  try {
    event = await verifyStripeWebhook(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      request.headers.get("stripe-signature"),
      config.STRIPE_SANDBOX_WEBHOOK_SECRET,
    );
  } catch {
    await recordProviderFailure(config, "stripe");
    return Response.json(
      { error: { message: "Webhook verification failed." } },
      { status: 400 },
    );
  }
  try {
    const result = await createPaymentService(config.MARKETPLACE_DB).ingest(
      event,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof MarketplaceError;
    await recordProviderFailure(
      config,
      "stripe",
      known && error.code === "PROVIDER_MISMATCH"
        ? "payment_mismatch"
        : "webhook_failed",
    );
    return Response.json(
      {
        error: {
          code: known ? error.code : "SERVER_ERROR",
          message: known
            ? error.message
            : "Payment reconciliation is temporarily unavailable.",
        },
      },
      { status: known ? error.status : 503 },
    );
  }
}
