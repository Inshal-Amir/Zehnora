# Zehnora platform API image (FastAPI). Migrations run at container start.
FROM python:3.12.13-slim
RUN pip install --no-cache-dir uv==0.11.28 && useradd -r -u 10002 zehnora
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
ENV PATH=/app/.venv/bin:$PATH
USER zehnora
EXPOSE 8200
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8200 --proxy-headers --forwarded-allow-ips='*'"]
