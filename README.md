# Human Connection

**[Open the interactive demo](https://gauravkudeshia.github.io/human-connection/)**

Choose **Make Me Laugh**, **Hear Me Out**, or **Distract Me** and meet a fictional host for a simulated 15- or 30-minute session. Anyone with the demo link can try it without an account, installation, or payment card.

## Try it

1. Open a host profile, choose a duration and format, and request a conversation.
2. Simulate the host’s acceptance, confirm the demo checkout, and enter the room.
3. Finish the demo session to try rating, tipping, favorites, and receipts. Host studio and Operations are previews of those roles within your own workspace.

The public preview runs entirely in your browser. Activity survives reloading the same tab when session storage is available. It does not sync to another device or another visitor. Use fictional details only. Reports do not notify a real person; no payments, microphone capture, camera access or live calls occur in the public demo.

You can also download `docs/index.html` and open it directly in a current browser. The interface, portraits and scripts are embedded; external fonts are optional.

## Source and publishing

- `app/`: shared React interface and the original full-stack server routes.
- `lib/`: fictional host catalog, booking and simulated ledger rules, and server-side D1 storage.
- `pages/`: guest preview transport and static build entry point. GitHub Pages serves `docs/index.html`, not the server routes.
- `tests/`: domain and public-preview tests. The HTTP integration test is for a disposable local full-stack database only.

### Rebuild the public preview

With Node 22.13+ and npm, run `npm ci`, `npm test`, then `npm run build:pages`. Commit the generated `docs/index.html`. In GitHub **Settings → Pages**, publish **main /docs**. The `docs` folder contains only the public demo and `.nojekyll`.

### Run the full-stack prototype separately

Run `npm ci`, `npm run build`, apply `drizzle/0000_faulty_clea.sql` once to a new local D1 database, then run `npm run dev -- --port 4193 --hostname 127.0.0.1`. Example migration command:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_faulty_clea.sql
```

The full-stack preview uses Sites authentication and owner-scoped D1 storage. Its checkout and room are also simulated. This repository contains no original hosting-project identity, customer data, provider keys or local database.

## Scope

Human Connection is an interactive prototype, not a working paid marketplace or a staffed safety service. Real verified hosts, provider integrations, policy approvals, and production operational controls are outside this demo. See [asset credits](ASSETS.md).
