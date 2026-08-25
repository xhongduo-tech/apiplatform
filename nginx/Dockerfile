# 多阶段：构建前端静态资源 → 注入 nginx
ARG VITE_PUBLIC_API_ORIGIN=
# ── Stage 1: 构建前端 ────────────────────────────────────────────────────────
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS build
ARG VITE_PUBLIC_API_ORIGIN
WORKDIR /app
ENV VITE_PUBLIC_API_ORIGIN=${VITE_PUBLIC_API_ORIGIN}
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000
COPY frontend/ ./
RUN npm run build

# ── Stage 2: nginx 运行时 ────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:93722936b82ec8a1178d48448e619226680d2de3706a1640800e186cd5fa7fd3
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/security_headers.conf /etc/nginx/security_headers.conf
COPY --chmod=755 nginx/20-real-ip.sh /docker-entrypoint.d/20-real-ip.sh
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
