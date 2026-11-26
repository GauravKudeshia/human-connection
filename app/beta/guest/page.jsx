import GuestPreview from "./guest-preview";
import { marketplaceConfig } from "../../../lib/marketplace/http-context";
import { guestInvitationsEnabled } from "../../../lib/marketplace/guest-invitations.mjs";
import "../beta.css";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Human Connection — Guest preview",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function GuestPage() {
  if (!guestInvitationsEnabled(marketplaceConfig())) {
    return (
      <main className="beta-shell">
        <section className="beta-card">
          <h1>Guest preview unavailable</h1>
          <p>Ask the person who invited you for an updated link.</p>
        </section>
      </main>
    );
  }
  return <GuestPreview />;
}
