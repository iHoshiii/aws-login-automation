import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daily Review · Builder Center",
  description: "A private dashboard for scheduling and recording manual AWS Builder Center activity.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
