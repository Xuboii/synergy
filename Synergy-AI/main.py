from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import numpy as np
import threading
import random
import os

# ---------- globals ----------
MODEL = None
WORDS: List[str] = []
BANK_EMB = None
READY = False
LOCK = threading.Lock()

MODEL_NAME = os.environ.get("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
WORDBANK_PATH = os.environ.get("WORDBANK_PATH", "wordbank.txt")

app = FastAPI(title="Synergy AI Service", version="1.0.5")

# ---------- schemas ----------
class SimilarityReq(BaseModel):
    word1: str
    word2: str

class EmbedReq(BaseModel):
    texts: List[str] = Field(..., min_items=1)

class NextWordReq(BaseModel):
    # only last round's words are provided
    prev_human: Optional[str] = None
    prev_bot: Optional[str] = None
    # words not allowed to be selected (e.g., anything already guessed)
    exclude: Optional[List[str]] = None
    # knobs (kept same defaults)
    top_k: int = 10
    beta: float = Field(0.5, ge=0.0, le=1.0)   # weight for prev_human
    gamma: float = Field(0.5, ge=0.0, le=1.0)  # weight for prev_bot

class ScoredWord(BaseModel):
    word: str
    score: float

class NextWordResp(BaseModel):
    choice: Optional[str]
    scores: List[ScoredWord]

# ---------- helpers ----------
def _ensure_wordbank():
    if not os.path.exists(WORDBANK_PATH):
        with open(WORDBANK_PATH, "w", encoding="utf-8") as f:
            f.write("\n".join([
                "apple","banana","orange","grape","fruit",
                "dog","cat","puppy","kitten","animal","pet",
                "car","truck","bus","vehicle","transport",
                "movie","film","cinema","actor","director",
                "computer","laptop","keyboard","mouse","screen",
                "phone","smartphone","tablet","device","camera",
                "music","song","melody","guitar","piano",
                "school","student","teacher","class","university",
                "ocean","sea","beach","sand","wave",
                "city","town","village","building","street",
                "game","play","win","lose","round"
            ]))

def _load_model_and_bank():
    global MODEL, WORDS, BANK_EMB, READY
    try:
        from sentence_transformers import SentenceTransformer
        _ensure_wordbank()
        with open(WORDBANK_PATH, "r", encoding="utf-8") as f:
            words = [w.strip() for w in f if w.strip()]
        model = SentenceTransformer(MODEL_NAME)
        emb = model.encode(words, normalize_embeddings=True)
        emb = np.array(emb, dtype=np.float32)
        with LOCK:
            MODEL = model
            WORDS = words
            BANK_EMB = emb
            READY = True
        print("[startup] Model and bank ready. Words:", len(WORDS))
    except Exception as e:
        print("[startup] Failed to load model:", repr(e))

def _get_embedding(text: str) -> np.ndarray:
    if not READY or MODEL is None:
        raise RuntimeError("Model not ready")
    v = MODEL.encode([text], normalize_embeddings=True)[0]
    return np.array(v, dtype=np.float32)

def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))

# ---------- app lifecycle ----------
@app.on_event("startup")
def kick_off_loading():
    t = threading.Thread(target=_load_model_and_bank, daemon=True)
    t.start()

# ---------- routes ----------
@app.get("/")
def root():
    return {"service": "synergy-ai", "status": "ok"}

@app.get("/healthz")
def healthz():
    return {"ok": True, "ready": READY, "words": len(WORDS), "model": MODEL_NAME}

@app.post("/similarity")
def similarity(req: SimilarityReq):
    if not READY:
        raise HTTPException(status_code=503, detail="Model is loading")
    a = _get_embedding(req.word1)
    b = _get_embedding(req.word2)
    return {"similarity": _cosine(a, b)}

@app.post("/embed")
def embed(req: EmbedReq):
    if not READY:
        raise HTTPException(status_code=503, detail="Model is loading")
    vecs = MODEL.encode(req.texts, normalize_embeddings=True)
    return {"vectors": [v.tolist() for v in vecs]}

# Core selection logic
def _best_next_word(
    exclude: Optional[List[str]],
    prev_human: Optional[str],
    prev_bot: Optional[str],
    beta: float,
    gamma: float,
    top_k: int
) -> Dict[str, Any]:
    used = {u.lower() for u in (exclude or [])}

    # If model isn't ready, return a deterministic-but-safe fallback
    if not READY or MODEL is None or BANK_EMB is None or not WORDS:
        pool = [w for w in WORDS] if WORDS else ["banana","apple","movie","dog"]
        candidates = [w for w in pool if w.lower() not in used]
        choice = random.choice(candidates) if candidates else "banana"
        return {"choice": choice, "scores": []}

    # First round: no prior context — choose a random allowed word
    if not prev_human and not prev_bot:
        candidates = [w for w in WORDS if w.lower() not in used]
        choice = random.choice(candidates) if candidates else None
        return {"choice": choice, "scores": []}

    ph = _get_embedding(prev_human) if prev_human else None
    pb = _get_embedding(prev_bot)   if prev_bot   else None

    scores: List[ScoredWord] = []
    for i, w in enumerate(WORDS):
        if w.lower() in used:
            continue
        cand = BANK_EMB[i]
        s = 0.0
        if ph is not None:
            s += beta  * _cosine(cand, ph)
        if pb is not None:
            s += gamma * _cosine(cand, pb)
        scores.append(ScoredWord(word=w, score=float(s)))

    scores.sort(key=lambda t: t.score, reverse=True)
    choice = scores[0].word if scores else None
    return {"choice": choice, "scores": scores[:max(1, top_k)]}

@app.post("/nextword", response_model=NextWordResp)
def nextword(req: NextWordReq):
    return _best_next_word(
        exclude=req.exclude,
        prev_human=req.prev_human,
        prev_bot=req.prev_bot,
        beta=req.beta,
        gamma=req.gamma,
        top_k=req.top_k
    )
