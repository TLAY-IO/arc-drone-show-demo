import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // SSE long-lived responses — keep dynamic.
  experimental: {},
  // This app never uses next/image, but the /_next/image optimization
  // endpoint is exposed by default and is the only runtime-reachable path
  // to the bundled sharp/libvips CVEs (fixed upstream only in next 16.3.x).
  // Disabling it closes that surface with zero behavior loss.
  images: { unoptimized: true },
}

export default nextConfig
