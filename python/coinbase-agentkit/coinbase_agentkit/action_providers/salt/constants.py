"""Chain registry for the Salt action provider.

The subset of Salt's own backend-authoritative registry (salt-api's
config/chains.yml) that is also EVM and also supported by AgentKit's
wallet providers: Ethereum, Polygon, Arbitrum, Optimism, Base, BNB Smart
Chain, Avalanche. Every chain has a mainnet and testnet variant, matching
Salt's Wallet model (chain + testnet columns).

USDC contract addresses are Circle's own official/native-issuance
addresses (verified against developers.circle.com/stablecoins,
2026-09-18), NOT a bridged/wrapped representation. BNB Smart Chain
deliberately has no usdc entry: Circle does not issue native USDC on BNB
Smart Chain -- the token commonly called "USDC" there is Binance-Peg USD
Coin, a different contract with different backing/risk characteristics.
Rather than guess which one a caller means, salt_request_payment /
salt_send_invoice refuse asset="usdc" on chain="bsc" outright. See
HANDOFF.md (github.com/0000F8/saltapp-agentkit).
"""

from __future__ import annotations

from dataclasses import dataclass

SALT_CHAIN_KEYS = ["ethereum", "polygon", "arbitrum", "optimism", "base", "bsc", "avalanche"]

NATIVE_DECIMALS = 18
USDC_DECIMALS = 6


@dataclass(frozen=True)
class SaltChainVariant:
    """One mainnet/testnet variant of a chain: its EVM chain id and (if any) Circle-native USDC address."""

    chain_id: int
    usdc: str | None = None


@dataclass(frozen=True)
class SaltChainConfig:
    """A chain Salt and AgentKit both support."""

    name_3: str
    display_name: str
    mainnet: SaltChainVariant
    testnet: SaltChainVariant


SALT_CHAINS: dict[str, SaltChainConfig] = {
    "ethereum": SaltChainConfig(
        name_3="ethereum",
        display_name="Ethereum",
        mainnet=SaltChainVariant(chain_id=1, usdc="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        testnet=SaltChainVariant(
            chain_id=11155111, usdc="0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"
        ),
    ),
    "polygon": SaltChainConfig(
        name_3="polygon",
        display_name="Polygon",
        mainnet=SaltChainVariant(chain_id=137, usdc="0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"),
        testnet=SaltChainVariant(chain_id=80002, usdc="0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582"),
    ),
    "arbitrum": SaltChainConfig(
        name_3="arbitrum",
        display_name="Arbitrum One",
        mainnet=SaltChainVariant(chain_id=42161, usdc="0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
        testnet=SaltChainVariant(
            chain_id=421614, usdc="0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d"
        ),
    ),
    "optimism": SaltChainConfig(
        name_3="optimism",
        display_name="Optimism",
        mainnet=SaltChainVariant(chain_id=10, usdc="0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"),
        testnet=SaltChainVariant(
            chain_id=11155420, usdc="0x5fd84259d66Cd46123540766Be93DFE6D43130D7"
        ),
    ),
    "base": SaltChainConfig(
        name_3="base",
        display_name="Base",
        mainnet=SaltChainVariant(chain_id=8453, usdc="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
        testnet=SaltChainVariant(chain_id=84532, usdc="0x036CbD53842c5426634e7929541eC2318f3dCF7e"),
    ),
    "bsc": SaltChainConfig(
        name_3="bsc",
        display_name="BNB Smart Chain",
        mainnet=SaltChainVariant(chain_id=56),  # no Circle-native USDC -- see module docstring
        testnet=SaltChainVariant(chain_id=97),
    ),
    "avalanche": SaltChainConfig(
        name_3="avalanche",
        display_name="Avalanche",
        mainnet=SaltChainVariant(chain_id=43114, usdc="0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"),
        testnet=SaltChainVariant(chain_id=43113, usdc="0x5425890298aed601595a70AB815c96711a31Bc65"),
    ),
}


def salt_chain_for_evm_chain_id(chain_id: int) -> tuple[str, bool] | None:
    """Reverse lookup: EVM chain id -> (Salt chain key, testnet flag).

    Used by salt_pay_request to confirm the connected wallet is actually on
    the request's chain before it ever signs anything.
    """
    for key in SALT_CHAIN_KEYS:
        cfg = SALT_CHAINS[key]
        if cfg.mainnet.chain_id == chain_id:
            return key, False
        if cfg.testnet.chain_id == chain_id:
            return key, True
    return None
