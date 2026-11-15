import { createOperations } from "./operations.mjs";
export async function recordProviderFailure(
  config,
  provider,
  kind = "webhook_failed",
) {
  if (!config.MARKETPLACE_DB) return;
  try {
    await createOperations(config.MARKETPLACE_DB).noteFailure(
      kind,
      provider + ":" + Math.floor(Date.now() / 3600000),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "marketplace_alert_storage_failed",
        provider,
        kind,
      }),
    );
  }
}
