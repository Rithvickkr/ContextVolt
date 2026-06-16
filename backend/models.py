"""
ContextVolt — Pydantic models for request / response validation.
"""

from pydantic import BaseModel


class SummarizeRequest(BaseModel):
    """Request body for the /api/summarize endpoint."""
    text: str


class CaptureRequest(BaseModel):
    """Request body for the /api/capture endpoint (browser extension + in-app Quick Capture)."""
    text: str
    source: str = "Extension"
    important_snippets: list[str] = []
    conversation_url: str = ""
    # Context the user pasted into this conversation via "From Vault" — lets a
    # save from a different conversation URL update that context in place.
    imported_context_id: int | None = None
    # In-app Quick Capture extras (extension leaves these at defaults).
    method: str = "Extension"          # capture-method tag ("Extension" | "Quick Capture")
    title: str | None = None           # user-provided title (else auto from summary)
    tags: list[str] = []               # user tags, merged with source/method
    collection_id: int | None = None   # assign to a collection on create


class SummaryData(BaseModel):
    """Structured summary returned by the LLM."""
    main_topic: str = ""
    key_ideas: list[str] = []
    snapshot: str = ""
    vitals: list[str] = []
    conclusions: list[str] = []
    unresolved_questions: list[str] = []


class PromptRequest(BaseModel):
    """Optional body for POST /api/contexts/{id}/prompt — enables retrieval mode.

    `size` defaults to None (not "standard") so callers can pass a query in
    the body while letting the `?size=` query param decide the tier. When
    both are None the endpoint falls back to "standard".
    """
    query: str | None = None
    size: str | None = None


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


class CollectionCreate(BaseModel):
    name: str
    color: str = "#6366f1"


class CollectionUpdate(BaseModel):
    name: str | None = None
    color: str | None = None


class ContextCollectionSet(BaseModel):
    collection_id: int | None = None


class CloudKeySet(BaseModel):
    """Request body for saving a cloud API key."""
    provider: str  # "openai" | "anthropic" | "google"
    api_key: str
    model: str | None = None  # optional model override


class ProviderSelect(BaseModel):
    """Request body for switching the active LLM provider."""
    provider: str  # "ollama" | "openai" | "anthropic" | "google"
    model: str | None = None


class CloudKeyValidate(BaseModel):
    """Request body for validating a cloud API key."""
    provider: str
    api_key: str


class UserProfileUpdate(BaseModel):
    """Request body for saving user profile info."""
    name: str = ""
    about: str = ""



