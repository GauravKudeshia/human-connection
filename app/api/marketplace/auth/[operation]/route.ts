import {
  marketplaceConfig,
  marketplaceFailure,
} from "../../../../../lib/marketplace/http-context";
import {
  createBrowserAuth,
  browserAuthConfigured,
} from "../../../../../lib/marketplace/browser-auth.mjs";

async function handle(request: Request) {
  const operation = new URL(request.url).pathname.split("/").at(-1);
  const config = marketplaceConfig(),
    db = config.MARKETPLACE_DB as D1Database | undefined;
  const configured = browserAuthConfigured(config);
  if (operation === "session" && request.method === "GET") {
    let user = null;
    if (configured && db) {
      try {
        user = await createBrowserAuth(db, config).identity(request);
      } catch (error) {
        if (
          !(
            error &&
            typeof error === "object" &&
            "status" in error &&
            error.status === 401
          )
        )
          return marketplaceFailure(error);
      }
    }
    return Response.json(
      {
        configured,
        authenticated: !!user,
        user,
        publicConfig: {
          stripePublishableKey:
            typeof config.STRIPE_SANDBOX_PUBLISHABLE_KEY === "string" &&
            config.STRIPE_SANDBOX_PUBLISHABLE_KEY.startsWith("pk_test_")
              ? config.STRIPE_SANDBOX_PUBLISHABLE_KEY
              : null,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!configured || !db)
    return Response.json(
      {
        error: {
          code: "AUTH_NOT_CONFIGURED",
          message: "Staging sign-in is not configured.",
        },
      },
      { status: 503 },
    );
  const auth = createBrowserAuth(db, config);
  try {
    if (operation === "login" && request.method === "GET")
      return await auth.login(request);
    if (operation === "callback" && request.method === "GET")
      return await auth.callback(request);
    if (operation === "logout" && request.method === "POST")
      return await auth.logout(request);
    return Response.json(
      { error: { message: "Authentication operation not found." } },
      { status: 404 },
    );
  } catch (error) {
    return marketplaceFailure(error);
  }
}
export const GET = handle;
export const POST = handle;
