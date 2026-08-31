# Open API Platform 后端镜像（多阶段，依赖与运行分离）
# ── Stage 1: 安装依赖到 /deps ────────────────────────────────────────────────
FROM python:3.11-alpine@sha256:6857d2dae63e052057f2db389a7061188ac9a92a3fa8d402bde68f36df6fada1 AS deps
WORKDIR /build
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --prefix=/deps -r requirements.lock

# ── Stage 2: 运行时 ──────────────────────────────────────────────────────────
FROM python:3.11-alpine@sha256:6857d2dae63e052057f2db389a7061188ac9a92a3fa8d402bde68f36df6fada1
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
# 管理后台可按需生成已验证的 PostgreSQL custom-format 快照。客户端 major
# 必须与 Compose 的 PostgreSQL 16 一致，避免新客户端生成旧恢复端不识别的归档。
RUN apk upgrade --no-cache \
    && apk add --no-cache postgresql16-client \
    && addgroup -S -g 10001 apiplatform \
    && adduser -S -D -H -u 10001 -G apiplatform -s /sbin/nologin apiplatform
COPY --from=deps /deps /usr/local
# Package installers are build-time tools, not runtime dependencies. Removing
# them shrinks the attack surface and prevents a compromised worker from
# installing arbitrary packages into the image layer.
RUN python -m pip uninstall --yes setuptools wheel \
    && python -m pip uninstall --yes pip
COPY --chown=apiplatform:apiplatform app ./app
COPY --chown=apiplatform:apiplatform alembic ./alembic
COPY --chown=apiplatform:apiplatform alembic.ini .
COPY --chown=apiplatform:apiplatform gunicorn_conf.py .
COPY --chown=apiplatform:apiplatform entrypoint.sh /entrypoint.sh
RUN chmod 0555 /entrypoint.sh \
    && mkdir -p /app/data /var/lib/apiplatform/usage \
    && chown -R apiplatform:apiplatform /app/data /var/lib/apiplatform/usage
USER apiplatform
EXPOSE 8000
CMD ["/entrypoint.sh"]
