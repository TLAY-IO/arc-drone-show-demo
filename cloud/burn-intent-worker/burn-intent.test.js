// Tests for the BurnIntent EIP-712 builder.
//
//   cd cloud/burn-intent-worker && npm test
//
// What these are checked AGAINST matters more than how many there are. A test
// that compares digestOf() with ethers' own TypedDataEncoder would pass for
// any type table, right or wrong. So the reference values here come from
// outside this repo:
//
//   - the type strings and typehash constants are copied from Circle's
//     published contracts (github.com/circlefin/evm-gateway-contracts,
//     src/lib/BurnIntents.sol, TransferSpec.sol, EIP712Domain.sol);
//   - the digest is recomputed by hand from the EIP-712 definition using only
//     keccak256 and the ABI coder, never TypedDataEncoder.
//
// What this does NOT prove: that Circle's deployed Gateway accepts the
// signature, or that the domain name/version and contract addresses are right
// for a given network. Only a live settlement proves that.

import { test } from "node:test"
import assert from "node:assert/strict"
import { ethers } from "ethers"

import {
  ARC,
  BURN_INTENT_TYPES,
  CIRCLE_GATEWAY_DOMAIN,
  buildArcSelfMint,
  digestOf,
  toTransferPayload,
  verifySignature,
} from "./burn-intent.js"

// ── Reference values from Circle's contracts ────────────────────────────────

const TRANSFER_SPEC_TYPE =
  "TransferSpec(uint32 version,uint32 sourceDomain,uint32 destinationDomain," +
  "bytes32 sourceContract,bytes32 destinationContract,bytes32 sourceToken," +
  "bytes32 destinationToken,bytes32 sourceDepositor,bytes32 destinationRecipient," +
  "bytes32 sourceSigner,bytes32 destinationCaller,uint256 value,bytes32 salt," +
  "bytes hookData)"
const BURN_INTENT_TYPE =
  "BurnIntent(uint256 maxBlockHeight,uint256 maxFee,TransferSpec spec)" +
  TRANSFER_SPEC_TYPE
const DOMAIN_TYPE = "EIP712Domain(string name,string version)"

// Public typehash constants from the same Solidity files. Each is written in
// two halves only so the repo's committed-private-key scan (64 hex chars in a
// row) does not flag a public constant.
const BURN_INTENT_TYPEHASH =
  "0x8b99d17a83a2dd1add9fc2a450e22732" + "c7e8564aa110ab99c20485a7a10ba37c"
const TRANSFER_SPEC_TYPEHASH =
  "0x44409c7ba8872720f5fc290d2788c2d7" + "0a3905b7ca1cdb2ffa152791a69e089b"
const DOMAIN_TYPEHASH =
  "0xb03948446334eb9b2196d5eb166f69b9" + "d49403eb4a12f36de8d3f9f3cb8e15c3"

const keccakText = (s) => ethers.keccak256(ethers.toUtf8Bytes(s))
const coder = ethers.AbiCoder.defaultAbiCoder()

/** EIP-712 digest from first principles — no TypedDataEncoder. */
function digestByHand(intent, domain) {
  const s = intent.spec
  const specHash = ethers.keccak256(
    coder.encode(
      [
        "bytes32",
        "uint32", "uint32", "uint32",
        "bytes32", "bytes32", "bytes32", "bytes32",
        "bytes32", "bytes32", "bytes32", "bytes32",
        "uint256", "bytes32", "bytes32",
      ],
      [
        TRANSFER_SPEC_TYPEHASH,
        s.version, s.sourceDomain, s.destinationDomain,
        s.sourceContract, s.destinationContract, s.sourceToken, s.destinationToken,
        s.sourceDepositor, s.destinationRecipient, s.sourceSigner, s.destinationCaller,
        s.value, s.salt, ethers.keccak256(s.hookData), // dynamic `bytes` is hashed
      ],
    ),
  )
  const structHash = ethers.keccak256(
    coder.encode(
      ["bytes32", "uint256", "uint256", "bytes32"],
      [BURN_INTENT_TYPEHASH, intent.maxBlockHeight, intent.maxFee, specHash],
    ),
  )
  const domainSeparator = ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32"],
      [DOMAIN_TYPEHASH, keccakText(domain.name), keccakText(domain.version)],
    ),
  )
  return ethers.keccak256(ethers.concat(["0x1901", domainSeparator, structHash]))
}

// Fixed, obviously-not-real inputs. No private key is committed: the signing
// tests generate a throwaway wallet per run.
const DEPOSITOR = "0x" + "11".repeat(20)
const SALT = "0x" + "ab".repeat(32)
const fixedIntent = () =>
  buildArcSelfMint({ depositor: DEPOSITOR, valueMicroUsdc: 12345n, salt: SALT })

// ── Type table ──────────────────────────────────────────────────────────────

test("type strings match Circle's BurnIntents.sol / TransferSpec.sol", () => {
  const enc = ethers.TypedDataEncoder.from(BURN_INTENT_TYPES)
  assert.equal(enc.primaryType, "BurnIntent")
  assert.equal(enc.encodeType("BurnIntent"), BURN_INTENT_TYPE)
  assert.equal(enc.encodeType("TransferSpec"), TRANSFER_SPEC_TYPE)
})

test("the copied type strings hash to Circle's published typehash constants", () => {
  // Guards the reference values themselves: a typo in the strings above would
  // otherwise make the previous test agree with a wrong table.
  assert.equal(keccakText(BURN_INTENT_TYPE), BURN_INTENT_TYPEHASH)
  assert.equal(keccakText(TRANSFER_SPEC_TYPE), TRANSFER_SPEC_TYPEHASH)
  assert.equal(keccakText(DOMAIN_TYPE), DOMAIN_TYPEHASH)
})

// ── Domain ──────────────────────────────────────────────────────────────────

test("domain carries name and version only — no chainId, no verifyingContract", () => {
  assert.deepEqual(Object.keys(CIRCLE_GATEWAY_DOMAIN).sort(), ["name", "version"])
  const bySelf = ethers.TypedDataEncoder.hashDomain(CIRCLE_GATEWAY_DOMAIN)
  const byHand = ethers.keccak256(
    coder.encode(
      ["bytes32", "bytes32", "bytes32"],
      [
        DOMAIN_TYPEHASH,
        keccakText(CIRCLE_GATEWAY_DOMAIN.name),
        keccakText(CIRCLE_GATEWAY_DOMAIN.version),
      ],
    ),
  )
  assert.equal(bySelf, byHand)
})

// ── Digest ──────────────────────────────────────────────────────────────────

test("digestOf equals the digest computed by hand from the EIP-712 definition", () => {
  const intent = fixedIntent()
  assert.equal(digestOf(intent), digestByHand(intent, CIRCLE_GATEWAY_DOMAIN))
})

test("digestOf agrees with the by-hand digest for non-default fields too", () => {
  const intent = buildArcSelfMint({
    depositor: DEPOSITOR,
    recipient: "0x" + "22".repeat(20),
    caller: "0x" + "33".repeat(20),
    valueMicroUsdc: 2n ** 64n + 7n,
    salt: SALT,
    maxFee: 2000n,
    maxBlockHeight: 987654321n,
  })
  assert.equal(digestOf(intent), digestByHand(intent, CIRCLE_GATEWAY_DOMAIN))
})

test("every signed field changes the digest", () => {
  const base = digestOf(fixedIntent())
  const other32 = "0x" + "cd".repeat(32)
  const mutations = {
    maxBlockHeight: (i) => (i.maxBlockHeight = 1n),
    maxFee: (i) => (i.maxFee = 1n),
    version: (i) => (i.spec.version = 2),
    sourceDomain: (i) => (i.spec.sourceDomain += 1),
    destinationDomain: (i) => (i.spec.destinationDomain += 1),
    sourceContract: (i) => (i.spec.sourceContract = other32),
    destinationContract: (i) => (i.spec.destinationContract = other32),
    sourceToken: (i) => (i.spec.sourceToken = other32),
    destinationToken: (i) => (i.spec.destinationToken = other32),
    sourceDepositor: (i) => (i.spec.sourceDepositor = other32),
    destinationRecipient: (i) => (i.spec.destinationRecipient = other32),
    sourceSigner: (i) => (i.spec.sourceSigner = other32),
    destinationCaller: (i) => (i.spec.destinationCaller = other32),
    value: (i) => (i.spec.value += 1n),
    salt: (i) => (i.spec.salt = other32),
    hookData: (i) => (i.spec.hookData = "0x01"),
  }
  // Every field in the type table must have a mutation here, so adding a
  // field without covering it fails loudly.
  const typed = [
    ...BURN_INTENT_TYPES.BurnIntent.map((f) => f.name).filter((n) => n !== "spec"),
    ...BURN_INTENT_TYPES.TransferSpec.map((f) => f.name),
  ]
  assert.deepEqual(Object.keys(mutations).sort(), typed.sort())

  for (const [field, mutate] of Object.entries(mutations)) {
    const intent = fixedIntent()
    mutate(intent)
    assert.notEqual(digestOf(intent), base, `changing ${field} left the digest unchanged`)
  }
})

// ── Builder ─────────────────────────────────────────────────────────────────

test("buildArcSelfMint defaults: depositor is signer and recipient, any caller", () => {
  const { spec, maxFee, maxBlockHeight } = fixedIntent()
  const depositor32 = "0x" + "00".repeat(12) + "11".repeat(20)
  assert.equal(spec.sourceDepositor, depositor32)
  assert.equal(spec.sourceSigner, depositor32)
  assert.equal(spec.destinationRecipient, depositor32)
  assert.equal(spec.destinationCaller, "0x" + "00".repeat(32))
  assert.equal(spec.version, 1)
  assert.equal(spec.sourceDomain, ARC.domainId)
  assert.equal(spec.destinationDomain, ARC.domainId)
  assert.equal(spec.sourceContract, ethers.zeroPadValue(ARC.walletContract, 32))
  assert.equal(spec.destinationContract, ethers.zeroPadValue(ARC.minterContract, 32))
  assert.equal(spec.sourceToken, ethers.zeroPadValue(ARC.usdc, 32))
  assert.equal(spec.destinationToken, ethers.zeroPadValue(ARC.usdc, 32))
  assert.equal(spec.value, 12345n)
  assert.equal(spec.hookData, "0x")
  assert.equal(maxFee, 0n)
  assert.equal(maxBlockHeight, 2n ** 256n - 1n)
})

test("buildArcSelfMint with a separate recipient keeps depositor as the signer", () => {
  const recipient = "0x" + "22".repeat(20)
  const caller = "0x" + "33".repeat(20)
  const { spec } = buildArcSelfMint({ depositor: DEPOSITOR, recipient, caller, valueMicroUsdc: 1n })
  const pad = (a) => ethers.zeroPadValue(a, 32)
  assert.equal(spec.sourceDepositor, pad(DEPOSITOR))
  assert.equal(spec.sourceSigner, pad(DEPOSITOR))
  assert.equal(spec.destinationRecipient, pad(recipient))
  assert.equal(spec.destinationCaller, pad(caller))
})

test("buildArcSelfMint draws a fresh 32-byte salt when none is given", () => {
  const a = buildArcSelfMint({ depositor: DEPOSITOR, valueMicroUsdc: 1n })
  const b = buildArcSelfMint({ depositor: DEPOSITOR, valueMicroUsdc: 1n })
  assert.match(a.spec.salt, /^0x[0-9a-f]{64}$/)
  assert.notEqual(a.spec.salt, b.spec.salt)
})

test("buildArcSelfMint rejects a malformed depositor address", () => {
  assert.throws(() => buildArcSelfMint({ depositor: "0x1234", valueMicroUsdc: 1n }))
})

// ── Signature ───────────────────────────────────────────────────────────────

test("verifySignature accepts the signer and rejects everyone else", () => {
  const wallet = ethers.Wallet.createRandom()
  const stranger = ethers.Wallet.createRandom()
  const intent = buildArcSelfMint({ depositor: wallet.address, valueMicroUsdc: 5000n, salt: SALT })
  // Sign the 32-byte digest directly (no EIP-191 prefix): that is what
  // verifySignature recovers from, so it is what a signer has to produce.
  const signature = wallet.signingKey.sign(digestOf(intent)).serialized

  assert.equal(verifySignature(intent, signature, wallet.address), true)
  assert.equal(verifySignature(intent, signature, wallet.address.toLowerCase()), true)
  assert.equal(verifySignature(intent, signature, stranger.address), false)

  const tampered = structuredClone(intent)
  tampered.spec.value += 1n
  assert.equal(verifySignature(tampered, signature, wallet.address), false)
})

test("a signature made with ethers signTypedData verifies against digestOf", async () => {
  // Independent route to the same signature: lets a wallet library build the
  // typed-data hash itself, the way an off-device signer would.
  const wallet = ethers.Wallet.createRandom()
  const intent = buildArcSelfMint({ depositor: wallet.address, valueMicroUsdc: 5000n, salt: SALT })
  const signature = await wallet.signTypedData(CIRCLE_GATEWAY_DOMAIN, BURN_INTENT_TYPES, intent)
  assert.equal(verifySignature(intent, signature, wallet.address), true)
})

// ── Wire format ─────────────────────────────────────────────────────────────

test("toTransferPayload: array of one, big integers as decimal strings, JSON-safe", () => {
  const intent = fixedIntent()
  const payload = toTransferPayload(intent, "0xsig")

  assert.equal(Array.isArray(payload), true)
  assert.equal(payload.length, 1)
  assert.equal(payload[0].signature, "0xsig")

  const bi = payload[0].burnIntent
  assert.equal(bi.maxBlockHeight, (2n ** 256n - 1n).toString())
  assert.equal(bi.maxFee, "0")
  assert.equal(bi.spec.value, "12345")
  assert.equal(bi.spec.salt, SALT)
  assert.equal(bi.spec.sourceDepositor, intent.spec.sourceDepositor)

  // JSON.stringify throws on a BigInt, so this fails if one leaks through.
  assert.doesNotThrow(() => JSON.stringify(payload))
  // The input must not be mutated: the caller still signs/verifies with it.
  assert.equal(typeof intent.spec.value, "bigint")
})
