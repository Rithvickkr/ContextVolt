"""
ContextVolt — Pydantic models for request / response validation.
"""

from pydantic import BaseModel


class SummarizeRequest(BaseModel):
    """Request body for the /api/summarize endpoint."""
    text: str


class CaptureRequest(BaseModel):
    """Request body for the /api/capture endpoint from the browser extension."""
    text: str
    source: str = "Extension"
    important_snippets: list[str] = []


class SummaryData(BaseModel):
    """Structured summary returned by the LLM."""
    main_topic: str = ""
    key_ideas: list[str] = []
    snapshot: str = ""
    vitals: list[str] = []
    conclusions: list[str] = []
    unresolved_questions: list[str] = []


class PromptRequest(BaseModel):
    """Optional body for POST /api/contexts/{id}/prompt — enables retrieval mode."""
    query: str | None = None
    size: str = "standard"


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
    important_notes: list[str] | None = None


class ContextResponse(BaseModel):
    """Response model for a single context."""
    id: int
    title: str
    summary: SummaryData | dict
    tags: list[str]
    original_chat: str
    status: str = "completed"
    created_at: str
    updated_at: str


class EmbedModelSelect(BaseModel):
    """Request body for selecting the embedding model."""
    model: str


class ModelSelect(BaseModel):
    """Request body for selecting the main LLM model."""
    model: str

