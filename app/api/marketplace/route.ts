import { env } from "cloudflare:workers";
import { verifyAccessToken } from "../../../lib/marketplace/auth.mjs";
import { createMarketplace } from "../../../lib/marketplace/store.mjs";
import { MarketplaceError } from "../../../lib/marketplace/errors.mjs";
import { createStripeSandbox } from "../../../lib/marketplace/providers.mjs";
import { createPaymentService } from "../../../lib/marketplace/finance.mjs";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
function runtime() {
  return env as unknown as Record<string, string | D1Database | undefined>;
}
async function context(request: Request) {
  const config = runtime();
  if (
    config.HC_MARKETPLACE_ENABLED !== "true" ||
    config.MARKETPLACE_MODE !== "staging"
  )
    throw new MarketplaceError(
      "MARKETPLACE_DISABLED",
      "The staging marketplace is disabled.",
      503,
    );
  const db = config.MARKETPLACE_DB as D1Database | undefined;
  if (!db)
    throw new MarketplaceError(
      "STORAGE_NOT_CONFIGURED",
      "Staging storage is not configured.",
      503,
    );
  const identity = await verifyAccessToken(request, config);
  const service = createMarketplace(db);
  const actor = await service.provisionIdentity(identity);
  return { service, actor, db, config };
}
function failure(error: unknown) {
  if (error instanceof MarketplaceError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers },
    );
  console.error(
    "Marketplace request failed",
    error instanceof Error ? error.name : "Unknown",
  );
  return Response.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed.",
      },
    },
    { status: 500, headers },
  );
}
async function boundedJson(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new MarketplaceError("JSON_REQUIRED", "JSON is required.", 415);
  const reader = request.body?.getReader();
  if (!reader)
    throw new MarketplaceError(
      "VALIDATION",
      "A request body is required.",
      400,
    );
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 12000) {
      await reader.cancel();
      throw new MarketplaceError("TOO_LARGE", "The request is too large.", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new MarketplaceError("VALIDATION", "Valid JSON is required.", 400);
  }
}
export async function GET(request: Request) {
  try {
    const { service, actor } = await context(request);
    const params = new URL(request.url).searchParams;
    const data = await service.read(
      actor,
      params.get("resource") || "me",
      params.get("id"),
      {
        experience: params.get("experience"),
        duration: Number(params.get("duration")),
        format: params.get("format"),
        language: params.get("language"),
      },
    );
    return Response.json({ data, mode: "staging" }, { headers });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      throw new MarketplaceError(
        "ORIGIN_DENIED",
        "This request origin is not permitted.",
        403,
      );
    const { service, actor, db, config } = await context(request);
    const body = await boundedJson(request);
    if (
      !body ||
      typeof body.action !== "string" ||
      !body.payload ||
      typeof body.payload !== "object" ||
      Array.isArray(body.payload)
    )
      throw new MarketplaceError(
        "VALIDATION",
        "An action and payload object are required.",
        400,
      );
    let result;
    if (body.action === "checkout") {
      await service.authorize(actor, ["customer"]);
      const secretKey = config.STRIPE_SANDBOX_SECRET_KEY;
      if (typeof secretKey !== "string" || !secretKey.startsWith("sk_test_"))
        throw new MarketplaceError(
          "PAYMENT_NOT_CONFIGURED",
          "Sandbox payments are not configured.",
          503,
        );
      const provider = createStripeSandbox({ secretKey });
      result = await createPaymentService(db, { provider }).checkout(
        actor,
        body.payload.bookingId,
      );
    } else
      result = await service.act(
        actor,
        body.action,
        body.payload,
        request.headers.get("idempotency-key"),
      );
    return Response.json({ result, mode: "staging" }, { headers });
  } catch (error) {
    return failure(error);
  }
}
