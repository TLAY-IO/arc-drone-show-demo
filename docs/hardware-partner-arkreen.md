# Hardware partner: Arkreen

## Who is Arkreen

[Arkreen](https://arkreen.com) is a renewable-energy DePIN network. The real
**eCandle** used in the SF Drone Show 2026 demonstration is an Arkreen device —
a portable solar-charged battery with a 230 V inverter, telemetered over an
ESP32 control board running BoAT MER.

For the live SF Drone Show (2026), real eCandle hardware sells energy
to a real drone that is charging on a real landing pad. The pad measures
real power, the battery's BMS reports real state-of-charge, and the AC output
data that the buyer trusts comes from the inverter via Arkreen's vendor-private
control protocol.

## Why this repo does NOT include the real interface

Two reasons:

1. **Hardware availability.** A real eCandle is an Arkreen physical product;
   it is not freely available to community developers. Requiring it would
   defeat the purpose of an open-source demo.
2. **Vendor IP.** Arkreen's inverter-control protocol is hardware-vendor
   intellectual property. The communication shape (which ports, which framing,
   which command codes) belongs to Arkreen and is not ours to publish.

So in `apps/ecandle/`, the AC-output signal is **synthesized in firmware**.
A scripted ramp in firmware (`synthetic_power_task`) substitutes for the
real-world reading. The slice math, BLE protocol, MER identity,
MER attest, and EIP-3009 signing are all real — what's substituted is
upstream of those layers.

## What this means for honesty in the demo

The buyer (`apps/drone`) signs an EIP-3009 authorization saying "I owe X µUSDC
for Y Wh of energy at $Z/kWh." That authorization is cryptographically real
and settles on Arc Testnet. But:

- In **this demo**, the kWh figure derives from a **synthetic** AC reading.
- In **production eCandle**, the kWh figure derives from the real Arkreen inverter.

The MER `boat_attest` tier is what binds the figure to the device that
witnessed it. In this demo, the attestation says "device X witnessed Y" but
Y is synthetic. That is enough to demonstrate the *machinery*; it is not
enough to settle real renewable-energy commerce. Don't mistake the demo's
witness for an oracle on real grid power.

If you build an app that needs to oracle real physical readings, you must
add a trusted measurement layer between hardware and MER attest. BoAT MER's
attest tier does not magically make synthetic data real. See upstream
`boat-mer/docs/boat-mer-overview.md` for the attestation model.

## What Arkreen contributes to this demo

- The **real hardware** for the SF Drone Show live demonstration.
- The **inverter protocol** that production eCandle uses (closed-source by Arkreen).
- Brand co-credit (Arkreen + Circle + Arc + TLAY) on this demo's launch.

What Arkreen does NOT contribute to this repository: no source code, no protocol
specification. The demo is intentionally hardware-agnostic so that any developer
can run it on $5 of ESP32 dev boards.

## Acknowledgment

We thank Arkreen for providing the SF Drone Show hardware and for being a
launch partner. This demo is open-source so that the BLE-native machine-economy
nanopayment pattern can be reproduced on any ESP32 — not just on an eCandle.

— TLAY
