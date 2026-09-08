import "./globals.css";

export const metadata = {
  title: "Arbit — onchain policy enforcement for AI agents",
  description: "Uniswap v4 hook that enforces AI trading agents' declared rules. Violate the manifest, get slashed and suspended — automatically.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
