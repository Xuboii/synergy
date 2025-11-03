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

function nowMs() { return Date.now(); }

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

function scheduleAfkClose(room) {
  if (room.afkTimer) clearTimeout(room.afkTimer);
  room.afkTimer = setTimeout(() => {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    io.to(room.code).emit("room:closed", { text: "Room closed due to inactivity" });
    rooms.delete(room.code);
  }, AFK_CLOSE_SECONDS * 1000);
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

  // reset timer for this round and enforce auto "(no guess)"
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => {
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
  scheduleAfkClose(room);
}

async function maybeFinishRound(room) {
  if (!(room.submittedHuman && room.submittedAI)) return;
  const r = room.round;
  room.history.push({
    round: r,
    human: room.lastHuman || "(no guess)",
    ai: room.lastAI || "(no guess)",
  });

  // remember this pair for the next round
  room.prevHuman = room.lastHuman || "";
  room.prevAI = room.lastAI || "";

  emitUpdate(room, "postSubmit");
  setTimeout(() => startRound(room), 400);
}

// ---------------- sockets ----------------
io.on("connection", socket => {
  const log = (...a) => console.log("[S]", ...a);

  socket.on("room:create", ({ name }) => {
    const room = makeRoom();
    room.players.push({ id: socket.id, name: name || "Player" });
    socket.join(room.code);
    log("room:create", room.code, "by", socket.id, "name=", name);
    startRound(room);
  });

  socket.on("room:create:ai", ({ name }) => {
    const room = makeRoom();
    room.players.push({ id: socket.id, name: name || "Player" });
    room.players.push({ id: "AI", name: "AI" });
    socket.join(room.code);
    log("room:create:ai", room.code, "by", socket.id, "name=", name);
    startRound(room);
  });

  socket.on("room:join", ({ code, name }) => {
    const room = rooms.get(String(code || "").trim());
    if (!room) return socket.emit("auth:error", { text: "bad-room" });
    room.players.push({ id: socket.id, name: name || "Player" });
    socket.join(room.code);
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
    room.lastActivity = nowMs();

    // human goes first
    if (!room.submittedHuman) {
      room.lastHuman = String(word || "").trim() || "(no guess)";
      room.submittedHuman = true;

      try {
        // Build exclude list from entire room history and current fields
        const ex = new Set();
        room.history.forEach(h => {
          if (h.human) ex.add(h.human);
          if (h.ai) ex.add(h.ai);
        });
        if (room.prevHuman) ex.add(room.prevHuman);
        if (room.prevAI) ex.add(room.prevAI);
        if (room.lastHuman) ex.add(room.lastHuman);
        if (room.lastAI) ex.add(room.lastAI);
        ex.delete("(no guess)");

        // Use previous round pair to form the next connection
        const aiWord = await getNextWord(
          room.prevHuman || "",
          room.prevAI || "",
          Array.from(ex)
        );

        room.lastAI = aiWord || "(no guess)";
        room.submittedAI = true;
      } catch (e) {
        console.error("[AI] error", e);
        room.lastAI = "(no guess)";
        room.submittedAI = true;
      }

      await maybeFinishRound(room);
    } else {
      // if somehow AI already took a turn, treat this as overwrite
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
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`[server] public dir: ${PUBLIC_DIR}`);
  console.log(`[server] listening on ${PORT}`);
  console.log("[server] health endpoint ready at GET /healthz");
});
