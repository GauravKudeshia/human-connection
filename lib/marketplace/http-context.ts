import { env } from "cloudflare:workers";
import { createBrowserAuth } from "./browser-auth.mjs";
import { createMarketplace } from "./store.mjs";
import { MarketplaceError } from "./errors.mjs";

export function marketplaceConfig() {
  return env as unknown as Record<
    string,
    string | D1Database | R2Bucket | undefined
  >;
}
export function marketplaceStorage() {
  const config = marketplaceConfig();
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
  return { config, db };
}
export async function marketplaceContext(request: Request) {
  const { config, db } = marketplaceStorage();
  const identity = await createBrowserAuth(db, config).identity(request);
  const service = createMarketplace(db);
  const actor = await service.provisionIdentity(identity);
  return { config, db, service, actor };
}
export function marketplaceFailure(error: unknown) {
  const known = error instanceof MarketplaceError;
  return Response.json(
    {
      error: {
        code: known ? error.code : "INTERNAL_ERROR",
        message: known ? error.message : "The request could not be completed.",
      },
    },
    {
      status: known ? error.status : 500,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
