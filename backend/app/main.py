"""可自定义品牌的大模型 API 开放平台 — FastAPI 入口。"""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy import select, text
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.catalog_seed import seed_catalog_models, seed_scene_types
from app._version import __version__
from app.forum_seed import seed_forum_faq
from app.config import settings
from app.config_preflight import validate_runtime_config as _validate_runtime_config
from app.database import SessionLocal, engine, init_db, validate_connection_budget
from app.demo_seed import seed_demo_data
from app.extensions import ExtensionManager
from app.models import ModelRegistryORM
from app.log_stream import start_log_listener, stop_log_listener
from app.ops_scheduler import ops_scheduler
from app.proxy import router as proxy_router, beta_router
from app.proxy.client import close_client
from app.proxy.db_bridge import start_invalidate_listener, stop_invalidate_listener
from app.proxy.fallback import start_circuit_listener, stop_circuit_listener
from app.redis_client import redis
from app.request_context import RequestContextMiddleware
from app.routers import router as api_router
from app.usage_retention import usage_retention
from app.usage_writer import usage_writer
from app.platform_settings import get_branding_config

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("platform")

extension_manager = ExtensionManager()

# 多 worker 冷启动种子锁（"APISEED" 的稳定整数表示）。事务提交/回滚自动释放。
_SEED_ADVISORY_LOCK_ID = 0x41504953454544


class GatewayCORSMiddleware(CORSMiddleware):
    """只给无 Cookie 的公开中继端点提供跨源访问。

    管理端和用户端 UI 使用同源 ``/api`` 请求。把通配 CORS 应用到整个应用会让
    首次管理员认领等敏感端点也响应第三方站点的预检，因此非网关路径直接绕过
    CORS 中间件，由浏览器的同源策略保护。
    """

    _GATEWAY_PREFIXES = ("/v1/", "/beta/v1/")

    async def __call__(self, scope, receive, send):
        path = scope.get("path", "")
        if scope.get("type") == "http" and (
            path == "/v1" or path == "/beta/v1"
            or path.startswith(self._GATEWAY_PREFIXES)
        ):
            await super().__call__(scope, receive, send)
            return
        await self.app(scope, receive, send)


def _seed_catalog() -> None:
    db = SessionLocal()
    try:
        db.execute(text("SELECT pg_advisory_xact_lock(:lock_id)"), {"lock_id": _SEED_ADVISORY_LOCK_ID})
        seed_catalog_models(db)
        seed_scene_types(db)
        seed_forum_faq(db)
        if settings.DEMO_DATA_ENABLED:
            seed_demo_data(db)
        db.commit()
    finally:
        db.close()


def _startup_db_work() -> None:
    init_db()
    validate_connection_budget()
    _seed_catalog()
    with SessionLocal() as db:
        branding = get_branding_config(db)
    app.title = branding.browser_title


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.ready = False
    try:
        _validate_runtime_config()
        # 先完成数据库校验/种子与强依赖探测，再启动任何后台 task。过去 Redis 必需
        # 且 ping 失败时会在 yield 前抛错，已经启动的 task 没有机会清理。
        await asyncio.to_thread(_startup_db_work)
        try:
            await asyncio.wait_for(redis.ping(), timeout=5)
            log.info("Redis 连接正常")
        except Exception as exc:
            if settings.REDIS_REQUIRED_ON_STARTUP:
                raise RuntimeError(f"Redis 不可达，生产环境拒绝启动: {exc}") from exc
            log.warning("Redis 连接失败（中继限流将 fail-closed 返回 503）：%s", exc)

        await usage_writer.start()
        await ops_scheduler.start()
        await usage_retention.start()
        await start_invalidate_listener()  # 跨 worker 缓存失效广播订阅
        await start_circuit_listener()     # 跨 worker 兜底熔断状态广播订阅
        await start_log_listener()         # 跨 worker 实时日志流广播订阅
        # 扩展可依赖已经就绪的数据库/Redis/核心后台组件；任何启动失败都会在
        # ready=True 前向上抛出，使生产探针保持 fail-closed。
        await extension_manager.startup(app)
        app.state.ready = True
        log.info("%s 已启动", app.title)
        yield
    finally:
        app.state.ready = False
        # 先关闭扩展，让其仍可使用数据库、Redis 和核心后台资源完成刷写/清理。
        try:
            await extension_manager.shutdown(app)
        except Exception:
            log.exception("关闭应用扩展失败")
        # 任一组件清理失败不能阻断其他组件释放连接/刷写用量。
        shutdown_steps = (
            ("log listener", stop_log_listener),
            ("circuit listener", stop_circuit_listener),
            ("cache listener", stop_invalidate_listener),
            ("ops scheduler", ops_scheduler.stop),
            ("usage retention", usage_retention.stop),
            ("usage writer", usage_writer.stop),
            ("http client", close_client),
            ("redis", redis.aclose),
        )
        for name, stop in shutdown_steps:
            try:
                await stop()
            except Exception:
                log.exception("关闭 %s 失败", name)
        try:
            await asyncio.to_thread(engine.dispose)
        except Exception:
            log.exception("关闭数据库连接池失败")


app = FastAPI(
    title="Open API Platform",
    version=__version__,
    lifespan=lifespan,
    docs_url="/docs" if settings.API_DOCS_ENABLED else None,
    redoc_url="/redoc" if settings.API_DOCS_ENABLED else None,
    openapi_url="/openapi.json" if settings.API_DOCS_ENABLED else None,
)
app.include_router(proxy_router)
app.include_router(beta_router)
app.include_router(api_router)

# 第三方浏览器客户端依赖 CORS 预检，只允许其通过显式 Authorization/x-api-key
# 调用中继接口。用户与管理员 Cookie 保持 same-origin；这里不启用
# allow_credentials，避免通配来源携带平台会话 Cookie。
app.add_middleware(
    GatewayCORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
    expose_headers=["X-Resolved-Model", "X-Fallback-From", "Retry-After", "X-Request-Id"],
)

# request-id 贯穿（最外层：包括 4xx/429 等被策略拒绝的响应也带 X-Request-Id）
app.add_middleware(RequestContextMiddleware)


# ── 中继端点错误格式：OpenAI / A社 兼容 ────────────────────────────────
# SDK 与 agent 框架靠 error.type / error.code 决定重试与降级；FastAPI 默认的
# {"detail": ...} 会让它们把 429/503 当成不可恢复错误。/api 管理端保持原格式。
_OPENAI_ERR_TYPE = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    408: "timeout_error",
    413: "request_too_large",
    422: "invalid_request_error",
    429: "rate_limit_error",
    503: "overloaded_error",
}


def _err_type(status: int) -> str:
    return _OPENAI_ERR_TYPE.get(status, "api_error")


def _shape_error(path: str, status: int, message: str) -> dict | None:
    """返回中继风格错误体；非中继路径返回 None（沿用 FastAPI 默认格式）。"""
    if path.startswith("/v1/messages"):
        return {"type": "error", "error": {"type": _err_type(status), "message": message}}
    if path.startswith("/v1/") or path.startswith("/beta/"):
        return {"error": {"message": message, "type": _err_type(status), "code": status}}
    return None


@app.exception_handler(StarletteHTTPException)
async def _http_exc_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    body = _shape_error(request.url.path, exc.status_code, str(detail))
    if body is None:
        body = {"detail": detail}
    return JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers or {})


@app.exception_handler(json.JSONDecodeError)
async def _bad_json_handler(request: Request, exc: json.JSONDecodeError):
    msg = f"请求体不是合法 JSON: {exc}"
    body = _shape_error(request.url.path, 400, msg) or {"detail": msg}
    return JSONResponse(status_code=400, content=body)


def _check_db() -> bool:
    try:
        db = SessionLocal()
        try:
            db.execute(select(ModelRegistryORM.id).limit(1))
            return True
        finally:
            db.close()
    except Exception:
        return False


@app.get("/metrics")
async def metrics():
    """Prometheus 抓取端点（多进程聚合）。nginx 不路由此路径，仅 compose 网络内可达。"""
    from app.metrics import render_metrics

    data, content_type = render_metrics()
    return Response(content=data, media_type=content_type)


async def _readiness_response() -> JSONResponse:
    try:
        db_ok = await asyncio.wait_for(asyncio.to_thread(_check_db), timeout=4)
    except Exception:
        db_ok = False
    try:
        await asyncio.wait_for(redis.ping(), timeout=3)
        redis_ok = True
    except Exception:
        redis_ok = False
    startup_ok = bool(getattr(app.state, "ready", False))
    status = "ok" if (startup_ok and db_ok and redis_ok) else "degraded"
    body = {
        "status": status,
        "ready": startup_ok,
        "db": db_ok,
        "redis": redis_ok,
        "usage_dropped": usage_writer.dropped,
    }
    code = 200 if status == "ok" else 503
    return JSONResponse(status_code=code, content=body)


@app.get("/live")
async def live():
    """只证明 worker 事件循环仍可响应，不探测外部依赖。"""
    return {"status": "ok"}


@app.get("/ready")
async def ready():
    """流量就绪探针：启动完成且数据库、Redis 均可用才返回 200。"""
    return await _readiness_response()


@app.get("/health")
async def health():
    """兼容旧部署的综合健康探针；语义与 /ready 一致。"""
    return await _readiness_response()


# 放在全部核心路由和异常处理器之后安装，确保扩展不能通过同路径抢占核心安全
# 端点。配置项为空时不导入任何第三方模块，社区版行为保持不变。
extension_manager.install_configured(app, settings.APPLICATION_EXTENSIONS)
