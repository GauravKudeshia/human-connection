import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { createMarketplace } from "../lib/marketplace/store.mjs";
import { createSessionService } from "../lib/marketplace/sessions.mjs";
import { createPaymentService } from "../lib/marketplace/finance.mjs";
import {
  createPrivacy,
  privacyPolicyFromConfig,
} from "../lib/marketplace/privacy.mjs";
import {
  createStripeSandbox,
  createDailyTestProvider,
} from "../lib/marketplace/providers.mjs";
import {
  createOperations,
  createNotificationWebhook,
} from "../lib/marketplace/operations.mjs";

const worker = {
  async scheduled(_event: ScheduledEvent, env: Cloudflare.Env) {
    const config = env as unknown as Record<string, unknown>;
    if (
      config.HC_MARKETPLACE_ENABLED === "true" &&
      config.MARKETPLACE_MODE === "staging" &&
      config.MARKETPLACE_DB
    ) {
      const db = config.MARKETPLACE_DB;
      const videoProvider =
        config.DAILY_ALLOW_TEST_ROOMS === "true" &&
        typeof config.DAILY_API_KEY === "string"
          ? createDailyTestProvider({
              apiKey: config.DAILY_API_KEY,
              allowTestRooms: true,
            })
          : undefined;
      await createSessionService(db, { videoProvider }).expire();
      await createMarketplace(db).expire();
      if (
        typeof config.STRIPE_SANDBOX_SECRET_KEY === "string" &&
        config.STRIPE_SANDBOX_SECRET_KEY.startsWith("sk_test_")
      )
        await createPaymentService(db, {
          provider: createStripeSandbox({
            secretKey: config.STRIPE_SANDBOX_SECRET_KEY,
          }),
        }).retryPending();
      const operations = createOperations(db, {
        notificationProvider:
          config.NOTIFICATION_MODE === "sandbox"
            ? createNotificationWebhook({
                mode: "sandbox",
                url:
                  typeof config.NOTIFICATION_DELIVERY_URL === "string"
                    ? config.NOTIFICATION_DELIVERY_URL
                    : undefined,
                secret:
                  typeof config.NOTIFICATION_DELIVERY_SECRET === "string"
                    ? config.NOTIFICATION_DELIVERY_SECRET
                    : undefined,
              })
            : undefined,
      });
      await operations.refreshAlerts();
      await operations.pruneAnalytics();
      const privacy = createPrivacy(db, {
        bucket: config.MARKETPLACE_MEDIA,
        policy: privacyPolicyFromConfig(config),
      });
      await privacy.run({ limit: 10 });
      await privacy.sweepExpired();
      await (db as D1Database)
        .prepare("DELETE FROM mp_request_limits WHERE window<?")
        .bind(Math.floor(Date.now() / 60000) - 2)
        .run();
      await (db as D1Database)
        .prepare("DELETE FROM mp_rate_limits WHERE window<?")
        .bind(Math.floor(Date.now() / 60000) - 2)
        .run();
      if (config.NOTIFICATION_MODE === "sandbox")
        await operations.dispatch({ limit: 20 });
    }
  },
  fetch(
    request: Request,
    env: Cloudflare.Env,
    ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>,
  ) {
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt)
            return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return {
              status: "request_context_expired",
              message: "This request has expired. Please try again.",
            };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () =>
      handler.fetch(request, env, ctx),
    );
  },
};

export default worker;
