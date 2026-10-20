// The wait/resume machinery behind salt_ask_human / salt_get_answer.
//
// An AgentKit action is a single stateless function call -- there is no
// long-running process here the way salt-agent-sdk's ask.ts assumes (it
// keeps a `pendingByKey` map alive across an entire webhook server's
// lifetime). So instead of in-memory state, the "ask" is a self-contained
// continuation: everything needed to resume waiting -- the card, its
// button-to-label map, the expected answerer, the chat, the card's own
// interaction cursor, and the card's own chat bubble message id (the
// anchor for a free-text-reply read) -- travels in `askId` itself (a
// base64 JSON token), and salt_get_answer just decodes it and picks the
// poll back up. This also means an ask survives the AgentKit process
// restarting between salt_ask_human and salt_get_answer, which an
// in-memory map would not.
//
// Neither check here reads the shared, per-agent socket-mode outbox
// (GET /api/v1/agent/updates) at all -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26
// entries. A button tap reads the tapped card's own interaction log
// (GET /api/v1/cards/:id); a free-text reply reads the chat itself, since
// the card's own bubble (GET /api/v1/chats/:chatId?last=<messageId>).
// Both are idempotent, per-ask reads that share no state with any other
// ask, this agent's other checks, or any other consumer of this agent's
// outbox -- unlike the outbox, which kept exactly one forward-only ack
// cursor PER AGENT and could not be read by two independent checks
// without one silently stealing the other's rows.
import { SaltRestClient, SaltApiError, SaltCardInteraction } from "./saltRestClient";
import { decrypt } from "./saltCrypto";

export interface AskState {
  v: 1;
  chatId: string;
  cardId: string | null;
  humanId: string;
  /** action_id -> button label. */
  options: Record<string, string>;
  /**
   * The newest card interaction id/timestamp already consumed (salt-api
   *  0.96.0, `GET /api/v1/cards/:id`) -- never resume the button-tap check
   *  from before this. `null` until the card's first interaction is seen
   *  (a freshly posted card has none yet).
   */
  after: string | number | null;
  /**
   * The card's own chat bubble message id (`POST /api/v1/cards`'
   *  response `message_id`) -- the FIXED anchor `GET /api/v1/chats/:
   *  chatId?last=` reads from for the free-text-reply check. Fixed, never
   *  advanced: every check re-reads everything since the ask began
   *  (capped at 200 rows server-side), so there is no separate message
   *  cursor to track or lose between calls. `null` only for a
   *  hand-constructed AskState with no card at all (see tests) -- `GET
   *  /api/v1/chats/:chatId` with no `last` degrades to "the ten most
   *  recent messages" rather than refusing.
   */
  messageId: string | null;
}

/**
 * Serializes an AskState into the opaque askId string.
 *
 * @param state - The decoded ask state.
 *
 * @returns The base64url-encoded askId.
 */
export function encodeAskId(state: AskState): string {
  return Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
}

/**
 * Parses and validates an askId produced by encodeAskId.
 *
 * @param askId - The opaque askId returned by salt_ask_human.
 *
 * @returns The decoded AskState.
 */
export function decodeAskId(askId: string): AskState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(askId, "base64url").toString("utf8"));
  } catch {
    throw new Error("This askId isn't a value salt_ask_human/salt_get_answer produced.");
  }
  const s = parsed as Partial<AskState>;
  const afterOk = s.after === null || typeof s.after === "string" || typeof s.after === "number";
  const messageIdOk = s.messageId === null || typeof s.messageId === "string";
  if (
    s.v !== 1 ||
    typeof s.chatId !== "string" ||
    typeof s.humanId !== "string" ||
    typeof s.options !== "object" ||
    !afterOk ||
    !messageIdOk
  ) {
    throw new Error("This askId isn't a value salt_ask_human/salt_get_answer produced.");
  }
  return s as AskState;
}

export type AskOutcome =
  // A button tap has no encryption concept (card interactions are
  // plaintext metadata regardless of the chat), so `encrypted` only exists
  // on a `via: "message"` outcome. Unlike before the 2026-09-26 pass, a
  // message outcome no longer carries `deliveredBecause`: that field named
  // WHY a specific outbox delivery reached this agent (mention/reply/
  // keyword/all), stamped only onto a webhook/outbox envelope body
  // (`Message#send_webhook`'s `delivered_because:` argument) -- `GET
  // /api/v1/chats/:id` never sets it (it's not a stored column), so
  // reading a reply that way genuinely cannot recover it any more. See
  // HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries.
  //
  // `transferRequestId`/`transferRequestStatus` ride along on a `"button"`
  // outcome only when the tapped interaction carried them -- salt-api's
  // GET /api/v1/cards/:id sets them only on a "pay" button's tap, live
  // status included. salt_ask_human's own buttons are plain option
  // buttons today, never `type: "pay"`, so these are normally absent;
  // threaded through anyway (mirrors salt-mcp's `answerFromInteraction`)
  // so the next card type that reuses this poll doesn't need its own
  // answer-shaping code.
  | {
      status: "answered";
      answer: string;
      via: "button";
      transferRequestId?: string;
      transferRequestStatus?: string;
    }
  | { status: "answered"; answer: string; via: "message"; encrypted: boolean }
  | { status: "pending"; askId: string; note?: string };

/**
 * Converts a card button tap into an answered outcome.
 *
 * @param options - Map of button action id to option label.
 * @param interaction - The card interaction to convert.
 *
 * @returns An answered outcome with via set to "button".
 */
function answerFromInteraction(
  options: Record<string, string>,
  interaction: SaltCardInteraction,
): Extract<AskOutcome, { via: "button" }> {
  const answer = options[interaction.action_id] ?? interaction.value ?? interaction.action_id;
  const outcome: Extract<AskOutcome, { via: "button" }> = {
    status: "answered",
    answer,
    via: "button",
  };
  if (interaction.transfer_request_id) {
    outcome.transferRequestId = interaction.transfer_request_id;
    outcome.transferRequestStatus = interaction.transfer_request_status;
  }
  return outcome;
}

/**
 * A 429 from either read becomes information for the CALLER's own pacing,
 * never an internal retry (this function does not loop): there is
 * nothing to sleep inside it, so the hint travels back out in the
 * pending result's note instead. Mirrors salt-mcp honouring Retry-After,
 * translated for a stateless single-shot call.
 *
 * @param state - The decoded ask state.
 * @param after - The interaction cursor to resume from.
 * @param err - The 429 error from Salt.
 *
 * @returns A pending outcome carrying a fresh askId and a retry note.
 */
function pendingWithRetryHint(
  state: AskState,
  after: AskState["after"],
  err: SaltApiError,
): AskOutcome {
  const wait = err.retryAfterSeconds !== undefined ? `~${err.retryAfterSeconds}s` : "a bit";
  return {
    status: "pending",
    askId: encodeAskId({ ...state, after }),
    note: `Salt asked this provider to slow down (429). Call salt_get_answer with this askId again after waiting ${wait}.`,
  };
}

/**
 * A single, immediate, on-demand check for either a tap on one of this
 * ask's own card buttons, or (if this provider has a private key
 * configured, or the reply landed in an open/unencrypted room) a text
 * reply from the named human.
 *
 * Exactly ONE HTTP request per check performed -- never a wait/retry
 * loop. Owner rule: "DO NOT USE POLLING as a mechanic EVER." An AgentKit
 * action is a single stateless tool call with no long-running process
 * behind it, so the only honest way to "wait" here is to not wait at all:
 * check once, right now, and hand back a fresh askId if nothing's there
 * yet. It is the CALLER (the model deciding to invoke `salt_get_answer`
 * again, on its own next turn, or the surrounding host re-invoking a tool
 * later) that supplies the passage of time, never a sleep inside this
 * function.
 *
 * Two independent checks, in order, either of which can resolve the ask:
 *
 * 1. The card's OWN interaction log (salt-api 0.96.0,
 * `GET /api/v1/cards/:id`) for a tap on one of `state.options`' own
 * action ids, matched on `action_id` AND `user_id` (stricter than
 * salt-mcp's own card poll -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit)). Reading one card by id
 * is idempotent and shares nothing with any other ask.
 *
 * 2. If no button match: a free-text reply, via `GET /api/v1/chats/:
 * chatId?last=<state.messageId>` -- the chat itself, anchored on the
 * ask's own card's chat bubble. Also idempotent and shares nothing
 * with any other ask: unlike the outbox this replaced, a chat read has
 * no per-agent shared cursor at all, so any number of concurrent asks
 * (for this agent, or any other agent, or in the same chat, or in
 * different chats) can each read their own history back independently.
 * This is a deliberate divergence from salt-mcp's ask_human/
 * get_ask_result, which is button-only and has no free-text fallback
 * to worry about at all.
 *
 * @param client - The Salt REST client.
 * @param apiKey - The calling agent's Salt api-key.
 * @param state - The decoded ask state.
 * @param opts - Optional settings.
 * @param opts.canDecrypt - Whether a PGP private key is configured.
 * @param opts.decryptOne - Decrypts one ASCII-armored message.
 *
 * @returns The answer if one has arrived, otherwise a pending outcome with a fresh askId.
 */
export async function checkForAnswer(
  client: SaltRestClient,
  apiKey: string,
  state: AskState,
  opts: { canDecrypt: boolean; decryptOne: (armored: string) => Promise<string> },
): Promise<AskOutcome> {
  let after = state.after;

  if (state.cardId) {
    try {
      const card = await client.getCard(apiKey, state.cardId, { after: state.after });
      const interactions = card.interactions ?? [];
      // Newest first, per the route's contract -- advance `after` to the
      // newest interaction id seen regardless of whether it matches this
      // ask's own buttons, so a resumed poll never re-reads a row it has
      // already looked at and rejected.
      if (interactions.length > 0 && interactions[0]?.id !== undefined) after = interactions[0].id;
      // Matches on action_id AND user_id -- stricter than salt-mcp's own
      // card poll, which trusts action_id alone (its comment argues
      // `restricted_to` already gates who can tap, so a second check
      // "costs nothing" but isn't load-bearing). This provider keeps the
      // user_id check anyway: it's the same defense-in-depth the old
      // outbox-based check applied.
      const match = interactions.find(
        i =>
          Object.prototype.hasOwnProperty.call(state.options, i.action_id) &&
          String(i.user_id).toLowerCase() === state.humanId.toLowerCase(),
      );
      if (match) return answerFromInteraction(state.options, match);
    } catch (err) {
      if (err instanceof SaltApiError && err.status === 429)
        return pendingWithRetryHint(state, after, err);
      throw err;
    }
  }

  let chat;
  try {
    chat = await client.getChat(apiKey, state.chatId, { last: state.messageId ?? undefined });
  } catch (err) {
    if (err instanceof SaltApiError && err.status === 429)
      return pendingWithRetryHint(state, after, err);
    throw err;
  }

  let sawUnreadableReply = false;
  for (const msg of chat.messages ?? []) {
    if (msg.event_type) continue; // a system/event row -- membership churn, a call, etc., never something the human typed
    const sender = msg.user;
    const isFromHuman =
      sender?.account_type !== "Agent" &&
      String(sender?.id ?? "").toLowerCase() === state.humanId.toLowerCase();
    if (!isFromHuman || typeof msg.message !== "string") continue;

    // Open rooms: a plain-text reply carries `encrypted: false` and needs
    // no decrypt attempt at all -- readable even in keyless mode.
    if (msg.encrypted === false) {
      return { status: "answered", answer: msg.message, via: "message", encrypted: false };
    }
    if (!opts.canDecrypt) {
      sawUnreadableReply = true;
      continue;
    }
    try {
      const plaintext = await opts.decryptOne(msg.message);
      return { status: "answered", answer: plaintext, via: "message", encrypted: true };
    } catch {
      continue; // not decryptable with this key -- not our answer
    }
  }

  const note = sawUnreadableReply
    ? "The human replied with a plain-text message this provider couldn't read (no PGP private key configured) -- only their button taps can resolve this ask. Configure pgpPrivateKey/pgpPassphrase to read free-text replies too."
    : undefined;
  return { status: "pending", askId: encodeAskId({ ...state, after }), note };
}

export { decrypt };
