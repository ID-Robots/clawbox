"""ClawBox AI image generation backend for the Hermes agent.

Installed by ClawBox into ``~/.hermes/plugins/image_gen/clawai/`` when the
device is linked to ClawBox AI. It exists because the bundled ``openai``
backend hardcodes ``gpt-image-2``, which the ClawBox AI proxy serves to Max
subscribers only -- so on every other plan an agent that reached for it would
get a model-gate rejection instead of a picture.

Everything here is the device's own credential talking to the device's own
proxy: base URL and model come from ``image_gen.clawai`` in config.yaml, the
token from ``CLAWBOX_AI_TOKEN``, which nothing else in Hermes reads.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from agent.secret_scope import get_secret
from agent.image_gen_provider import (
    DEFAULT_ASPECT_RATIO,
    ImageGenProvider,
    error_response,
    resolve_aspect_ratio,
    save_b64_image,
    success_response,
)

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://clawbox.com/api/ai"
DEFAULT_MODEL = "gpt-image-1-mini"
TOKEN_ENV = "CLAWBOX_AI_TOKEN"

_MODELS: Dict[str, Dict[str, Any]] = {
    "gpt-image-1-mini": {
        "display": "ClawBox AI Images",
        "speed": "~15s",
        "strengths": "Included on every ClawBox AI plan",
    },
    "gpt-image-2": {
        "display": "ClawBox AI Images (Max)",
        "speed": "~40s",
        "strengths": "Highest fidelity -- Max plans only",
    },
}

_SIZES = {
    "landscape": "1536x1024",
    "square": "1024x1024",
    "portrait": "1024x1536",
}


def _config() -> Dict[str, Any]:
    """Read ``image_gen.clawai`` from config.yaml (returns {} on any failure)."""
    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        section = cfg.get("image_gen") if isinstance(cfg, dict) else None
        if not isinstance(section, dict):
            return {}
        mine = section.get("clawai")
        return mine if isinstance(mine, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.debug("Could not load image_gen.clawai config: %s", exc)
        return {}


def _base_url(cfg: Dict[str, Any]) -> str:
    value = cfg.get("base_url") if isinstance(cfg, dict) else None
    text = str(value).strip() if isinstance(value, str) else ""
    return (text or DEFAULT_BASE_URL).rstrip("/")


def _model(cfg: Dict[str, Any]) -> str:
    value = cfg.get("model") if isinstance(cfg, dict) else None
    text = str(value).strip() if isinstance(value, str) else ""
    return text or DEFAULT_MODEL


class ClawaiImageGenProvider(ImageGenProvider):
    """ClawBox AI ``images/generations`` backend (OpenAI-compatible)."""

    @property
    def name(self) -> str:
        return "clawai"

    @property
    def display_name(self) -> str:
        return "ClawBox AI"

    def is_available(self) -> bool:
        if not (get_secret(TOKEN_ENV, "") or "").strip():
            return False
        try:
            import openai  # noqa: F401
        except ImportError:
            return False
        return True

    def list_models(self) -> List[Dict[str, Any]]:
        return [
            {
                "id": model_id,
                "display": meta["display"],
                "speed": meta["speed"],
                "strengths": meta["strengths"],
                "price": "included",
            }
            for model_id, meta in _MODELS.items()
        ]

    def default_model(self) -> Optional[str]:
        return DEFAULT_MODEL

    def get_setup_schema(self) -> Dict[str, Any]:
        return {
            "name": "ClawBox AI",
            "badge": "included",
            "tag": "Image generation through this device's ClawBox AI subscription",
            "env_vars": [
                {
                    "key": TOKEN_ENV,
                    "prompt": "ClawBox AI device token",
                    "url": "https://clawbox.com/",
                },
            ],
        }

    def capabilities(self) -> Dict[str, Any]:
        # Text-to-image only. The proxy exposes /images/generations and no edit
        # endpoint, so claiming reference images would accept sources it then
        # silently ignored.
        return {"modalities": ["text"], "max_reference_images": 0}

    def generate(
        self,
        prompt: str,
        aspect_ratio: str = DEFAULT_ASPECT_RATIO,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        prompt = (prompt or "").strip()
        aspect = resolve_aspect_ratio(aspect_ratio)
        cfg = _config()
        model = _model(cfg)

        if not prompt:
            return error_response(
                error="Prompt is required and must be a non-empty string",
                error_type="invalid_argument",
                provider="clawai",
                aspect_ratio=aspect,
            )

        token = (get_secret(TOKEN_ENV, "") or "").strip()
        if not token:
            return error_response(
                error=(
                    "This ClawBox is not linked to ClawBox AI yet, so it cannot "
                    "make pictures. Link it from the ClawBox dashboard."
                ),
                error_type="auth_required",
                provider="clawai",
                aspect_ratio=aspect,
            )

        try:
            import openai
        except ImportError:
            return error_response(
                error="openai Python package not installed (pip install openai)",
                error_type="missing_dependency",
                provider="clawai",
                aspect_ratio=aspect,
            )

        client = openai.OpenAI(api_key=token, base_url=_base_url(cfg))
        try:
            response = client.images.generate(
                model=model,
                prompt=prompt,
                size=_SIZES.get(aspect, _SIZES["square"]),
                n=1,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("ClawBox AI image generation failed", exc_info=True)
            return error_response(
                error=f"ClawBox AI image generation failed: {exc}",
                error_type="api_error",
                provider="clawai",
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )
        finally:
            close = getattr(client, "close", None)
            if callable(close):
                close()

        data = getattr(response, "data", None) or []
        if not data:
            return error_response(
                error="ClawBox AI returned no image data",
                error_type="empty_response",
                provider="clawai",
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )

        b64 = getattr(data[0], "b64_json", None)
        if not b64:
            return error_response(
                error="ClawBox AI returned no image data",
                error_type="empty_response",
                provider="clawai",
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )
        try:
            saved = save_b64_image(b64, prefix="clawai")
        except Exception as exc:  # noqa: BLE001
            return error_response(
                error=f"Could not save image to cache: {exc}",
                error_type="io_error",
                provider="clawai",
                model=model,
                prompt=prompt,
                aspect_ratio=aspect,
            )

        return success_response(
            image=str(saved),
            model=model,
            prompt=prompt,
            aspect_ratio=aspect,
            provider="clawai",
            modality="text",
        )


def register(ctx) -> None:
    """Plugin entry point -- wire the ClawBox AI backend into the registry."""
    ctx.register_image_gen_provider(ClawaiImageGenProvider())
