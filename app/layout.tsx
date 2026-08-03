import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "雫 書房 — 軽やかな小説執筆",
  description: "オフラインでも原稿を守る、静かで軽量な小説執筆PWA。",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "雫 書房" },
  icons: { icon: "/icon.svg", apple: "/icon.svg" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#173d32" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
