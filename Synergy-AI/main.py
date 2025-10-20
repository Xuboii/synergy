from dotenv import load_dotenv
load_dotenv()

import os
import re
import json
from typing import List, Optional

from fastapi import FastAPI
from pydantic import BaseModel, field_validator
import httpx

# =========================
# Config
# =========================
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-5-nano")  # use a model you have access to
OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses"

PORT = int(os.environ.get("PORT", "8000"))

# One lowercase token, letters or digits or single hyphen, length 1..25
SINGLE_WORD_REGEX = re.compile(r"\b([a-z][a-z0-9\-]{0,24})\b")

SYSTEM_INSTRUCTIONS = (
    "You are the AI teammate in a word-connection game called Synergy. "
    "Each round you must output exactly one lowercase English word that best connects the two words from the previous round. "
    "Rules: output one token only, no spaces, no punctuation, no quotes. "
    "Do not repeat any banned words."
)

# =========================
# FastAPI app
# =========================
app = FastAPI(title="Synergy-AI LLM Service", version="1.0.0")


class NextWordRequest(BaseModel):
    prev_human: Optional[str] = None
    prev_bot: Optional[str] = None
    exclude: Optional[List[str]] = None
    # the server may send these, we ignore for LLM but accept to avoid 422 errors
    beta: Optional[float] = None
    gamma: Optional[float] = None
    top_k: Optional[int] = None

    @field_validator("prev_human", "prev_bot")
    @classmethod
    def clean_prev(cls, v):
        if v is None:
            return None
        v = v.strip()
        return v if v else None

    @field_validator("exclude")
    @classmethod
    def clean_exclude(cls, v):
        if not v:
            return []
        return sorted(set([str(x).strip().lower() for x in v if str(x).strip()]))


def build_user_prompt(prev_human: Optional[str], prev_bot: Optional[str], exclude: List[str]) -> str:
    ph = prev_human or ""
    pb = prev_bot or ""
    ex = ", ".join(exclude) if exclude else "(none)"
    seed_hint = ""
    if not ph and not pb:
        seed_hint = (
            "\nIt is the first round and there is no previous pair. "
            "Return a neutral, common word that would be useful as a seed. "
        )
    return (
        f"Previous round words:\n"
        f"- human: {ph}\n"
        f"- ai: {pb}\n"
        f"Banned words (do not output any of these):\n{ex}\n\n"
        f"Your task: return a single lowercase connector word that relates strongly to BOTH previous words. "
        f"Return only the word, nothing else."
        f"{seed_hint}"
    )


def sanitize_choice(word: Optional[str], exclude: List[str]) -> Optional[str]:
    if not word:
        return None
    w = word.strip().lower()
    m = SINGLE_WORD_REGEX.fullmatch(w) or SINGLE_WORD_REGEX.search(w)
    if not m:
        return None
    w = m.group(1)
    if w in (exclude or []):
        return None
    return w


async def call_openai_connector(prev_human: Optional[str], prev_bot: Optional[str], exclude: List[str]) -> Optional[str]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY is not set")

    payload = {
        "model": OPENAI_MODEL,
        "input": [
            {"role": "system", "content": SYSTEM_INSTRUCTIONS},
            {"role": "user", "content": build_user_prompt(prev_human, prev_bot, exclude)},
        ],
        "max_output_tokens": 32
    }



    headers = {
        "authorization": f"Bearer {OPENAI_API_KEY}",
        "content-type": "application/json",
    }

    # Call OpenAI
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(OPENAI_RESPONSES_URL, headers=headers, json=payload)
        # If the model does not support JSON schema, you can comment the response_format,
        # and we will fall back to text parsing below.
        if resp.status_code >= 400:
            # Try to capture body for logs
            try:
                body = resp.text
            except Exception:
                body = "<no-body>"
            raise RuntimeError(f"OpenAI error {resp.status_code}: {body}")

        data = resp.json()

    # Try to pull the word from any JSON in the response
    # The Responses API structure may vary by SDK. We do a robust parse.
    text_blob = json.dumps(data, ensure_ascii=False)

    # First try a JSON key named "word"
    m = re.search(r'"word"\s*:\s*"([a-zA-Z0-9\-]{1,25})"', text_blob)
    if m:
        candidate = sanitize_choice(m.group(1), exclude)
        if candidate:
            return candidate

    # Fallback: scan all text for the first valid token
    m2 = SINGLE_WORD_REGEX.search(text_blob.lower())
    if m2:
        candidate = sanitize_choice(m2.group(1), exclude)
        if candidate:
            return candidate

    return None


@app.get("/healthz")
def healthz():
    return {"status": "ok", "model": OPENAI_MODEL or "<unset>"}


@app.post("/nextword")
async def nextword(req: NextWordRequest):
    """
    Request shape from the game server:
    {
      "prev_human": string or null,
      "prev_bot": string or null,
      "exclude": [string, ...]
    }

    Response shape expected by the game server:
    { "choice": string or null, "scores": [] }
    """
    try:
        word = await call_openai_connector(req.prev_human, req.prev_bot, req.exclude or [])
        # If the LLM produced nothing valid, return null and let the server fallback if it wants
        return {"choice": word, "scores": []}
    except Exception as e:
        # Return null on error. Server can fallback to a random word or leave blank.
        # Keep message out of response to avoid leaking keys or payloads.
        print(f"[error] /nextword failed: {e}")
        return {"choice": None, "scores": []}
