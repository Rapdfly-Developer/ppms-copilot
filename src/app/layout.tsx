import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PPMS AI Copilot",
  description: "AI Clinical Decision Support — embedded in PPMS Core via iframe",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
