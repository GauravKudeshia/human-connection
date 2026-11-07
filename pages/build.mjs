import { build } from "esbuild";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hosts, experiences } from "../lib/catalog.mjs";
const root = new URL("../", import.meta.url);
const file = (p) => new URL(p, root);
const portraits = Object.fromEntries(
  await Promise.all(
    hosts.map(async (h) => [
      h.id,
      "data:image/jpeg;base64," +
        (await readFile(file(`public/hosts/${h.id}.jpg`))).toString("base64"),
    ]),
  ),
);
const moments = Object.fromEntries(
  await Promise.all(
    [...experiences.map((experience) => experience.id), "cards"].map(
      async (id) => [
        id,
        "data:image/webp;base64," +
          (await readFile(file(`public/moments/${id}.webp`))).toString(
            "base64",
          ),
      ],
    ),
  ),
);
const { outputFiles } = await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["pages/entry.mjs"],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: "es2022",
  jsx: "automatic",
  define: {
    "process.env.NODE_ENV": '"production"',
    __HC_PORTRAITS__: JSON.stringify(portraits),
    __HC_MOMENTS__: JSON.stringify(moments),
  },
  legalComments: "eof",
});
let css = await readFile(file("app/globals.css"), "utf8");
const favicon =
  "data:image/svg+xml," +
  encodeURIComponent(await readFile(file("public/favicon.svg"), "utf8"));
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="description" content="Choose a laugh, a listening ear, or a playful detour. Explore fictional human hosts and optional activities in a free interactive demo."><title>Human Connection — Interactive Demo</title><link rel="icon" href="${favicon}"><style>${css}</style></head><body><div id="root"></div><noscript>Enable JavaScript to try Human Connection.</noscript><script>${outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await mkdir(file("docs/"), { recursive: true });
await writeFile(file("docs/index.html"), html);
await writeFile(file("docs/.nojekyll"), "");
console.log(
  `Created GitHub Pages demo (${Math.round(Buffer.byteLength(html) / 1024)} KiB).`,
);
