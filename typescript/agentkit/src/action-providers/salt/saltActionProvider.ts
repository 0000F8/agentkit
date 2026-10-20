import { z } from "zod";
import { randomBytes } from "node:crypto";
import { parseUnits, type Hex } from "viem";
import { ActionProvider } from "../actionProvider";
import { CreateAction } from "../actionDecorator";
import { Network } from "../../network";
import { EvmWalletProvider } from "../../wallet-providers";
import {
  SaltAskHumanSchema,
  SaltGetAnswerSchema,
  SaltGetPaymentStatusSchema,
  SaltPayRequestSchema,
  SaltRequestPaymentSchema,
  SaltSendInvoiceSchema,
  SaltSendMessageSchema,
  SaltSetRoomInterestsSchema,
} from "./schemas";
import {
  createSaltRestClient,
  SaltApiError,
  SaltRestClient,
  SaltTransferRequest,
  SaltUser,
} from "./saltRestClient";
import { decrypt, encryptFor } from "./saltCrypto";
import { resolveSaltConfig, ResolvedSaltConfig, SaltActionProviderConfig } from "./types";
import { decodeAskId, checkForAnswer, type AskOutcome } from "./askPoll";
import { NATIVE_DECIMALS, SALT_CHAINS, saltChainForEvmChainId, SaltChainKey } from "./constants";

const sameId = (a: unknown, b: unknown): boolean =>
  String(a).toLowerCase() === String(b).toLowerCase();

/**
 * SaltActionProvider connects an AgentKit agent to Salt (saltapp.ai), the
 * end-to-end encrypted chat app where humans and AI agents message each
 * other and move money in the conversation. Every action here talks to
 * Salt's own REST API; only salt_pay_request also touches the AgentKit
 * wallet provider, to send a real on-chain payment.
 *
 * See this folder's README.md for setup (host/agentId/apiKey, the optional
 * PGP key) and the current limits of each action.
 */
export class SaltActionProvider extends ActionProvider<EvmWalletProvider> {
  private readonly config: ResolvedSaltConfig;
  private readonly client: SaltRestClient;

  /**
   * Creates the provider and its Salt REST client from the resolved configuration.
   *
   * @param config - The provider configuration.
   */
  constructor(config: SaltActionProviderConfig = {}) {
    super("salt", []);
    this.config = resolveSaltConfig(config);
    this.client = createSaltRestClient({ host: this.config.host });
  }

  // --- salt_send_message ---------------------------------------------

  /**
   * Sends a message to a Salt chat or @handle.
   *
   * @param args - The validated action arguments.
   *
   * @returns A message describing the result or the error.
   */
  @CreateAction({
    name: "salt_send_message",
    description: `
Send a chat message on Salt (saltapp.ai) to a Salt @handle or an existing chat.

It takes:
- Exactly one of chatId (an existing Salt chat) or handle (a Salt @handle -- opens or reuses the 1:1 chat with them)
- message: the plaintext to send

The message is PGP-encrypted client-side for every current member of an ordinary end-to-end encrypted chat
before it is posted -- Salt's own server never sees the plaintext there. If nobody in the chat has a public
key on file, this refuses to send rather than posting anything unencrypted. Into an OPEN room (no end-to-end
encryption, salt-api's \`encrypted: false\`), the message is posted as plain text instead -- no PGP at all,
matching what every member's client already shows.
`,
    schema: SaltSendMessageSchema,
  })
  async salt_send_message(args: z.infer<typeof SaltSendMessageSchema>): Promise<string> {
    try {
      let chatId = args.chatId;
      if (!chatId) {
        const user = await this.client.getUserByHandle(args.handle!);
        if (!user) return `Error: no Salt user found for handle "${args.handle}".`;
        const chat = await this.client.createOrGetChat(this.config.apiKey, user.id);
        chatId = chat.id;
      }

      const sent = await this.sendSmart(chatId!, args.message, { mentions: args.mentions });
      return sent.plain
        ? `Sent as plain text into the open room, chat ${chatId}. Message id: ${sent.id}.`
        : `Sent, encrypted for ${sent.recipientCount} member(s), in chat ${chatId}. Message id: ${sent.id}.`;
    } catch (err) {
      return `Error sending Salt message: ${describeError(err)}`;
    }
  }

  // --- salt_ask_human / salt_get_answer --------------------------------

  /**
   * Asks a named human a question on Salt as a card with option buttons.
   *
   * @param args - The validated action arguments.
   *
   * @returns The askId and instructions, or an error message.
   */
  @CreateAction({
    name: "salt_ask_human",
    description: `
Ask ONE named human a question on Salt, as a card with option buttons restricted so only they can answer.

It takes:
- chatId: the Salt chat this agent and the human are both already in
- Exactly one of humanId or humanHandle: the ONE person allowed to answer
- question: the question text
- options: 1-5 button labels, e.g. ["Yes", "No"] or ["Approve", "Reject", "Ask me later"]

Checks ONCE, immediately, for an answer -- this action never waits or blocks inside the call (Salt agents must
not poll). If an answer is already sitting there, returns it directly. Otherwise returns {status: "pending",
askId} -- call salt_get_answer with that askId on a LATER turn to check again, rather than calling this again
(which would post a second, separate card) or expecting this call itself to wait.
`,
    schema: SaltAskHumanSchema,
  })
  async salt_ask_human(args: z.infer<typeof SaltAskHumanSchema>): Promise<string> {
    try {
      const humanId = await this.resolveUserId(args.humanId, args.humanHandle);

      const optionLabels: Record<string, string> = {};
      const buttons = args.options.map((label, i) => {
        const actionId = `salt_ask_${i}_${randomBytes(4).toString("hex")}`;
        optionLabels[actionId] = label;
        return { type: "button", action_id: actionId, label, restricted_to: [humanId] };
      });
      const blocks = [
        { type: "section", text: args.question },
        { type: "actions", elements: buttons },
        { type: "section", text: "Or just reply with your own answer." },
      ];
      // The response is the card's chat BUBBLE, not the card itself -- see
      // saltRestClient.ts#postCard's doc comment. `resource_id` is the
      // card's own id (what `getCard`/markCardAnswered poll and PATCH);
      // `message_id` is the bubble's own id, the fixed anchor the
      // free-text-reply check reads the chat from.
      const card = await this.client.postCard(
        this.config.apiKey,
        args.chatId,
        blocks,
        args.question,
      );
      const cardId = card.resource_id ?? card.resource?.id;
      if (!cardId)
        throw new Error("Salt didn't return this card's id -- can't poll it for an answer.");
      const messageId = card.message_id ?? null;

      const outcome = await checkForAnswer(
        this.client,
        this.config.apiKey,
        {
          v: 1,
          chatId: args.chatId,
          cardId,
          humanId,
          options: optionLabels,
          after: null,
          messageId,
        },
        {
          canDecrypt: Boolean(this.config.pgpPrivateKey),
          decryptOne: armored =>
            decrypt(armored, this.config.pgpPrivateKey!, this.config.pgpPassphrase ?? ""),
        },
      );

      if (outcome.status === "answered") {
        await this.markCardAnswered(cardId, args.question, outcome.answer);
        return `Answered (${describeOutcome(outcome)}): ${outcome.answer}${transferNote(outcome)}`;
      }
      return `Pending -- no answer yet. Call salt_get_answer with askId "${outcome.askId}" on a later turn to check again.${outcome.note ? ` Note: ${outcome.note}` : ""}`;
    } catch (err) {
      return `Error asking human on Salt: ${describeError(err)}`;
    }
  }

  /**
   * Checks once whether an earlier question has been answered.
   *
   * @param args - The validated action arguments.
   *
   * @returns The answer, a pending notice, or an error message.
   */
  @CreateAction({
    name: "salt_get_answer",
    description: `
Check ONCE, immediately, whether a pending salt_ask_human question has been answered -- this action never
waits or blocks inside the call (Salt agents must not poll). Takes the askId a pending salt_ask_human (or a
previous pending salt_get_answer) returned. If still pending, call this again with the same askId on a LATER
turn.
`,
    schema: SaltGetAnswerSchema,
  })
  async salt_get_answer(args: z.infer<typeof SaltGetAnswerSchema>): Promise<string> {
    try {
      const state = decodeAskId(args.askId);
      const outcome = await checkForAnswer(this.client, this.config.apiKey, state, {
        canDecrypt: Boolean(this.config.pgpPrivateKey),
        decryptOne: armored =>
          decrypt(armored, this.config.pgpPrivateKey!, this.config.pgpPassphrase ?? ""),
      });
      if (outcome.status === "answered") {
        if (state.cardId) await this.markCardAnswered(state.cardId, undefined, outcome.answer);
        return `Answered (${describeOutcome(outcome)}): ${outcome.answer}${transferNote(outcome)}`;
      }
      return `Still pending -- no answer yet. Call salt_get_answer with askId "${outcome.askId}" on a later turn to check again.${outcome.note ? ` Note: ${outcome.note}` : ""}`;
    } catch (err) {
      return `Error checking Salt answer: ${describeError(err)}`;
    }
  }

  // --- salt_set_room_interests (open rooms) -----------------------------

  /**
   * Sets which messages in a chat are delivered to this agent.
   *
   * @param args - The validated action arguments.
   *
   * @returns A message describing the result or the error.
   */
  @CreateAction({
    name: "salt_set_room_interests",
    description: `
Set (or clear) this agent's delivery preference for an open (unencrypted) Salt room -- controls which
messages in that room this agent is even told about (relevant to this provider's own on-demand reads, e.g.
salt_ask_human/salt_get_answer, and to any push delivery a separately-run webhook host receives for this
agent -- see the provider README's "Receiving pushed updates without polling" section).

It takes chatId and mode:
- "addressed": only deliver a message that's a direct reply or @mention of this agent
- "keywords": deliver any message containing one of \`keywords\` (required in that case)
- "all": deliver every message in the room
- "off": clear the subscription -- Salt's default applies again

Has no effect on an ordinary end-to-end encrypted chat, where every member is always delivered every message
regardless of any subscription.
`,
    schema: SaltSetRoomInterestsSchema,
  })
  async salt_set_room_interests(args: z.infer<typeof SaltSetRoomInterestsSchema>): Promise<string> {
    try {
      if (args.mode === "off") {
        await this.client.clearChatSubscription(this.config.apiKey, args.chatId);
        return `Cleared this agent's delivery preference for chat ${args.chatId} -- Salt's default applies again.`;
      }
      await this.client.setChatSubscription(this.config.apiKey, args.chatId, {
        mode: args.mode,
        keywords: args.keywords,
      });
      const keywordsNote =
        args.mode === "keywords" && args.keywords?.length
          ? ` (keywords: ${args.keywords.join(", ")})`
          : "";
      return `Set this agent's delivery preference for chat ${args.chatId} to "${args.mode}"${keywordsNote}.`;
    } catch (err) {
      return `Error setting Salt room interests: ${describeError(err)}`;
    }
  }

  /**
   * Sends a payment request in a Salt chat.
   *
   * @param args - The validated action arguments.
   *
   * @returns A message describing the result or the error.
   */
  @CreateAction({
    name: "salt_request_payment",
    description: `
Request a plain (non-itemized) payment from a human or agent in a Salt chat, on Salt's TransferRequest rail.

It takes chatId, exactly one of payerId/payerHandle, amount (human-decimal string), chain (one of ethereum,
polygon, arbitrum, optimism, base, bsc, avalanche -- chains both AgentKit and Salt support), testnet (default
true), asset ("native" or "usdc", default "native"), and an optional message.

Requires this agent to already have a Salt wallet on the requested chain/testnet -- it does not create one.
`,
    schema: SaltRequestPaymentSchema,
  })
  async salt_request_payment(args: z.infer<typeof SaltRequestPaymentSchema>): Promise<string> {
    try {
      const note = this.assetNote(args.asset, args.chain as SaltChainKey);
      const payerId = await this.resolveUserId(args.payerId, args.payerHandle);
      const wallet = await this.pickWallet(args.chain as SaltChainKey, args.testnet);
      const request = await this.client.requestPayment(this.config.apiKey, {
        chatId: args.chatId,
        receiverId: payerId,
        walletId: wallet.id,
        amount: args.amount,
        message: `${args.message ?? ""}${note}`.trim() || undefined,
      });
      return `Requested ${args.amount} ${wallet.name_3 ?? SALT_CHAINS[args.chain as SaltChainKey].displayName}${note} from ${payerId} in chat ${args.chatId}. Request id: ${request.id}, status: ${request.status}.`;
    } catch (err) {
      return `Error requesting payment on Salt: ${describeError(err)}`;
    }
  }

  /**
   * Sends an itemized invoice in a Salt chat.
   *
   * @param args - The validated action arguments.
   *
   * @returns A message describing the result or the error.
   */
  @CreateAction({
    name: "salt_send_invoice",
    description: `
Send an itemized invoice to a human or agent in a Salt chat, on the same TransferRequest rail as
salt_request_payment. It takes chatId, exactly one of payerId/payerHandle, lineItems (name/qty/unitPrice --
subtotal and the total amount are computed here, not asked of you), chain, testnet (default true), asset
("native" or "usdc"), an optional message, and an optional ISO-8601 dueAt.
`,
    schema: SaltSendInvoiceSchema,
  })
  async salt_send_invoice(args: z.infer<typeof SaltSendInvoiceSchema>): Promise<string> {
    try {
      const note = this.assetNote(args.asset, args.chain as SaltChainKey);
      const payerId = await this.resolveUserId(args.payerId, args.payerHandle);
      const wallet = await this.pickWallet(args.chain as SaltChainKey, args.testnet);

      let total = 0;
      const lineItems = args.lineItems.map(item => {
        const subtotal = item.qty * Number(item.unitPrice);
        total += subtotal;
        return {
          name: item.name,
          qty: item.qty,
          unit_price: item.unitPrice,
          subtotal: subtotal.toString(),
        };
      });

      const request = await this.client.createInvoice(this.config.apiKey, {
        chatId: args.chatId,
        receiverId: payerId,
        walletId: wallet.id,
        amount: total.toString(),
        lineItems,
        message: `${args.message ?? ""}${note}`.trim() || undefined,
        dueAt: args.dueAt,
      });
      return `Sent an invoice for ${total} ${wallet.name_3 ?? ""}${note} (${lineItems.length} item(s)) to ${payerId} in chat ${args.chatId}. Invoice id: ${request.id}, status: ${request.status}.`;
    } catch (err) {
      return `Error sending invoice on Salt: ${describeError(err)}`;
    }
  }

  /**
   * Reports the status of a payment request or invoice.
   *
   * @param args - The validated action arguments.
   *
   * @returns A message describing the status or the error.
   */
  @CreateAction({
    name: "salt_get_payment_status",
    description: `
Look up the current status of a Salt payment request or invoice this agent sent or received.
Takes requestId (the id returned by salt_request_payment / salt_send_invoice, or seen in a chat/webhook).
Status is one of Pending, Paying, Completed, Declined, Cancelled.
`,
    schema: SaltGetPaymentStatusSchema,
  })
  async salt_get_payment_status(args: z.infer<typeof SaltGetPaymentStatusSchema>): Promise<string> {
    try {
      const request = await this.findTransferRequest(args.requestId);
      if (!request)
        return `No such payment request/invoice (or this agent isn't party to it): ${args.requestId}.`;
      const failure = request.last_failed_reason
        ? ` Last attempt failed: ${request.last_failed_reason}.`
        : "";
      return `Request ${request.id}: ${request.status}, amount ${request.amount}${request.wallet ? ` ${request.wallet.name_3 ?? ""}` : ""}.${failure}`;
    } catch (err) {
      return `Error checking Salt payment status: ${describeError(err)}`;
    }
  }

  /**
   * Pays a Salt payment request from the connected wallet.
   *
   * @param walletProvider - The connected EVM wallet provider.
   * @param args - The validated action arguments.
   *
   * @returns A message describing the result or the error.
   */
  @CreateAction({
    name: "salt_pay_request",
    description: `
Pay an incoming Salt payment request directly from this AgentKit agent's own wallet -- a real on-chain EVM
transfer, sent and broadcast by the connected wallet provider, not by Salt's own wallet system.

Takes ONLY requestId. Amount and destination address are read from the request itself and are never taken
from arguments here, so this action can't be steered into paying an amount or address you supply directly.

Refuses to pay: a request not addressed to this exact agent, a request that isn't Pending, a request whose
chain doesn't match the currently connected wallet's network, or a request that looks like it wants USDC (see
the provider README -- Salt's request rail has no structured asset field, so this only pays native currency).

Important: Salt's own record of this request will still show "Pending" afterward -- there is currently no
salt-api endpoint to reconcile an externally-broadcast payment against a TransferRequest (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)).
This action posts a receipt message with the transaction hash into the request's chat as the best available
substitute, so a human can see proof of payment and settle the request's status themselves for now.
`,
    schema: SaltPayRequestSchema,
  })
  async salt_pay_request(
    walletProvider: EvmWalletProvider,
    args: z.infer<typeof SaltPayRequestSchema>,
  ): Promise<string> {
    try {
      const request = await this.findTransferRequest(args.requestId);
      if (!request)
        return `No such payment request (or this agent isn't party to it): ${args.requestId}.`;
      if (!sameId(request.receiver_id, this.config.agentId)) {
        return `Error: request ${args.requestId} is not addressed to this agent (receiver_id ${request.receiver_id}). Refusing to pay someone else's request.`;
      }
      if (request.status !== "Pending") {
        return `Error: request ${args.requestId} is ${request.status}, not Pending. Nothing to pay.`;
      }
      if (!request.wallet) {
        return `Error: request ${args.requestId} has no receiving wallet on file.`;
      }
      if (/\busdc\b/i.test(request.message ?? "")) {
        return (
          `Error: request ${args.requestId}'s note mentions USDC, but Salt's TransferRequest rail has no structured ` +
          `asset field for this action to trust, and this action only ever sends the chain's native currency. ` +
          `Refusing to guess -- pay it manually, or ask the requester to confirm before retrying.`
        );
      }

      const network = walletProvider.getNetwork();
      const chainId = Number(network.chainId);
      const resolved = saltChainForEvmChainId(chainId);
      if (
        !resolved ||
        resolved.chain !== request.wallet.chain ||
        resolved.testnet !== Boolean(request.wallet.testnet)
      ) {
        return (
          `Error: this wallet is connected to chain id ${network.chainId}, but request ${args.requestId} is on ` +
          `${request.wallet.chain} (${request.wallet.testnet ? "testnet" : "mainnet"}). Switch the wallet provider's ` +
          `network and retry.`
        );
      }

      const value = parseUnits(String(request.amount), NATIVE_DECIMALS);
      const hash = await walletProvider.sendTransaction({
        to: request.wallet.public_address as Hex,
        value,
      });
      await walletProvider.waitForTransactionReceipt(hash);

      let receiptNote = "";
      if (request.chat_id) {
        try {
          // sendSmart posts plain into an open room or encrypted otherwise
          // (and throws when an ordinary chat has nobody with a known
          // key) -- either way this try/catch is best-effort: the payment
          // itself already happened, so a failed/skipped receipt post
          // shouldn't look like a failed payment.
          await this.sendSmart(
            request.chat_id,
            `Paid this request on-chain. Transaction hash: ${hash}`,
          );
          receiptNote = " Posted a receipt with the tx hash into the request's chat.";
        } catch {
          // best-effort: see above
        }
      }

      return (
        `Paid ${request.amount} ${request.wallet.name_3 ?? ""} to ${request.wallet.public_address} for request ${args.requestId}. ` +
        `Transaction hash: ${hash}.${receiptNote} Note: Salt's own request status will still read "Pending" until a ` +
        `human reconciles it or salt-api adds a way to report an externally-broadcast payment (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)).`
      );
    } catch (err) {
      return `Error paying Salt request: ${describeError(err)}`;
    }
  }

  /**
   * Checks whether this provider supports a network.
   *
   * @param network - The network to check.
   * @returns True for EVM networks.
   */
  supportsNetwork = (network: Network): boolean => network.protocolFamily === "evm";

  /**
   * Resolves a Salt user id from an explicit id or a handle.
   *
   * @param explicitId - A Salt user id, when the caller gave one.
   * @param handle - A Salt @handle.
   *
   * @returns The Salt user id.
   */
  private async resolveUserId(
    explicitId: string | undefined,
    handle: string | undefined,
  ): Promise<string> {
    if (explicitId) return explicitId;
    const user = await this.client.getUserByHandle(handle!);
    if (!user) throw new Error(`No Salt user found for handle "${handle}".`);
    return user.id;
  }

  /**
   * The one path every plain-text send in this provider goes through
   * (`salt_send_message`, and the on-chain payment receipt
   * `salt_pay_request` posts). Reads the chat's `session.encrypted` flag
   * (`client.getChat`) and posts PLAIN into an open room -- no PGP
   * attempted, matching what the human's own client will show -- or
   * PGP-encrypted for every current member's key otherwise. Throws (never
   * silently posts unencrypted) when an ordinary chat has no member with a
   * known public key.
   *
   * @param chatId - The Salt chat id.
   * @param text - The message text to send.
   * @param opts - Optional settings.
   * @param opts.mentions - User ids to mention.
   *
   * @returns The posted message id, whether it was plain text, and how many recipients it was encrypted for.
   */
  private async sendSmart(
    chatId: string,
    text: string,
    opts?: { mentions?: string[] },
  ): Promise<{ id: string; plain: boolean; recipientCount: number }> {
    const chat = await this.client.getChat(this.config.apiKey, chatId);
    const members: SaltUser[] = chat.session?.users ?? [];

    if (chat.session?.encrypted === false) {
      const posted = await this.client.postMessage(this.config.apiKey, chatId, text, {
        mentions: opts?.mentions,
      });
      return { id: posted.id, plain: true, recipientCount: members.length };
    }

    const recipientKeys = members
      .filter(m => typeof m.public_key === "string" && m.public_key)
      .map(m => m.public_key as string);
    if (recipientKeys.length === 0) {
      throw new Error(
        `no member of chat ${chatId} has a public key on file. Refusing to send unencrypted.`,
      );
    }
    const ciphertext = await encryptFor(text, recipientKeys);
    const self = members.find(m => sameId(m.id, this.config.agentId));
    const senderMessage = self?.public_key ? await encryptFor(text, [self.public_key]) : undefined;
    const posted = await this.client.postMessage(this.config.apiKey, chatId, ciphertext, {
      senderMessage,
      mentions: opts?.mentions,
    });
    return { id: posted.id, plain: false, recipientCount: recipientKeys.length };
  }

  /**
   * Updates a card to show the recorded answer, ignoring failures.
   *
   * @param cardId - The Salt card id.
   * @param question - The question text shown on the card.
   * @param answer - The answer text that was received.
   */
  private async markCardAnswered(
    cardId: string,
    question: string | undefined,
    answer: string,
  ): Promise<void> {
    try {
      const blocks = question
        ? [
            { type: "section", text: question },
            { type: "section", text: `Answered: ${answer}` },
          ]
        : [{ type: "section", text: `Answered: ${answer}` }];
      await this.client.updateCard(this.config.apiKey, cardId, blocks);
    } catch {
      // best-effort: the answer itself is already resolved either way
    }
  }

  // --- money: request / invoice / status / pay -------------------------

  /**
   * Finds this agent's Salt wallet for a chain and network.
   *
   * @param chain - The Salt chain key.
   * @param testnet - Whether to use the testnet wallet.
   *
   * @returns The matching Salt wallet.
   */
  private async pickWallet(chain: SaltChainKey, testnet: boolean) {
    const wallets = await this.client.listWallets(this.config.apiKey);
    const cfg = SALT_CHAINS[chain];
    const wallet = wallets.find(w => w.chain === cfg.name_3 && Boolean(w.testnet) === testnet);
    if (!wallet) {
      throw new Error(
        `This agent has no Salt wallet on ${cfg.displayName} (${testnet ? "testnet" : "mainnet"}). ` +
          `Create one for this agent on Salt first (POST /api/v1/wallets, or via the agent's own dashboard), then retry.`,
      );
    }
    return wallet;
  }

  /**
   * Describes how the chosen asset is handled on a chain.
   *
   * @param asset - The asset to use, either the chain native asset or USDC.
   * @param chain - The Salt chain key.
   *
   * @returns A short note for the model.
   */
  private assetNote(asset: "native" | "usdc", chain: SaltChainKey): string {
    if (asset !== "usdc") return "";
    if (chain === "bsc") {
      throw new Error(
        "USDC isn't offered on bsc here: Circle doesn't issue native USDC on BNB Smart Chain, only a separate " +
          "Binance-Peg token, and guessing which one you mean is not a safe default for a payment request. Use native BNB, " +
          "or a chain where Circle-native USDC exists.",
      );
    }
    return " (USDC -- note: Salt's payment-request rail has no structured asset field yet; this is a note for the human, not something Salt enforces on-chain)";
  }

  /**
   * salt-api has no `GET /transfer_requests/:id` today (see saltRestClient.ts) --
   * only index is wired up, scoped to requests this agent sent or received.
   * Looking one up by id means paging that index and filtering client-side.
   *
   * @param requestId - The Salt transfer request id.
   *
   * @returns The matching transfer request, or undefined if none matches.
   */
  private async findTransferRequest(requestId: string): Promise<SaltTransferRequest | undefined> {
    const requests = await this.client.listTransferRequests(this.config.apiKey);
    return requests.find(r => sameId(r.id, requestId));
  }
}

/**
 * Turns a caught error into a message string.
 *
 * @param err - The caught error.
 *
 * @returns The error message.
 */
function describeError(err: unknown): string {
  if (err instanceof SaltApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Renders an answered AskOutcome's `via` for the model, naming an
 * open-room (plain-text) answer explicitly -- `encrypted` only exists on
 * a `via: "message"` outcome (see askPoll.ts's AskOutcome).
 *
 * @param outcome - The answered outcome.
 *
 * @returns "button", "message" or "message, open room".
 */
function describeOutcome(outcome: Extract<AskOutcome, { status: "answered" }>): string {
  if (outcome.via === "button") return "button";
  return outcome.encrypted === false ? "message, open room" : "message";
}

/**
 * A button tap's `transferRequestId`/`transferRequestStatus` (see
 * askPoll.ts's AskOutcome) are dead weight for THIS provider today --
 * salt_ask_human's own buttons are never `type: "pay"` -- but cost
 * nothing to surface when a future card type populates them.
 *
 * @param outcome - The answered outcome.
 *
 * @returns A note about an attached payment request, or an empty string.
 */
function transferNote(outcome: Extract<AskOutcome, { status: "answered" }>): string {
  if (outcome.via !== "button" || !outcome.transferRequestId) return "";
  return ` (this tap also carries a payment request: ${outcome.transferRequestId}, status ${outcome.transferRequestStatus}.)`;
}

export const saltActionProvider = (config?: SaltActionProviderConfig) =>
  new SaltActionProvider(config);
