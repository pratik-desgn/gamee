import type { Metadata } from "next";
import "./globals.css";
import Navbar from "@/components/Navbar";
import Providers from "@/components/Providers";

export const metadata: Metadata = {
  title: "GAMEE — Prove Your Skill. Win the Jackpot.",
  description: "Pay $1, spin the wheel, play a skill game. Win real crypto jackpots on Solana.",
  openGraph: {
    title: "GAMEE — Prove Your Skill. Win the Jackpot.",
    description: "Web3 skill-gaming jackpot platform on Solana.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gamee-dark text-gamee-text">
        <Providers>
          <Navbar />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  );
}
