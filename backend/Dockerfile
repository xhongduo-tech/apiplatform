# Open API Platform 后端镜像（多阶段，依赖与运行分离）
# ── Stage 1: 安装依赖到 /deps ────────────────────────────────────────────────
FROM python:3.14-slim@sha256:656d12e70054d5fda18a045e2494c96701e9792dd1445f95b3d038df954f57e9 AS deps
WORKDIR /build
COPY requirements.lock .
RUN pip install --no-cache-dir --require-hashes --prefix=/deps -r requirements.lock

# ── Stage 2: 运行时 ──────────────────────────────────────────────────────────
FROM python:3.14-slim@sha256:656d12e70054d5fda18a045e2494c96701e9792dd1445f95b3d038df954f57e9
WORKDIR /app
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
# 管理后台可按需生成已验证的 PostgreSQL custom-format 快照。
RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 apiplatform \
    && useradd --uid 10001 --gid apiplatform --no-create-home --shell /usr/sbin/nologin apiplatform
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
