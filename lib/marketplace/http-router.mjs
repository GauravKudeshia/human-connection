import {
  readMarketplace,
  actMarketplace,
  boundedJson,
} from "./http-handlers.mjs";
import { MarketplaceError, requireCondition as need } from "./errors.mjs";
import { createOperations } from "./operations.mjs";
export const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
export async function consumeQuota(
  db,
  userId,
  bucket,
  limit,
  clock = Date.now,
) {
  const window = Math.floor(clock() / 60000);
  const row = await db
    .prepare(
      "INSERT INTO mp_request_limits VALUES(?,?,?,1) ON CONFLICT(user_id,bucket,window) DO UPDATE SET count=count+1 RETURNING count",
    )
    .bind(userId, bucket, window)
    .first();
  need(
    row.count <= limit,
    "RATE_LIMITED",
    "Too many requests. Try again shortly.",
    429,
  );
}
// The framework supplies the trusted context resolver. Neither actors nor providers come from JSON/headers.
export function createMarketplaceHttp({
  contextFor,
  logger = (entry) => console.info(JSON.stringify(entry)),
  clock = Date.now,
}) {
  return async function handle(request) {
    const requestId = crypto.randomUUID(),
      started = clock();
    let status = 200,
      code = "OK",
      context;
    try {
      need(
        ["GET", "POST"].includes(request.method),
        "METHOD_NOT_ALLOWED",
        "Choose a supported method.",
        405,
      );
      if (request.method === "POST")
        need(
          request.headers.get("origin") === new URL(request.url).origin,
          "ORIGIN_DENIED",
          "This request origin is not permitted.",
          403,
        );
      context = await contextFor(request);
      await consumeQuota(
        context.db,
        context.actor.id,
        request.method === "GET" ? "read" : "mutation",
        request.method === "GET" ? 1200 : 120,
        clock,
      );
      let body;
      if (request.method === "GET") {
        const params = new URL(request.url).searchParams;
        const filter = {
          experience: params.get("experience"),
          style: params.get("style"),
          duration: Number(params.get("duration")),
          format: params.get("format"),
          language: params.get("language"),
          from: params.has("from") ? Number(params.get("from")) : undefined,
          to: params.has("to") ? Number(params.get("to")) : undefined,
        };
        body = {
          data: await readMarketplace(
            context,
            params.get("resource") || "me",
            params.get("id"),
            filter,
          ),
          mode: "staging",
        };
      } else {
        const parsed = await boundedJson(request);
        need(
          parsed &&
            typeof parsed.action === "string" &&
            parsed.payload &&
            typeof parsed.payload === "object" &&
            !Array.isArray(parsed.payload),
          "VALIDATION",
          "An action and payload object are required.",
          400,
        );
        body = {
          result: await actMarketplace(
            context,
            parsed.action,
            parsed.payload,
            request.headers.get("idempotency-key"),
          ),
          mode: "staging",
        };
      }
      return Response.json(
        { ...body, requestId },
        { headers: { ...PRIVATE_HEADERS, "X-Request-Id": requestId } },
      );
    } catch (error) {
      const known = error instanceof MarketplaceError;
      status = known ? error.status : 500;
      code = known ? error.code : "INTERNAL_ERROR";
      const kind = ["HOST_RESERVED", "CONCURRENT_UPDATE"].includes(code)
        ? "booking_conflict"
        : code === "PROVIDER_MISMATCH"
          ? "payment_mismatch"
          : !known
            ? "database_error"
            : null;
      if (kind && context?.db)
        try {
          await createOperations(context.db, { clock }).noteFailure(
            kind,
            String(Math.floor(clock() / 60000)),
          );
        } catch {
          /* The structured request result remains available when storage fails. */
        }
      return Response.json(
        {
          error: {
            code,
            message: known
              ? error.message
              : "The request could not be completed.",
          },
          requestId,
        },
        { status, headers: { ...PRIVATE_HEADERS, "X-Request-Id": requestId } },
      );
    } finally {
      logger({
        event: "marketplace_request",
        requestId,
        method: request.method,
        status,
        code,
        durationMs: Math.max(0, clock() - started),
      });
    }
  };
}
