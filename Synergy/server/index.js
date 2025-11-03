// server/index.js  (ESM)
// Run with: node index.js
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Server } from "socket.io";
import { getNextWord } from "./aiClient.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROUND_SECONDS = 30;
const AFK_CLOSE_SECONDS = 70;

// static and health
app.use(express.static(PUBLIC_DIR));
app.get("/healthz", (_, res) => res.json({ ok: true }));

// ---------------- room state ----------------
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
const nowMs = () => Date.now();

function makeRoom() {
  const code = makeCode();
  const room = {
    code,
    status: "playing",
    round: 1,
    deadline: nowMs() + ROUND_SECONDS * 1000,
    players: [],                 // [{id, name}]
    history: [],                 // [{round, human, ai}]
    // current round state
    lastHuman: "",
    lastAI: "",
    submittedHuman: false,
    submittedAI: false,
    roundClosed: false,          // prevents double finish
    // previous round pair used to form the next connection
    prevHuman: "",
    prevAI: "",
    // timers
    lastActivity: nowMs(),
    afkTimer: null,
    roundTimer: null,
  };
  rooms.set(code, room);
  return room;
}

// Close room after AFK_CLOSE_SECONDS since lastActivity
function refreshAfkTimer(room) {
  if (room.afkTimer) clearTimeout(room.afkTimer);
  const elapsed = nowMs() - room.lastActivity;
  const remaining = Math.max(1000, AFK_CLOSE_SECONDS * 1000 - elapsed);
  room.afkTimer = setTimeout(() => {
    if (nowMs() - room.lastActivity >= AFK_CLOSE_SECONDS * 1000) {
      if (room.roundTimer) clearTimeout(room.roundTimer);
      io.to(room.code).emit("room:closed", { text: "Room closed due to inactivity" });
      rooms.delete(room.code);
    } else {
      // user acted while timer was counting down, reschedule
      refreshAfkTimer(room);
    }
  }, remaining);
}

function emitUpdate(room, tag = "") {
  io.to(room.code).emit("room:update", {
    tag,
    code: room.code,
    status: room.status,
    round: room.round,
    deadline: room.deadline,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
    history: room.history.map(r => ({ round: r.round, human: r.human, ai: r.ai })),
  });
}

function startRound(room) {
  room.round += room.history.length === 0 ? 0 : 1; // first call keeps round=1
  room.deadline = nowMs() + ROUND_SECONDS * 1000;
  room.submittedHuman = false;
  room.submittedAI = false;
  room.roundClosed = false;
  room.lastHuman = "";
  room.lastAI = "";

  // reset timer for this round and enforce auto "(no guess)"
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (room.roundClosed) return; // guard late fires
    // fill missing entries with "(no guess)" and finish
    if (!room.submittedHuman) {
      room.lastHuman = "(no guess)";
      room.submittedHuman = true;
    }
    if (!room.submittedAI) {
      room.lastAI = "(no guess)";
      room.submittedAI = true;
    }
    maybeFinishRound(room);
  }, ROUND_SECONDS * 1000);

  emitUpdate(room, "roundStart");
  // do not refresh AFK here to avoid masking inactivity across rounds
}

function wordsUsedSoFar(room) {
  const ex = new Set();
  for (const h of room.history) {
    if (h.human && h.human !== "(no guess)") ex.add(h.human);
    if (h.ai && h.ai !== "(no guess)") ex.add(h.ai);
  }
  // we intentionally do not add current round guesses here,
  // so the AI can match the player's current word.
  if (room.prevHuman && room.prevHuman !== "(no guess)") ex.add(room.prevHuman);
  if (room.prevAI && room.prevAI !== "(no guess)") ex.add(room.prevAI);
  return Array.from(ex);
}

async function maybeFinishRound(room) {
  if (room.roundClosed) return;
  if (!(room.submittedHuman && room.submittedAI)) return;

  room.roundClosed = true;
  if (room.roundTimer) { clearTimeout(room.roundTimer); room.roundTimer = null; }

  const r = room.round;
  const human = room.lastHuman || "(no guess)";
  const ai = room.lastAI || "(no guess)";
  room.history.push({ round: r, human, ai });

  // remember previous pair for next round, but ignore "(no guess)"
  room.prevHuman = human === "(no guess)" ? "" : human;
  room.prevAI = ai === "(no guess)" ? "" : ai;

  emitUpdate(room, "postSubmit");
  setTimeout(() => startRound(room), 400);
}

// ---------------- sockets ----------------
io.on("connection", socket => {
  const log = (...a) => console.log("[S]", ...a);

  const setActive = room => {
    room.lastActivity = nowMs();
    refreshAfkTimer(room);
  };

  socket.on("room:create", ({ name }) => {
    const room = makeRoom();
    room.players.push({ id: socket.id, name: name || "Player" });
    socket.join(room.code);
    log("room:create", room.code, "by", socket.id, "name=", name);
    setActive(room);
    startRound(room);
  });

  socket.on("room:create:ai", ({ name }) => {
    const room = makeRoom();
    room.players.push({ id: socket.id, name: name || "Player" });
    room.players.push({ id: "AI", name: "AI" });
    socket.join(room.code);
    log("room:create:ai", room.code, "by", socket.id, "name=", name);
    setActive(room);
    startRound(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return socket.emit("auth:error", { text: "bad-room" });
    room.players.push({ id: socket.id, name: name || "Player" });
    socket.join(room.code);
    setActive(room);
    emitUpdate(room, "join");
  });

  socket.on("room:leave", () => {
    for (const room of rooms.values()) {
      const ix = room.players.findIndex(p => p.id === socket.id);
      if (ix >= 0) {
        room.players.splice(ix, 1);
        emitUpdate(room, "leave");
        if (room.players.length <= 1) {
          if (room.roundTimer) clearTimeout(room.roundTimer);
          io.to(room.code).emit("room:closed", { text: "Your teammate left" });
          rooms.delete(room.code);
        } else {
          setActive(room);
        }
        break;
      }
    }
    socket.leaveAll();
  });

  socket.on("game:submit", async ({ word }) => {
    // find the room by membership
    let found = null;
    for (const r of rooms.values()) {
      if (
        r.players.some(p => p.id === socket.id) ||
        r.players.some(p => p.id === "AI" && r.players.find(q => q.id === socket.id))
      ) { found = r; break; }
    }
    if (!found) return;

    const room = found;
    if (room.roundClosed) return; // late submits after timeout are ignored
    setActive(room);

    // human goes first
    if (!room.submittedHuman) {
      room.lastHuman = String(word || "").trim() || "(no guess)";
      room.submittedHuman = true;

      try {
        // Exclude only words from previous rounds, not current round guesses
        const exclude = wordsUsedSoFar(room);

        // Use the previous round pair to form the next connection
        const prevH = room.prevHuman || "";
        const prevA = room.prevAI || "";
        const aiWord = await getNextWord(prevH, prevA, exclude);

        room.lastAI = aiWord || "(no guess)";
        room.submittedAI = true;
      } catch (e) {
        console.error("[AI] error", e);
        room.lastAI = "(no guess)";
        room.submittedAI = true;
      }

      await maybeFinishRound(room);
    } else {
      // already have a human submit, ignore overwrites if round closing
      if (room.roundClosed) return;
      room.lastHuman = String(word || "").trim() || "(no guess)";
      room.submittedHuman = true;
      await maybeFinishRound(room);
    }
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const ix = room.players.findIndex(p => p.id === socket.id);
      if (ix >= 0) room.players.splice(ix, 1);
      if (room.players.length <= 1) {
        if (room.roundTimer) clearTimeout(room.roundTimer);
        io.to(room.code).emit("room:closed", { text: "Your teammate left" });
        rooms.delete(room.code);
      } else {
        emitUpdate(room, "disconnect");
        refreshAfkTimer(room);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[server] public dir: ${PUBLIC_DIR}`);
  console.log(`[server] listening on ${PORT}`);
  console.log("[server] health endpoint ready at GET /healthz");
});
