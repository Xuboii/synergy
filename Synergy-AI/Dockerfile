# FastAPI AI service
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# System deps for torch/sentence-transformers
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# (Optional) warm the model cache at build time to reduce first-start latency:
# RUN python - <<'PY'
# from sentence_transformers import SentenceTransformer
# SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
# PY

COPY . .

# Your FastAPI exposes / and /healthz and /nextword in main.py
# and we bind to PORT=8080 for Cloud Run
ENV PORT=8080
EXPOSE 8080

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
