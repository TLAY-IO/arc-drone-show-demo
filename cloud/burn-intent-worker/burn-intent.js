// Circle Gateway BurnIntent EIP-712 builder + verifier.
//
// Spec source: github.com/circlefin/evm-gateway-contracts
//   - src/lib/EIP712Domain.sol  (domain: name+version only; no chainId / verifyingContract)
//   - src/lib/BurnIntents.sol
//   - src/lib/TransferSpec.sol
//
// Ported from the internal production implementation on 2026-06-15 for the OSS demo.

import { ethers } from "ethers"

export const CIRCLE_GATEWAY_DOMAIN = {
  // EIP-712 domain fields. Testnet values proven by live settlement;
  // for mainnet set ARC_EIP712_DOMAIN_NAME/VERSION from Circle's official
  // contract-address reference — a wrong value makes every signature
  // recover to the wrong address.
  name: process.env.ARC_EIP712_DOMAIN_NAME || "GatewayWallet",
  version: process.env.ARC_EIP712_DOMAIN_VERSION || "1",
}

export const BURN_INTENT_TYPES = {
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
}

// Arc network constants. The Wallet/Minter/USDC addresses below are the
// TESTNET set, empirically verified (131/131 settles, June 2026).
//
// ⚠️ MAINNET IS UNCONFIRMED. Do not assume mainnet reuses the testnet
// addresses — take the mainnet GatewayWallet/GatewayMinter/USDC addresses
// and the EIP-712 domain fields from Circle's official contract-address
// reference before pointing this worker at a mainnet profile. The EIP-712
// domain includes `verifyingContract`, so a wrong address means every
// signature fails to recover. Set them via the ARC_* env overrides above.
//   Testnet chainId: 5042002  explorer: https://testnet.arcscan.app
//   Mainnet chainId: 5042     explorer: https://explorer.arc.io
export const ARC = {
  chainId: parseInt(process.env.ARC_CHAIN_ID || "5042002"),
  domainId: parseInt(process.env.ARC_GATEWAY_DOMAIN_ID || "26"),
  // Contract addresses: defaults are the Arc TESTNET set (verified by live
  // settlement). Mainnet uses DIFFERENT canonical addresses — override via
  // env from Circle's official reference; never assume they match testnet.
  walletContract: process.env.ARC_GATEWAY_CONTRACT || "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  minterContract: process.env.ARC_MINTER_CONTRACT || "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
  usdc: process.env.ARC_USDC_CONTRACT || "0x3600000000000000000000000000000000000000",
  explorer: process.env.ARC_EXPLORER || "https://testnet.arcscan.app",
}

const UINT256_MAX = BigInt(
  "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
)

function addrTo32(a) {
  return ethers.zeroPadValue(ethers.getAddress(a), 32)
}

/**
 * Build a self-mint BurnIntent (depositor == recipient == signer on Arc).
 *
 * @param {{ depositor: string, recipient?: string, caller?: string,
 *           valueMicroUsdc: bigint, salt?: string, maxFee?: bigint,
 *           maxBlockHeight?: bigint }} opts
 */
export function buildArcSelfMint(opts) {
  const depositor32 = addrTo32(opts.depositor)
  const recipient32 = opts.recipient ? addrTo32(opts.recipient) : depositor32
  const caller32 = opts.caller
    ? addrTo32(opts.caller)
    : ethers.zeroPadValue("0x", 32)
  const salt = opts.salt ?? ethers.hexlify(ethers.randomBytes(32))

  return {
    maxBlockHeight: opts.maxBlockHeight ?? UINT256_MAX,
    maxFee: opts.maxFee ?? BigInt(0),
    spec: {
      version: 1,
      sourceDomain: ARC.domainId,
      destinationDomain: ARC.domainId,
      sourceContract: addrTo32(ARC.walletContract),
      destinationContract: addrTo32(ARC.minterContract),
      sourceToken: addrTo32(ARC.usdc),
      destinationToken: addrTo32(ARC.usdc),
      sourceDepositor: depositor32,
      destinationRecipient: recipient32,
      sourceSigner: depositor32,
      destinationCaller: caller32,
      value: opts.valueMicroUsdc,
      salt,
      hookData: "0x",
    },
  }
}

export function digestOf(intent) {
  return ethers.TypedDataEncoder.hash(
    CIRCLE_GATEWAY_DOMAIN,
    BURN_INTENT_TYPES,
    intent,
  )
}

export function verifySignature(intent, signature, expectedSigner) {
  const recovered = ethers.recoverAddress(digestOf(intent), signature)
  return recovered.toLowerCase() === expectedSigner.toLowerCase()
}

/** Body shape Circle requires at POST /v1/transfer (note: array of 1). */
export function toTransferPayload(intent, signature) {
  return [
    {
      burnIntent: {
        maxBlockHeight: intent.maxBlockHeight.toString(),
        maxFee: intent.maxFee.toString(),
        spec: {
          ...intent.spec,
          value: intent.spec.value.toString(),
        },
      },
      signature,
    },
  ]
}
