import { spawnSync } from "node:child_process";
import { marketplaceMigrations } from "../db/marketplace-migrations.mjs";
// This command never accepts --remote. Hosted migration requires a separate authorized staging procedure.
if (process.argv.slice(2).length)
  throw Error(
    "This command applies only the repository local staging migrations and accepts no arguments.",
  );
for (const migration of marketplaceMigrations) {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/sites-env.mjs",
      "./node_modules/wrangler/bin/wrangler.js",
      "d1",
      "execute",
      "MARKETPLACE_DB",
      "--local",
      "--config",
      "wrangler.staging.example.jsonc",
      "--file",
      "db/" + migration,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
