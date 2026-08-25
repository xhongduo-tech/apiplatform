"""OpenAI/A社 兼容中继。"""
from fastapi import APIRouter

from app.proxy.anthropic import router as anthropic_router
from app.proxy.beta import router as beta_chat_router
from app.proxy.chat import router as chat_router
from app.proxy.completions import router as completions_router
from app.proxy.embeddings import router as embeddings_router
from app.proxy.extra import router as extra_router
from app.proxy.models import router as models_router
from app.proxy.responses import router as responses_router

router = APIRouter(prefix="/v1", tags=["relay"])
router.include_router(chat_router)
router.include_router(completions_router)
router.include_router(embeddings_router)
router.include_router(extra_router)
router.include_router(anthropic_router)
router.include_router(models_router)
router.include_router(responses_router)

beta_router = APIRouter(prefix="/beta/v1", tags=["relay-beta"])
beta_router.include_router(beta_chat_router)
