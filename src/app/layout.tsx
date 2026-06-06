import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LiveCrew",
  description: "AI operations crew for livestream commerce demos",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
