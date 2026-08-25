"""REST 路由聚合（/api/*）。"""
from fastapi import APIRouter

from app.routers.admin import router as admin_router
from app.routers.admin_stats import router as admin_stats_router
from app.routers.ask_docs import router as ask_docs_router
from app.routers.night_batch import router as night_batch_router
from app.routers.public import router as public_router
from app.routers.user import router as user_router

router = APIRouter(prefix="/api", tags=["api"])
router.include_router(public_router)
router.include_router(user_router)
router.include_router(admin_router)
router.include_router(admin_stats_router)
router.include_router(night_batch_router)
router.include_router(ask_docs_router)
