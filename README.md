# Human Connection

**[Open the interactive demo](https://gauravkudeshia.github.io/human-connection/)**

Choose **Make Me Laugh**, **Hear Me Out**, or **Distract Me** and meet a fictional host for a simulated 15- or 30-minute session. Anyone with the demo link can try it without an account, installation, or payment card.

## V1.3: find your moment

1. Choose an experience and an optional conversation style.
2. Choose 15 or 30 minutes, audio/video and language. Use **Match Me Now** or browse hosts yourself.
3. Simulate the host’s acceptance, review the exact demo total, and confirm checkout.
4. Join within three minutes or receive a full automatic demo reversal. Explore optional sample activity cards inside the simulated room.
5. Complete the demo to try a review and optional tip; use receipts, refund review, favorites and rebooking. Host studio and Operations remain fictional role previews.

See [feature audit](docs/V1.3-FEATURE-AUDIT.md), [product experience](docs/V1.3-PRODUCT-EXPERIENCE.md), [engineering changes and tests](docs/V1.3-ENGINEERING-CHANGES.md), and [production gaps](docs/V1.3-PRODUCTION-GAPS.md).

The public preview runs entirely in your browser. Activity survives reloading the same tab when session storage is available. It does not sync to another device or another visitor. Use fictional details only. Reports do not notify a real person; no payments, microphone capture, camera access or live calls occur in the public demo.

You can also download `docs/index.html` and open it directly in a current browser. The interface, portraits and scripts are embedded; external fonts are optional.

## Source and publishing

- `app/`: shared React interface and the original full-stack server routes.
- `lib/`: fictional host catalog, booking and simulated ledger rules, and server-side D1 storage.
- `pages/`: guest preview transport and static build entry point. GitHub Pages serves `docs/index.html`, not the server routes.
- `tests/`: domain and public-preview tests. The HTTP integration test is for a disposable local full-stack database only.

### Rebuild the public preview

With Node 22.13+ and npm, run `npm ci`, `npm test`, then `npm run build:pages`. Commit the generated `docs/index.html`. In GitHub **Settings → Pages**, publish **main /docs**. The `docs` folder contains the public demo, `.nojekyll`, and the public V1.3 handoff documents. No runtime data or secrets are published.

For a local preview, run `npm run preview:pages` after building and open `http://127.0.0.1:4195/`. Stop it with Ctrl+C. Useful checks are `npm run lint`, `npm test`, and `node node_modules/typescript/bin/tsc --noEmit`.

### Run the full-stack prototype separately

Run `npm ci`, `npm run build`, apply `drizzle/0000_faulty_clea.sql` once to a new local D1 database, then run `npm run dev -- --port 4193 --hostname 127.0.0.1`. Example migration command:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_faulty_clea.sql
```

The HTTP integration suite must run only against a disposable local workspace: `TEST_BASE_URL=http://127.0.0.1:4193 npm run test:http`. It resets that test workspace.

The full-stack preview uses Sites authentication and owner-scoped D1 storage. Its checkout and room are also simulated. This repository contains no original hosting-project identity, customer data, provider keys or local database.

## Scope

Human Connection is an interactive prototype, not a working paid marketplace or a staffed safety service. Real verified hosts, provider integrations, policy approvals, and production operational controls are outside this demo. See [asset credits](ASSETS.md).
