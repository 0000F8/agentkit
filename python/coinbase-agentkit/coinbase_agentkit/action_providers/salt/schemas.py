"""Schemas for the Salt action provider."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

SALT_CHAINS = ["ethereum", "polygon", "arbitrum", "optimism", "base", "bsc", "avalanche"]
SaltChain = Literal["ethereum", "polygon", "arbitrum", "optimism", "base", "bsc", "avalanche"]
SaltAsset = Literal["native", "usdc"]

_CHAIN_DESCRIPTION = "The chain, using Salt's own chain names: ethereum, polygon, arbitrum, optimism, base, bsc, avalanche"
_ASSET_DESCRIPTION = (
    '"native" = the chain\'s own gas token (ETH/MATIC/BNB/AVAX); "usdc" = Circle-issued USDC, where Salt/AgentKit\'s '
    "shared chains issue it. Not available on bsc (see the provider README). Salt's payment-request rail has no "
    "structured asset field -- this is recorded only as a note in the request's message text for the human to read, "
    "never enforced on-chain by Salt itself."
)


class SaltSendMessageSchema(BaseModel):
    """Send an end-to-end encrypted message to a Salt handle or an existing chat."""

    chat_id: str | None = Field(None, description="An existing Salt chat id to post into")
    handle: str | None = Field(
        None, description="A Salt @handle to message 1:1 (creates or reuses the 1:1 chat)"
    )
    message: str = Field(
        ...,
        min_length=1,
        description="The plaintext to send. Encrypted client-side for every chat member's public key before it is "
        "posted -- Salt's server never sees plaintext.",
    )
    mentions: list[str] | None = Field(
        None,
        description="User ids to @-mention (drives their mention notification; Salt cannot infer this from ciphertext)",
    )

    @model_validator(mode="after")
    def _exactly_one_target(self) -> SaltSendMessageSchema:
        if bool(self.chat_id) == bool(self.handle):
            raise ValueError("Provide exactly one of chat_id or handle, not both and not neither.")
        return self


class SaltAskHumanSchema(BaseModel):
    """Ask a specific human a question as a card with option buttons restricted so only they can answer."""

    chat_id: str = Field(
        ..., description="The Salt chat both this agent and the human are already in"
    )
    human_id: str | None = Field(
        None, description="The Salt user id of the ONE human allowed to answer"
    )
    human_handle: str | None = Field(
        None,
        description="The Salt @handle of the ONE human allowed to answer, if the id isn't known",
    )
    question: str = Field(..., min_length=1, description="The question to ask")
    options: list[str] = Field(
        ...,
        min_length=1,
        max_length=5,
        description='Button labels the human can tap, e.g. ["Yes", "No"]',
    )
    timeout_seconds: int = Field(
        50,
        ge=1,
        le=50,
        description="How long to wait for an answer before returning pending, in seconds. Capped at 50 -- Salt's "
        "short-poll socket mode itself is clamped to a 0-2s wait per request, so this action polls it repeatedly up "
        "to this budget.",
    )

    @model_validator(mode="after")
    def _exactly_one_answerer(self) -> SaltAskHumanSchema:
        if bool(self.human_id) == bool(self.human_handle):
            raise ValueError(
                "Provide exactly one of human_id or human_handle, not both and not neither."
            )
        return self


class SaltGetAnswerSchema(BaseModel):
    """Check whether a pending salt_ask_human question has been answered yet."""

    ask_id: str = Field(
        ...,
        min_length=1,
        description="The ask_id returned by a pending salt_ask_human/salt_get_answer call",
    )
    timeout_seconds: int = Field(
        50,
        ge=1,
        le=50,
        description="How long to keep waiting for an answer, in seconds. Capped at 50.",
    )


class SaltRequestPaymentSchema(BaseModel):
    """Request a plain (non-itemized) payment from a human or agent in a chat."""

    chat_id: str = Field(..., description="The chat to post the request into")
    payer_id: str | None = Field(None, description="The Salt user id being asked to pay")
    payer_handle: str | None = Field(
        None, description="The Salt @handle being asked to pay, if the id isn't known"
    )
    amount: str = Field(
        ...,
        min_length=1,
        description='A human-decimal amount, e.g. "12.50" -- never base units (wei)',
    )
    chain: SaltChain = Field(..., description=_CHAIN_DESCRIPTION)
    testnet: bool = Field(True, description="true for the chain's testnet, false for mainnet")
    asset: SaltAsset = Field("native", description=_ASSET_DESCRIPTION)
    message: str | None = Field(None, description="A note shown on the request bubble")

    @model_validator(mode="after")
    def _exactly_one_payer(self) -> SaltRequestPaymentSchema:
        if bool(self.payer_id) == bool(self.payer_handle):
            raise ValueError(
                "Provide exactly one of payer_id or payer_handle, not both and not neither."
            )
        return self


class InvoiceLineItem(BaseModel):
    """One line item on a salt_send_invoice call."""

    name: str = Field(..., min_length=1, description="Line item description")
    qty: float = Field(..., gt=0, description="Quantity")
    unit_price: str = Field(..., min_length=1, description='Human-decimal unit price, e.g. "4.99"')


class SaltSendInvoiceSchema(BaseModel):
    """Send an itemized invoice to a human or agent in a chat, on the same rail as salt_request_payment."""

    chat_id: str = Field(..., description="The chat to post the invoice into")
    payer_id: str | None = Field(None, description="The Salt user id being invoiced")
    payer_handle: str | None = Field(
        None, description="The Salt @handle being invoiced, if the id isn't known"
    )
    line_items: list[InvoiceLineItem] = Field(
        ...,
        min_length=1,
        description="Itemized charges. subtotal = qty * unit_price is computed here, not asked of the model.",
    )
    chain: SaltChain = Field(..., description=_CHAIN_DESCRIPTION)
    testnet: bool = Field(True, description="true for the chain's testnet, false for mainnet")
    asset: SaltAsset = Field("native", description=_ASSET_DESCRIPTION)
    message: str | None = Field(None, description="A note shown on the invoice bubble")
    due_at: str | None = Field(None, description="ISO 8601 due date")

    @model_validator(mode="after")
    def _exactly_one_payer(self) -> SaltSendInvoiceSchema:
        if bool(self.payer_id) == bool(self.payer_handle):
            raise ValueError(
                "Provide exactly one of payer_id or payer_handle, not both and not neither."
            )
        return self


class SaltGetPaymentStatusSchema(BaseModel):
    """Look up the current status of a payment request or invoice this agent sent or received."""

    request_id: str = Field(
        ...,
        min_length=1,
        description="The TransferRequest id returned by salt_request_payment or salt_send_invoice",
    )


class SaltPayRequestSchema(BaseModel):
    """Pay an incoming Salt payment request from this agent's own AgentKit wallet."""

    request_id: str = Field(
        ...,
        min_length=1,
        description="The TransferRequest id of an incoming request addressed to THIS agent. Amount and destination "
        "are read from the request itself, never from arguments here -- this action refuses to pay an amount or "
        "address supplied directly.",
    )
