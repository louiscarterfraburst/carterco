import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Homemade_Apple, Caveat } from "next/font/google";
import Script from "next/script";
import { PwaRegistrar } from "./pwa-registrar";
import "./globals.css";

const SITE_URL = "https://carterco.dk";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const homemadeApple = Homemade_Apple({
  variable: "--font-signature",
  weight: "400",
  subsets: ["latin"],
});

const caveat = Caveat({
  variable: "--font-handwritten",
  subsets: ["latin"],
});

const SITE_TITLE = "Carter & Co — Smed mens jernet er varmt";
const SITE_DESCRIPTION =
  "Vi kontakter dine leads inden for 5 minutter — 21× mere tilbøjelige til at blive kvalificeret. Carter & Co bygger systemet, der fanger dem varme og ikke slipper før de er lukket.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  applicationName: "CarterCo",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CarterCo",
  },
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  formatDetection: {
    telephone: true,
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
  },
  openGraph: {
    type: "website",
    locale: "da_DK",
    url: SITE_URL,
    siteName: "Carter & Co",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#0f0d0a",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="da"
      className={`${geistSans.variable} ${geistMono.variable} ${homemadeApple.variable} ${caveat.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Script
          defer
          data-domain="carterco.dk"
          src="https://plausible.io/js/script.tagged-events.js"
          strategy="afterInteractive"
        />
        <Script id="plausible-init" strategy="afterInteractive">
          {`window.plausible = window.plausible || function() { (window.plausible.q = window.plausible.q || []).push(arguments) }`}
        </Script>
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}
