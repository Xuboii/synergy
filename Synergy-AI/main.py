# main.py
import os
import re
import random
from typing import List, Optional

import httpx
from fastapi import FastAPI
from pydantic import BaseModel, field_validator
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Synergy-AI")

# -------- Settings --------
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
OPENAI_URL = "https://api.openai.com/v1/responses"

HEADERS = {
    "authorization": f"Bearer {OPENAI_API_KEY}",
    "content-type": "application/json",
}

# A small neutral seed list for round 1 or any fallback
NEUTRAL_SEEDS = [
    "bridge", "link", "common", "middle", "center",
    "focus", "union", "merge", "pair", "match",
    "signal", "theme", "point", "route", "path",
]


WORD_RE = re.compile(r"^[a-z]{2,20}$")

def sanitize_word(text: Optional[str]) -> str:
    """Return a single lowercase a-z word if valid, else empty string."""
    if not text:
        return ""
    token = text.strip().split()[0].lower()
    token = re.sub(r"[^a-z]", "", token)
    if WORD_RE.fullmatch(token):
        return token
    return ""

def pick_seed(exclude: List[str]) -> str:
    pool = [w for w in NEUTRAL_SEEDS if w not in exclude]
    if not pool:
        return "bridge"
    return random.choice(pool)


def build_prompt(prev_human: str, prev_bot: str, exclude: List[str]) -> List[dict]:
    """
    Prompt the model to converge on the teammate's likely guess, using ONLY the
    previous round pair (A, B). Matching the teammate is desirable.
    """
    rules = (
        "You are playing a converging-words game.\n"
        "You see ONLY the previous round's two words: A and B.\n"
        "Goal: return a single common associative English word that BOTH A and B suggest.\n"
        "Convergence rule: choose the most obvious bridge word that a human teammate is also likely to pick.\n"
        "It is OK to match the teammate's guess. Do NOT avoid matches.\n"
        "Hard rules:\n"
        "1) Return exactly one word\n"
        "2) Lowercase a-z only\n"
        "3) No spaces, punctuation, numbers, or hyphens\n"
        "4) Do NOT return A or B\n"
        "5) Do NOT return any word in the exclude list\n"
        "6) Ignore the literal string '(no guess)' completely if present\n"
        "Examples:\n"
        "A=car, B=road -> highway\n"
        "A=pirates, B=treasure -> map\n"
        "A=apple, B=yellow -> banana\n"
    )
    # remove literal '(no guess)' defensively before showing to the model
    A = prev_human if prev_human != "(no guess)" else ""
    B = prev_bot if prev_bot != "(no guess)" else ""
    ex_clean = [w for w in (exclude or []) if w and w != "(no guess)"]

    user = (
        f"A={A}\n"
        f"B={B}\n"
        f"exclude={ex_clean}\n"
        f"Return only the single connecting word."
    )
    return [
        {"role": "system", "content": rules},
        {"role": "user", "content": user},
    ]


def extract_output_text(data: dict) -> Optional[str]:
    """
    Try several shapes the Responses API may return.
    Prefer convenience field output_text, then walk output[0].content[*].text,
    then a light legacy fallback.
    """
    txt = data.get("output_text")
    if isinstance(txt, str) and txt.strip():
        return txt

    outputs = data.get("output") or []
    if outputs:
        content = outputs[0].get("content") or []
        for part in content:
            if isinstance(part, dict) and part.get("text"):
                return part["text"]

    # legacy-ish safety
    choices = data.get("choices") or []
    if choices:
        msg = choices[0].get("message") or {}
        t = msg.get("content")
        if isinstance(t, str) and t.strip():
            return t

    return None

async def call_openai_connector(prev_human: str, prev_bot: str, exclude: List[str]) -> str:
    if not OPENAI_API_KEY:
        return pick_seed(exclude)

    payload = {
        "model": OPENAI_MODEL,
        "input": build_prompt(prev_human, prev_bot, exclude),
        "max_output_tokens": 32,  # must be >= 16 for Responses API
        # no temperature here since some models reject it in Responses API
    }

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(OPENAI_URL, headers=HEADERS, json=payload)
        if resp.status_code != 200:
            print(f"[error] OpenAI call failed {resp.status_code}: {resp.text[:200]}")
            return pick_seed(exclude)

        data = resp.json()
        raw_text = extract_output_text(data)
        cand = sanitize_word(raw_text)
        print(f"[ai] model={OPENAI_MODEL} prev=({prev_human}, {prev_bot}) raw={raw_text!r} -> cand={cand!r}")

        if not cand or cand in exclude or cand in (prev_human, prev_bot):
            return pick_seed(exclude)
        return cand

    except Exception as e:
        print(f"[error] OpenAI exception: {e}")
        return pick_seed(exclude)

class NextWordReq(BaseModel):
    prev_human: Optional[str] = ""
    prev_bot: Optional[str] = ""
    exclude: Optional[List[str]] = None

    @field_validator("prev_human", "prev_bot")
    @classmethod
    def _norm_str(cls, v):
        return (v or "").strip().lower()

    @field_validator("exclude")
    @classmethod
    def _norm_exclude(cls, v):
        if not v:
            return []
        out = []
        for w in v:
            w = (w or "").strip().lower()
            w = re.sub(r"[^a-z]", "", w)
            if w:
                out.append(w)
        # dedupe while preserving order
        seen = set()
        deduped = []
        for w in out:
            if w not in seen:
                seen.add(w)
                deduped.append(w)
        return deduped
@app.get("/")
async def root():
    return {"ok": True, "model": OPENAI_MODEL, "service": "synergy-ai"}

@app.get("/healthz")
async def healthz():
    return {"ok": True, "model": OPENAI_MODEL}

@app.post("/nextword")
async def nextword(req: NextWordReq):
    prev_h = req.prev_human
    prev_b = req.prev_bot
    exclude = list(req.exclude or [])

    # For round 1 when there is no previous pair, return a seed
    if not prev_h or not prev_b:
        seed = pick_seed(exclude)
        return {"word": seed}

    # Also exclude the immediate pair to avoid echo
    if prev_h not in exclude:
        exclude.append(prev_h)
    if prev_b not in exclude:
        exclude.append(prev_b)

    # NEW: ignore literal '(no guess)' in excludes and in the pair
    exclude = [w for w in exclude if w and w != "(no guess)"]
    if prev_h == "(no guess)":
        prev_h = ""
    if prev_b == "(no guess)":
        prev_b = ""

    word = await call_openai_connector(prev_h, prev_b, exclude)

    # final sanitize and repeat guard
    word = sanitize_word(word)
    if not word or word in exclude:
        word = pick_seed(exclude)

    return {"word": word}

@app.on_event("startup")
async def on_startup():
    print(f"[startup] Model ready: {OPENAI_MODEL}. Seeds={len(NEUTRAL_SEEDS)}")
