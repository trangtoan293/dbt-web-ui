# =============================================================================
# dbt-runner Dockerfile - Security Hardened
# Base: Python 3.11 Debian Slim (DuckDB requires glibc)
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Builder - Install dependencies
# -----------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS builder

WORKDIR /app
ARG INSTALL_DBT_SPARK=false
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

# Install build dependencies for Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gcc \
    g++ \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*

COPY --from=ghcr.io/astral-sh/uv:0.11.13 /uv /uvx /bin/
COPY pyproject.toml uv.lock ./
RUN if [ "$INSTALL_DBT_SPARK" = "true" ]; then \
        uv sync --frozen --no-dev --no-install-project --extra spark; \
    else \
        uv sync --frozen --no-dev --no-install-project; \
    fi

# -----------------------------------------------------------------------------
# Stage 2: Runtime - Minimal production image
# -----------------------------------------------------------------------------
FROM python:3.11-slim-bookworm

WORKDIR /app
ARG INSTALL_DBT_SPARK=false

# Install runtime dependencies. Base-image updates are handled by Dependabot
# so the build remains reproducible instead of running an unbounded upgrade.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    libffi8 \
    curl \
    $(if [ "$INSTALL_DBT_SPARK" = "true" ]; then echo default-jre-headless; fi) \
    && rm -rf /var/lib/apt/lists/* \
    /usr/local/lib/python3.11/site-packages/pip* \
    /usr/local/lib/python3.11/site-packages/setuptools* \
    /usr/local/lib/python3.11/site-packages/wheel* \
    && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.11

# Copy the locked virtual environment from the builder.
COPY --from=builder /app/.venv /app/.venv

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash --uid 1000 appuser

# Copy application code
COPY --chown=appuser:appuser . .

# Create workspace and storage directories with proper permissions
RUN mkdir -p /tmp/dbt-projects /data/storage/dbt-projects && \
    chown -R appuser:appuser /tmp/dbt-projects /data/storage /app

# Switch to non-root user
USER appuser

# Environment variables
ENV WORKSPACE_DIR=/tmp/dbt-projects
ENV PYTHONUNBUFFERED=1
ENV DBT_SEND_ANONYMOUS_USAGE_STATS=false
ENV DBT_RUNNER_UVICORN_WORKERS=1
ENV PATH="/app/.venv/bin:$PATH"

# Expose port
EXPOSE 8080

# Health check using curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Run the application. Keep the default worker count low so project-scoped dbt
# warm workers are reused consistently; override in production if throughput
# matters more than first-preview latency.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8080 --workers ${DBT_RUNNER_UVICORN_WORKERS:-1}"]
