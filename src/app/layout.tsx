import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GitStandup — Weekly standup from git history",
  description:
    "Generate per-person weekly standup summaries from GitHub PRs, commits, issues, and reviews.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // System font stack — avoids build/runtime fetches to Google Fonts, which
  // can fail on networks that block or break TLS to fonts.gstatic.com.
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
