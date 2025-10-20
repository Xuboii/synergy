// Synergy/server/aiClient.js
const AI_URL = (process.env.AI_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");

// simple jittered delay
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function postJSON(path, body, { abortMs = 20000, retries = 1 } = {}) {
  let attempt = 0;
  while (true) {
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
    } catch (err) {
      if (attempt < retries) {
        attempt++;
        // backoff 400–900 ms
        await sleep(400 + Math.floor(Math.random() * 500));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
}

/**
 * Ask the AI for a next word using the previous human and bot words.
 * @param {string|null} prevHuman
 * @param {string|null} prevBot
 * @param {string[]} exclude
 * @param {{beta?:number,gamma?:number,top_k?:number,abortMs?:number}} [opts]
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
  const abortMs = typeof opts.abortMs === "number" ? opts.abortMs : 20000;
  return postJSON("/nextword", body, { abortMs, retries: 1 });
}

/**
 * Get a seed word. We still ask the AI, but we allow a shorter timeout.
 * If it times out, the server will apply a local seed fallback.
 */
export async function getRandomWord(exclude, opts = {}) {
  const body = {
    prev_human: null,
    prev_bot: null,
    exclude: Array.from(new Set(exclude || [])),
    top_k: 1
  };
  const abortMs = typeof opts.abortMs === "number" ? opts.abortMs : 12000;
  return postJSON("/nextword", body, { abortMs, retries: 1 });
}
