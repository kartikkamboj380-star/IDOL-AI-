FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    KAVRON_DATA_DIR=/app/data \
    KAVRON_DATABASE_PATH=/app/data/kavron.sqlite3

WORKDIR /app
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt
COPY backend /app/backend
RUN useradd --system --create-home --uid 10001 kavron \
    && mkdir -p /app/data \
    && chown -R kavron:kavron /app
USER kavron

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/v1/health', timeout=3)" || exit 1
CMD ["uvicorn", "kavron.main:app", "--app-dir", "/app/backend", "--host", "0.0.0.0", "--port", "8000"]
