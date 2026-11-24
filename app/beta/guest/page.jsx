import GuestPreview from "./guest-preview";
import "../beta.css";

export const metadata = {
  title: "Human Connection — Guest preview",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function GuestPage() {
  return <GuestPreview />;
}
