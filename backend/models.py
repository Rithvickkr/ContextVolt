"""
Context Vault — Pydantic models for request / response validation.
"""

from pydantic import BaseModel


class SummarizeRequest(BaseModel):
    """Request body for the /api/summarize endpoint."""
    text: str


class CaptureRequest(BaseModel):
    """Request body for the /api/capture endpoint from the browser extension."""
    text: str
    source: str = "Extension"


class SummaryData(BaseModel):
    """Structured summary returned by the LLM."""
    main_topic: str = ""
    key_ideas: list[str] = []
    conclusions: list[str] = []
    unresolved_questions: list[str] = []


class ContextCreate(BaseModel):
    """Request body for creating a new context."""
    title: str
    summary: SummaryData
    tags: list[str] = []
    original_chat: str


class ContextUpdate(BaseModel):
    """Request body for updating a context (all fields optional)."""
    title: str | None = None
    summary: SummaryData | None = None
    tags: list[str] | None = None


class ContextResponse(BaseModel):
    """Response model for a single context."""
    id: int
    title: str
    summary: SummaryData | dict
    tags: list[str]
    original_chat: str
    created_at: str
    updated_at: str
