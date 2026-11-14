# November 12 audit fixes

The eight findings from the November 9–12 audit are addressed in this release.

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| Browse choices lost at booking | Explicit experience, format and language filters populate the host's booking form. Compatible wizard duration and style are retained. | Browser check carried Spanish, Video and Distract Me into Maya's form. |
| Closure stranded open reviews | New account closure waits for active sessions and open safety/refund reviews. Account settings link to Operations. Older closed workspaces can finish their existing reviews. | Engine and HTTP tests cover urgent partial delivery, refund, case closure and final removal of personal content. Browser check completed both reviews in an older closed workspace. |
| Vulnerable dependencies | Updated the framework, React, Cloudflare tools and affected transitive packages. Scoped overrides provide patched versions where upstream ranges lag. | Fresh lockfile install and full registry audit passed with zero reported vulnerabilities. |
| No-match recovery repeated an empty result | Adjust my choices returns to the experience step and focuses its heading. See other experiences retains the visitor's language and format while opening the experience filter. | Both browser routes exercised with Spanish Playful Banter. The alternatives route displayed two Spanish-speaking hosts. |
| Incomplete decision history | Decisions store the subject ID, prior status, new status, explanation and time. Operations exposes each record's history. | Engine tests and browser check preserve assignment and escalation explanations. Refund and application decisions have their own subject IDs. |
| Cached information after sign-in expiry | A 401 clears the loaded workspace, active session, open dialog, notifications and view. | Browser fixture verified both polling expiry with an open account dialog and expiry during a favorite action. |
| Reset retries erased subsequent work | Reset request fingerprints survive later resets and closure, and remain private to persistence. | Engine, browser transport and HTTP checks replay an earlier reset after a new favorite without removing it. |
| Mid-session storage failure blocked progress | Failed saves preserve acknowledged state and offer explicit temporary continuation. The visitor retries the failed change. | Browser and transport checks cover full storage, denied reads, invalid stored data and consistent retries in memory. |

## Data handling

Case explanations remain available while reviews are open. After all reviews finish, account closure removes profile content and explanations while retaining dated decision statuses and simulated financial records. Earlier releases may already have removed a narrative from a closed workspace. The recovery path uses the records that remain.

Temporary mode keeps activity in memory until the page reloads or closes. Existing browser storage is preserved when the visitor chooses temporary continuation.

## Dependency and framework checks

The full npm advisory scan reported zero vulnerabilities on November 12, 2026. This is a registry advisory result for the committed dependency lock.

The esbuild override consolidates older build-tool copies onto the patched root version. The minimatch override supplies the patched major version for affected v7–v10 consumers. The brace-expansion and fflate overrides use patched releases in their existing major series. The sharp override updates Miniflare's image dependency.

Vinext's updated development workflow uses Vite. The existing `npm run dev -- --port … --hostname …` entry point remains supported through argument translation. Cloudflare's new development registry uses the existing checkout-local runtime directory.

## Verification completed

- Clean `npm ci` from the committed lockfile.
- 58 domain and browser-transport tests.
- HTTP integration suite against a new local D1 database, including concurrent reservations, repeated checkout, refund accounting, decision history, closure and reset replay.
- ESLint, TypeScript, schema generation check, static Pages build and Worker build.
- Browser checks of booking selection, recovery, authentication expiry, decision history, temporary storage and closed-workspace reviews.

Browser fixtures used fictional data and one browser engine. Physical-device and screen-reader testing remain future verification work. Real calls, payments and staffed safety require the integrations described in [production gaps](V1.3-PRODUCTION-GAPS.md).

