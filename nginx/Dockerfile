# 多阶段：构建前端静态资源 → 注入 nginx
ARG VITE_PUBLIC_API_ORIGIN=
# ── Stage 1: 构建前端 ────────────────────────────────────────────────────────
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS build
ARG VITE_PUBLIC_API_ORIGIN
WORKDIR /app
ENV VITE_PUBLIC_API_ORIGIN=${VITE_PUBLIC_API_ORIGIN}
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=10000 --fetch-retry-maxtimeout=60000
COPY frontend/ ./
RUN npm run build

# ── Stage 2: nginx 运行时 ────────────────────────────────────────────────────
FROM nginxinc/nginx-unprivileged:stable-alpine@sha256:45ce1e2e699234253d1def7baa96218a5d00b498d1ba0cbb1a17b6bdf73d1351
COPY nginx/nginx.conf /etc/nginx/nginx.conf
COPY nginx/security_headers.conf /etc/nginx/security_headers.conf
COPY --chmod=755 nginx/20-real-ip.sh /docker-entrypoint.d/20-real-ip.sh
COPY --from=build /app/dist /usr/share/nginx/html
USER 101
EXPOSE 8080
