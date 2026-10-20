import { z } from "zod";
import { SALT_CHAIN_KEYS } from "./constants";

const CHAIN_ENUM = z
  .enum(SALT_CHAIN_KEYS as [string, ...string[]])
  .describe(
    "The chain, using Salt's own chain names: ethereum, polygon, arbitrum, optimism, base, bsc, avalanche",
  );

/** Exactly one of chatId/handle -- salt_send_message can target an existing chat or a Salt handle it will open/reuse a 1:1 with. */
export const SaltSendMessageSchema = z
  .object({
    chatId: z.string().optional().describe("An existing Salt chat id to post into"),
    handle: z
      .string()
      .optional()
      .describe("A Salt @handle to message 1:1 (creates or reuses the 1:1 chat)"),
    message: z
      .string()
      .min(1)
      .describe(
        "The plaintext to send. Encrypted client-side for every chat member's public key before it is posted -- Salt's server never sees plaintext.",
      ),
    mentions: z
      .array(z.string())
      .optional()
      .describe(
        "User ids to @-mention (drives their mention notification; Salt cannot infer this from ciphertext)",
      ),
  })
  .refine(v => Boolean(v.chatId) !== Boolean(v.handle), {
    message: "Provide exactly one of chatId or handle, not both and not neither.",
  })
  .describe("Send an end-to-end encrypted message to a Salt handle or an existing chat");

export const SaltAskHumanSchema = z
  .object({
    chatId: z.string().describe("The Salt chat both this agent and the human are already in"),
    humanId: z.string().optional().describe("The Salt user id of the ONE human allowed to answer"),
    humanHandle: z
      .string()
      .optional()
      .describe("The Salt @handle of the ONE human allowed to answer, if the id isn't known"),
    question: z.string().min(1).describe("The question to ask"),
    options: z
      .array(z.string().min(1))
      .min(1)
      .max(5)
      .describe(
        'Button labels the human can tap, e.g. ["Yes", "No"] or ["Approve", "Reject", "Ask me later"]',
      ),
  })
  .refine(v => Boolean(v.humanId) !== Boolean(v.humanHandle), {
    message: "Provide exactly one of humanId or humanHandle, not both and not neither.",
  })
  .describe(
    "Ask a specific human a question as a card with option buttons, restricted so only they can answer. " +
      "Checks ONCE, immediately, for an answer already waiting -- this never blocks or waits inside the call " +
      '(Salt agents must not poll). If nobody has answered yet, returns {status: "pending", askId} -- call ' +
      "salt_get_answer with that askId on a later turn to check again, rather than calling this again (which would " +
      "post a second, separate card) or waiting here.",
  );

export const SaltGetAnswerSchema = z
  .object({
    askId: z
      .string()
      .min(1)
      .describe(
        "The askId returned by a pending salt_ask_human (or a previous pending salt_get_answer) call",
      ),
  })
  .describe(
    "Check ONCE, immediately, whether a pending salt_ask_human question has been answered yet -- this never blocks " +
      "or waits inside the call. If still pending, call this again with the returned askId on a later turn.",
  );

export const SaltSetRoomInterestsSchema = z
  .object({
    chatId: z
      .string()
      .describe("The chat (an open, unencrypted room) to set this agent's delivery preference for"),
    mode: z
      .enum(["addressed", "keywords", "all", "off"])
      .describe(
        '"addressed": only deliver a message that\'s a direct reply or @mention of this agent. "keywords": deliver any message ' +
          'containing one of `keywords`. "all": deliver every message in the room. "off": clear the subscription -- Salt\'s default applies again.',
      ),
    keywords: z
      .array(z.string().min(1))
      .optional()
      .describe('Required when mode is "keywords" -- ignored otherwise.'),
  })
  .refine(v => v.mode !== "keywords" || (v.keywords && v.keywords.length > 0), {
    message: 'keywords is required (and non-empty) when mode is "keywords".',
  })
  .describe(
    'Set (or, with mode "off", clear) this agent\'s delivery preference for an open (unencrypted) room -- controls ' +
      "which messages in that room this agent is even told about. Has no effect on an ordinary end-to-end encrypted " +
      "chat, where every member is always delivered every message.",
  );

const AssetEnum = z
  .enum(["native", "usdc"])
  .default("native")
  .describe(
    '"native" = the chain\'s own gas token (ETH/MATIC/BNB/AVAX); "usdc" = Circle-issued USDC, where Salt/AgentKit\'s shared chains issue it. ' +
      "Not available on bsc (see the provider README). Salt's payment-request rail has no structured asset field -- " +
      "this is recorded only as a note in the request's message text for the human to read, never enforced on-chain by Salt itself.",
  );

export const SaltRequestPaymentSchema = z
  .object({
    chatId: z.string().describe("The chat to post the request into"),
    payerId: z.string().optional().describe("The Salt user id being asked to pay"),
    payerHandle: z
      .string()
      .optional()
      .describe("The Salt @handle being asked to pay, if the id isn't known"),
    amount: z
      .string()
      .min(1)
      .describe('A human-decimal amount, e.g. "12.50" -- never base units (wei)'),
    chain: CHAIN_ENUM,
    testnet: z
      .boolean()
      .default(true)
      .describe(
        "true for the chain's testnet, false for mainnet. Defaults to testnet -- an agent's first payment request should not default to real money.",
      ),
    asset: AssetEnum,
    message: z.string().optional().describe("A note shown on the request bubble"),
  })
  .refine(v => Boolean(v.payerId) !== Boolean(v.payerHandle), {
    message: "Provide exactly one of payerId or payerHandle, not both and not neither.",
  })
  .describe(
    "Request a plain (non-itemized) payment from a human or agent in a chat, on the TransferRequest rail",
  );

const InvoiceLineItemSchema = z.object({
  name: z.string().min(1).describe("Line item description"),
  qty: z.number().positive().describe("Quantity"),
  unitPrice: z.string().min(1).describe('Human-decimal unit price, e.g. "4.99"'),
});

export const SaltSendInvoiceSchema = z
  .object({
    chatId: z.string().describe("The chat to post the invoice into"),
    payerId: z.string().optional().describe("The Salt user id being invoiced"),
    payerHandle: z
      .string()
      .optional()
      .describe("The Salt @handle being invoiced, if the id isn't known"),
    lineItems: z
      .array(InvoiceLineItemSchema)
      .min(1)
      .describe(
        "Itemized charges. subtotal = qty * unitPrice is computed here, not asked of the model.",
      ),
    chain: CHAIN_ENUM,
    testnet: z.boolean().default(true),
    asset: AssetEnum,
    message: z.string().optional().describe("A note shown on the invoice bubble"),
    dueAt: z.string().optional().describe("ISO 8601 due date"),
  })
  .refine(v => Boolean(v.payerId) !== Boolean(v.payerHandle), {
    message: "Provide exactly one of payerId or payerHandle, not both and not neither.",
  })
  .describe(
    "Send an itemized invoice to a human or agent in a chat, on the same TransferRequest rail as salt_request_payment",
  );

export const SaltGetPaymentStatusSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .describe("The TransferRequest id returned by salt_request_payment or salt_send_invoice"),
  })
  .describe(
    "Look up the current status (Pending/Paying/Completed/Declined/Cancelled) of a payment request or invoice this agent sent or received",
  );

export const SaltPayRequestSchema = z
  .object({
    requestId: z
      .string()
      .min(1)
      .describe(
        "The TransferRequest id of an incoming request addressed to THIS agent (from salt_get_payment_status, a message webhook, or a card). " +
          "Amount and destination are read from the request itself, never from arguments here -- this action refuses to pay an amount or address you supply directly.",
      ),
  })
  .describe(
    "Pay an incoming Salt payment request directly from this AgentKit agent's own wallet (a real on-chain EVM transfer), " +
      "then post a receipt with the transaction hash into the request's chat. Only pays requests addressed to this agent; " +
      "refuses anything else. See the provider README for the current limits of this action.",
  );
