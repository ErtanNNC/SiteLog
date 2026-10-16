# SiteLog voice agent (spec §4.2, §9.4). `lk agent deploy` builds this on LiveKit Cloud; deploying is
# an owner-approved hand step (docs/RUNBOOK.md, W3-16), never CI.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.11.32 /uv /usr/local/bin/uv

ENV PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    NODE_ENV=production

WORKDIR /app

# Dependencies first (cached while only the code changes), exactly as uv.lock pins them.
COPY pyproject.toml uv.lock .python-version README.md ./
RUN uv sync --locked --no-dev --no-install-project

# The generated contract and copy (`pnpm voice:contract`), then the package.
COPY contract ./contract
COPY copy ./copy
COPY src ./src
RUN uv sync --locked --no-dev

# Model files the plugins need at runtime (Silero VAD, the local turn detector).
RUN uv run --no-sync python -m livekit.agents download-files

RUN useradd --create-home --uid 10001 agent
USER agent

CMD ["uv", "run", "--no-sync", "python", "-m", "livekit.agents", "start", "src/sitelog_voice/agent.py"]
