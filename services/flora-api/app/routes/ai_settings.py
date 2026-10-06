"""Configure the shared AI / LLM service. Canopy edits it; Leafs show their synced copy."""
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from psycopg import Connection
from pydantic import BaseModel, Field

from .. import ai_service, directory
from ..database import connection


class AiServiceInput(BaseModel):
    api_format: Literal["anthropic", "openai"] = "anthropic"
    host: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=200)
    # None keeps the stored key, "" clears it.
    api_key: str | None = Field(default=None, max_length=2000)


def _config_manager():
    if directory.is_leaf():
        from .auth_leaf import require_permission
        return require_permission("config.manage")
    from .canopy_preferences import require_canopy_permission
    return require_canopy_permission("config.manage")


def build_router() -> APIRouter:
    router = APIRouter(prefix="/api/auth/preferences/ai-service", tags=["ai service"])
    manager = _config_manager()

    @router.get("")
    def get_ai_service(_: dict = Depends(manager), database: Connection = Depends(connection)) -> dict[str, Any]:
        return {**ai_service.public(ai_service.load(database)), "managedBy": "leaf-sync" if directory.is_leaf() else "canopy"}

    @router.put("")
    def put_ai_service(payload: AiServiceInput, user: dict = Depends(manager),
                       database: Connection = Depends(connection)) -> dict[str, Any]:
        if directory.is_leaf():
            raise HTTPException(status_code=409, detail="the AI service is configured in Canopy")
        if payload.api_format == "openai" and not payload.host.strip():
            raise HTTPException(status_code=400, detail="host is required for an OpenAI-compatible service")
        saved = ai_service.save(database, api_format=payload.api_format, host=payload.host, model=payload.model,
                                api_key=payload.api_key, actor=user.get("username"))
        return {**ai_service.public(saved), "managedBy": "canopy"}

    @router.post("/test")
    def test_ai_service(payload: AiServiceInput | None = None, _: dict = Depends(manager),
                        database: Connection = Depends(connection)) -> dict[str, Any]:
        """Test the saved settings, or unsaved form values (a blank key uses the saved key)."""
        config = ai_service.load(database)
        if payload is not None:
            config = {**config, "api_format": payload.api_format, "host": payload.host.strip().rstrip("/"),
                      "model": payload.model.strip(),
                      "api_key": config.get("api_key") if payload.api_key is None else payload.api_key.strip()}
        return ai_service.test(config)

    return router
