import {
  marketplaceContext,
  marketplaceFailure,
} from "../../../lib/marketplace/http-context";
import {
  readMarketplace,
  actMarketplace,
  boundedJson,
} from "../../../lib/marketplace/http-handlers.mjs";
import { MarketplaceError } from "../../../lib/marketplace/errors.mjs";

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
export async function GET(request: Request) {
  try {
    const context = await marketplaceContext(request);
    const params = new URL(request.url).searchParams;
    const data = await readMarketplace(
      context,
      params.get("resource") || "me",
      params.get("id"),
      {
        experience: params.get("experience"),
        duration: Number(params.get("duration")),
        format: params.get("format"),
        language: params.get("language"),
        from: params.has("from") ? Number(params.get("from")) : undefined,
        to: params.has("to") ? Number(params.get("to")) : undefined,
      },
    );
    return Response.json({ data, mode: "staging" }, { headers });
  } catch (error) {
    return marketplaceFailure(error);
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
    const context = await marketplaceContext(request);
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
    const result = await actMarketplace(
      context,
      body.action,
      body.payload,
      request.headers.get("idempotency-key"),
    );
    return Response.json({ result, mode: "staging" }, { headers });
  } catch (error) {
    return marketplaceFailure(error);
  }
}
