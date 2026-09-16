export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "60px auto", padding: "0 20px" }}>
      <h1 style={{ fontSize: 24, margin: 0 }}>arc-drone-show-demo</h1>
      <p style={{ color: "var(--fg-dim)", marginTop: 4 }}>
        Built by{" "}
        <a href="https://tlay.io" target="_blank" rel="noreferrer">
          TLAY
        </a>{" "}
        in collaboration with Circle, Arc, and Arkreen.
      </p>

      <p style={{ marginTop: 28 }}>
        BLE-native machine-economy nanopayments demonstrated by an eCandle ESP32
        (energy seller) and a drone-agent ESP32 (energy buyer). Slice authorizations
        are signed on-chip, batched, and settled on Arc Testnet via Circle Gateway.
      </p>

      <p>
        <a href="/demo" style={{ fontSize: 16 }}>
          → Live demo visualization
        </a>
      </p>

      <h2 style={{ fontSize: 18, marginTop: 36 }}>Upstream products</h2>
      <ul>
        <li>
          <a href="https://github.com/TLAY-IO/boat-mer" target="_blank" rel="noreferrer">
            TLAY-IO/boat-mer
          </a>{" "}
          — Machine Economy Runtime (5-tier SDK + 0xEE00 protocol + seller/buyer engines)
        </li>
        <li>
          <a href="https://github.com/TLAY-IO/hashanchor" target="_blank" rel="noreferrer">
            TLAY-IO/hashanchor
          </a>{" "}
          — Settle bridge client SDK (JS / Python / Go)
        </li>
      </ul>

      <h2 style={{ fontSize: 18, marginTop: 36 }}>This repository</h2>
      <ul>
        <li>
          <a
            href="https://github.com/TLAY-IO/arc-drone-show-demo"
            target="_blank"
            rel="noreferrer"
          >
            TLAY-IO/arc-drone-show-demo
          </a>{" "}
          — MIT-licensed ESP32 integration + cloud reference + visualization
        </li>
      </ul>

      <p style={{ marginTop: 60, color: "var(--fg-dim)", fontSize: 12 }}>
        SF Drone Show 2026
      </p>
    </main>
  )
}
