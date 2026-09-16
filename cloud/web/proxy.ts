// HTTP Basic Auth for the demo surface. Enabled only when BOTH
// DRONE_DEMO_AUTH_USER and DRONE_DEMO_AUTH_PASS are set (see .env.example);
// with them unset the page stays open, which is fine for a private LAN but
// NOT for anything internet-facing.
//
// /api/mint is gated too: it publishes real Path-A mint jobs to the broker,
// so it must not be callable by arbitrary visitors when auth is on.
// Next 16 renamed middleware.ts to proxy.ts; matchers have been unreliable,
// so the path check is done at runtime instead.

import { NextRequest, NextResponse } from "next/server"

const PROTECTED_PREFIXES = ["/demo", "/api/mint", "/api/stream"]

export default function proxy(req: NextRequest) {
  const user = process.env.DRONE_DEMO_AUTH_USER
  const pass = process.env.DRONE_DEMO_AUTH_PASS
  if (!user || !pass) return NextResponse.next() // auth disabled

  const { pathname } = req.nextUrl
  if (!PROTECTED_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  const header = req.headers.get("authorization") ?? ""
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString()
    const idx = decoded.indexOf(":")
    if (
      idx > 0 &&
      decoded.slice(0, idx) === user &&
      decoded.slice(idx + 1) === pass
    ) {
      return NextResponse.next()
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="arc-drone-show-demo"' },
  })
}
