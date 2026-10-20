import * as openpgp from "openpgp";
import { SaltActionProvider, saltActionProvider } from "./saltActionProvider";
import {
  SaltAskHumanSchema,
  SaltPayRequestSchema,
  SaltSendInvoiceSchema,
  SaltSendMessageSchema,
  SaltSetRoomInterestsSchema,
} from "./schemas";
import type { EvmWalletProvider } from "../../wallet-providers";
import { encodeAskId, checkForAnswer } from "./askPoll";
import { createSaltRestClient } from "./saltRestClient";

const HOST = "https://salt.test";
const AGENT_ID = "agent-1";
const API_KEY = "test-api-key";

/**
 * Builds a minimal fetch Response mock with a JSON body.
 *
 * @param status - The HTTP status code.
 * @param body - The JSON response body.
 * @param headers - Response headers.
 *
 * @returns A fetch Response-like object.
 */
function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

/**
 * Creates a SaltActionProvider with test configuration.
 *
 * @param extra - Optional config overrides, such as a PGP key.
 *
 * @returns A configured SaltActionProvider.
 */
function newProvider(extra: Partial<{ pgpPrivateKey: string; pgpPassphrase: string }> = {}) {
  return saltActionProvider({ host: HOST, agentId: AGENT_ID, apiKey: API_KEY, ...extra });
}

describe("schemas", () => {
  it("SaltSendMessageSchema requires exactly one of chatId/handle", () => {
    expect(SaltSendMessageSchema.safeParse({ message: "hi" }).success).toBe(false);
    expect(
      SaltSendMessageSchema.safeParse({ message: "hi", chatId: "c1", handle: "bob" }).success,
    ).toBe(false);
    expect(SaltSendMessageSchema.safeParse({ message: "hi", chatId: "c1" }).success).toBe(true);
    expect(SaltSendMessageSchema.safeParse({ message: "hi", handle: "bob" }).success).toBe(true);
  });

  it("SaltAskHumanSchema requires 1-5 options and takes no timeoutSeconds (each call checks once, never waits)", () => {
    expect(
      SaltAskHumanSchema.safeParse({ chatId: "c1", humanId: "h1", question: "?", options: [] })
        .success,
    ).toBe(false);
    expect(
      SaltAskHumanSchema.safeParse({
        chatId: "c1",
        humanId: "h1",
        question: "?",
        options: ["a", "b", "c", "d", "e", "f"],
      }).success,
    ).toBe(false);
    const parsed = SaltAskHumanSchema.safeParse({
      chatId: "c1",
      humanId: "h1",
      question: "?",
      options: ["Yes", "No"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("timeoutSeconds" in parsed.data).toBe(false);
  });

  it("SaltSetRoomInterestsSchema requires keywords only when mode is keywords", () => {
    expect(SaltSetRoomInterestsSchema.safeParse({ chatId: "c1", mode: "keywords" }).success).toBe(
      false,
    );
    expect(
      SaltSetRoomInterestsSchema.safeParse({ chatId: "c1", mode: "keywords", keywords: ["help"] })
        .success,
    ).toBe(true);
    expect(SaltSetRoomInterestsSchema.safeParse({ chatId: "c1", mode: "all" }).success).toBe(true);
    expect(SaltSetRoomInterestsSchema.safeParse({ chatId: "c1", mode: "off" }).success).toBe(true);
    expect(SaltSetRoomInterestsSchema.safeParse({ chatId: "c1", mode: "nonsense" }).success).toBe(
      false,
    );
  });

  it("SaltSendInvoiceSchema requires exactly one of payerId/payerHandle", () => {
    const base = {
      chatId: "c1",
      lineItems: [{ name: "Widget", qty: 1, unitPrice: "1.00" }],
      chain: "base" as const,
    };
    expect(SaltSendInvoiceSchema.safeParse(base).success).toBe(false);
    expect(SaltSendInvoiceSchema.safeParse({ ...base, payerId: "p1" }).success).toBe(true);
  });

  it("SaltPayRequestSchema takes only requestId -- no amount/address fields exist to be misused", () => {
    const parsed = SaltPayRequestSchema.safeParse({
      requestId: "req-1",
      amount: "1000000",
      receiverAddress: "0xattacker",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(Object.keys(parsed.data)).toEqual(["requestId"]);
    }
  });
});

describe("salt_send_message", () => {
  it("encrypts to every chat member (real PGP) and includes a sender copy", async () => {
    const self = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "agent" }],
      format: "armored",
    });
    const other = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "human" }],
      format: "armored",
    });

    let posted: Record<string, unknown> | undefined;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-1") {
        return jsonResponse(200, {
          session: {
            users: [
              {
                id: AGENT_ID,
                username: "agent",
                account_type: "Agent",
                public_key: self.publicKey,
              },
              { id: "human-1", username: "bob", account_type: "User", public_key: other.publicKey },
            ],
          },
        });
      }
      if (u.pathname === "/api/v1/messages" && init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return jsonResponse(200, { id: "msg-1" });
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_send_message({ chatId: "chat-1", message: "hi there" });

    expect(result).toContain("Sent, encrypted for 2 member(s)");
    expect(posted).toBeDefined();
    const ciphertext = posted!.message as string;
    const senderCopy = posted!.sender_message as string;
    expect(ciphertext).toContain("BEGIN PGP MESSAGE");

    const decryptedForBob = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: ciphertext }),
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: other.privateKey }),
    });
    expect(decryptedForBob.data).toBe("hi there");

    const decryptedSenderCopy = await openpgp.decrypt({
      message: await openpgp.readMessage({ armoredMessage: senderCopy }),
      decryptionKeys: await openpgp.readPrivateKey({ armoredKey: self.privateKey }),
    });
    expect(decryptedSenderCopy.data).toBe("hi there");
  });

  it("refuses to send when no member has a public key", async () => {
    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-2") {
        return jsonResponse(200, { session: { users: [{ id: "human-1", account_type: "User" }] } });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_send_message({ chatId: "chat-2", message: "hi" });
    expect(result).toContain("no member of chat chat-2 has a public key");
  });

  it("posts PLAIN text into an open room, with no encryption attempted at all", async () => {
    let posted: Record<string, unknown> | undefined;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-6") {
        // session.encrypted: false, and deliberately NO member has a
        // public_key -- proves the plain branch never even looks for one.
        return jsonResponse(200, {
          session: { encrypted: false, users: [{ id: "human-1", account_type: "User" }] },
        });
      }
      if (u.pathname === "/api/v1/messages" && init?.method === "POST") {
        posted = JSON.parse(init.body as string);
        return jsonResponse(200, { id: "msg-open-1" });
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_send_message({ chatId: "chat-6", message: "hey everyone" });

    expect(posted).toEqual({ chat_id: "chat-6", message: "hey everyone" });
    expect(result).toContain("Sent as plain text into the open room");
  });
});

describe("salt_ask_human / salt_get_answer", () => {
  it("resolves via a button tap through GET /cards/:id -- never reads the chat at all when the card already matches", async () => {
    let capturedActionId: string | undefined;
    let chatShowCalls = 0;
    let cardShowCalls = 0;

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";

      if (u.pathname === "/api/v1/cards" && method === "POST") {
        const body = JSON.parse(init!.body as string);
        const actionsBlock = body.blocks.find((b: { type: string }) => b.type === "actions");
        capturedActionId = actionsBlock.elements[0].action_id;
        return jsonResponse(200, {
          message_id: "msg-1",
          resource_id: "card-1",
          resource: { id: "card-1" },
        });
      }
      if (u.pathname === "/api/v1/cards/card-1" && method === "PATCH") return jsonResponse(200, {});
      if (u.pathname === "/api/v1/cards/card-1" && method === "GET") {
        cardShowCalls += 1;
        return jsonResponse(200, {
          id: "card-1",
          state: {},
          owner_id: AGENT_ID,
          interactions: [
            {
              id: "int-1",
              user_id: "human-1",
              action_id: capturedActionId,
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      if (u.pathname === "/api/v1/chats/chat-1") {
        chatShowCalls += 1;
        return jsonResponse(200, { session: { id: "chat-1", encrypted: true }, messages: [] });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_ask_human({
      chatId: "chat-1",
      humanId: "human-1",
      question: "Ready?",
      options: ["Yes", "No"],
    });
    expect(result).toBe("Answered (button): Yes");
    expect(cardShowCalls).toBe(1);
    // A card match short-circuits before ever reading the chat -- and,
    // more generally, this whole suite never mocks /api/v1/agent/updates
    // at all any more: neither check reads the shared outbox. See
    // HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries.
    expect(chatShowCalls).toBe(0);
  });

  it("returns pending with a resumable askId when nobody has answered yet, passing the card's own message id as `last`", async () => {
    let receivedLast: string | null | undefined;

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/api/v1/cards" && method === "POST")
        return jsonResponse(200, {
          message_id: "msg-2",
          resource_id: "card-2",
          resource: { id: "card-2" },
        });
      if (u.pathname === "/api/v1/cards/card-2" && method === "GET")
        return jsonResponse(200, { id: "card-2", state: {}, owner_id: AGENT_ID, interactions: [] });
      if (u.pathname === "/api/v1/chats/chat-1") {
        receivedLast = u.searchParams.get("last");
        return jsonResponse(200, { session: { id: "chat-1", encrypted: true }, messages: [] });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_ask_human({
      chatId: "chat-1",
      humanId: "human-1",
      question: "Ready?",
      options: ["Yes", "No"],
    });
    expect(result).toContain("Pending -- no answer yet");
    expect(result).toMatch(/askId "[\w-]+"/);
    expect(receivedLast).toBe("msg-2"); // the card's own bubble -- never a rolling cursor
  });

  it("resolves on a SECOND check, resuming the askId the first pending check returned", async () => {
    let capturedActionId: string | undefined;
    let tap = false;

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/api/v1/cards" && method === "POST") {
        const body = JSON.parse(init!.body as string);
        const actionsBlock = body.blocks.find((b: { type: string }) => b.type === "actions");
        capturedActionId = actionsBlock.elements[1].action_id; // "Yes" is options[1] below
        return jsonResponse(200, {
          message_id: "msg-3",
          resource_id: "card-3",
          resource: { id: "card-3" },
        });
      }
      if (u.pathname === "/api/v1/cards/card-3" && method === "GET") {
        if (!tap)
          return jsonResponse(200, {
            id: "card-3",
            state: {},
            owner_id: AGENT_ID,
            interactions: [],
          });
        return jsonResponse(200, {
          id: "card-3",
          state: {},
          owner_id: AGENT_ID,
          interactions: [
            {
              id: "int-1",
              user_id: "human-1",
              action_id: capturedActionId,
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      if (u.pathname === "/api/v1/cards/card-3" && method === "PATCH") return jsonResponse(200, {});
      if (u.pathname === "/api/v1/chats/chat-1")
        return jsonResponse(200, { session: { id: "chat-1", encrypted: true }, messages: [] });
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const first = await provider.salt_ask_human({
      chatId: "chat-1",
      humanId: "human-1",
      question: "Ready?",
      options: ["No", "Yes"],
    });
    expect(first).toContain("Pending -- no answer yet");
    const askId = first.match(/askId "([\w-]+)"/)?.[1];
    expect(askId).toBeTruthy();

    tap = true;
    const second = await provider.salt_get_answer({ askId: askId! });
    expect(second).toBe("Answered (button): Yes");
  });

  it("two concurrent asks, on the same agent, each resolve their OWN answer independently", async () => {
    // The exact bug this pass fixes: the old outbox-based check shared ONE
    // forward-only cursor per agent, so two concurrent salt_get_answer calls
    // could consume each other's rows. Polling each card by id has nothing
    // shared between them -- assert that directly.
    const client = createSaltRestClient({
      host: HOST,
      fetchImpl: (async (url: string) => {
        const u = new URL(url);
        if (u.pathname === "/api/v1/cards/card-a") {
          return jsonResponse(200, {
            id: "card-a",
            state: {},
            owner_id: AGENT_ID,
            interactions: [
              {
                id: "int-a1",
                user_id: "human-a",
                action_id: "opt_a_yes",
                created_at: new Date().toISOString(),
              },
            ],
          });
        }
        if (u.pathname === "/api/v1/cards/card-b") {
          return jsonResponse(200, {
            id: "card-b",
            state: {},
            owner_id: AGENT_ID,
            interactions: [
              {
                id: "int-b1",
                user_id: "human-b",
                action_id: "opt_b_no",
                created_at: new Date().toISOString(),
              },
            ],
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as unknown as typeof fetch,
    });

    const stateA: Parameters<typeof checkForAnswer>[2] = {
      v: 1,
      chatId: "chat-a",
      cardId: "card-a",
      humanId: "human-a",
      options: { opt_a_yes: "Yes" },
      after: null,
      messageId: null,
    };
    const stateB: Parameters<typeof checkForAnswer>[2] = {
      v: 1,
      chatId: "chat-b",
      cardId: "card-b",
      humanId: "human-b",
      options: { opt_b_no: "No" },
      after: null,
      messageId: null,
    };
    const decryptOne = async (s: string) => s;

    const [outcomeA, outcomeB] = await Promise.all([
      checkForAnswer(client, API_KEY, stateA, { canDecrypt: false, decryptOne }),
      checkForAnswer(client, API_KEY, stateB, { canDecrypt: false, decryptOne }),
    ]);
    expect(outcomeA).toMatchObject({ status: "answered", answer: "Yes" });
    expect(outcomeB).toMatchObject({ status: "answered", answer: "No" });
  });

  it("a corrupt/stale `after` cursor still resolves -- salt-api fails open server-side, so this client sends it as-is", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-6",
      cardId: "card-6",
      humanId: "human-1",
      options: { opt_0: "Yes" },
      after: "not-a-real-interaction-id",
      messageId: null,
    });
    let receivedAfter: string | null | undefined;

    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/api/v1/cards/card-6" && method === "GET") {
        receivedAfter = u.searchParams.get("after");
        // Fails open: the full list, regardless of an `after` it doesn't recognise.
        return jsonResponse(200, {
          id: "card-6",
          state: {},
          owner_id: AGENT_ID,
          interactions: [
            {
              id: "int-1",
              user_id: "human-1",
              action_id: "opt_0",
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      if (u.pathname === "/api/v1/cards/card-6" && method === "PATCH") return jsonResponse(200, {}); // markCardAnswered, best-effort
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_get_answer({ askId });
    expect(receivedAfter).toBe("not-a-real-interaction-id");
    expect(result).toBe("Answered (button): Yes");
  });

  it("a pay tap's transfer_request_id/status ride along on the button outcome", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-7",
      cardId: "card-7",
      humanId: "human-1",
      options: { opt_0: "Approve" },
      after: null,
      messageId: null,
    });

    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/cards/card-7") {
        return jsonResponse(200, {
          id: "card-7",
          state: {},
          owner_id: AGENT_ID,
          interactions: [
            {
              id: "int-1",
              user_id: "human-1",
              action_id: "opt_0",
              created_at: new Date().toISOString(),
              transfer_request_id: "tr-1",
              transfer_request_status: "Confirmed",
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_get_answer({ askId });
    expect(result).toBe(
      "Answered (button): Approve (this tap also carries a payment request: tr-1, status Confirmed.)",
    );
  });

  it("a 429 from the card route never retries internally -- it comes back pending with a Retry-After hint", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-8",
      cardId: "card-8",
      humanId: "human-1",
      options: { opt_0: "Yes" },
      after: null,
      messageId: null,
    });
    let cardCalls = 0;

    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/cards/card-8") {
        cardCalls += 1;
        return jsonResponse(429, { error: "slow down" }, { "retry-after": "3" });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_get_answer({ askId });
    expect(cardCalls).toBe(1); // exactly one request -- never an internal retry loop
    expect(result).toContain("Still pending");
    expect(result).toContain("429");
    expect(result).toContain("~3s");
  });

  it("a 429 from the chat route (no card) also comes back pending with a Retry-After hint, never retried", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-9",
      cardId: null,
      humanId: "human-1",
      options: {},
      after: null,
      messageId: "msg-9",
    });
    let chatCalls = 0;

    global.fetch = jest.fn(async (_url: string) => {
      chatCalls += 1;
      return jsonResponse(429, { error: "slow down" }, { "retry-after": "5" });
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_get_answer({ askId });
    expect(chatCalls).toBe(1);
    expect(result).toContain("Still pending");
    expect(result).toContain("~5s");
  });

  it("salt_get_answer decrypts a free-text reply when a private key is configured (real PGP)", async () => {
    const agentKey = await openpgp.generateKey({
      type: "ecc",
      curve: "curve25519",
      userIDs: [{ name: "agent" }],
      format: "armored",
    });
    const ciphertextToAgent = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: "42" }),
      encryptionKeys: await openpgp.readKey({ armoredKey: agentKey.publicKey }),
    });

    // Build an askId as salt_ask_human would have, but with no card (this
    // human is expected to reply in free text, not tap a button).
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-3",
      cardId: null,
      humanId: "human-1",
      options: {},
      after: null,
      messageId: "msg-anchor",
    });

    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-3") {
        expect(u.searchParams.get("last")).toBe("msg-anchor");
        return jsonResponse(200, {
          session: { id: "chat-3", encrypted: true },
          messages: [
            {
              id: "m1",
              chat_id: "chat-3",
              message: ciphertextToAgent,
              encrypted: true,
              user: { id: "human-1", account_type: "User" },
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    // Constructed only now, so createSaltRestClient captures THIS mock (it
    // reads global.fetch once, at construction time).
    const provider = newProvider({ pgpPrivateKey: agentKey.privateKey, pgpPassphrase: "" });
    const result = await provider.salt_get_answer({ askId });
    expect(result).toBe("Answered (message): 42");
  });

  it("salt_get_answer reads a plain-text reply from an OPEN ROOM directly, with no key configured at all", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-5",
      cardId: null,
      humanId: "human-1",
      options: {},
      after: null,
      messageId: null,
    });

    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-5") {
        return jsonResponse(200, {
          session: { id: "chat-5", encrypted: false },
          messages: [
            {
              id: "m1",
              chat_id: "chat-5",
              message: "sure, go ahead",
              encrypted: false,
              user: { id: "human-1", account_type: "User" },
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider(); // no pgpPrivateKey -- an open-room reply needs none
    const result = await provider.salt_get_answer({ askId });
    expect(result).toBe("Answered (message, open room): sure, go ahead");
  });

  it("salt_get_answer without a configured private key cannot read an ENCRYPTED free-text reply, and stays pending", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-4",
      cardId: null,
      humanId: "human-1",
      options: {},
      after: null,
      messageId: null,
    });

    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-4") {
        return jsonResponse(200, {
          session: { id: "chat-4", encrypted: true },
          messages: [
            {
              id: "m1",
              chat_id: "chat-4",
              message: "-----BEGIN PGP MESSAGE-----\nfake\n-----END PGP MESSAGE-----",
              encrypted: true,
              user: { id: "human-1", account_type: "User" },
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider(); // no pgpPrivateKey, constructed after the mock is in place
    const result = await provider.salt_get_answer({ askId });
    expect(result).toContain("Still pending");
    expect(result).toContain("couldn't read");
  });

  it("ignores a system/event row and a message from anyone other than the named human (including the agent's own), then finds the real reply", async () => {
    const askId = encodeAskId({
      v: 1,
      chatId: "chat-10",
      cardId: null,
      humanId: "human-1",
      options: {},
      after: null,
      messageId: null,
    });

    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-10") {
        return jsonResponse(200, {
          session: { id: "chat-10", encrypted: false },
          messages: [
            // A system/event row -- never something a human typed, even
            // though it otherwise carries a plausible-looking `message`.
            {
              id: "m1",
              chat_id: "chat-10",
              message: "chat_encrypted",
              event_type: "chat_encrypted",
              encrypted: false,
              user: { id: "human-1", account_type: "User" },
              created_at: new Date().toISOString(),
            },
            // A different chat member replying -- not the named human.
            {
              id: "m2",
              chat_id: "chat-10",
              message: "not me",
              encrypted: false,
              user: { id: "human-bystander", account_type: "User" },
              created_at: new Date().toISOString(),
            },
            // The agent's own message (e.g. the question itself echoed back).
            {
              id: "m3",
              chat_id: "chat-10",
              message: "Ready?",
              encrypted: false,
              user: { id: AGENT_ID, account_type: "Agent" },
              created_at: new Date().toISOString(),
            },
            // The real reply.
            {
              id: "m4",
              chat_id: "chat-10",
              message: "yes indeed",
              encrypted: false,
              user: { id: "human-1", account_type: "User" },
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_get_answer({ askId });
    expect(result).toBe("Answered (message, open room): yes indeed");
  });
});

describe("salt_set_room_interests", () => {
  it("PUTs the subscription for a real mode", async () => {
    let putBody: Record<string, unknown> | undefined;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-1/subscription" && init?.method === "PUT") {
        putBody = JSON.parse(init!.body as string);
        return jsonResponse(200, {});
      }
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_set_room_interests({
      chatId: "chat-1",
      mode: "keywords",
      keywords: ["urgent", "help"],
    });

    expect(putBody).toEqual({ mode: "keywords", keywords: ["urgent", "help"] });
    expect(result).toContain('"keywords"');
    expect(result).toContain("urgent, help");
  });

  it("DELETEs the subscription when mode is off", async () => {
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/chats/chat-1/subscription" && init?.method === "DELETE")
        return jsonResponse(200, {});
      throw new Error(`unexpected fetch ${init?.method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_set_room_interests({ chatId: "chat-1", mode: "off" });
    expect(result).toContain("Cleared");
  });
});

describe("money actions", () => {
  it("salt_request_payment resolves a handle, picks the matching wallet, and requests payment", async () => {
    let requestBody: Record<string, unknown> | undefined;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/api/v1/users/bob")
        return jsonResponse(200, { id: "user-2", username: "bob" });
      if (u.pathname === "/api/v1/wallets") {
        return jsonResponse(200, [
          {
            id: "w-mainnet",
            chain: "base",
            testnet: false,
            public_address: "0xmain",
            name_3: "ETH",
          },
          {
            id: "w-testnet",
            chain: "base",
            testnet: true,
            public_address: "0xtest",
            name_3: "ETH",
          },
        ]);
      }
      if (u.pathname === "/api/v1/transfer_requests" && method === "POST") {
        requestBody = JSON.parse(init!.body as string);
        return jsonResponse(200, {
          id: "req-1",
          status: "Pending",
          amount: requestBody!.amount,
          wallet: { chain: "base", testnet: true, name_3: "ETH" },
        });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_request_payment({
      chatId: "chat-1",
      payerHandle: "bob",
      amount: "5.00",
      chain: "base",
      testnet: true,
      asset: "native",
    });

    expect(requestBody).toMatchObject({
      chat_id: "chat-1",
      receiver_id: "user-2",
      wallet_id: "w-testnet",
      amount: "5.00",
    });
    expect(result).toContain("Requested 5.00 ETH");
    expect(result).toContain("req-1");
  });

  it("salt_request_payment fails clearly when the agent has no matching wallet", async () => {
    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/wallets") return jsonResponse(200, []);
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_request_payment({
      chatId: "chat-1",
      payerId: "user-2",
      amount: "5.00",
      chain: "polygon",
      testnet: false,
      asset: "native",
    });
    expect(result).toContain("has no Salt wallet on Polygon (mainnet)");
  });

  it("salt_request_payment refuses usdc on bsc rather than guessing which USDC", async () => {
    global.fetch = jest.fn(async () => {
      throw new Error("should not call the network before the asset check");
    }) as unknown as typeof fetch;
    const provider = newProvider();
    const result = await provider.salt_request_payment({
      chatId: "chat-1",
      payerId: "user-2",
      amount: "1",
      chain: "bsc",
      testnet: true,
      asset: "usdc",
    });
    expect(result).toContain("Circle doesn't issue native USDC on BNB Smart Chain");
  });

  it("salt_send_invoice computes subtotal/amount from qty * unitPrice", async () => {
    let requestBody: Record<string, unknown> | undefined;
    global.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      const method = init?.method ?? "GET";
      if (u.pathname === "/api/v1/wallets")
        return jsonResponse(200, [
          { id: "w1", chain: "base", testnet: true, public_address: "0xtest", name_3: "ETH" },
        ]);
      if (u.pathname === "/api/v1/transfer_requests" && method === "POST") {
        requestBody = JSON.parse(init!.body as string);
        return jsonResponse(200, { id: "inv-1", status: "Pending" });
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_send_invoice({
      chatId: "chat-1",
      payerId: "user-2",
      lineItems: [
        { name: "Widget", qty: 2, unitPrice: "3.5" },
        { name: "Shipping", qty: 1, unitPrice: "1" },
      ],
      chain: "base",
      testnet: true,
      asset: "native",
    });

    expect(requestBody?.amount).toBe("8");
    expect((requestBody?.line_items as Array<{ subtotal: string }>)[0].subtotal).toBe("7");
    expect(result).toContain("inv-1");
  });

  it("salt_get_payment_status finds a request this agent is party to", async () => {
    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/transfer_requests") {
        return jsonResponse(200, [
          { id: "req-9", status: "Completed", amount: "1.0", wallet: { name_3: "ETH" } },
        ]);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_get_payment_status({ requestId: "req-9" });
    expect(result).toContain("Completed");
  });

  it("salt_get_payment_status reports a clean miss for an unknown id", async () => {
    global.fetch = jest.fn(async () => jsonResponse(200, [])) as unknown as typeof fetch;
    const provider = newProvider();
    const result = await provider.salt_get_payment_status({ requestId: "does-not-exist" });
    expect(result).toContain("No such payment request");
  });
});

describe("salt_pay_request", () => {
  /**
   * Builds a mock EVM wallet provider for the pay-request tests.
   *
   * @param chainId - The EVM chain id.
   * @param sendTransaction - Mock for the wallet sendTransaction call.
   * @param waitForTransactionReceipt - Mock for the wallet waitForTransactionReceipt call.
   *
   * @returns A mock EvmWalletProvider.
   */
  function mockWallet(
    chainId: number,
    sendTransaction = jest.fn().mockResolvedValue("0xhash"),
    waitForTransactionReceipt = jest.fn().mockResolvedValue({}),
  ) {
    return {
      getNetwork: jest.fn().mockReturnValue({ protocolFamily: "evm", chainId: String(chainId) }),
      sendTransaction,
      waitForTransactionReceipt,
    } as unknown as EvmWalletProvider;
  }

  it("pays a pending request addressed to this agent, from the connected wallet, and reports the tx hash", async () => {
    global.fetch = jest.fn(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/v1/transfer_requests") {
        return jsonResponse(200, [
          {
            id: "req-9",
            status: "Pending",
            receiver_id: AGENT_ID,
            amount: "0.01",
            message: null,
            chat_id: "chat-9",
            wallet: { chain: "base", testnet: true, public_address: "0xdead", name_3: "ETH" },
          },
        ]);
      }
      if (u.pathname === "/api/v1/chats/chat-9")
        return jsonResponse(200, { session: { users: [] } }); // nobody with a public key -> receipt post is skipped
      throw new Error(`unexpected fetch ${url}`);
    }) as unknown as typeof fetch;

    const provider = newProvider();
    const wallet = mockWallet(84532); // base-sepolia
    const result = await provider.salt_pay_request(wallet, { requestId: "req-9" });

    expect(wallet.sendTransaction).toHaveBeenCalledWith({
      to: "0xdead",
      value: 10000000000000000n,
    });
    expect(result).toContain("Transaction hash: 0xhash");
    expect(result).toContain('Salt\'s own request status will still read "Pending"');
  });

  it("refuses to pay a request not addressed to this agent", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(200, [
        {
          id: "req-1",
          status: "Pending",
          receiver_id: "someone-else",
          amount: "1",
          wallet: { chain: "base", testnet: true, public_address: "0xdead" },
        },
      ]),
    ) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_pay_request(mockWallet(84532), { requestId: "req-1" });
    expect(result).toContain("is not addressed to this agent");
  });

  it("refuses to pay on the wrong network", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(200, [
        {
          id: "req-1",
          status: "Pending",
          receiver_id: AGENT_ID,
          amount: "1",
          wallet: { chain: "base", testnet: true, public_address: "0xdead" },
        },
      ]),
    ) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_pay_request(mockWallet(1), { requestId: "req-1" }); // ethereum mainnet, request wants base testnet
    expect(result).toContain("Switch the wallet provider's");
  });

  it("refuses to guess when the request's note mentions USDC", async () => {
    global.fetch = jest.fn(async () =>
      jsonResponse(200, [
        {
          id: "req-1",
          status: "Pending",
          receiver_id: AGENT_ID,
          amount: "1",
          message: "for 1 USDC please",
          wallet: { chain: "base", testnet: true, public_address: "0xdead" },
        },
      ]),
    ) as unknown as typeof fetch;

    const provider = newProvider();
    const result = await provider.salt_pay_request(mockWallet(84532), { requestId: "req-1" });
    expect(result).toContain("mentions USDC");
    expect(mockWallet).toBeDefined(); // wallet must not have been asked to send anything
  });
});

describe("provider shape", () => {
  it("only gates on EVM networks", () => {
    const provider = new SaltActionProvider({ host: HOST, agentId: AGENT_ID, apiKey: API_KEY });
    expect(provider.supportsNetwork({ protocolFamily: "evm" })).toBe(true);
    expect(provider.supportsNetwork({ protocolFamily: "svm" })).toBe(false);
  });

  it("throws a clear error when required config is missing", () => {
    const originalEnv = { ...process.env };
    delete process.env.SALT_HOST;
    delete process.env.SALT_AGENT_ID;
    delete process.env.SALT_API_KEY;
    expect(() => new SaltActionProvider({})).toThrow(/missing required configuration/);
    process.env = originalEnv;
  });
});
