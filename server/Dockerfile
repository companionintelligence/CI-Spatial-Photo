# CI Photo Time Machine — processing server (API + MCP).
#
# This is the slim API/MCP image; the CPU "preview" engine works out of the box. To enable the
# GPU engines, build FROM a CUDA base and install their runtimes/weights (TripoSplat, SHARP,
# COLMAP+Brush) into this image or a sibling worker image — see docs/ARCHITECTURE.md.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    ASSET_DIR=/data/assets \
    MODEL_WEIGHTS_DIR=/models

WORKDIR /app

# ffmpeg is used to extract frames from videos for the photogrammetry path.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY pyproject.toml README.md ./
COPY app ./app
RUN pip install -e ".[mcp]"

VOLUME ["/data", "/models"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
