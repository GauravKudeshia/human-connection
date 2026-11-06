import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Human Connection — A little human time",
  description:
    "Choose a personalized conversation experience. Fictional hosts, sample activities and simulated payments in this interactive demo.",
  icons: { icon: "/favicon.svg" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
