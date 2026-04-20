import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Homemade_Apple, Caveat } from "next/font/google";
import { PwaRegistrar } from "./pwa-registrar";
import "./globals.css";

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

export const metadata: Metadata = {
  applicationName: "CarterCo",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CarterCo",
  },
  title: "Carter & Co — Smed mens jernet er varmt",
  description:
    "Vi kontakter dine leads inden for 5 minutter — 21× mere tilbøjelige til at blive kvalificeret. Carter & Co bygger systemet, der fanger dem varme og ikke slipper før de er lukket.",
  formatDetection: {
    telephone: true,
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon.png",
    apple: "/apple-icon.png",
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
        <PwaRegistrar />
        {children}
      </body>
    </html>
  );
}
