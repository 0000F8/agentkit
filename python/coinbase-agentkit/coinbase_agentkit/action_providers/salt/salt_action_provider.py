"""Salt action provider.

Connects an AgentKit agent to Salt (saltapp.ai), the end-to-end encrypted
chat app where humans and AI agents message each other and move money in
the conversation. Every action here talks to Salt's own REST API (via the
`saltapp` package -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit) for why this depends on it directly,
unlike the TypeScript sibling); only salt_pay_request also touches the
AgentKit wallet provider, to send a real on-chain payment.

See this folder's README.md for setup (host/agent_id/api_key, the optional
PGP key) and the current limits of each action.
"""

from __future__ import annotations

import os
import re
from decimal import Decimal
from typing import Any

from saltapp import crypto
from saltapp.cards import actions as card_actions, button, section
from saltapp.client import SaltClient
from saltapp.errors import SaltApiError

from ...network import Network
from ...wallet_providers import EvmWalletProvider
from ..action_decorator import create_action
from ..action_provider import ActionProvider
from .ask_poll import (
    AskOutcome,
    AskState,
    decode_ask_id,
    poll_for_answer,
)
from .constants import NATIVE_DECIMALS, SALT_CHAINS, salt_chain_for_evm_chain_id
from .schemas import (
    SaltAskHumanSchema,
    SaltGetAnswerSchema,
    SaltGetPaymentStatusSchema,
    SaltPayRequestSchema,
    SaltRequestPaymentSchema,
    SaltSendInvoiceSchema,
    SaltSendMessageSchema,
)


def _same_id(a: Any, b: Any) -> bool:
    return str(a).lower() == str(b).lower()


def _format_amount(value: Decimal) -> str:
    """Format a decimal as a plain string with no unnecessary trailing zeros.

    "8", not "8.00" -- matching Salt's own convention (salt-api's
    TransferRequestsController#sum_amounts strips trailing zeros the same
    way) and the TypeScript sibling's plain Number arithmetic. Never
    exponential notation (Decimal.normalize() alone would turn "100" into
    "1E+2"), since `amount` rides the wire as a string salt-api parses with
    its own BigDecimal(...).
    """
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


class SaltActionProvider(ActionProvider[EvmWalletProvider]):
    """Action provider for Salt (saltapp.ai)."""

    def __init__(
        self,
        host: str | None = None,
        agent_id: str | None = None,
        api_key: str | None = None,
        pgp_private_key: str | None = None,
        pgp_passphrase: str | None = None,
    ) -> None:
        """Initialize the Salt action provider.

        Args:
            host: Salt API base URL, e.g. "https://saltapp.ai". Defaults to the SALT_HOST env var.
            agent_id: This agent's own Salt user id. Required for salt_pay_request. Defaults to SALT_AGENT_ID.
            api_key: This agent's Salt api-key. Defaults to SALT_API_KEY.
            pgp_private_key: Armored PGP private key. Optional -- without it this provider is
                "keyless": it can still send messages (encryption needs only recipients' public
                keys) and still see button taps on salt_ask_human cards (plaintext metadata),
                but cannot decrypt a free-text reply. Defaults to SALT_PGP_PRIVATE_KEY.
            pgp_passphrase: The passphrase protecting pgp_private_key. Defaults to SALT_PGP_PASSPHRASE.

        """
        super().__init__("salt", [])

        self.host = (host or os.environ.get("SALT_HOST") or "").rstrip("/")
        self.agent_id = agent_id or os.environ.get("SALT_AGENT_ID") or ""
        self.api_key = api_key or os.environ.get("SALT_API_KEY") or ""
        missing = [
            name
            for name, value in (
                ("host (SALT_HOST)", self.host),
                ("agent_id (SALT_AGENT_ID)", self.agent_id),
                ("api_key (SALT_API_KEY)", self.api_key),
            )
            if not value
        ]
        if missing:
            raise ValueError(
                f"SaltActionProvider is missing required configuration: {', '.join(missing)}"
            )

        self.pgp_private_key = pgp_private_key or os.environ.get("SALT_PGP_PRIVATE_KEY") or None
        self.pgp_passphrase = pgp_passphrase or os.environ.get("SALT_PGP_PASSPHRASE") or ""

        self.client = SaltClient(self.host)

    # -- small helpers the `saltapp` package doesn't wrap yet (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)) --

    def _get_user_by_handle(self, handle: str) -> dict[str, Any] | None:
        """Public: resolve a Salt handle to its user record. No auth needed -- salt-api's users#show is public by design."""
        try:
            return self.client._request("GET", f"/api/v1/users/{handle}", self.api_key)
        except SaltApiError as exc:
            if exc.status == 404:
                return None
            raise

    def _list_wallets(self) -> list[dict[str, Any]]:
        return self.client._request("GET", "/api/v1/wallets", self.api_key)

    def _list_transfer_requests(self) -> list[dict[str, Any]]:
        return self.client._request("GET", "/api/v1/transfer_requests", self.api_key)

    def _resolve_user_id(self, explicit_id: str | None, handle: str | None) -> str:
        if explicit_id:
            return explicit_id
        user = self._get_user_by_handle(handle)  # type: ignore[arg-type]
        if not user:
            raise ValueError(f'No Salt user found for handle "{handle}".')
        return user["id"]

    def _find_transfer_request(self, request_id: str) -> dict[str, Any] | None:
        """Find a transfer request by id.

        salt-api has no `GET /transfer_requests/:id` today -- only index is wired up, scoped to
        requests this agent sent or received. Looking one up by id means paging that index and
        filtering client-side.
        """
        for request in self._list_transfer_requests():
            if _same_id(request.get("id"), request_id):
                return request
        return None

    def _pick_wallet(self, chain: str, testnet: bool) -> dict[str, Any]:
        cfg = SALT_CHAINS[chain]
        for wallet in self._list_wallets():
            if wallet.get("chain") == cfg.name_3 and bool(wallet.get("testnet")) == testnet:
                return wallet
        raise ValueError(
            f"This agent has no Salt wallet on {cfg.display_name} ({'testnet' if testnet else 'mainnet'}). "
            "Create one for this agent on Salt first (POST /api/v1/wallets, or via the agent's own dashboard), then retry."
        )

    def _asset_note(self, asset: str, chain: str) -> str:
        if asset != "usdc":
            return ""
        if chain == "bsc":
            raise ValueError(
                "USDC isn't offered on bsc here: Circle doesn't issue native USDC on BNB Smart Chain, only a "
                "separate Binance-Peg token, and guessing which one you mean is not a safe default for a payment "
                "request. Use native BNB, or a chain where Circle-native USDC exists."
            )
        return (
            " (USDC -- note: Salt's payment-request rail has no structured asset field yet; this is a note for the "
            "human, not something Salt enforces on-chain)"
        )

    # -- salt_send_message --------------------------------------------------

    @create_action(
        name="salt_send_message",
        description="""
Send an end-to-end encrypted chat message on Salt (saltapp.ai) to a Salt @handle or an existing chat.

It takes:
- Exactly one of chat_id (an existing Salt chat) or handle (a Salt @handle -- opens or reuses the 1:1 chat with them)
- message: the plaintext to send

The message is PGP-encrypted client-side for every current member of the chat before it is posted -- Salt's own
server never sees the plaintext. If nobody in the chat has a public key on file, this refuses to send rather than
posting anything unencrypted.
""",
        schema=SaltSendMessageSchema,
    )
    def salt_send_message(self, args: dict[str, Any]) -> str:
        """Send an end-to-end encrypted message to a Salt handle or an existing chat."""
        try:
            validated = SaltSendMessageSchema(**args)
            chat_id = validated.chat_id
            if not chat_id:
                user = self._get_user_by_handle(validated.handle)  # type: ignore[arg-type]
                if not user:
                    return f'Error: no Salt user found for handle "{validated.handle}".'
                chat = self.client.create_or_get_chat(self.api_key, user["id"])
                chat_id = chat["id"]

            members = self.client.get_chat_members(self.api_key, chat_id)
            recipient_keys = [m["public_key"] for m in members if m.get("public_key")]
            if not recipient_keys:
                return f"Error: no member of chat {chat_id} has a public key on file. Refusing to send unencrypted."

            ciphertext = crypto.encrypt_for(validated.message, recipient_keys)
            self_member = next((m for m in members if _same_id(m.get("id"), self.agent_id)), None)
            sender_message = (
                crypto.encrypt_for(validated.message, [self_member["public_key"]])
                if self_member and self_member.get("public_key")
                else None
            )

            posted = self.client.post_message(
                self.api_key, chat_id, ciphertext, sender_message, mentions=validated.mentions
            )
            return f"Sent, encrypted for {len(recipient_keys)} member(s), in chat {chat_id}. Message id: {posted.get('id')}."
        except Exception as e:
            return f"Error sending Salt message: {e!s}"

    # -- salt_ask_human / salt_get_answer ------------------------------------

    @create_action(
        name="salt_ask_human",
        description="""
Ask ONE named human a question on Salt, as a card with option buttons restricted so only they can answer.

It takes chat_id, exactly one of human_id/human_handle, question, options (1-5 button labels), and
timeout_seconds (default and max 50). Waits for an answer up to timeout_seconds. If someone answers in
time, returns their answer directly. If not, returns a pending result with an ask_id -- call
salt_get_answer with that ask_id to keep waiting, rather than asking again.
""",
        schema=SaltAskHumanSchema,
    )
    def salt_ask_human(self, args: dict[str, Any]) -> str:
        """Ask a human a question as a restricted-button card and wait for an answer."""
        try:
            validated = SaltAskHumanSchema(**args)
            human_id = self._resolve_user_id(validated.human_id, validated.human_handle)

            option_labels: dict[str, str] = {}
            buttons = []
            for i, label in enumerate(validated.options):
                action_id = f"salt_ask_{i}_{os.urandom(4).hex()}"
                option_labels[action_id] = label
                buttons.append(button(action_id, label, restricted_to=[human_id]))
            blocks = [
                section(text=validated.question),
                card_actions(buttons),
                section(text="Or just reply with your own answer."),
            ]
            # The response is the card's chat BUBBLE, not the card itself --
            # see ask_poll.py's HANDOFF.md (github.com/0000F8/saltapp-agentkit) reference. `resource_id` is the
            # card's own id (what `_get_card`/`_mark_card_answered` poll and
            # PATCH); `message_id` is the bubble's own id, the fixed anchor
            # the free-text-reply check reads the chat from.
            card = self.client.post_card(
                self.api_key, validated.chat_id, blocks, validated.question
            )
            card_id = card.get("resource_id") or (card.get("resource") or {}).get("id")
            if not card_id:
                raise RuntimeError(
                    "Salt didn't return this card's id -- can't poll it for an answer."
                )
            message_id = card.get("message_id")

            outcome = poll_for_answer(
                self.client,
                self.api_key,
                AskState(
                    chat_id=validated.chat_id,
                    card_id=card_id,
                    human_id=human_id,
                    options=option_labels,
                    after=None,
                    message_id=message_id,
                ),
                validated.timeout_seconds,
                can_decrypt=bool(self.pgp_private_key),
                decrypt_one=self._decrypt_one,
            )

            if outcome.status == "answered":
                self._mark_card_answered(card_id, validated.question, outcome.answer)
                return f"Answered ({outcome.via}): {outcome.answer}{self._transfer_note(outcome)}"
            note = f" Note: {outcome.note}" if outcome.note else ""
            return f'Pending -- no answer within {validated.timeout_seconds}s. Call salt_get_answer with ask_id "{outcome.ask_id}" to keep waiting.{note}'
        except Exception as e:
            return f"Error asking human on Salt: {e!s}"

    @create_action(
        name="salt_get_answer",
        description="""
Check whether a pending salt_ask_human question has been answered, waiting up to timeout_seconds (default and
max 50) for a new answer. Takes the ask_id a pending salt_ask_human (or a previous pending salt_get_answer)
returned.
""",
        schema=SaltGetAnswerSchema,
    )
    def salt_get_answer(self, args: dict[str, Any]) -> str:
        """Check whether a pending salt_ask_human question has been answered."""
        try:
            validated = SaltGetAnswerSchema(**args)
            state = decode_ask_id(validated.ask_id)
            outcome = poll_for_answer(
                self.client,
                self.api_key,
                state,
                validated.timeout_seconds,
                can_decrypt=bool(self.pgp_private_key),
                decrypt_one=self._decrypt_one,
            )
            if outcome.status == "answered":
                if state.card_id:
                    self._mark_card_answered(state.card_id, None, outcome.answer)
                return f"Answered ({outcome.via}): {outcome.answer}{self._transfer_note(outcome)}"
            note = f" Note: {outcome.note}" if outcome.note else ""
            return f'Still pending -- no answer within {validated.timeout_seconds}s. Call salt_get_answer with ask_id "{outcome.ask_id}" to keep waiting.{note}'
        except Exception as e:
            return f"Error checking Salt answer: {e!s}"

    def _decrypt_one(self, armored: str) -> str:
        return crypto.decrypt(armored, self.pgp_private_key or "", self.pgp_passphrase or "")

    def _mark_card_answered(self, card_id: str, question: str | None, answer: str | None) -> None:
        try:
            blocks = (
                [section(text=question), section(text=f"Answered: {answer}")]
                if question
                else [section(text=f"Answered: {answer}")]
            )
            self.client.update_card(self.api_key, card_id, blocks)
        except Exception:  # best-effort: the answer itself is already resolved either way
            pass

    @staticmethod
    def _transfer_note(outcome: AskOutcome) -> str:
        """Render a button tap's transfer_request_id/status, if present.

        See ask_poll.py's AskOutcome -- these are dead weight for THIS
        provider today (salt_ask_human's own buttons are never
        `type: "pay"`) but cost nothing to surface when a future card type
        populates them.
        """
        if outcome.via != "button" or not outcome.transfer_request_id:
            return ""
        return f" (this tap also carries a payment request: {outcome.transfer_request_id}, status {outcome.transfer_request_status}.)"

    # -- money: request / invoice / status / pay ----------------------------

    @create_action(
        name="salt_request_payment",
        description="""
Request a plain (non-itemized) payment from a human or agent in a Salt chat, on Salt's TransferRequest rail.

Takes chat_id, exactly one of payer_id/payer_handle, amount (human-decimal string), chain (one of ethereum,
polygon, arbitrum, optimism, base, bsc, avalanche), testnet (default true), asset ("native" or "usdc",
default "native"), and an optional message. Requires this agent to already have a Salt wallet on the
requested chain/testnet -- it does not create one.
""",
        schema=SaltRequestPaymentSchema,
    )
    def salt_request_payment(self, args: dict[str, Any]) -> str:
        """Request a plain payment from a human or agent in a chat."""
        try:
            validated = SaltRequestPaymentSchema(**args)
            note = self._asset_note(validated.asset, validated.chain)
            payer_id = self._resolve_user_id(validated.payer_id, validated.payer_handle)
            wallet = self._pick_wallet(validated.chain, validated.testnet)
            message = f"{validated.message or ''}{note}".strip() or None
            request = self.client.request_payment(
                self.api_key,
                chat_id=validated.chat_id,
                receiver_id=payer_id,
                wallet_id=wallet["id"],
                amount=validated.amount,
                message=message,
            )
            symbol = wallet.get("name_3") or SALT_CHAINS[validated.chain].display_name
            return f"Requested {validated.amount} {symbol}{note} from {payer_id} in chat {validated.chat_id}. Request id: {request.get('id')}, status: {request.get('status')}."
        except Exception as e:
            return f"Error requesting payment on Salt: {e!s}"

    @create_action(
        name="salt_send_invoice",
        description="""
Send an itemized invoice to a human or agent in a Salt chat, on the same rail as salt_request_payment.
Takes chat_id, exactly one of payer_id/payer_handle, line_items (name/qty/unit_price -- subtotal and the
total amount are computed here, not asked of you), chain, testnet (default true), asset ("native" or
"usdc"), an optional message, and an optional ISO-8601 due_at.
""",
        schema=SaltSendInvoiceSchema,
    )
    def salt_send_invoice(self, args: dict[str, Any]) -> str:
        """Send an itemized invoice to a human or agent in a chat."""
        try:
            validated = SaltSendInvoiceSchema(**args)
            note = self._asset_note(validated.asset, validated.chain)
            payer_id = self._resolve_user_id(validated.payer_id, validated.payer_handle)
            wallet = self._pick_wallet(validated.chain, validated.testnet)

            total = Decimal(0)
            line_items = []
            for item in validated.line_items:
                subtotal = Decimal(str(item.qty)) * Decimal(item.unit_price)
                total += subtotal
                line_items.append(
                    {
                        "name": item.name,
                        "qty": item.qty,
                        "unit_price": item.unit_price,
                        "subtotal": _format_amount(subtotal),
                    }
                )

            message = f"{validated.message or ''}{note}".strip() or None
            request = self.client.create_invoice(
                self.api_key,
                chat_id=validated.chat_id,
                receiver_id=payer_id,
                wallet_id=wallet["id"],
                amount=_format_amount(total),
                line_items=line_items,
                message=message,
                due_at=validated.due_at,
            )
            symbol = wallet.get("name_3") or ""
            return (
                f"Sent an invoice for {_format_amount(total)} {symbol}{note} ({len(line_items)} item(s)) to {payer_id} in chat "
                f"{validated.chat_id}. Invoice id: {request.get('id')}, status: {request.get('status')}."
            )
        except Exception as e:
            return f"Error sending invoice on Salt: {e!s}"

    @create_action(
        name="salt_get_payment_status",
        description="""
Look up the current status of a Salt payment request or invoice this agent sent or received. Takes
request_id. Status is one of Pending, Paying, Completed, Declined, Cancelled.
""",
        schema=SaltGetPaymentStatusSchema,
    )
    def salt_get_payment_status(self, args: dict[str, Any]) -> str:
        """Look up the status of a payment request or invoice."""
        try:
            validated = SaltGetPaymentStatusSchema(**args)
            request = self._find_transfer_request(validated.request_id)
            if not request:
                return f"No such payment request/invoice (or this agent isn't party to it): {validated.request_id}."
            wallet = request.get("wallet") or {}
            failure = (
                f" Last attempt failed: {request['last_failed_reason']}."
                if request.get("last_failed_reason")
                else ""
            )
            return f"Request {request.get('id')}: {request.get('status')}, amount {request.get('amount')} {wallet.get('name_3', '')}.{failure}"
        except Exception as e:
            return f"Error checking Salt payment status: {e!s}"

    @create_action(
        name="salt_pay_request",
        description="""
Pay an incoming Salt payment request directly from this AgentKit agent's own wallet -- a real on-chain EVM
transfer, sent and broadcast by the connected wallet provider, not by Salt's own wallet system.

Takes ONLY request_id. Amount and destination address are read from the request itself and are never taken
from arguments here. Refuses to pay: a request not addressed to this exact agent, a request that isn't
Pending, a request whose chain doesn't match the currently connected wallet's network, or a request that
looks like it wants USDC (Salt's request rail has no structured asset field, so this only pays native
currency).

Important: Salt's own record of this request will still show "Pending" afterward -- see the provider README
and HANDOFF.md (github.com/0000F8/saltapp-agentkit). This action posts a receipt message with the transaction hash into the request's chat as
the best available substitute.
""",
        schema=SaltPayRequestSchema,
    )
    def salt_pay_request(self, wallet_provider: EvmWalletProvider, args: dict[str, Any]) -> str:
        """Pay an incoming Salt payment request from this agent's own wallet."""
        try:
            validated = SaltPayRequestSchema(**args)
            request = self._find_transfer_request(validated.request_id)
            if not request:
                return f"No such payment request (or this agent isn't party to it): {validated.request_id}."
            if not _same_id(request.get("receiver_id"), self.agent_id):
                return f"Error: request {validated.request_id} is not addressed to this agent (receiver_id {request.get('receiver_id')}). Refusing to pay someone else's request."
            if request.get("status") != "Pending":
                return f"Error: request {validated.request_id} is {request.get('status')}, not Pending. Nothing to pay."
            wallet = request.get("wallet")
            if not wallet:
                return f"Error: request {validated.request_id} has no receiving wallet on file."
            if re.search(r"\busdc\b", request.get("message") or "", re.IGNORECASE):
                return (
                    f"Error: request {validated.request_id}'s note mentions USDC, but Salt's TransferRequest rail has "
                    "no structured asset field for this action to trust, and this action only ever sends the chain's "
                    "native currency. Refusing to guess -- pay it manually, or ask the requester to confirm before retrying."
                )

            network = wallet_provider.get_network()
            resolved = (
                salt_chain_for_evm_chain_id(int(network.chain_id)) if network.chain_id else None
            )
            if (
                not resolved
                or resolved[0] != wallet["chain"]
                or resolved[1] != bool(wallet.get("testnet"))
            ):
                return (
                    f"Error: this wallet is connected to chain id {network.chain_id}, but request {validated.request_id} "
                    f"is on {wallet['chain']} ({'testnet' if wallet.get('testnet') else 'mainnet'}). Switch the wallet "
                    "provider's network and retry."
                )

            value_wei = int(Decimal(str(request["amount"])) * (10**NATIVE_DECIMALS))
            tx_hash = wallet_provider.send_transaction(
                {"to": wallet["public_address"], "value": value_wei}
            )
            wallet_provider.wait_for_transaction_receipt(tx_hash)

            receipt_note = ""
            chat_id = request.get("chat_id")
            if chat_id:
                try:
                    members = self.client.get_chat_members(self.api_key, chat_id)
                    keys = [m["public_key"] for m in members if m.get("public_key")]
                    if keys:
                        ciphertext = crypto.encrypt_for(
                            f"Paid this request on-chain. Transaction hash: {tx_hash}", keys
                        )
                        self.client.post_message(self.api_key, chat_id, ciphertext)
                        receipt_note = " Posted a receipt with the tx hash into the request's chat."
                except Exception:  # best-effort: the payment itself already happened
                    pass

            return (
                f"Paid {request['amount']} {wallet.get('name_3', '')} to {wallet['public_address']} for request "
                f"{validated.request_id}. Transaction hash: {tx_hash}.{receipt_note} Note: Salt's own request status "
                'will still read "Pending" until a human reconciles it or salt-api adds a way to report an '
                "externally-broadcast payment (see HANDOFF.md (github.com/0000F8/saltapp-agentkit))."
            )
        except Exception as e:
            return f"Error paying Salt request: {e!s}"

    def supports_network(self, network: Network) -> bool:
        """Only EVM networks are supported."""
        return network.protocol_family == "evm"


def salt_action_provider(
    host: str | None = None,
    agent_id: str | None = None,
    api_key: str | None = None,
    pgp_private_key: str | None = None,
    pgp_passphrase: str | None = None,
) -> SaltActionProvider:
    """Create a new instance of the Salt action provider."""
    return SaltActionProvider(
        host=host,
        agent_id=agent_id,
        api_key=api_key,
        pgp_private_key=pgp_private_key,
        pgp_passphrase=pgp_passphrase,
    )
