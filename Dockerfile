# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web-build
WORKDIR /src
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
# workspaces の宣言先だけ用意する。PoC ソース・依存はビルド対象にしない。
COPY poc/package.json poc/package.json
COPY llm-poc/package.json llm-poc/package.json
COPY jev-poc/package.json jev-poc/package.json
RUN npm ci --workspace web --include-workspace-root
COPY web/ web/
RUN npm run build -w web

FROM ghcr.io/astral-sh/uv:0.9.3 AS uv
FROM python:3.13-slim-bookworm AS runtime
COPY --from=uv /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 UV_COMPILE_BYTECODE=1
WORKDIR /app/server
COPY server/pyproject.toml server/uv.lock ./
RUN uv sync --frozen --no-dev
COPY server/app/ app/
COPY --from=web-build /src/web/dist/ /app/web/dist/
# SE は任意。問題・秘密・実験結果はイメージに含めない。
COPY sound/ /app/sound/
# 手元の WAV が 700 だと COPY 後も非 root の実行ユーザーが読めず /sound が 502 になる。
RUN chmod -R a+rX /app/sound
RUN useradd --uid 10001 --create-home quiz
USER quiz
ENV PORT=8080
CMD ["sh", "-c", "exec .venv/bin/uvicorn app.cloud.app:from_environment --factory --host 0.0.0.0 --port \"${PORT}\" --workers 1 --ws-max-size 65536 --no-access-log"]
