import { env } from "cloudflare:workers";
import { verifyDailyWebhook } from "../../../../lib/marketplace/providers.mjs";
import { createSessionService } from "../../../../lib/marketplace/sessions.mjs";
import { MarketplaceError } from "../../../../lib/marketplace/errors.mjs";

export async function POST(request: Request) {
  const config = env as unknown as Record<string, unknown>;
  if (
    config.HC_MARKETPLACE_ENABLED !== "true" ||
    config.MARKETPLACE_MODE !== "staging" ||
    !config.MARKETPLACE_DB ||
    typeof config.DAILY_WEBHOOK_SECRET !== "string"
  )
    return Response.json(
      {
        error: {
          code: "UNCONFIGURED",
          message: "Video callbacks are unavailable.",
        },
      },
      { status: 503 },
    );
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json(
      { error: { message: "Body required." } },
      { status: 400 },
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 262144) {
      await reader.cancel();
      return Response.json(
        { error: { message: "Payload is too large." } },
        { status: 413 },
      );
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let event;
  try {
    event = await verifyDailyWebhook(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      request.headers.get("x-webhook-signature"),
      request.headers.get("x-webhook-timestamp"),
      config.DAILY_WEBHOOK_SECRET,
    );
  } catch {
    return Response.json(
      { error: { message: "Video callback verification failed." } },
      { status: 400 },
    );
  }
  if (event.test) return Response.json({ verified: true });
  if (!["participant.joined", "participant.left"].includes(event.type))
    return Response.json({ ignored: true });
  try {
    return Response.json(
      await createSessionService(config.MARKETPLACE_DB).ingest(event),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const known = error instanceof MarketplaceError;
    return Response.json(
      {
        error: {
          code: known ? error.code : "PROCESSING_ERROR",
          message: known
            ? error.message
            : "Callback processing will be retried.",
        },
      },
      { status: known ? error.status : 503 },
    );
  }
}
