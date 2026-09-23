# LiteLLM 1.102.0 gateway image for the Roshvyn server profile (same pins as uv.lock).
FROM python:3.12.13-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.11.28
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
ENV PATH=/app/.venv/bin:$PATH PRISMA_NODEENV_CACHE_DIR=/app/.prisma-nodeenv PRISMA_BINARY_CACHE_DIR=/app/.prisma-binaries
# Generate the Prisma client for LiteLLM's own schema at build time (network needed only here).
RUN prisma generate --schema /app/.venv/lib/python3.12/site-packages/litellm/proxy/schema.prisma
COPY config.gpu.yaml config.mock.yaml config.dev-local-4b.yaml litellm-entrypoint.sh ./
RUN chmod +x litellm-entrypoint.sh && useradd -r -u 10001 litellm && chown -R litellm /app
USER litellm
EXPOSE 4000
