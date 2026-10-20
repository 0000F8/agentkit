# Salt Action Provider

This directory contains the **SaltActionProvider** implementation, which provides actions to interact with [Salt](https://saltapp.ai) (`saltapp.ai`; the legacy `saltfor.com` host still answers) -- the end-to-end encrypted chat app where humans and AI agents message each other and move money in the conversation. It can send encrypted chat messages, ask a specific human a question and wait for their answer, and request, invoice, check on, and pay in-chat payments.

This is the Python sibling of the TypeScript `SaltActionProvider` (`typescript/agentkit/src/action-providers/salt/` in this repo). Same seven actions, same names, same argument shapes and behavior -- see `HANDOFF.md (github.com/0000F8/saltapp-agentkit)` at the repo root for why the two implementations differ in dependency shape (this provider imports the `saltapp` PyPI package directly for its REST client, PGP crypto, and card builders; the TypeScript sibling does not depend on `salt-agent-sdk` and instead ships a small self-contained REST client, because the npm release of `salt-agent-sdk` with socket-mode support doesn't exist yet).

## Getting Started

An agent needs its own Salt account (a Salt "Agent") to use this provider. Create one on Salt (web dashboard, or via `saltapp`/`salt-agent-sdk` for a scripted setup), then configure:

### Environment Variables

```
SALT_HOST                # e.g. "https://saltapp.ai" -- no trailing slash
SALT_AGENT_ID              # this agent's own Salt user id
SALT_API_KEY                 # this agent's Salt api-key
SALT_PGP_PRIVATE_KEY          # optional -- see "Keyless mode" below
SALT_PGP_PASSPHRASE             # optional -- the passphrase protecting SALT_PGP_PRIVATE_KEY
```

Or configure the provider directly:

```python
from coinbase_agentkit.action_providers.salt import salt_action_provider

provider = salt_action_provider(
    host="https://saltapp.ai",
    agent_id="your-agent-id",
    api_key="your-salt-api-key",
    pgp_private_key="-----BEGIN PGP PRIVATE KEY BLOCK-----...",  # optional
    pgp_passphrase="...",  # optional
)
```

### Keyless mode

`pgp_private_key`/`pgp_passphrase` are optional. Without them this provider is "keyless": it can still send messages (encryption needs only recipients' public keys) and can still see button taps on `salt_ask_human` cards (Salt reports those in plaintext metadata), but it cannot decrypt a free-text reply typed instead of tapping a button -- `salt_get_answer` keeps waiting and says so. Salt's servers never hold an agent's private key in a form they can read (see the Salt repo's `CLAUDE.md`), so there is no server-side fallback for this; configure a key if the agent needs to read free-text replies.

## Directory Structure

```
salt/
├── salt_action_provider.py    # The provider: all seven actions
├── schemas.py                 # Pydantic schemas for every action
├── constants.py                # Salt's EVM chain registry (subset shared with AgentKit) + USDC addresses
├── ask_poll.py                 # The salt_ask_human / salt_get_answer wait-and-resume machinery
├── __init__.py                  # Main exports
└── README.md                     # This file

# From python/coinbase-agentkit/
tests/action_providers/salt/
└── test_salt_action_provider.py   # Tests (HTTP mocked; real PGP round trips)
```

## Actions

- **`salt_send_message`**: Send an end-to-end encrypted chat message to a Salt handle (`handle`, opens or reuses the 1:1 chat) or an existing chat (`chat_id`). Encrypted client-side for every current chat member's public key before it's posted -- Salt's own server never sees the plaintext. Refuses to send, rather than posting unencrypted, if nobody in the chat has a public key on file.

- **`salt_ask_human`**: Ask ONE named human (`human_id`/`human_handle`) a question in a chat, as a card with 1-5 option buttons restricted so only they can answer. Waits up to `timeout_seconds` (default and max 50), checking the card's own interactions (`GET /api/v1/cards/:id`) and, if no tap yet, the chat since the card's own bubble (`GET /api/v1/chats/:id?last=`) each iteration. Resolves immediately on a button tap; resolves on a free-text reply only if a PGP key is configured. If nobody answers in time, returns a pending result with an `ask_id` -- pass that to `salt_get_answer` rather than asking again (which would post a second card).

- **`salt_get_answer`**: Keep waiting on a pending `salt_ask_human` (or a previous pending `salt_get_answer`), given its `ask_id`.

- **`salt_request_payment`**: Request a plain (non-itemized) payment from a human or agent in a chat, on Salt's TransferRequest rail. Takes `chat_id`, exactly one of `payer_id`/`payer_handle`, `amount` (human-decimal string, never wei), `chain`, `testnet` (default `True`), `asset` (`"native"` or `"usdc"`), and an optional `message`. Requires this agent to already have a Salt wallet on the requested chain/testnet -- it does not create one.

- **`salt_send_invoice`**: Send an itemized invoice on the same rail. Takes `line_items` (`name`/`qty`/`unit_price`); `subtotal` and the total `amount` are computed here with `Decimal` arithmetic (exact, no floating-point rounding), never asked of the model.

- **`salt_get_payment_status`**: Look up the current status (`Pending`/`Paying`/`Completed`/`Declined`/`Cancelled`) of a request or invoice this agent sent or received, by `request_id`.

- **`salt_pay_request`**: Pay an incoming Salt payment request directly from this AgentKit agent's own connected wallet -- a real on-chain EVM transfer, not a Salt-internal settlement. Takes **only** `request_id`; amount and destination are read from the request itself and can never be supplied as arguments, so this action can't be steered into paying an amount or address the caller supplies directly. Refuses: a request not addressed to this exact agent, a request that isn't `Pending`, a request whose chain doesn't match the connected wallet's current network, or a request whose note mentions USDC (see "Known limits"). Posts a receipt message with the transaction hash into the request's chat as a best-effort courtesy.

## Adding New Actions

To add new Salt actions:

1. Define your action schema in `schemas.py`. See [Defining the input schema](https://github.com/coinbase/agentkit/blob/main/CONTRIBUTING-PYTHON.md#defining-the-input-schema) for more information.
2. Implement the action on `SaltActionProvider` in `salt_action_provider.py`, matching the TypeScript sibling's behavior for the same action if one exists there.
3. Implement tests in `tests/action_providers/salt/test_salt_action_provider.py` (mock `provider.client.http`; use real `saltapp.crypto`/PGPy round trips for anything involving encryption, matching this file's existing style).
4. Keep both language implementations in step -- add the same action, with the same name and argument shape, to the TypeScript provider too.

## Network Support

EVM only (`supports_network` checks `network.protocol_family == "evm"`). The chains in `constants.py` are the subset of Salt's own chain registry that both Salt and AgentKit's wallet providers support: Ethereum, Polygon, Arbitrum One, Optimism, Base, BNB Smart Chain, Avalanche -- each with a mainnet and testnet variant. `testnet` defaults to `True` on every money action: an agent's first payment request should not default to real money.

## Known limits

These are real constraints of Salt's current API surface, not bugs in this provider -- each is asserted against, not silently guessed around:

- **No structured asset field.** Salt's TransferRequest rail records `asset: "usdc"` only as a note in the request's `message` text, never enforced on-chain. `salt_pay_request` only ever sends the chain's native currency, and refuses outright if the request's note mentions "USDC" rather than guess.
- **USDC is unavailable on `bsc`.** Circle does not issue native USDC on BNB Smart Chain -- the token commonly called "USDC" there is Binance-Peg USD Coin, a different contract with different backing. Rather than guess which one is meant, `salt_request_payment`/`salt_send_invoice` refuse `asset="usdc"` on `chain="bsc"` outright.
- **`salt_pay_request` cannot mark the request Paid.** There is currently no `salt-api` endpoint to reconcile an externally-broadcast on-chain payment against a `TransferRequest`, so Salt's own record of the request stays `Pending` after a successful `salt_pay_request` call. The action's return value says so explicitly and posts a receipt with the transaction hash into the chat as the best available substitute, so a human can see proof of payment.
- **No `GET /transfer_requests/:id`.** `salt-api` only exposes an index of requests this agent sent or received. `salt_get_payment_status` and `salt_pay_request` page that index and filter client-side rather than fetching by id directly.
- **Invoice math uses `Decimal`, exactly** -- deliberately different from the TypeScript sibling, which uses plain JS `Number` arithmetic to match Salt's own frontend convention (`salt-fe`'s amount handling is plain `Number()`, never a decimal library, by the product's own house rule). Both are correct for ordinary invoice amounts; only the Python side is guaranteed exact for adversarially chosen inputs with many decimal places. `_format_amount` strips trailing zeros the same way `salt-api`'s own `TransferRequestsController#sum_amounts` does, so "8.00" becomes "8" on the wire, never `"8.00"` or exponential notation.

## A note on `salt_ask_human`/`salt_get_answer` and concurrency

**No longer a shared-state problem at all (fixed 2026-09-26, salt-api 0.96.0).** Each iteration of `poll_for_answer`'s wait loop checks state scoped to the ask itself, never anything shared server-side across an agent's whole account:

- The tapped card FIRST, via `GET /api/v1/cards/:id` -- one card's own interaction log, matched on `action_id` AND `user_id`. Reading one card by id is idempotent and shares nothing with any other ask; two asks polling the SAME card even work correctly.
- If no tap yet, the chat since the card's own bubble, via `client.get_chat(..., last=state.message_id)` (`saltapp`'s existing public method) -- also idempotent, also shared with nothing else.

Any number of concurrent `salt_ask_human`/`salt_get_answer` calls -- for this agent, for any other agent, in the same chat, or in different chats -- can each resolve their own ask independently. This replaces the old check against the shared, per-agent `agent/updates` outbox (no longer called anywhere in this provider -- `establish_baseline_cursor`, `who_am_i`, and the HMAC envelope verification it existed for are gone along with it), which kept exactly **one** ack cursor per agent, server-side (`users.agent_updates_acked_id`), not one per caller -- and a request's `after` value lower than that stored position was silently ignored (`after=0` and omitting `after` were equivalent; the server always resolved `max(stored_ack, your_after)`). Two concurrent checks against it, or one running beside any other outbox consumer, could silently advance that one shared cursor past the other's answer and strand it forever -- the actual bug, not just a documented constraint. "One poller per agent at a time" used to be a hard requirement for embedding this provider; it no longer is, at all. Neither read has a server-side bounded wait the way the old outbox's `timeout=` parameter did, so the loop paces its own empty iterations with a real ≥1s sleep (`MIN_EMPTY_POLL_SECONDS`) instead of spinning. This is also a deliberate divergence from salt-mcp's own `ask_human`/`get_ask_result` (`salt-mcp`'s `lane/card-poll` branch), which is button-only and has no free-text fallback to worry about at all.
