import "./globals.css";

export const metadata = {
  title: "Arbit — Uniswap v4 Dynamic Hook on Robinhood Chain",
  description:
    "Prices every swap by participant: humans 0.30%, agents 0.05%, bots 1.00%. Automated onchain buyback and burn of ARBT.",
  icons: {
    icon: "/favicon.png",
  },
  openGraph: {
    title: "Arbit — Uniswap v4 Dynamic Hook on Robinhood Chain",
    description:
      "Prices every swap by participant: humans 0.30%, agents 0.05%, bots 1.00%. Automated onchain buyback and burn of ARBT.",
    type: "website",
  },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=Outfit:wght@300;400;500;600;700&family=Poppins:wght@400;500;600;700;800;900&family=Space+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
