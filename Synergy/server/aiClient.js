// Synergy/server/aiClient.js
const AI_URL = (process.env.AI_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

async function postJSON(path, body, abortMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), abortMs);
  try {
    const res = await fetch(`${AI_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`AI ${path} failed: ${res.status} ${txt}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Ask the AI for a next word using the previous human and bot words.
 * @param {string|null} prevHuman
 * @param {string|null} prevBot
 * @param {string[]} exclude Lowercased words already used in prior completed rounds
 * @param {{beta?:number,gamma?:number,top_k?:number}} [opts]
 * @returns {Promise<{choice:string|null,scores:any[]}>}
 */
export async function getNextWordUsingPrev(prevHuman, prevBot, exclude, opts = {}) {
  const body = {
    prev_human: prevHuman || null,
    prev_bot: prevBot || null,
    exclude: Array.from(new Set(exclude || [])),
    beta: typeof opts.beta === "number" ? opts.beta : 0.5,
    gamma: typeof opts.gamma === "number" ? opts.gamma : 0.5,
    top_k: typeof opts.top_k === "number" ? opts.top_k : 12
  };
  return postJSON("/nextword", body, 8000);
}

/**
 * Get a random allowed word by calling /nextword without prev context.
 * The FastAPI service returns a random word when both prev fields are null.
 * @param {string[]} exclude
 * @returns {Promise<{choice:string|null,scores:any[]}>}
 */
export async function getRandomWord(exclude) {
  const body = {
    prev_human: null,
    prev_bot: null,
    exclude: Array.from(new Set(exclude || [])),
    top_k: 1
  };
  return postJSON("/nextword", body, 8000);
}
