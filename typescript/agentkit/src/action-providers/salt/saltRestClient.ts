// A small, self-contained REST client for the Salt (saltapp.ai) platform
// API, covering only the endpoints this action provider needs.
//
// Salt already has a fuller TypeScript client, salt-agent-sdk (see
// HANDOFF.md (github.com/0000F8/saltapp-agentkit) for why this action provider does not depend on it directly:
// short version, the version with socket-mode support is not on npm yet).
// This mirrors salt-agent-sdk's src/client.ts closely enough that porting
// forward once salt-agent-sdk ships on npm is a straight swap -- same
// method names, same shapes, same "every call takes the caller's own
// api-key explicitly" convention (an AgentKit process is not a multi-agent
// host the way salt-agent-sdk's is, but the convention costs nothing and
// keeps the two codebases legible against each other).
export interface SaltUser {
  [key: string]: unknown;
  id: string;
  username: string;
  display_name: string;
  account_type: "User" | "Agent";
  public_key?: string;
}

/**
 * One message as `GET /api/v1/chats/:id` serializes it (`Message.as_json`
 *  plus `reactions`/moderation fields -- NOT the `formatted_message` shape
 *  `POST /api/v1/cards`/webhook bodies use, which nests the id under
 *  `message_id` instead of `id`). `event_type` present means a system/event
 *  row (e.g. a call or membership change), never something a human typed.
 */
export interface SaltChatMessage {
  [key: string]: unknown;
  id: string;
  chat_id: string;
  message: string | null;
  sender_message?: string | null;
  /**
   * False for an open room's plain text; true (or absent pre-column) for
   *  PGP ciphertext in an ordinary end-to-end encrypted chat.
   */
  encrypted?: boolean;
  event_type?: string | null;
  user: SaltUser;
  created_at: string;
}

/**
 * `GET /api/v1/chats/:id`'s response shape: everything about the chat
 *  itself -- INCLUDING `encrypted` -- lives under `session`, never at the
 *  top level (`chats_controller#show`'s `x_chat = {session:, messages:,
 *  pinned_messages:}`). `POST /api/v1/chats` (create/get-or-create) is a
 *  DIFFERENT, flatter shape (`chat.as_json` merged with `users` at the top
 *  level, no `session` wrapper, no `messages`) -- see `createOrGetChat`.
 */
export interface SaltChat {
  [key: string]: unknown;
  session: {
    [key: string]: unknown;
    id: string;
    /**
     * False for an open room -- plain text, no PGP, the whole chat.
     *  Absent/true for an ordinary end-to-end encrypted chat.
     */
    encrypted?: boolean;
    users?: SaltUser[];
  };
  /**
   * Present on `show` (not on `create`/`get-or-create`). Ascending by
   *  `seq` (oldest first). Newer than `?last=` when given, else the ten
   *  most recent; capped at `CATCHUP_LIMIT` (200) with `?last=`.
   */
  messages?: SaltChatMessage[];
  pinned_messages?: SaltChatMessage[];
}

export interface SaltWalletInfo {
  id: string;
  chain: string;
  testnet: boolean;
  public_address: string;
  wallet_type?: string;
  name_3?: string;
}

export interface SaltTransferRequest {
  [key: string]: unknown;
  id: string;
  amount: string;
  message: string | null;
  status: "Pending" | "Paying" | "Completed" | "Declined" | "Cancelled";
  sender_id: string;
  receiver_id: string;
  transfer_id: string | null;
  request_type: "request" | "invoice";
  line_items: unknown[] | null;
  due_at: string | null;
  wallet: SaltWalletInfo | null;
  chat_id: string | null;
  last_failed_at: string | null;
  last_failed_reason: string | null;
}

/**
 * One tap recorded against a card (salt-api 0.96.0, `GET /api/v1/cards/:id`).
 *  `transfer_request_id`/`transfer_request_status` are only ever present on
 *  a "pay" button's tap -- `salt_ask_human`'s own buttons are plain option
 *  buttons today, never `type: "pay"`, so these are normally absent here;
 *  threaded through anyway so the next card type that reuses this poll
 *  doesn't need its own answer-shaping code (mirrors salt-mcp's
 *  `answerFromInteraction`).
 */
export interface SaltCardInteraction {
  id: string;
  user_id: string;
  action_id: string;
  value?: string;
  created_at: string;
  transfer_request_id?: string;
  transfer_request_status?: string;
}

/** `GET /api/v1/cards/:id`'s response shape -- see `getCard` below. */
export interface SaltCard {
  id: string;
  state: unknown;
  owner_id: string;
  /** Newest first, capped at 50 server-side. */
  interactions: SaltCardInteraction[];
}

/**
 *
 */
export class SaltApiError extends Error {
  status: number;
  body: unknown;
  /**
   * Seconds to wait before retrying, parsed from a 429's `Retry-After`
   *  header -- undefined for any other status, or when the header is
   *  absent/unparseable. Mirrors salt-mcp's `SaltBearerApiError`.
   */
  retryAfterSeconds?: number;

  /**
   * Creates an error carrying the failed request and the response details.
   *
   * @param method - The HTTP method.
   * @param url - The request URL.
   * @param status - The HTTP status code returned by Salt.
   * @param body - The JSON request body, if any.
   * @param retryAfterSeconds - Seconds to wait before retrying, from a 429 response.
   */
  constructor(
    method: string,
    url: string,
    status: number,
    body: unknown,
    retryAfterSeconds?: number,
  ) {
    const reason =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? `: ${(body as { error: string }).error}`
        : "";
    super(`Salt API ${method} ${url} -> ${status}${reason}`);
    this.name = "SaltApiError";
    this.status = status;
    this.body = body;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface SaltRestClientOptions {
  host: string;
  fetchImpl?: typeof fetch;
}

/**
 * Creates a Salt REST client bound to one host.
 *
 * @param options - Client options: Salt host and an optional fetch implementation.
 *
 * @returns An object with one method per supported Salt endpoint.
 */
export function createSaltRestClient(options: SaltRestClientOptions) {
  const host = options.host.replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;

  /**
   * Sends one authenticated JSON request to the Salt API and parses the response.
   *
   * @param method - The HTTP method.
   * @param path - The API path, starting with a slash.
   * @param apiKey - The calling agent's Salt api-key.
   * @param body - The JSON request body, if any.
   * @param opts - Optional settings.
   * @param opts.timeoutMs - Abort the request after this many milliseconds.
   *
   * @returns The parsed response body, or undefined for an empty one.
   */
  async function request<T>(
    method: string,
    path: string,
    apiKey: string,
    body?: unknown,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const url = `${host}${path}`;
    const headers: Record<string, string> = { "api-key": apiKey };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const controller = opts?.timeoutMs ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), opts!.timeoutMs) : undefined;
    try {
      const res = await doFetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller?.signal,
      });
      if (!res.ok) {
        let parsed: unknown;
        try {
          parsed = await res.json();
        } catch {
          parsed = await res.text().catch(() => undefined);
        }
        let retryAfterSeconds: number | undefined;
        if (res.status === 429) {
          const header = res.headers?.get?.("retry-after");
          const parsedHeader = header ? Number(header) : NaN;
          if (Number.isFinite(parsedHeader) && parsedHeader >= 0) retryAfterSeconds = parsedHeader;
        }
        throw new SaltApiError(method, url, res.status, parsed, retryAfterSeconds);
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    /**
     * Public: resolve a Salt handle (@username) to its user record. No auth needed -- salt-api's users#show is public by design.
     *
     * @param handle - A Salt @handle.
     *
     * @returns The user record, or undefined if the handle does not exist.
     */
    async getUserByHandle(handle: string): Promise<SaltUser | undefined> {
      const url = `${host}/api/v1/users/${encodeURIComponent(handle)}`;
      const res = await doFetch(url);
      if (res.status === 404) return undefined;
      if (!res.ok)
        throw new SaltApiError("GET", url, res.status, await res.text().catch(() => undefined));
      return (await res.json()) as SaltUser;
    },

    /**
     * Which agent this api-key belongs to, and its webhook signing secret.
     * Not currently called by this provider's own actions (nothing here
     * verifies a webhook envelope any more -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26
     * entries), kept as a general capability of this client.
     *
     * @param apiKey - The calling agent's Salt api-key.
     *
     * @returns The agent id and webhook secret.
     */
    async whoAmI(apiKey: string): Promise<{ agent_id: string; webhook_secret?: string }> {
      return request("GET", `/api/v1/agents/webhook_secret?_=${Date.now()}`, apiKey);
    },

    /**
     * Sets this agent's OWN delivery mode ("webhook" or "socket"). Not
     * currently called by this provider's own actions -- `salt_ask_human`
     * used to force "socket" so a tapped/typed answer would land in the
     * agent/updates outbox this provider polled; now that neither check
     * reads that outbox at all (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries),
     * doing so would serve no purpose and could actively break a SEPARATE
     * webhook listener the same agent also runs. Kept as a general
     * capability of this client, not a step in the ask flow.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param mode - The delivery or subscription mode to set.
     */
    async setDeliveryMode(apiKey: string, mode: "webhook" | "socket"): Promise<void> {
      await request("PATCH", "/api/v1/agents/delivery", apiKey, { mode });
    },

    /**
     * Reads one card's own interaction log (salt-api 0.96.0,
     * `GET /api/v1/cards/:id`) -- owner-only (404 for a non-owner, byte-
     * identical to an unknown id). `interactions` comes back newest
     * first, capped at 50 server-side. `after` (an interaction id) asks
     * for only interactions strictly newer than that; omitted, the full
     * (capped) list comes back. An unrecognised `after` fails OPEN
     * server-side (the full list, never a 500), so this client never
     * needs to validate its own cursor before sending it.
     *
     * `askPoll.ts#checkForAnswer` polls THIS route for a tap on one of an
     * ask's own card buttons -- unlike the shared, per-agent
     * `agent/updates` outbox this replaces for that check (removed from
     * this client entirely -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries),
     * reading one card by id is idempotent and shares nothing with any
     * other ask: any number of concurrent `salt_ask_human`/
     * `salt_get_answer` calls, for this agent or any other agent, can
     * each resolve their own ask independently.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param cardId - The Salt card id.
     * @param opts - Optional settings.
     * @param opts.after - Interaction id cursor; only newer interactions are returned.
     *
     * @returns The card with its interaction log.
     */
    async getCard(
      apiKey: string,
      cardId: string,
      opts?: { after?: string | number | null },
    ): Promise<SaltCard> {
      const after = opts?.after;
      const qs =
        after !== undefined && after !== null && after !== ""
          ? `?after=${encodeURIComponent(String(after))}`
          : "";
      return request("GET", `/api/v1/cards/${encodeURIComponent(cardId)}${qs}`, apiKey);
    },

    /**
     * A chat's full record -- `session.encrypted` (open rooms: is this
     * chat plain text, no PGP?) and `session.users` (members, including
     * public keys); `?last=<messageId>` (an existing message's id) asks
     * for `messages` strictly newer than it (up to 200), instead of the
     * ten most recent -- `askPoll.ts#checkForAnswer` polls THIS route,
     * anchored on the ask's own card's chat bubble, for a free-text reply
     * (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries: this replaced a check against
     * the shared, per-agent `agent/updates` outbox, since removed from
     * this client entirely). `getChatMembers` below is a thin wrapper
     * over this for callers that only need the member list.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param chatId - The Salt chat id.
     * @param opts - Optional settings.
     * @param opts.last - Id of the last message already seen; only newer messages are returned.
     *
     * @returns The chat record.
     */
    async getChat(apiKey: string, chatId: string, opts?: { last?: string }): Promise<SaltChat> {
      const lastQs = opts?.last ? `&last=${encodeURIComponent(opts.last)}` : "";
      return request("GET", `/api/v1/chats/${chatId}?_=${Date.now()}${lastQs}`, apiKey);
    },

    /**
     * A chat's members, including public keys -- who to encrypt a message for.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param chatId - The Salt chat id.
     *
     * @returns The chat members.
     */
    async getChatMembers(apiKey: string, chatId: string): Promise<SaltUser[]> {
      const chat = await request<SaltChat>(
        "GET",
        `/api/v1/chats/${chatId}?_=${Date.now()}`,
        apiKey,
      );
      return chat?.session?.users ?? [];
    },

    /**
     * Get-or-create the 1:1 chat with `contactId`. Idempotent on Salt's side.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param contactId - The Salt user id of the contact.
     *
     * @returns The chat record.
     */
    async createOrGetChat(
      apiKey: string,
      contactId: string,
    ): Promise<{ id: string; session?: { users?: SaltUser[] } }> {
      return request("POST", "/api/v1/chats", apiKey, { contact_id: contactId });
    },

    /**
     * Posts a message into a chat -- `message` is either PGP ciphertext
     * (an ordinary end-to-end encrypted chat) or, into an open room
     * (`chat.session.encrypted === false`), the plain text itself;
     * salt-api stores whatever string it's given either way, so which one
     * is correct is the caller's job (see `saltActionProvider.ts`'s
     * `sendSmart`, which checks `getChat`'s `session.encrypted` flag
     * before calling this).
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param chatId - The Salt chat id.
     * @param message - The message text, PGP-encrypted unless the chat is an open room.
     * @param opts - Optional settings.
     * @param opts.senderMessage - Copy of the message encrypted for the sender's own key.
     * @param opts.mentions - User ids to mention in the message.
     *
     * @returns The posted message.
     */
    async postMessage(
      apiKey: string,
      chatId: string,
      message: string,
      opts?: { senderMessage?: string; mentions?: string[] },
    ): Promise<{ [key: string]: unknown; id: string }> {
      const body: Record<string, unknown> = { chat_id: chatId, message };
      if (opts?.senderMessage) body.sender_message = opts.senderMessage;
      if (opts?.mentions && opts.mentions.length > 0) body.mentions = opts.mentions;
      return request("POST", "/api/v1/messages", apiKey, body);
    },

    /**
     * Declares what this agent wants delivered from an open room it isn't
     * necessarily addressed in every message of -- `"addressed"` (only a
     * direct reply/@mention), `"keywords"` (any message containing one of
     * `keywords`), or `"all"` (every message). Always this agent's OWN
     * subscription for `chatId`.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param chatId - The Salt chat id.
     * @param params - The request parameters.
     * @param params.mode - Which messages are delivered: all, mentions or keyword.
     * @param params.keywords - Keywords that trigger delivery in keyword mode.
     *
     * @returns The updated subscription.
     */
    async setChatSubscription(
      apiKey: string,
      chatId: string,
      params: { mode: "addressed" | "keywords" | "all"; keywords?: string[] },
    ): Promise<unknown> {
      const body: Record<string, unknown> = { mode: params.mode };
      if (params.keywords && params.keywords.length > 0) body.keywords = params.keywords;
      return request("PUT", `/api/v1/chats/${chatId}/subscription`, apiKey, body);
    },

    /**
     * Removes this agent's subscription record for `chatId` -- salt-api's
     * default (unsubscribed) behavior applies again.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param chatId - The Salt chat id.
     *
     * @returns The API response.
     */
    async clearChatSubscription(apiKey: string, chatId: string): Promise<unknown> {
      return request("DELETE", `/api/v1/chats/${chatId}/subscription`, apiKey);
    },

    /**
     * Post a declarative blocks card into a chat. The response is the
     * card's chat BUBBLE (a `formatted_message`, salt-api
     * `cards_controller#create`) -- NOT the card record itself, and NOT
     * `{id}` (an earlier version of this method's return type claimed
     * that; it was never correct against the real route and nothing here
     * currently reads it, but the shape is worth getting right anyway):
     * the bubble MESSAGE's own id is `message_id`, and the CARD's own id
     * is `resource_id` (== `resource.id`). `salt_ask_human` needs both --
     * `resource_id` to poll the card's own interactions (`getCard`
     * above), `message_id` as the anchor for the free-text-reply chat
     * read (`getChat`'s `last` above).
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param chatId - The Salt chat id.
     * @param blocks - The card blocks.
     * @param text - Optional plain-text fallback for the card.
     *
     * @returns The created card.
     */
    async postCard(
      apiKey: string,
      chatId: string,
      blocks: unknown[],
      text: string,
    ): Promise<{
      [key: string]: unknown;
      message_id: string;
      resource_id?: string;
      resource?: { [key: string]: unknown; id: string };
    }> {
      return request("POST", "/api/v1/cards", apiKey, { chat_id: chatId, blocks, text });
    },

    /**
     * Replace an owned card's blocks -- used to show "Answered: ..." once salt_ask_human resolves. Best-effort by every caller here.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param cardId - The Salt card id.
     * @param blocks - The card blocks.
     *
     * @returns The updated card.
     */
    async updateCard(apiKey: string, cardId: string, blocks: unknown[]): Promise<unknown> {
      return request("PATCH", `/api/v1/cards/${cardId}`, apiKey, { blocks });
    },

    /**
     * This agent's own active wallets (needed to pick a wallet_id to receive a payment request into).
     *
     * @param apiKey - The calling agent's Salt api-key.
     *
     * @returns This agent's Salt wallets.
     */
    async listWallets(apiKey: string): Promise<SaltWalletInfo[]> {
      return request("GET", "/api/v1/wallets", apiKey);
    },

    /**
     * A plain payment request (no line items) on the TransferRequest rail.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param params - The request parameters.
     * @param params.chatId - The Salt chat id to attach the request to.
     * @param params.receiverId - The Salt user id that will pay.
     * @param params.walletId - The Salt wallet id that receives the payment.
     * @param params.amount - The amount to request.
     * @param params.message - Optional note shown with the request.
     *
     * @returns The created transfer request.
     */
    async requestPayment(
      apiKey: string,
      params: {
        chatId: string;
        receiverId: string;
        walletId: string;
        amount: string;
        message?: string;
      },
    ): Promise<SaltTransferRequest> {
      return request("POST", "/api/v1/transfer_requests", apiKey, {
        chat_id: params.chatId,
        receiver_id: params.receiverId,
        wallet_id: params.walletId,
        amount: params.amount,
        message: params.message,
      });
    },

    /**
     * An itemized invoice: same rail as requestPayment, plus request_type + line_items.
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param params - The request parameters.
     * @param params.chatId - The Salt chat id to attach the request to.
     * @param params.receiverId - The Salt user id that will pay.
     * @param params.walletId - The Salt wallet id that receives the payment.
     * @param params.amount - The amount to request.
     * @param params.lineItems - Invoice line items.
     * @param params.message - Optional note shown with the request.
     * @param params.dueAt - Optional due date.
     *
     * @returns The created invoice transfer request.
     */
    async createInvoice(
      apiKey: string,
      params: {
        chatId: string;
        receiverId: string;
        walletId: string;
        amount: string;
        lineItems: Array<{ name: string; qty: number; unit_price: string; subtotal: string }>;
        message?: string;
        dueAt?: string;
      },
    ): Promise<SaltTransferRequest> {
      return request("POST", "/api/v1/transfer_requests", apiKey, {
        chat_id: params.chatId,
        receiver_id: params.receiverId,
        wallet_id: params.walletId,
        amount: params.amount,
        message: params.message,
        request_type: "invoice",
        line_items: params.lineItems,
        due_at: params.dueAt,
      });
    },

    /**
     * Every request/invoice this agent has sent or received. There is no `GET /transfer_requests/:id` on salt-api today (only index+create+update+split+remind are wired up), so looking up one by id means paging this and filtering client-side -- see salt_get_payment_status / salt_pay_request.
     *
     * @param apiKey - The calling agent's Salt api-key.
     *
     * @returns The transfer requests this agent sent or received.
     */
    async listTransferRequests(apiKey: string): Promise<SaltTransferRequest[]> {
      return request("GET", `/api/v1/transfer_requests?_=${Date.now()}`, apiKey);
    },

    /**
     * A Transfer's current on-chain status (Pending/Confirmed/Failed).
     *
     * @param apiKey - The calling agent's Salt api-key.
     * @param transferId - The Salt transfer id.
     *
     * @returns The transfer record.
     */
    async getTransfer(
      apiKey: string,
      transferId: string,
    ): Promise<{ [key: string]: unknown; id: string; status: string; tx_id?: string }> {
      return request("GET", `/api/v1/transfers/${transferId}`, apiKey);
    },
  };
}

export type SaltRestClient = ReturnType<typeof createSaltRestClient>;
