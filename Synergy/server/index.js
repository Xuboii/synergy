// server/index.js (ESM)
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

app.use(express.static(PUBLIC_DIR));
app.get("/healthz", (_, res) => res.json({ ok: true }));

// ---------- rooms ----------
const rooms = new Map();
const nowMs = () => Date.now();
const norm = s => String(s || "").trim().toLowerCase();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function makeRoom() {
  const code = makeCode();
  const room = {
    code,
    mode: "human",            // "human" or "ai"
    status: "waiting",
    round: 0,
    deadline: 0,
    players: [],              // [{id, name}]
    history: [],              // [{round, human, ai}]  slots A,B
    // current round state
    lastHuman: "",
    lastAI: "",
    submittedHuman: false,
    submittedAI: false,
    roundClosed: false,
    // previous valid pair (both were real, not "(no guess)")
    prevHuman: "",
    prevAI: "",
    // timers
    lastActivity: nowMs(),
    afkTimer: null,
    roundTimer: null,
    // finish state
    win: null,                // { round, word }
    rematchVotes: new Set(),
  };
  rooms.set(code, room);
  return room;
}

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
  room.round = room.history.length + 1;
  room.deadline = nowMs() + ROUND_SECONDS * 1000;

  room.submittedHuman = false;
  room.submittedAI = false;
  room.roundClosed = false;
  room.lastHuman = "";
  room.lastAI = "";

  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
    if (room.roundClosed) return;
    if (!room.submittedHuman) { room.lastHuman = "(no guess)"; room.submittedHuman = true; }
    if (!room.submittedAI)   { room.lastAI   = "(no guess)";  room.submittedAI   = true; }
    maybeFinishRound(room);
  }, ROUND_SECONDS * 1000);

  emitUpdate(room, "roundStart");
}

function wordsUsedSoFar(room) {
  const ex = new Set();
  for (const h of room.history) {
    if (h.human && h.human !== "(no guess)") ex.add(norm(h.human));
    if (h.ai && h.ai !== "(no guess)") ex.add(norm(h.ai));
  }
  if (room.prevHuman && room.prevHuman !== "(no guess)") ex.add(norm(room.prevHuman));
  if (room.prevAI && room.prevAI !== "(no guess)") ex.add(norm(room.prevAI));
  return Array.from(ex);
}

function wordAlreadyUsed(room, w) {
  if (!w) return false;
  const used = wordsUsedSoFar(room);
  return used.includes(norm(w));
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

  const realHuman = human !== "(no guess)";
  const realAI = ai !== "(no guess)";
  if (realHuman && realAI) {
    room.prevHuman = human;
    room.prevAI = ai;
  }

  if (realHuman && human === ai) {
    room.status = "closed";
    room.win = { round: r, word: human };
    io.to(room.code).emit("game:win", { code: room.code, round: r, word: human });
    return;
  }

  emitUpdate(room, "postSubmit");
  setTimeout(() => startRound(room), 400);
}

// ---------- sockets ----------
io.on("connection", socket => {
  const setActive = room => { room.lastActivity = nowMs(); refreshAfkTimer(room); };

  // Create Room: human mode, wait for teammate
  socket.on("room:create", ({ name }) => {
    const room = makeRoom(); // mode stays "human"
    room.players.push({ id: socket.id, name: name || "Player" });
    socket.join(room.code);
    setActive(room);
    emitUpdate(room, "created");
  });

  // Play with AI: start immediately
  socket.on("room:create:ai", ({ name }) => {
    const room = makeRoom();
    room.mode = "ai";
    room.players.push({ id: socket.id, name: name || "Player" });
    room.players.push({ id: "AI", name: "AI" });
    room.status = "playing";
    socket.join(room.code);
    setActive(room);
    emitUpdate(room, "createAI");
    startRound(room);
  });

  // Join by code
  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return socket.emit("auth:error", { text: "bad-room" });
    room.players.push({ id: socket.id, name: name || "Player" });
    socket.join(room.code);
    setActive(room);

    if (room.status === "waiting" && room.players.length >= 2) {
      room.status = "playing";
      emitUpdate(room, "join");
      startRound(room);
    } else {
      emitUpdate(room, "join");
    }
  });

  function handleLeave(socket) {
    for (const room of rooms.values()) {
      const ix = room.players.findIndex(p => p.id === socket.id);
      if (ix >= 0) {
        const leaver = room.players[ix];
        const isAI = room.mode === "ai";

        room.players.splice(ix, 1);

        // Notify teammate only if human room
        if (room.mode === "human") {
          socket.to(room.code).emit("room:closed", { text: "Your teammate left" });
        }

        // Clean up
        if (room.roundTimer) clearTimeout(room.roundTimer);
        if (room.afkTimer) clearTimeout(room.afkTimer);
        rooms.delete(room.code);
        break;
      }
    }

    socket.leaveAll();
    // Tell only the leaver to reset quietly
    socket.emit("room:left");
  }

  io.on("connection", socket => {
    socket.on("room:leave", () => handleLeave(socket));
    socket.on("rematch:leave", () => handleLeave(socket));

    // ... (keep the rest of your logic unchanged)
  });




  // Submit word
  socket.on("game:submit", async ({ word }) => {
    let room = null;
    for (const r of rooms.values()) {
      if (r.players.some(p => p.id === socket.id)) { room = r; break; }
    }
    if (!room) return;
    if (room.roundClosed || room.status !== "playing") return;

    setActive(room);

    const clean = String(word || "").trim() || "(no guess)";

    // Block repeats that were used in earlier rounds
    if (clean !== "(no guess)" && wordAlreadyUsed(room, clean)) {
      socket.emit("game:error", { text: "That word was already used in a previous round." });
      return;
    }

    const aId = room.players[0]?.id;
    const bId = room.players[1]?.id;

    // Human mode: record both humans, never call AI
    if (room.mode === "human") {
      if (socket.id === aId && !room.submittedHuman) {
        room.lastHuman = clean;
        room.submittedHuman = true;
      } else if (socket.id === bId && !room.submittedAI) {
        room.lastAI = clean;
        room.submittedAI = true;
      }
      await maybeFinishRound(room);
      return;
    }

    // AI mode: human in slot A submits, server fills slot B if it is truly AI
    if (room.mode === "ai" && bId === "AI" && socket.id === aId && !room.submittedHuman) {
      room.lastHuman = clean;
      room.submittedHuman = true;

      try {
        const exclude = wordsUsedSoFar(room); // excludes only earlier rounds
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
      return;
    }

    // ignore anything else
  });

  // Rematch request
  socket.on("rematch:request", () => {
    let found = null;
    for (const r of rooms.values()) {
      if (r.players.some(p => p.id === socket.id)) { found = r; break; }
    }
    if (!found || !found.win) return;

    const room = found;
    room.rematchVotes.add(socket.id);
    if (room.mode === "ai") room.rematchVotes.add("AI");

    io.to(room.code).emit("rematch:status", {
      readyCount: room.rematchVotes.size,
      total: room.players.length,
    });

    if (room.rematchVotes.size >= room.players.length) {
      room.status = "playing";
      room.round = 0;
      room.history = [];
      room.lastHuman = "";
      room.lastAI = "";
      room.submittedHuman = false;
      room.submittedAI = false;
      room.roundClosed = false;
      room.prevHuman = "";
      room.prevAI = "";
      room.win = null;
      room.rematchVotes.clear();

      emitUpdate(room, "rematchBegin");
      startRound(room);
      io.to(room.code).emit("rematch:begin");
    }
  });


  // Disconnect
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
