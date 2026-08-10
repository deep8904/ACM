import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./styles.css";

export const metadata: Metadata = {
  title: {
    default: "AI Content Machine",
    template: "%s | AI Content Machine",
  },
  description:
    "A trend-first, human-approved publishing system for an independent technology publication.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
