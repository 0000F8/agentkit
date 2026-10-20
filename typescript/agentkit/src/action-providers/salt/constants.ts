// Chain registry for the Salt action provider -- the subset of Salt's own
// backend-authoritative registry (salt-api's config/chains.yml) that is
// also EVM and also supported by AgentKit's wallet providers: Ethereum,
// Polygon, Arbitrum, Optimism, Base, BNB Smart Chain, Avalanche. Every
// chain has a mainnet and testnet variant, matching Salt's Wallet model
// (chain + testnet columns).
//
// USDC contract addresses are Circle's own official/native-issuance
// addresses (verified against developers.circle.com/stablecoins, 2026-09-18),
// NOT a bridged/wrapped representation. BNB Smart Chain deliberately has no
// `usdc` entry: Circle does not issue native USDC on BNB Smart Chain --
// the token commonly called "USDC" there is Binance-Peg USD Coin, a
// different contract with different backing/risk characteristics. Rather
// than guess which one a caller means, salt_request_payment/salt_send_invoice
// refuse `asset: "usdc"` on `bsc` outright. See HANDOFF.md (github.com/0000F8/saltapp-agentkit).
export type SaltChainKey =
  | "ethereum"
  | "polygon"
  | "arbitrum"
  | "optimism"
  | "base"
  | "bsc"
  | "avalanche";

export const SALT_CHAIN_KEYS: SaltChainKey[] = [
  "ethereum",
  "polygon",
  "arbitrum",
  "optimism",
  "base",
  "bsc",
  "avalanche",
];

export interface SaltChainVariant {
  /** The EVM chain id AgentKit's wallet providers report via getNetwork().chainId. */
  chainId: number;
  /** Circle's native USDC contract address on this chain, or undefined if none exists. */
  usdc?: `0x${string}`;
}

export interface SaltChainConfig {
  /** Salt's own chain slug (Wallet#chain / config/chains.yml key). */
  name_3: string;
  displayName: string;
  /** Every native asset on every chain here uses 18 decimals. */
  nativeDecimals: 18;
  mainnet: SaltChainVariant;
  testnet: SaltChainVariant;
}

export const SALT_CHAINS: Record<SaltChainKey, SaltChainConfig> = {
  ethereum: {
    name_3: "ethereum",
    displayName: "Ethereum",
    nativeDecimals: 18,
    mainnet: { chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    testnet: { chainId: 11155111, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  },
  polygon: {
    name_3: "polygon",
    displayName: "Polygon",
    nativeDecimals: 18,
    mainnet: { chainId: 137, usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
    testnet: { chainId: 80002, usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  },
  arbitrum: {
    name_3: "arbitrum",
    displayName: "Arbitrum One",
    nativeDecimals: 18,
    mainnet: { chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    testnet: { chainId: 421614, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  },
  optimism: {
    name_3: "optimism",
    displayName: "Optimism",
    nativeDecimals: 18,
    mainnet: { chainId: 10, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
    testnet: { chainId: 11155420, usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  },
  base: {
    name_3: "base",
    displayName: "Base",
    nativeDecimals: 18,
    mainnet: { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    testnet: { chainId: 84532, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  },
  bsc: {
    name_3: "bsc",
    displayName: "BNB Smart Chain",
    nativeDecimals: 18,
    mainnet: { chainId: 56 }, // no Circle-native USDC -- see header comment
    testnet: { chainId: 97 },
  },
  avalanche: {
    name_3: "avalanche",
    displayName: "Avalanche",
    nativeDecimals: 18,
    mainnet: { chainId: 43114, usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" },
    testnet: { chainId: 43113, usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  },
};

/** USDC is a 6-decimal token on every chain Salt/AgentKit share. */
export const USDC_DECIMALS = 6;

/** Every native asset Salt supports here (ETH/MATIC/BNB/AVAX) uses 18 decimals. */
export const NATIVE_DECIMALS = 18;

/**
 * Reverse lookup: EVM chain id -> Salt chain key + testnet flag, used by
 * salt_pay_request to confirm the connected wallet is actually on the
 * request's chain before it ever signs anything.
 *
 * @param chainId - The EVM chain id.
 *
 * @returns The matching chain key and testnet flag, or undefined when the chain is not supported.
 */
export function saltChainForEvmChainId(
  chainId: number,
): { chain: SaltChainKey; testnet: boolean } | undefined {
  for (const key of SALT_CHAIN_KEYS) {
    const cfg = SALT_CHAINS[key];
    if (cfg.mainnet.chainId === chainId) return { chain: key, testnet: false };
    if (cfg.testnet.chainId === chainId) return { chain: key, testnet: true };
  }
  return undefined;
}
