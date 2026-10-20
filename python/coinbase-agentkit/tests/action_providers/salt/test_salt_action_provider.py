"""Tests for the Salt action provider.

HTTP is mocked (a fake httpx client
swapped onto provider.client.http); PGP round trips are real (saltapp.crypto
+ PGPy), matching this monorepo's usual "HTTP mocked, real crypto" style.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock
from urllib.parse import parse_qs, urlparse

import pytest
from saltapp import crypto

from coinbase_agentkit.action_providers.salt.ask_poll import (
    AskState,
    encode_ask_id,
    poll_for_answer,
)
from coinbase_agentkit.action_providers.salt.salt_action_provider import (
    SaltActionProvider,
    salt_action_provider,
)
from coinbase_agentkit.action_providers.salt.schemas import (
    SaltAskHumanSchema,
    SaltPayRequestSchema,
    SaltSendMessageSchema,
)
from coinbase_agentkit.network import Network

HOST = "https://salt.test"
AGENT_ID = "agent-1"
API_KEY = "test-api-key"


@dataclass
class FakeResponse:
    """A stand-in for an httpx.Response, just enough of the surface saltapp.client._request reads."""

    status_code: int
    _body: Any

    def json(self) -> Any:
        """Return the canned JSON body."""
        return self._body

    @property
    def headers(self) -> dict[str, str]:
        """No response headers; saltapp reads `Retry-After` from here on a 429."""
        return {}

    @property
    def text(self) -> str:
        """The body serialized as JSON text."""
        return json.dumps(self._body)

    @property
    def content(self) -> bytes:
        """Non-empty bytes for any real body -- `_request` treats an empty `.content` as 204-like."""
        return self.text.encode("utf-8")


@dataclass
class FakeHttpClient:
    """Swapped onto `provider.client.http`. `router(method, url, json_body) -> FakeResponse`."""

    router: Callable[[str, str, Any], FakeResponse]
    calls: list[tuple[str, str, Any]] = field(default_factory=list)

    def request(
        self, method: str, url: str, *, json: Any = None, headers: Any = None, timeout: Any = None
    ) -> FakeResponse:
        """Record the call and dispatch it to the test's router."""
        self.calls.append((method, url, json))
        return self.router(method, url, json)


def new_provider(**extra: Any) -> SaltActionProvider:
    """Build a SaltActionProvider with fixed host/agent_id/api_key for tests."""
    return salt_action_provider(host=HOST, agent_id=AGENT_ID, api_key=API_KEY, **extra)


def path_of(url: str) -> str:
    """Return the URL's path, with the host and any query string stripped."""
    return url.split(HOST, 1)[1].split("?", 1)[0]


def mock_wallet(chain_id: int) -> MagicMock:
    """Build a minimal EvmWalletProvider mock connected to `chain_id`."""
    wallet = MagicMock()
    wallet.get_network.return_value = Network(protocol_family="evm", chain_id=str(chain_id))
    wallet.send_transaction.return_value = "0xhash"
    wallet.wait_for_transaction_receipt.return_value = {}
    return wallet


# -- schemas ------------------------------------------------------------


def test_send_message_schema_requires_exactly_one_target():
    """Exactly one of chat_id/handle must be given."""
    with pytest.raises(ValueError, match="exactly one"):
        SaltSendMessageSchema(message="hi")
    with pytest.raises(ValueError, match="exactly one"):
        SaltSendMessageSchema(message="hi", chat_id="c1", handle="bob")
    assert SaltSendMessageSchema(message="hi", chat_id="c1").chat_id == "c1"


def test_ask_human_schema_caps_timeout_and_option_count():
    """timeout_seconds is capped at 50 and options must have 1-5 entries."""
    with pytest.raises(ValueError, match="less than or equal to 50"):
        SaltAskHumanSchema(
            chat_id="c1", human_id="h1", question="?", options=["Yes"], timeout_seconds=51
        )
    with pytest.raises(ValueError):
        SaltAskHumanSchema(chat_id="c1", human_id="h1", question="?", options=[])
    parsed = SaltAskHumanSchema(chat_id="c1", human_id="h1", question="?", options=["Yes", "No"])
    assert parsed.timeout_seconds == 50


def test_pay_request_schema_takes_only_request_id():
    """No amount/address field exists on this schema to be misused."""
    parsed = SaltPayRequestSchema(request_id="req-1")
    assert parsed.model_dump() == {"request_id": "req-1"}


# -- salt_send_message ---------------------------------------------------


def test_send_message_encrypts_to_every_member_real_pgp():
    """salt_send_message encrypts to every chat member's real key and includes a sender copy."""
    self_key = crypto.generate_keypair("")
    other_key = crypto.generate_keypair("")
    posted: dict[str, Any] = {}

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/chats/chat-1" and method == "GET":
            return FakeResponse(
                200,
                {
                    "session": {
                        "users": [
                            {
                                "id": AGENT_ID,
                                "account_type": "Agent",
                                "public_key": self_key.public_key,
                            },
                            {
                                "id": "human-1",
                                "account_type": "User",
                                "public_key": other_key.public_key,
                            },
                        ]
                    }
                },
            )
        if path == "/api/v1/messages" and method == "POST":
            posted.update(body)
            return FakeResponse(200, {"id": "msg-1"})
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)

    result = provider.salt_send_message({"chat_id": "chat-1", "message": "hi there"})

    assert "Sent, encrypted for 2 member(s)" in result
    assert crypto.decrypt(posted["message"], other_key.private_key, "") == "hi there"
    assert crypto.decrypt(posted["sender_message"], self_key.private_key, "") == "hi there"


def test_send_message_refuses_when_nobody_has_a_public_key():
    """salt_send_message refuses to post unencrypted when no member has a key on file."""

    def router(method: str, url: str, body: Any) -> FakeResponse:
        if path_of(url) == "/api/v1/chats/chat-2":
            return FakeResponse(
                200, {"session": {"users": [{"id": "human-1", "account_type": "User"}]}}
            )
        raise AssertionError(f"unexpected {method} {url}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_send_message({"chat_id": "chat-2", "message": "hi"})
    assert "no member of chat chat-2 has a public key" in result


# -- salt_ask_human / salt_get_answer ------------------------------------


def test_ask_human_resolves_via_button_tap():
    """salt_ask_human resolves via GET /api/v1/cards/:id -- never reads the chat at all when the card already matches."""
    captured: dict[str, str] = {}
    chat_calls = 0

    def router(method: str, url: str, body: Any) -> FakeResponse:
        nonlocal chat_calls
        path = path_of(url)
        if path == "/api/v1/cards" and method == "POST":
            actions_block = next(b for b in body["blocks"] if b["type"] == "actions")
            captured["action_id"] = actions_block["elements"][0]["action_id"]
            return FakeResponse(
                200, {"message_id": "msg-1", "resource_id": "card-1", "resource": {"id": "card-1"}}
            )
        if path == "/api/v1/cards/card-1" and method == "GET":
            return FakeResponse(
                200,
                {
                    "id": "card-1",
                    "state": {},
                    "owner_id": AGENT_ID,
                    "interactions": [
                        {
                            "id": "int-1",
                            "user_id": "human-1",
                            "action_id": captured["action_id"],
                            "created_at": "2026-09-18T00:00:00Z",
                        }
                    ],
                },
            )
        if path == "/api/v1/cards/card-1" and method == "PATCH":
            return FakeResponse(200, {})
        if path == "/api/v1/chats/chat-1":
            chat_calls += 1
            return FakeResponse(
                200, {"session": {"id": "chat-1", "encrypted": True}, "messages": []}
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)

    result = provider.salt_ask_human(
        {
            "chat_id": "chat-1",
            "human_id": "human-1",
            "question": "Ready?",
            "options": ["Yes", "No"],
            "timeout_seconds": 5,
        }
    )
    assert result == "Answered (button): Yes"
    # A card match short-circuits before ever reading the chat -- and, more
    # generally, this whole suite never mocks /api/v1/agent/updates at all
    # any more: neither check reads the shared outbox. See HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s
    # 2026-09-26 entries.
    assert chat_calls == 0


def test_ask_human_returns_pending_with_resumable_ask_id():
    """salt_ask_human returns a pending result with a resumable ask_id, passing the card's own message id as `last`."""
    received_last: dict[str, str | None] = {}

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/cards" and method == "POST":
            return FakeResponse(
                200, {"message_id": "msg-2", "resource_id": "card-2", "resource": {"id": "card-2"}}
            )
        if path == "/api/v1/cards/card-2" and method == "GET":
            return FakeResponse(
                200, {"id": "card-2", "state": {}, "owner_id": AGENT_ID, "interactions": []}
            )
        if path == "/api/v1/chats/chat-1":
            received_last["last"] = parse_qs(urlparse(url).query).get("last", [None])[0]
            return FakeResponse(
                200, {"session": {"id": "chat-1", "encrypted": True}, "messages": []}
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_ask_human(
        {
            "chat_id": "chat-1",
            "human_id": "human-1",
            "question": "Ready?",
            "options": ["Yes", "No"],
            "timeout_seconds": 1,
        }
    )
    assert "Pending -- no answer within 1s" in result
    assert "ask_id" in result
    assert received_last["last"] == "msg-2"  # the card's own bubble -- never a rolling cursor


def test_ask_human_resolves_on_a_second_poll_for_answer_call():
    """A pending ask's ask_id resumes correctly on a later salt_get_answer call, once the human taps."""
    captured: dict[str, str] = {}
    tapped = {"v": False}

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/cards" and method == "POST":
            actions_block = next(b for b in body["blocks"] if b["type"] == "actions")
            captured["action_id"] = actions_block["elements"][1][
                "action_id"
            ]  # "Yes" is options[1] below
            return FakeResponse(
                200, {"message_id": "msg-3", "resource_id": "card-3", "resource": {"id": "card-3"}}
            )
        if path == "/api/v1/cards/card-3" and method == "GET":
            if not tapped["v"]:
                return FakeResponse(
                    200, {"id": "card-3", "state": {}, "owner_id": AGENT_ID, "interactions": []}
                )
            return FakeResponse(
                200,
                {
                    "id": "card-3",
                    "state": {},
                    "owner_id": AGENT_ID,
                    "interactions": [
                        {
                            "id": "int-1",
                            "user_id": "human-1",
                            "action_id": captured["action_id"],
                            "created_at": "2026-09-18T00:00:00Z",
                        }
                    ],
                },
            )
        if path == "/api/v1/cards/card-3" and method == "PATCH":
            return FakeResponse(200, {})
        if path == "/api/v1/chats/chat-1":
            return FakeResponse(
                200, {"session": {"id": "chat-1", "encrypted": True}, "messages": []}
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)

    first = provider.salt_ask_human(
        {
            "chat_id": "chat-1",
            "human_id": "human-1",
            "question": "Ready?",
            "options": ["No", "Yes"],
            "timeout_seconds": 1,
        }
    )
    assert "Pending -- no answer within 1s" in first
    ask_id = first.split('ask_id "')[1].split('"')[0]

    tapped["v"] = True
    second = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 5})
    assert second == "Answered (button): Yes"


def test_ask_human_two_concurrent_asks_each_resolve_their_own_answer():
    """Two concurrent asks resolve independently -- the exact bug this pass fixes.

    The old outbox check shared ONE cursor per agent, so two concurrent
    checks could consume each other's rows. Polling each card by id
    shares nothing.
    """

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/cards/card-a":
            return FakeResponse(
                200,
                {
                    "id": "card-a",
                    "state": {},
                    "owner_id": AGENT_ID,
                    "interactions": [
                        {
                            "id": "int-a1",
                            "user_id": "human-a",
                            "action_id": "opt_a_yes",
                            "created_at": "2026-09-18T00:00:00Z",
                        }
                    ],
                },
            )
        if path == "/api/v1/cards/card-b":
            return FakeResponse(
                200,
                {
                    "id": "card-b",
                    "state": {},
                    "owner_id": AGENT_ID,
                    "interactions": [
                        {
                            "id": "int-b1",
                            "user_id": "human-b",
                            "action_id": "opt_b_no",
                            "created_at": "2026-09-18T00:00:00Z",
                        }
                    ],
                },
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)

    state_a = AskState(
        chat_id="chat-a",
        card_id="card-a",
        human_id="human-a",
        options={"opt_a_yes": "Yes"},
        after=None,
        message_id=None,
    )
    state_b = AskState(
        chat_id="chat-b",
        card_id="card-b",
        human_id="human-b",
        options={"opt_b_no": "No"},
        after=None,
        message_id=None,
    )
    outcome_a = poll_for_answer(
        provider.client, provider.api_key, state_a, 5, can_decrypt=False, decrypt_one=lambda s: s
    )
    outcome_b = poll_for_answer(
        provider.client, provider.api_key, state_b, 5, can_decrypt=False, decrypt_one=lambda s: s
    )
    assert outcome_a.status == "answered" and outcome_a.answer == "Yes"
    assert outcome_b.status == "answered" and outcome_b.answer == "No"


def test_ask_human_corrupt_after_cursor_still_resolves():
    """salt-api fails open server-side on an unrecognised `after` -- this provider sends it as-is."""
    received: dict[str, str | None] = {}
    ask_id = encode_ask_id(
        AskState(
            chat_id="chat-6",
            card_id="card-6",
            human_id="human-1",
            options={"opt_0": "Yes"},
            after="not-a-real-interaction-id",
            message_id=None,
        )
    )

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/cards/card-6" and method == "GET":
            received["after"] = url.split("after=")[1] if "after=" in url else None
            return FakeResponse(
                200,
                {
                    "id": "card-6",
                    "state": {},
                    "owner_id": AGENT_ID,
                    "interactions": [
                        {
                            "id": "int-1",
                            "user_id": "human-1",
                            "action_id": "opt_0",
                            "created_at": "2026-09-18T00:00:00Z",
                        }
                    ],
                },
            )
        if path == "/api/v1/cards/card-6" and method == "PATCH":
            return FakeResponse(200, {})  # _mark_card_answered, best-effort
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 5})
    assert received["after"] == "not-a-real-interaction-id"
    assert result == "Answered (button): Yes"


def test_ask_human_pay_tap_carries_transfer_request_status():
    """A pay tap's transfer_request_id/status ride along on the button outcome."""
    ask_id = encode_ask_id(
        AskState(
            chat_id="chat-7",
            card_id="card-7",
            human_id="human-1",
            options={"opt_0": "Approve"},
            after=None,
            message_id=None,
        )
    )

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/cards/card-7":
            return FakeResponse(
                200,
                {
                    "id": "card-7",
                    "state": {},
                    "owner_id": AGENT_ID,
                    "interactions": [
                        {
                            "id": "int-1",
                            "user_id": "human-1",
                            "action_id": "opt_0",
                            "created_at": "2026-09-18T00:00:00Z",
                            "transfer_request_id": "tr-1",
                            "transfer_request_status": "Confirmed",
                        }
                    ],
                },
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 5})
    assert (
        result
        == "Answered (button): Approve (this tap also carries a payment request: tr-1, status Confirmed.)"
    )


def test_ask_human_429_propagates_as_a_plain_error_python_has_no_retry_after_signal():
    """Confirm the accepted divergence from the TypeScript sibling.

    saltapp.errors.SaltApiError carries no response headers, so there is no
    Retry-After to recover without bypassing `_request` entirely (out of
    scope here -- see ask_poll.py's `_get_card` docstring). A 429
    propagates like any other SaltApiError this loop already lets through,
    rendered by the action-level try/except.
    """
    ask_id = encode_ask_id(
        AskState(
            chat_id="chat-11",
            card_id="card-11",
            human_id="human-1",
            options={"opt_0": "Yes"},
            after=None,
            message_id=None,
        )
    )

    def router(method: str, url: str, body: Any) -> FakeResponse:
        return FakeResponse(429, {"error": "slow down"})

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 1})
    assert "Error checking Salt answer" in result
    assert "429" in result


def test_get_answer_decrypts_free_text_reply_real_pgp():
    """salt_get_answer decrypts a free-text reply when a private key is configured (real PGP)."""
    agent_key = crypto.generate_keypair("")
    ciphertext = crypto.encrypt_for("42", [agent_key.public_key])
    # Build an ask_id as salt_ask_human would have, but with no card (this
    # human is expected to reply in free text, not tap a button).
    ask_id = encode_ask_id(
        AskState(
            chat_id="chat-3",
            card_id=None,
            human_id="human-1",
            options={},
            after=None,
            message_id="msg-anchor",
        )
    )

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/chats/chat-3":
            assert parse_qs(urlparse(url).query).get("last", [None])[0] == "msg-anchor"
            return FakeResponse(
                200,
                {
                    "session": {"id": "chat-3", "encrypted": True},
                    "messages": [
                        {
                            "id": "m1",
                            "chat_id": "chat-3",
                            "message": ciphertext,
                            "user": {"id": "human-1", "account_type": "User"},
                        }
                    ],
                },
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider(pgp_private_key=agent_key.private_key, pgp_passphrase="")
    provider.client.http = FakeHttpClient(router)

    result = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 5})
    assert result == "Answered (message): 42"


def test_get_answer_without_a_key_cannot_read_free_text():
    """salt_get_answer keeps waiting, with a note, when it has no private key to read a free-text reply."""
    ask_id = encode_ask_id(
        AskState(
            chat_id="chat-4",
            card_id=None,
            human_id="human-1",
            options={},
            after=None,
            message_id=None,
        )
    )

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/chats/chat-4":
            return FakeResponse(
                200,
                {
                    "session": {"id": "chat-4", "encrypted": True},
                    "messages": [
                        {
                            "id": "m1",
                            "chat_id": "chat-4",
                            "message": "-----BEGIN PGP MESSAGE-----\nfake\n-----END PGP MESSAGE-----",
                            "user": {"id": "human-1", "account_type": "User"},
                        }
                    ],
                },
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()  # no pgp_private_key
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 1})
    assert "Still pending" in result
    assert "couldn't read" in result


def test_get_answer_ignores_event_rows_and_anyone_other_than_the_named_human():
    """Skip a system/event row, a bystander's message and the agent's own message.

    The real reply from the named human still resolves the ask.
    """
    agent_key = crypto.generate_keypair("")
    bystander_ciphertext = crypto.encrypt_for("not me", [agent_key.public_key])
    own_ciphertext = crypto.encrypt_for("Ready?", [agent_key.public_key])
    reply_ciphertext = crypto.encrypt_for("yes indeed", [agent_key.public_key])
    ask_id = encode_ask_id(
        AskState(
            chat_id="chat-10",
            card_id=None,
            human_id="human-1",
            options={},
            after=None,
            message_id=None,
        )
    )

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/chats/chat-10":
            return FakeResponse(
                200,
                {
                    "session": {"id": "chat-10", "encrypted": True},
                    "messages": [
                        # A system/event row -- never something a human typed,
                        # even carrying a plausible-looking `message`.
                        {
                            "id": "m1",
                            "chat_id": "chat-10",
                            "message": "chat_encrypted",
                            "event_type": "chat_encrypted",
                            "user": {"id": "human-1", "account_type": "User"},
                        },
                        # A different chat member replying -- not the named human.
                        {
                            "id": "m2",
                            "chat_id": "chat-10",
                            "message": bystander_ciphertext,
                            "user": {"id": "human-bystander", "account_type": "User"},
                        },
                        # The agent's own message (e.g. the question itself echoed back).
                        {
                            "id": "m3",
                            "chat_id": "chat-10",
                            "message": own_ciphertext,
                            "user": {"id": AGENT_ID, "account_type": "Agent"},
                        },
                        # The real reply.
                        {
                            "id": "m4",
                            "chat_id": "chat-10",
                            "message": reply_ciphertext,
                            "user": {"id": "human-1", "account_type": "User"},
                        },
                    ],
                },
            )
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider(pgp_private_key=agent_key.private_key, pgp_passphrase="")
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_get_answer({"ask_id": ask_id, "timeout_seconds": 1})
    assert result == "Answered (message): yes indeed"


# -- money actions --------------------------------------------------------


def test_request_payment_resolves_handle_and_picks_wallet():
    """salt_request_payment resolves a handle to an id and picks the matching wallet."""
    request_body: dict[str, Any] = {}

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/users/bob":
            return FakeResponse(200, {"id": "user-2", "username": "bob"})
        if path == "/api/v1/wallets":
            return FakeResponse(
                200,
                [
                    {
                        "id": "w-mainnet",
                        "chain": "base",
                        "testnet": False,
                        "public_address": "0xmain",
                        "name_3": "ETH",
                    },
                    {
                        "id": "w-testnet",
                        "chain": "base",
                        "testnet": True,
                        "public_address": "0xtest",
                        "name_3": "ETH",
                    },
                ],
            )
        if path == "/api/v1/transfer_requests" and method == "POST":
            request_body.update(body)
            return FakeResponse(200, {"id": "req-1", "status": "Pending"})
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_request_payment(
        {
            "chat_id": "chat-1",
            "payer_handle": "bob",
            "amount": "5.00",
            "chain": "base",
            "testnet": True,
            "asset": "native",
        }
    )
    assert request_body["wallet_id"] == "w-testnet"
    assert request_body["receiver_id"] == "user-2"
    assert "Requested 5.00 ETH" in result
    assert "req-1" in result


def test_request_payment_fails_without_matching_wallet():
    """salt_request_payment fails clearly when the agent has no wallet on the requested chain/testnet."""

    def router(method: str, url: str, body: Any) -> FakeResponse:
        if path_of(url) == "/api/v1/wallets":
            return FakeResponse(200, [])
        raise AssertionError(f"unexpected {method} {url}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_request_payment(
        {
            "chat_id": "chat-1",
            "payer_id": "user-2",
            "amount": "5",
            "chain": "polygon",
            "testnet": False,
            "asset": "native",
        }
    )
    assert "has no Salt wallet on Polygon (mainnet)" in result


def test_request_payment_refuses_usdc_on_bsc():
    """salt_request_payment refuses usdc on bsc rather than guessing which USDC is meant."""
    provider = new_provider()
    provider.client.http = FakeHttpClient(
        lambda *_a: (_ for _ in ()).throw(AssertionError("no network call expected"))
    )
    result = provider.salt_request_payment(
        {
            "chat_id": "chat-1",
            "payer_id": "user-2",
            "amount": "1",
            "chain": "bsc",
            "testnet": True,
            "asset": "usdc",
        }
    )
    assert "Circle doesn't issue native USDC on BNB Smart Chain" in result


def test_send_invoice_computes_subtotal_and_amount():
    """salt_send_invoice computes each line's subtotal and the total amount from qty * unit_price."""
    request_body: dict[str, Any] = {}

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/wallets":
            return FakeResponse(
                200,
                [
                    {
                        "id": "w1",
                        "chain": "base",
                        "testnet": True,
                        "public_address": "0xtest",
                        "name_3": "ETH",
                    }
                ],
            )
        if path == "/api/v1/transfer_requests" and method == "POST":
            request_body.update(body)
            return FakeResponse(200, {"id": "inv-1", "status": "Pending"})
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    result = provider.salt_send_invoice(
        {
            "chat_id": "chat-1",
            "payer_id": "user-2",
            "line_items": [
                {"name": "Widget", "qty": 2, "unit_price": "3.5"},
                {"name": "Shipping", "qty": 1, "unit_price": "1"},
            ],
            "chain": "base",
            "testnet": True,
            "asset": "native",
        }
    )
    assert request_body["amount"] == "8"
    assert request_body["line_items"][0]["subtotal"] == "7"
    assert "inv-1" in result


def test_get_payment_status_finds_a_request():
    """salt_get_payment_status finds a request this agent is party to."""
    provider = new_provider()
    provider.client.http = FakeHttpClient(
        lambda method, url, body: FakeResponse(
            200,
            [{"id": "req-9", "status": "Completed", "amount": "1.0", "wallet": {"name_3": "ETH"}}],
        )
    )
    result = provider.salt_get_payment_status({"request_id": "req-9"})
    assert "Completed" in result


def test_get_payment_status_reports_a_clean_miss():
    """salt_get_payment_status reports a clean miss for an unknown id."""
    provider = new_provider()
    provider.client.http = FakeHttpClient(lambda method, url, body: FakeResponse(200, []))
    result = provider.salt_get_payment_status({"request_id": "does-not-exist"})
    assert "No such payment request" in result


# -- salt_pay_request -----------------------------------------------------


def test_pay_request_pays_a_pending_request_addressed_to_this_agent():
    """salt_pay_request pays a pending request addressed to this agent and reports the tx hash."""

    def router(method: str, url: str, body: Any) -> FakeResponse:
        path = path_of(url)
        if path == "/api/v1/transfer_requests":
            return FakeResponse(
                200,
                [
                    {
                        "id": "req-9",
                        "status": "Pending",
                        "receiver_id": AGENT_ID,
                        "amount": "0.01",
                        "message": None,
                        "chat_id": "chat-9",
                        "wallet": {
                            "chain": "base",
                            "testnet": True,
                            "public_address": "0xdead",
                            "name_3": "ETH",
                        },
                    }
                ],
            )
        if path == "/api/v1/chats/chat-9":
            return FakeResponse(
                200, {"session": {"users": []}}
            )  # nobody with a public key -> receipt post is skipped
        raise AssertionError(f"unexpected {method} {path}")

    provider = new_provider()
    provider.client.http = FakeHttpClient(router)
    wallet = mock_wallet(84532)  # base-sepolia

    result = provider.salt_pay_request(wallet, {"request_id": "req-9"})

    wallet.send_transaction.assert_called_once_with({"to": "0xdead", "value": 10000000000000000})
    assert "Transaction hash: 0xhash" in result
    assert 'status will still read "Pending"' in result


def test_pay_request_refuses_a_request_not_addressed_to_this_agent():
    """salt_pay_request refuses to pay a request whose receiver_id isn't this agent."""
    provider = new_provider()
    provider.client.http = FakeHttpClient(
        lambda m, u, b: FakeResponse(
            200,
            [
                {
                    "id": "req-1",
                    "status": "Pending",
                    "receiver_id": "someone-else",
                    "amount": "1",
                    "wallet": {"chain": "base", "testnet": True, "public_address": "0xdead"},
                }
            ],
        )
    )
    result = provider.salt_pay_request(mock_wallet(84532), {"request_id": "req-1"})
    assert "is not addressed to this agent" in result


def test_pay_request_refuses_on_the_wrong_network():
    """salt_pay_request refuses to pay when the connected wallet's network doesn't match the request's chain."""
    provider = new_provider()
    provider.client.http = FakeHttpClient(
        lambda m, u, b: FakeResponse(
            200,
            [
                {
                    "id": "req-1",
                    "status": "Pending",
                    "receiver_id": AGENT_ID,
                    "amount": "1",
                    "wallet": {"chain": "base", "testnet": True, "public_address": "0xdead"},
                }
            ],
        )
    )
    result = provider.salt_pay_request(
        mock_wallet(1), {"request_id": "req-1"}
    )  # ethereum mainnet, request wants base testnet
    assert "Switch the wallet provider" in result


def test_pay_request_refuses_when_note_mentions_usdc():
    """salt_pay_request refuses to guess an asset when the request's note mentions USDC."""
    provider = new_provider()
    provider.client.http = FakeHttpClient(
        lambda m, u, b: FakeResponse(
            200,
            [
                {
                    "id": "req-1",
                    "status": "Pending",
                    "receiver_id": AGENT_ID,
                    "amount": "1",
                    "message": "for 1 USDC please",
                    "wallet": {"chain": "base", "testnet": True, "public_address": "0xdead"},
                }
            ],
        )
    )
    wallet = mock_wallet(84532)
    result = provider.salt_pay_request(wallet, {"request_id": "req-1"})
    assert "mentions USDC" in result
    wallet.send_transaction.assert_not_called()


# -- provider shape --------------------------------------------------------


def test_provider_only_supports_evm():
    """SaltActionProvider only claims to support EVM networks."""
    provider = new_provider()
    assert provider.supports_network(Network(protocol_family="evm")) is True
    assert provider.supports_network(Network(protocol_family="svm")) is False


def test_provider_missing_config_raises(monkeypatch):
    """SaltActionProvider raises a clear error when required configuration is missing."""
    monkeypatch.delenv("SALT_HOST", raising=False)
    monkeypatch.delenv("SALT_AGENT_ID", raising=False)
    monkeypatch.delenv("SALT_API_KEY", raising=False)
    with pytest.raises(ValueError, match="missing required configuration"):
        SaltActionProvider()
