import { readFile } from "node:fs/promises";
import { estimateContribution } from "../lib/marketplace/economics.mjs";

try {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) throw Error("Pass one JSON assumptions file.");
  const input = JSON.parse(await readFile(path, "utf8"));
  const scenarios = Array.isArray(input) ? input : [input];
  const estimates = scenarios.map(estimateContribution);
  console.log(JSON.stringify({ currency: "USD", estimates }, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
