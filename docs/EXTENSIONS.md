# 应用扩展 API

Open API Platform 社区版提供一个最小、版本化的进程内扩展 API。它的用途是让
单独分发的功能包复用社区核心，而不需要复制或修改核心源码。本目录中的扩展契约、
加载器和默认空实现属于 Apache-2.0 开源代码；它们本身不包含任何商业功能。

扩展与核心运行在同一个 Python 进程，拥有与核心相同的权限。因此只应加载由部署方
审查、固定版本并纳入镜像供应链的软件包。扩展机制不是第三方代码沙箱。

## 配置和加载顺序

平台仅加载 `APPLICATION_EXTENSIONS` 明确列出的对象。默认值为空，空值不会导入
任何扩展模块，社区版的运行行为不变。

```dotenv
APPLICATION_EXTENSIONS=acme_platform.identity,acme_platform.backup:application_extension
```

每项格式是 `python.module[:attribute]`，省略属性名时使用模块级 `extension`。
声明顺序也是导入验证、安装和启动顺序，关闭顺序与之相反。配置中的空项、非法模块
路径、重复扩展名、导入错误、API 版本不匹配和生命周期错误都不会被静默忽略。

所有模块和契约会先完成验证，之后才调用第一个 `install`。安装发生在 FastAPI
应用构建阶段；启动发生在数据库、Redis 和核心后台服务就绪之后、`ready=True`
之前。任一已配置扩展失败都会阻止生产实例就绪。扩展启动失败时，平台会先尝试清理
失败扩展，再按逆序清理已经启动的扩展。

## `ApplicationExtension` 契约

扩展包只需要依赖 `app.extensions` 这一公开入口：

```python
from fastapi import APIRouter, Depends, FastAPI

from app.extensions import (
    EXTENSION_API_VERSION,
    ApplicationExtension,
    require_admin,
)

router = APIRouter(prefix="/api/admin/extensions/acme", tags=["enterprise"])


@router.get("/status", dependencies=[Depends(require_admin)])
async def enterprise_status() -> dict[str, str]:
    return {"status": "ok"}


class EnterpriseExtension(ApplicationExtension):
    name = "acme.enterprise"
    api_version = EXTENSION_API_VERSION

    def install(self, app: FastAPI) -> None:
        app.include_router(router)

    async def startup(self, app: FastAPI) -> None:
        app.state.enterprise_ready = True

    async def shutdown(self, app: FastAPI) -> None:
        app.state.enterprise_ready = False


extension = EnterpriseExtension()
```

扩展对象必须具备：

- `name: str`：非空且在进程内唯一的稳定名称；
- `api_version: str`：当前必须等于 `"1"`；
- `install(app) -> None`：同步安装函数，只调用一次；
- `startup(app)`：可同步或异步；
- `shutdown(app)`：可同步或异步。

推荐继承 `ApplicationExtension`；加载器也接受满足同一结构契约的对象。`install`
不能是异步函数，因为路由和中间件必须在 ASGI 服务开始接受请求前确定下来。启动和
关闭钩子必须返回 `None` 或 awaitable。

核心路由会先于扩展路由注册，扩展不能通过注册相同路径抢占核心安全端点。扩展仍应
使用独立、稳定的 URL 前缀，避免未来核心版本新增路由时发生冲突。

## 安全依赖

企业 Router 不应复制管理员鉴权逻辑，也不应直接导入核心内部模块。公开 API 提供
以下保持 FastAPI 原始签名的依赖：

```python
from app.extensions import get_db, require_admin, require_recent_admin
```

- `Depends(require_admin)`：要求有效管理员会话，并保留核心 CSRF 防护；
- `Depends(require_recent_admin)`：用于恢复、密钥导出等高风险操作，要求最近重新认证；
- `Depends(get_db)`：每请求一个 SQLAlchemy session，请求结束时由核心关闭。

常规企业管理端点至少使用 `require_admin`。恢复生产数据、下载原始备份、变更 KMS
和许可证等敏感动作应使用 `require_recent_admin`，并在企业模块中追加审批和审计。
浏览器管理员 Cookie 的作用域刻意限制在 `/api/admin`；需要复用该 Cookie 的扩展
管理路由也必须位于 `/api/admin/...` 下。其他路径只能由显式 Bearer 客户端调用，
不能假设浏览器会收到管理员 Cookie。

## Provider 注册表

多个扩展可以通过 `ExtensionRegistry` 协作，而不互相导入具体实现。Provider 至少
实现公开 `Provider` Protocol，即暴露非敏感、稳定的 `provider_id`。

```python
from typing import Protocol, runtime_checkable

from fastapi import FastAPI

from app.extensions import get_extension_registry


@runtime_checkable
class BackupProvider(Protocol):
    provider_id: str

    async def create_backup(self) -> str: ...


def install(self, app: FastAPI) -> None:
    registry = get_extension_registry(app)
    registry.register_provider("com.example.backup.v1", self.backup_provider)

    backup = registry.require_provider(
        "com.example.backup.v1",
        expected_type=BackupProvider,
    )
```

Contract 名会规范为小写，不能包含空白。注册遵循 first-writer-wins：同一 contract
不能被后加载扩展静默替换，防止加载顺序改变身份、密钥或审计 Provider。丰富的
Provider Protocol 应由 contract 所有者定义，并使用 `@runtime_checkable` 后传给
`expected_type` 做边界校验。

## 兼容性和发布

当前扩展 API 常量为 `EXTENSION_API_VERSION = "1"`。社区核心在同一 API 大版本内
保持上述入口和语义兼容；发生不兼容变更时会提高 API 版本，旧扩展会在安装前被明确
拒绝，而不是带着未知行为启动。

企业镜像应在构建阶段安装固定版本的私有 Python 包，再设置
`APPLICATION_EXTENSIONS`。不要在运行时从网络下载代码，也不要把许可证、数据库
口令、对象存储密钥等秘密编码在模块路径或 Provider ID 中。所有秘密继续通过部署方
的 Secret/KMS 机制提供。

开发扩展时至少运行：

```bash
cd backend
python -m ruff check app tests
python -m pytest -q tests/test_extensions.py tests/test_startup_reliability.py
```
