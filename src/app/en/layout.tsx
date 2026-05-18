import type { Metadata } from "next";

const SITE_URL = "https://carterco.dk";
const SITE_TITLE = "Carter & Co — Strike while the iron is hot";
const SITE_DESCRIPTION =
  "I call your leads within 5 minutes — 21× more likely to qualify. Carter & Co builds the system that catches them hot and doesn't let go until they close.";

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  alternates: {
    canonical: `${SITE_URL}/en`,
    languages: {
      da: "/",
      en: "/en",
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: `${SITE_URL}/en`,
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

export default function EnLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return children;
}
