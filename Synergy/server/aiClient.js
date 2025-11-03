// server/aiClient.js  (ESM)
const AI_URL = process.env.AI_URL || "http://127.0.0.1:8000";

export async function getNextWord(prevHuman, prevBot, exclude = []) {
  try {
    const resp = await fetch(`${AI_URL}/nextword`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prev_human: String(prevHuman || ""),
        prev_bot: String(prevBot || ""),
        exclude: Array.isArray(exclude) ? exclude : [],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error("[AI] bad status", resp.status, text);
      return "apple";
    }
    const data = await resp.json();
    const w = String(data?.word || "").trim();
    return w || "apple";
  } catch (e) {
    console.error("[AI] fetch error", e);
    return "apple";
  }
}
