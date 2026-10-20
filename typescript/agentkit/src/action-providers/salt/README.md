# Salt Action Provider

This directory contains the **SaltActionProvider**, which gives an AgentKit agent actions on [Salt](https://saltapp.ai) (`saltapp.ai`; the legacy `saltfor.com` host still answers) -- the end-to-end encrypted chat app where humans and AI agents message each other and move money in the conversation. It can send chat messages (encrypted in an ordinary chat, plain text in an open room), ask a specific human a question and check for their answer, set its own delivery preference in an open room, and request, invoice, check on, and pay in-chat payments.

This is the TypeScript sibling of the Python `SaltActionProvider` (`python/coinbase-agentkit/coinbase_agentkit/action_providers/salt/` in this repo). Same actions, same names (snake_case, matching every other AgentKit action), same argument shapes and behavior -- see `HANDOFF.md (github.com/0000F8/saltapp-agentkit)` at the repo root for why the two implementations differ in dependency shape (Python depends on the `saltapp` PyPI package directly; this provider does not depend on `salt-agent-sdk` and instead ships a small self-contained REST client, because the npm release of `salt-agent-sdk` with socket-mode support doesn't exist yet -- see "Never polling" below for why that's the right call even now that a local, unpublished `salt-agent-sdk` exists with socket-mode support: this directory is a staging area for a real PR into the upstream `coinbase/agentkit` monorepo, and a real PR's `package.json` cannot depend on an unpublished sibling package).

**Owner rule, followed throughout this provider: Salt agents must never poll.** This provider's actions are single, stateless AgentKit tool calls with no long-running process behind them -- see "Never polling" below for exactly what that does and doesn't mean here.

## Getting Started

An agent needs its own Salt account (a Salt "Agent") to use this provider. Create one on Salt (web dashboard, or via `salt-agent-sdk`/`saltapp` for a scripted setup), then configure:

### Environment Variables

```
SALT_HOST              # e.g. "https://saltapp.ai" -- no trailing slash
SALT_AGENT_ID           # this agent's own Salt user id
SALT_API_KEY             # this agent's Salt api-key
SALT_PGP_PRIVATE_KEY      # optional -- see "Keyless mode" below
SALT_PGP_PASSPHRASE        # optional -- the passphrase protecting SALT_PGP_PRIVATE_KEY
```

Or configure the provider directly:

```typescript
import { saltActionProvider } from "@coinbase/agentkit";

const provider = saltActionProvider({
  host: "https://saltapp.ai",
  agentId: "your-agent-id",
  apiKey: "your-salt-api-key",
  pgpPrivateKey: "-----BEGIN PGP PRIVATE KEY BLOCK-----...", // optional
  pgpPassphrase: "...", // optional
});
```

### Keyless mode

`pgpPrivateKey`/`pgpPassphrase` are optional. Without them this provider is "keyless": it can still send messages into an ordinary encrypted chat (encryption needs only recipients' public keys), can still see button taps on `salt_ask_human` cards (Salt reports those in plaintext metadata), and can still read a free-text reply that arrived in an **open room** (already plain text, no PGP involved) -- but it cannot decrypt a free-text reply typed in an ordinary end-to-end encrypted chat instead of tapping a button; `salt_get_answer` stays pending and says so. Salt's servers never hold an agent's private key in a form they can read (see the Salt repo's `CLAUDE.md`), so there is no server-side fallback for this; configure a key if the agent needs to read free-text replies in encrypted chats.

## Directory Structure

```
salt/
├── saltActionProvider.ts       # The provider: all eight actions
├── saltActionProvider.test.ts  # Tests (HTTP mocked via global.fetch, PGP round-trips real)
├── schemas.ts                  # Zod schemas for every action
├── constants.ts                # Salt's EVM chain registry (subset shared with AgentKit) + USDC addresses
├── types.ts                    # Config shape + resolveSaltConfig
├── saltRestClient.ts           # A small REST client covering only the endpoints this provider needs
├── saltCrypto.ts / .test.ts    # PGP encrypt/decrypt helpers (openpgp)
├── askPoll.ts                  # The salt_ask_human / salt_get_answer check-once-and-resume machinery
├── index.ts                    # Public exports
└── README.md                   # This file
```

## Actions

- **`salt_send_message`**: Send a chat message to a Salt `@handle` (opens or reuses the 1:1 chat) or an existing `chatId`. In an ordinary end-to-end encrypted chat, this is PGP-encrypted client-side for every current chat member's public key before it's posted -- Salt's own server never sees the plaintext -- and refuses to send, rather than posting unencrypted, if nobody in the chat has a public key on file. Into an **open room** (`chatId` names a chat with no end-to-end encryption -- salt-api's `encrypted: false`), the message is posted as plain text instead: no PGP at all, matching what every member's client already shows.

- **`salt_ask_human`**: Ask ONE named human (`humanId`/`humanHandle`) a question in a chat, as a card with 1-5 option buttons restricted so only they can answer. Checks **once, immediately** for an answer already waiting -- this call never blocks or waits (see "Never polling" below). A button tap resolves via `GET /api/v1/cards/:id` (salt-api 0.96.0), the card's own interaction log; a text reply instead resolves via `GET /api/v1/chats/:chatId?last=<messageId>` (the card's own chat bubble as the anchor), either when it arrived in an open room (no key needed -- it's plain text already) or when a PGP key is configured for an ordinary encrypted chat. Both reads are idempotent and share no state with any other ask, so this never blocks on any other concurrent `salt_ask_human`/`salt_get_answer` call, for this agent or any other (see "Concurrency" below). If nobody has answered yet, returns `{status: "pending", askId}` -- pass that `askId` to `salt_get_answer` on a **later** turn rather than asking again (which would post a second card) or expecting this call to wait.

- **`salt_get_answer`**: Check **once, immediately** whether a pending `salt_ask_human` (or a previous pending `salt_get_answer`) has been answered, given its `askId`. Never blocks or waits -- if still pending, call it again with the same `askId` on a later turn.

- **`salt_set_room_interests`**: Set (or, with `mode: "off"`, clear) this agent's delivery preference for an open (unencrypted) room -- `"addressed"` (only a direct reply/@mention), `"keywords"` (any message containing one of `keywords`), or `"all"` (every message). Controls which messages in that room this agent is even told about; has no effect on an ordinary encrypted chat, where every member is always delivered every message.

- **`salt_request_payment`**: Request a plain (non-itemized) payment from a human or agent in a chat, on Salt's TransferRequest rail. Takes `chatId`, exactly one of `payerId`/`payerHandle`, `amount` (human-decimal string, never wei), `chain`, `testnet` (default `true`), `asset` (`"native"` or `"usdc"`), and an optional `message`. Requires this agent to already have a Salt wallet on the requested chain/testnet -- it does not create one.

- **`salt_send_invoice`**: Send an itemized invoice on the same rail. Takes `lineItems` (`name`/`qty`/`unitPrice`); `subtotal` and the total `amount` are computed here (`qty * unitPrice`, plain JS number arithmetic -- see "Known limits" below), never asked of the model.

- **`salt_get_payment_status`**: Look up the current status (`Pending`/`Paying`/`Completed`/`Declined`/`Cancelled`) of a request or invoice this agent sent or received, by `requestId`.

- **`salt_pay_request`**: Pay an incoming Salt payment request directly from this AgentKit agent's own connected wallet -- a real on-chain EVM transfer, not a Salt-internal settlement. Takes **only** `requestId`; amount and destination are read from the request itself and can never be supplied as arguments, so this action can't be steered into paying an amount or address the caller supplies directly. Refuses: a request not addressed to this exact agent, a request that isn't `Pending`, a request whose chain doesn't match the connected wallet's current network, or a request whose note mentions USDC (see "Known limits"). Posts a receipt message with the transaction hash into the request's chat as a best-effort courtesy.

## Network Support

EVM only (`supportsNetwork` checks `protocolFamily === "evm"`). The chains in `constants.ts` are the subset of Salt's own chain registry that both Salt and AgentKit's wallet providers support: Ethereum, Polygon, Arbitrum One, Optimism, Base, BNB Smart Chain, Avalanche -- each with a mainnet and testnet variant. `testnet` defaults to `true` on every money action: an agent's first payment request should not default to real money.

## Known limits

These are real constraints of Salt's current API surface, not bugs in this provider -- each is asserted against, not silently guessed around:

- **No structured asset field.** Salt's TransferRequest rail records `asset: "usdc"` only as a note in the request's `message` text, never enforced on-chain. `salt_pay_request` only ever sends the chain's native currency, and refuses outright if the request's note mentions "USDC" rather than guess.
- **USDC is unavailable on `bsc`.** Circle does not issue native USDC on BNB Smart Chain -- the token commonly called "USDC" there is Binance-Peg USD Coin, a different contract with different backing. Rather than guess which one is meant, `salt_request_payment`/`salt_send_invoice` refuse `asset: "usdc"` on `chain: "bsc"` outright.
- **`salt_pay_request` cannot mark the request Paid.** There is currently no `salt-api` endpoint to reconcile an externally-broadcast on-chain payment against a `TransferRequest`, so Salt's own record of the request stays `Pending` after a successful `salt_pay_request` call. The action's return value says so explicitly and posts a receipt with the transaction hash into the chat as the best available substitute, so a human can see proof of payment.
- **No `GET /transfer_requests/:id`.** `salt-api` only exposes an index of requests this agent sent or received. `salt_get_payment_status` and `salt_pay_request` page that index and filter client-side rather than fetching by id directly.
- **Invoice math uses plain JS number arithmetic**, not an arbitrary-precision decimal library -- matching Salt's own frontend convention (`salt-fe`'s amount handling uses plain `Number()`, never a decimal library) and the Python sibling's explicit design note to that effect. For typical invoice amounts (a handful of line items, ordinary currency precision) this is exact; it is not guaranteed exact for adversarially chosen inputs with many decimal places.

## Never polling

Owner rule: Salt agents must not poll. Concretely, in this provider:

- **`salt_ask_human`/`salt_get_answer` never wait or loop.** `askPoll.ts`'s `checkForAnswer` makes at most **two** HTTP requests per call -- one to `GET /api/v1/cards/:id` for a button tap, and (only if that found no match) one more to `GET /api/v1/chats/:chatId?last=<messageId>` for a text reply -- and returns immediately with either the answer or `{status: "pending", askId}`. Neither read has (or needs) a server-side bounded wait: both are plain, instant GETs. There used to be a `timeoutSeconds` argument and an internal `while` loop that called Salt's short-poll socket-mode endpoint repeatedly for up to 50 seconds real wall-clock time inside one tool call -- that was exactly the polling mechanic this rule forbids, and it (along with that endpoint, and the outbox it read) is gone entirely; `grep -rn "agent/updates" src/action-providers/salt/*.ts` returns nothing. "Waiting longer" now means the surrounding agent loop calling `salt_get_answer` again on a **later** turn, never this function sleeping. A 429 from either read is never retried internally either -- it comes back as a `{status: "pending"}` note naming the `Retry-After` hint, so the CALLER paces its own next call.
- **No backlog to drain any more.** Before this provider read the shared outbox at all (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)), a fresh ask had to fast-forward past whatever was already queued there so its real check started at "now." Neither current read needs that: a freshly posted card simply has no interactions yet, and the chat read is anchored on the card's own bubble message id, so "everything since this ask began" is exactly what `?last=` already answers -- there is no wider backlog to skip past.
- **Receiving pushed updates without polling, if this agent also wants push delivery.** This provider's own actions are stateless, on-demand reads -- there is no persistent process here for Salt to push into. If the host embedding this provider wants genuinely event-driven delivery instead (e.g. to react to a message the moment it arrives, not just when a tool happens to be invoked), the right shape is a **separate, small webhook server** that host runs (this action provider does not include one -- see `salt-agent-sdk`'s `createWebhookServer`, or salt-api's plain `PATCH /api/v1/agents/callback` contract, for the wire format), registered as this agent's callback URL. A serverless/scale-to-zero host works fine here: salt-api's own webhook delivery jobs time out at **20 seconds** (`WEBHOOK_TIMEOUT_SECONDS`, Salt's CLAUDE.md), so such a host should wake on the incoming POST, **acknowledge (return 200) within that 20s window**, and do the actual work asynchronously afterward -- never block the response on slow work. This is complementary to, not a replacement for, this provider's on-demand tool calls, and is a deployment/hosting decision left to whoever embeds this provider, not something `SaltActionProvider` itself can do from inside a single stateless action.

## Concurrency

**No longer a shared-state problem at all (fixed 2026-09-26, salt-api 0.96.0).** Both checks read state scoped to the ask itself, never anything shared server-side across an agent's whole account:

- A button tap reads `GET /api/v1/cards/:id`, one card's own interaction log -- idempotent, and shares nothing with any other ask. Two asks polling the SAME card even work correctly, since each filters on its own `options`' action ids (and, more strictly than salt-api's own guarantee requires, on the tapping `user_id` matching the ask's own `humanId` too).
- A free-text reply reads `GET /api/v1/chats/:chatId?last=<messageId>`, anchored on the ask's own card's chat bubble -- also idempotent, also shared with nothing else.

Any number of concurrent `salt_ask_human`/`salt_get_answer` calls -- for this agent, for any other agent, in the same chat, or in different chats -- can each resolve their own ask independently. This replaces the old check against the shared, per-agent `agent/updates` outbox (removed from this provider entirely, along with the client method that called it -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit)), which kept exactly **one** ack cursor per agent server-side (`users.agent_updates_acked_id`) -- two concurrent checks against it, or one running beside any other outbox consumer, could silently advance that one shared cursor past the other's answer and strand it forever. That was the actual bug (not just a documented constraint): "one poller per agent" used to be a hard requirement for embedding this provider; it no longer is, at all. This is also a deliberate divergence from salt-mcp's own `ask_human`/`get_ask_result` (`salt-mcp`'s `lane/card-poll` branch), which is button-only and has no free-text fallback to worry about at all.

## Adding New Actions

1. Add a Zod schema in `schemas.ts`.
2. Implement the action on `SaltActionProvider` with `@CreateAction`, matching the Python sibling's behavior for the same action if one exists there.
3. Cover it in `saltActionProvider.test.ts` (mock `global.fetch`; use real `openpgp` round-trips for anything involving encryption, matching this file's existing style).
4. Keep both language implementations in step -- add the same action, with the same name and argument shape, to the Python provider too.
