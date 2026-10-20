"""The wait/resume machinery behind salt_ask_human / salt_get_answer.

An AgentKit action is a single stateless function call -- there is no
long-running process here the way saltapp.agent.Agent assumes (it keeps an
`_AskRegistry` alive across an entire webhook/socket server's lifetime).
So instead of in-memory state, the "ask" is a self-contained continuation:
everything needed to resume waiting -- the card, its button-to-label map,
the expected answerer, the chat, the card's own interaction cursor, and the
card's own chat bubble message id (the anchor for a free-text-reply read)
-- travels in `ask_id` itself (a base64 JSON token), and salt_get_answer
just decodes it and picks the poll back up. This also means an ask
survives the AgentKit process restarting between salt_ask_human and
salt_get_answer, which an in-memory registry would not.

Neither check here reads the shared, per-agent socket-mode outbox
(GET /api/v1/agent/updates) at all -- see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries.
A button tap reads the tapped card's own interaction log
(GET /api/v1/cards/:id); a free-text reply reads the chat itself, since
the card's own bubble (GET /api/v1/chats/:chat_id?last=<message_id>). Both
are idempotent, per-ask reads that share no state with any other ask, this
agent's other checks, or any other consumer of this agent's outbox --
unlike the outbox, which kept exactly one forward-only ack cursor PER
AGENT and could not be read by two independent checks without one
silently stealing the other's rows.
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

from saltapp.client import SaltClient

# Neither the card read nor the chat read has a server-side bounded wait
# the way the old outbox's `timeout=` parameter did, so this loop paces
# itself: an iteration that resolves nothing sleeps at least this long
# before trying again, rather than spinning as fast as the network
# round-trip allows. Mirrors salt-mcp's MIN_EMPTY_POLL_MS (1s), simplified
# to apply every non-resolving iteration uniformly rather than only a
# truly-empty one -- this loop reads two different endpoints per
# iteration, and "empty" would have to be defined as "neither card nor
# chat had anything new," which is more bookkeeping than the pacing floor
# is worth here.
MIN_EMPTY_POLL_SECONDS = 1.0


@dataclass
class AskState:
    """Where a resumable ask stands: which chat and card, and the last interaction seen."""

    chat_id: str
    card_id: str | None
    human_id: str
    options: dict[str, str]  # action_id -> label
    # The newest card interaction id/timestamp already consumed (salt-api
    # 0.96.0, GET /api/v1/cards/:id) -- never resume the button-tap check
    # from before this. `None` until the card's first interaction is seen
    # (a freshly posted card has none yet).
    after: Any = None
    # The card's own chat bubble message id (`post_card`'s response
    # `message_id`) -- the FIXED anchor `GET /api/v1/chats/:chat_id?last=`
    # reads from for the free-text-reply check. Fixed, never advanced:
    # every check re-reads everything since the ask began (capped at 200
    # rows server-side), so there is no separate message cursor to track
    # or lose between calls. `None` only for a hand-constructed AskState
    # with no card at all (see tests) -- `get_chat` with no `last` degrades
    # to "the ten most recent messages" rather than refusing.
    message_id: str | None = None
    v: int = 1


def encode_ask_id(state: AskState) -> str:
    """Encode an AskState into the opaque ask_id handed back to the model."""
    payload = {
        "v": state.v,
        "chat_id": state.chat_id,
        "card_id": state.card_id,
        "human_id": state.human_id,
        "options": state.options,
        "after": state.after,
        "message_id": state.message_id,
    }
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def decode_ask_id(ask_id: str) -> AskState:
    """Decode an ask_id back into an AskState."""
    try:
        payload = json.loads(base64.urlsafe_b64decode(ask_id.encode("ascii")).decode("utf-8"))
        return AskState(
            v=payload["v"],
            chat_id=payload["chat_id"],
            card_id=payload["card_id"],
            human_id=payload["human_id"],
            options=payload["options"],
            after=payload.get("after"),
            message_id=payload.get("message_id"),
        )
    except Exception as exc:
        raise ValueError(
            "This ask_id isn't a value salt_ask_human/salt_get_answer produced."
        ) from exc


@dataclass
class AskOutcome:
    """What one check for an answer found."""

    status: str  # "answered" | "pending"
    answer: str | None = None
    via: str | None = None  # "button" | "message"
    ask_id: str | None = None
    note: str | None = None
    # Only ever set on a "button" outcome, and only when the tapped
    # interaction carried them (a "pay" button's tap) -- see
    # `_answer_from_interaction` below.
    transfer_request_id: str | None = None
    transfer_request_status: str | None = None


def _get_card(client: SaltClient, api_key: str, card_id: str, after: Any = None) -> dict[str, Any]:
    """Fetch one card (GET /api/v1/cards/:id, salt-api 0.96.0).

    Returns the card's own interaction
    log, owner-only (404 for a non-owner, byte-identical to an unknown id).
    `interactions` comes back newest first, capped at 50 server-side.
    `after` (an interaction id or ISO8601 timestamp) asks for only
    interactions strictly newer than that; an unrecognised value fails
    OPEN server-side (the full list, never a 500), so this never needs to
    validate its own cursor before sending it.

    `saltapp.client.SaltClient` has no public `get_card` method as of this
    writing (confirmed: no `def get_card` anywhere in that package) and
    this deliberately does not add one -- another lane is actively working
    in `saltapp-python` right now, so this goes through `_request`, the
    SDK's own underlying method every public call on `SaltClient` is
    already built on, rather than editing a package another lane owns
    mid-edit. See HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s 2026-09-26 entries.
    """
    path = f"/api/v1/cards/{quote(str(card_id), safe='')}"
    if after is not None and after != "":
        path += f"?after={quote(str(after), safe='')}"
    return client._request(
        "GET", path, api_key
    )  # see docstring for why this reaches past the public API


def _answer_from_interaction(options: dict[str, str], interaction: dict[str, Any]) -> AskOutcome:
    """Build a button AskOutcome from one matched card interaction.

    `transfer_request_id`/`transfer_request_status` ride along when the
    interaction carries them -- salt-api's GET /api/v1/cards/:id only sets
    them on a "pay" button's tap, live status included, which is genuinely
    new information the old outbox event body never carried.
    salt_ask_human's own buttons are plain option buttons today, never
    `type: "pay"`, so these are normally absent; threaded through anyway
    (mirrors salt-mcp's `answerFromInteraction`, and the TypeScript
    sibling's identical helper) so the next card type that reuses this
    poll doesn't need its own answer-shaping code.
    """
    action_id = interaction.get("action_id")
    answer = options.get(action_id, interaction.get("value", action_id))
    return AskOutcome(
        status="answered",
        answer=answer,
        via="button",
        transfer_request_id=interaction.get("transfer_request_id"),
        transfer_request_status=interaction.get("transfer_request_status"),
    )


def poll_for_answer(
    client: SaltClient,
    api_key: str,
    state: AskState,
    budget_seconds: float,
    *,
    can_decrypt: bool,
    decrypt_one: Callable[[str], str],
) -> AskOutcome:
    """Poll for up to `budget_seconds` for an answer to this ask.

    Looks for either a tap on one of this ask's own card buttons, or (if
    this provider has a private key configured) a plain-text reply from
    the named human.

    Two independent checks per iteration, either of which can resolve the
    ask:

    1. The card's OWN interaction log (salt-api 0.96.0, GET
       /api/v1/cards/:id, via `_get_card` above), matched on `action_id`
       (one of `state.options`) AND `user_id` (the named human) --
       stricter than salt-mcp's own card poll, which trusts `action_id`
       alone; kept here anyway as free defense-in-depth, matching what
       this check verified back when it read the shared outbox. Reading
       one card by id is idempotent and shares nothing with any other
       ask, so any number of concurrent salt_ask_human/salt_get_answer
       calls -- for this agent or any other agent -- can each resolve
       their own ask independently. On a match, this returns immediately
       WITHOUT ever reaching step 2 that iteration.

    2. If no button match: a free-text reply, via `client.get_chat(...,
       last=state.message_id)` -- the chat itself, anchored on the ask's
       own card's chat bubble (salt-api `chats_controller#show`, an
       existing public method on `saltapp.client.SaltClient`). Also
       idempotent and shares nothing with any other ask: unlike the
       outbox this replaced, a chat read has no per-agent shared cursor
       at all, so any number of concurrent asks (for this agent, or any
       other agent, or in the same chat, or in different chats) can each
       read their own history back independently. This is a deliberate
       divergence from salt-mcp's ask_human/get_ask_result, which is
       button-only and has no free-text fallback to worry about at all.

    Neither read has a server-side bounded wait the way the old outbox's
    `timeout=` parameter did, so this loop paces its own empty iterations
    with a real sleep (`MIN_EMPTY_POLL_SECONDS`) rather than spinning.

    This is otherwise unchanged from before the 2026-09-26 pass: it keeps
    its own pre-existing wait LOOP, unlike the TypeScript sibling's
    `checkForAnswer` (a single check per call, per the owner's "never
    poll" rule applied there) -- that rule's application to Python was
    explicitly out of scope for the pass that removed the loop from
    TypeScript (see HANDOFF.md (github.com/0000F8/saltapp-agentkit)'s "Cross-language asymmetry"), and this fix
    does not revisit that decision; it only changes WHERE both checks
    inside the existing loop read from.
    """
    deadline = time.monotonic() + budget_seconds
    after = state.after

    saw_unreadable_reply = False

    while time.monotonic() < deadline:
        if state.card_id:
            card = _get_card(client, api_key, state.card_id, after)
            interactions = card.get("interactions") or []
            # Newest first, per the route's contract -- advance `after` to
            # the newest interaction id seen regardless of whether it
            # matches this ask's own buttons, so a resumed poll never
            # re-reads a row it has already looked at and rejected.
            if interactions and interactions[0].get("id") is not None:
                after = interactions[0]["id"]
            match = next(
                (
                    i
                    for i in interactions
                    if i.get("action_id") in state.options
                    and str(i.get("user_id", "")).lower() == state.human_id.lower()
                ),
                None,
            )
            if match:
                return _answer_from_interaction(state.options, match)

        chat = client.get_chat(api_key, state.chat_id, last=state.message_id)
        for message in chat.get("messages") or []:
            # A system/event row -- membership churn, a call, etc., never
            # something the human typed.
            if message.get("event_type"):
                continue
            sender = message.get("user") or {}
            is_from_human = (
                sender.get("account_type") != "Agent"
                and str(sender.get("id", "")).lower() == state.human_id.lower()
            )
            if not is_from_human or not isinstance(message.get("message"), str):
                continue
            if not can_decrypt:
                saw_unreadable_reply = True
                continue
            try:
                plaintext = decrypt_one(message["message"])
                return AskOutcome(status="answered", answer=plaintext, via="message")
            except Exception:
                continue

        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        time.sleep(min(MIN_EMPTY_POLL_SECONDS, remaining))

    note = (
        "The human replied with a plain-text message this provider couldn't read (no PGP private key configured) -- "
        "only their button taps can resolve this ask. Configure pgp_private_key/pgp_passphrase to read free-text "
        "replies too."
        if saw_unreadable_reply
        else None
    )
    return AskOutcome(
        status="pending",
        ask_id=encode_ask_id(AskState(**{**state.__dict__, "after": after})),
        note=note,
    )
