import {
  marketplaceStorage,
  marketplaceFailure,
} from "../../../../lib/marketplace/http-context";
import { createPrivacy } from "../../../../lib/marketplace/privacy.mjs";
import { boundedJson } from "../../../../lib/marketplace/http-handlers.mjs";
import { MarketplaceError } from "../../../../lib/marketplace/errors.mjs";
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      throw new MarketplaceError(
        "ORIGIN_DENIED",
        "This request origin is not permitted.",
        403,
      );
    const { db } = marketplaceStorage(),
      body = await boundedJson(request, 1024);
    const data = await createPrivacy(db).receipt(body?.receiptToken);
    return Response.json(
      { data },
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    return marketplaceFailure(error);
  }
}
