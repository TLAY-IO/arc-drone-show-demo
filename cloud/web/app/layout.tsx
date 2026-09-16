import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Arc Drone Show 2026 — Nanopayment Demo",
  description:
    "BLE-native machine-economy nanopayments. Built by TLAY in collaboration with Circle, Arc, and Arkreen.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
