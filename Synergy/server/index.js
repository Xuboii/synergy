import express from "express";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import fetch from "node-fetch";
import { customAlphabet } from "nanoid";
if (!global.fetch) global.fetch = fetch;

import { getNextWordUsingPrev, getRandomWord } from "./aiClient.js";


// logging helpers
const DEBUG = (process.env.DEBUG || "0") === "1";
const ts = () => new Date().toISOString().slice(11, 19);
function slog(...args) { if (DEBUG) console.log(`[S ${ts()}]`, ...args); }
function ilog(...args) { if (DEBUG) console.info(`[I ${ts()}]`, ...args); }
function elog(...args) { console.error(`[E ${ts()}]`, ...args); }

// room code generator
const nanoid = customAlphabet("ABCDEFGHJKMNPQRSTUVWXYZ23456789", 6);

// server objects
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

app.use(express.static("public"));
app.get("/healthz", (req, res) => res.json({ ok: true, ts: Date.now() }));


/*
rooms[code] = {
  players: Map<socketId, { name }>,
  submissions: { [socketId]: string },
  history: [{ round, pairs: [{ id, name, word }] }],
  status: "lobby" | "playing" | "won",
  winnerRound: number | null,
  rematchReady: Set<socketId>,
  roundTimer: NodeJS.Timeout | null,
  deadline: number | null,
  afkTimer: NodeJS.Timeout | null,
  lastActivity: number,
  closing: boolean,
  // AI fields
  ai: boolean,
  botId: string | null,
  prevBot: string | null
}
*/
const rooms = {};

function getRoom(code) { return rooms[code] || null; }
function getPartnerId(room, me) { for (const id of room.players.keys()) if (id !== me) return id; return null; }

function snapshot(code) {
  const room = rooms[code];
  if (!room) return null;
  const players = Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name }));
  return {
    code,
    players,
    history: room.history,
    status: room.status,
    winnerRound: room.winnerRound,
    rematchReady: Array.from(room.rematchReady || []),
    deadline: room.deadline || null,
  };
}
function broadcast(code, tag = "") {
  const room = rooms[code];
  if (!room || room.closing) { slog(`broadcast skipped ${code} tag=${tag}`); return; }
  const s = snapshot(code);
  if (s) {
    slog(`broadcast room:update -> ${code} tag=${tag} status=${s.status} players=${s.players.length}`);
    io.to(code).emit("room:update", s);
  }
}
function clearRoundTimer(room) { if (room.roundTimer) clearTimeout(room.roundTimer); room.roundTimer = null; room.deadline = null; }
function clearAfk(room) { if (room.afkTimer) clearTimeout(room.afkTimer); room.afkTimer = null; }
function closeRoom(code, reasonText, reason) {
  const room = rooms[code];
  if (!room) return;
  room.closing = true;
  clearRoundTimer(room); clearAfk(room);
  slog(`closeRoom ${code} reason=${reason || "none"} text="${reasonText}"`);
  io.to(code).emit("room:closed", { text: reasonText || "Room closed", reason: reason || null });
  delete rooms[code];
}
function touch(code) { const room = rooms[code]; if (room && !room.closing) room.lastActivity = Date.now(); }
function bumpAfk(code, tag = "") {
  const room = rooms[code]; if (!room || room.closing) return;
  touch(code); clearAfk(room);
  slog(`bumpAfk ${code} tag=${tag}`);
  room.afkTimer = setTimeout(() => {
    const r = rooms[code]; if (!r || r.closing) return; if (r.status === "won") return;
    closeRoom(code, "Room closed due to inactivity", "afk");
  }, 70_000);
}

async function maybeMakeBotSubmission(room) {
  try {
    // Words used in completed rounds. Do not include this round so the bot can match the player.
    const exclude = getUsedWordsFromHistory(room);

    const { prevHuman, prevBot } = getPrevRoundWords(room);

    let botWord;
    if (!prevHuman && !prevBot) {
      // Round 1: ask AI to pick a random allowed word
      const rand = await getRandomWord(exclude);
      botWord = rand?.choice || "apple";
    } else {
      const ai = await getNextWordUsingPrev(prevHuman, prevBot, exclude, { beta: 0.5, gamma: 0.5, top_k: 12 });
      botWord = ai?.choice || (await getRandomWord(exclude))?.choice || "apple";
    }

    room.submissions[room.botId] = botWord;
    room.prevBot = botWord;
  } catch (err) {
    console.warn("[AI] error, using random fallback:", err?.message || err);
    const exclude = getUsedWordsFromHistory(room);
    const rand = await getRandomWord(exclude).catch(() => null);
    room.submissions[room.botId] = rand?.choice || "apple";
  }
}



function startRound(code) {
  const room = rooms[code];
  if (!room || room.closing || room.status !== "playing") return;

  room.submissions = {};
  room.deadline = Date.now() + 30_000;

  slog(`startRound ${code} round=${room.history.length + 1}`);
  io.to(code).emit("game:round", { round: room.history.length + 1, deadline: room.deadline });

  clearRoundTimer(room);
  room.roundTimer = setTimeout(async () => {
    const r = rooms[code];
    if (!r || r.closing || r.status !== "playing") return;

    if (r.ai && !r.submissions[r.botId]) {
      await maybeMakeBotSubmission(r);
    }

    const roundNum = r.history.length + 1;
    const pairs = Array.from(r.players.keys()).map((id) => ({
      id,
      name: r.players.get(id)?.name || "Player",
      word: r.submissions[id] ? r.submissions[id] : "(no guess)",
    }));

    slog(`autoReveal ${code} round=${roundNum}`);
    io.to(code).emit("game:reveal", { round: roundNum, pairs });
    r.history.push({ round: roundNum, pairs });

    const unique = new Set(pairs.map((p) => p.word.toLowerCase()));
    const allReal = pairs.every((p) => p.word && p.word.toLowerCase() !== "(no guess)");

    if (allReal && unique.size === 1) {
      r.status = "won";
      r.winnerRound = roundNum;
      slog(`game:win ${code} round=${roundNum} word="${pairs[0].word}"`);
      io.to(code).emit("game:win", { round: roundNum, word: pairs[0].word });
      clearRoundTimer(r);
      broadcast(code, "win");
      return;
    }

    broadcast(code, "afterReveal");
    startRound(code);
  }, 30_000);
}

// Words used in completed rounds only, do NOT look at current submissions.
// This allows matching in the current round.
function getUsedWordsFromHistory(room) {
  const used = new Set();
  for (const h of room.history || []) {
    for (const p of h.pairs || []) {
      const w = p.word;
      if (w && w !== "(no guess)") used.add(w.toLowerCase());
    }
  }
  return Array.from(used);
}

// Previous round’s human and AI words
function getPrevRoundWords(room) {
  if (!room.history || room.history.length === 0) return { prevHuman: null, prevBot: null };
  const last = room.history[room.history.length - 1];
  let prevHuman = null, prevBot = null;
  for (const p of last.pairs || []) {
    if (p.id === room.botId) prevBot = p.word;
    else prevHuman = p.word;
  }
  return { prevHuman, prevBot };
}

// AFK sweep
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(rooms)) {
    const room = rooms[code];
    if (!room || room.closing) continue;
    if (room.status === "won") continue;
    const idle = now - (room.lastActivity || 0);
    if (idle >= 70_000) {
      slog(`AFK sweep closing ${code} idleMs=${idle}`);
      closeRoom(code, "Room closed due to inactivity", "afk");
    }
  }
}, 5_000);

// sockets
io.on("connection", (socket) => {
  let currentRoom = null;
  const sid = socket.id.slice(-4);
  slog(`socket connected ${socket.id}`);

  socket.on("room:create", ({ name }, ack) => {
    const code = nanoid();
    rooms[code] = {
      players: new Map(),
      submissions: {},
      history: [],
      status: "lobby",
      winnerRound: null,
      rematchReady: new Set(),
      roundTimer: null,
      deadline: null,
      afkTimer: null,
      lastActivity: Date.now(),
      closing: false,
      ai: false,
      botId: null,
      prevBot: null
    };
    socket.join(code);
    rooms[code].players.set(socket.id, { name: name?.trim() || "Player" });
    currentRoom = code;
    slog(`room:create ${code} by ${sid} name="${name}"`);
    ack?.({ ok: true, code });
    broadcast(code, "create");
    bumpAfk(code, "create");
  });

  // New: AI room creation
  socket.on("room:create:ai", ({ name }, ack) => {
    const code = nanoid();
    const botId = `bot:${code}`;
    rooms[code] = {
      players: new Map(),
      submissions: {},
      history: [],
      status: "playing",
      winnerRound: null,
      rematchReady: new Set(),
      roundTimer: null,
      deadline: null,
      afkTimer: null,
      lastActivity: Date.now(),
      closing: false,
      ai: true,
      botId,
      prevBot: null
    };
    socket.join(code);
    rooms[code].players.set(socket.id, { name: name?.trim() || "Player" });
    rooms[code].players.set(botId, { name: "AI" });
    currentRoom = code;
    slog(`room:create:ai ${code} by ${sid} name="${name}"`);
    ack?.({ ok: true, code });
    broadcast(code, "createAI");
    startRound(code);
  });

  socket.on("room:join", ({ code, name }, ack) => {
    const room = getRoom(code);
    slog(`room:join req ${code} by ${sid} name="${name}"`);
    if (!room || room.closing) return ack?.({ ok: false, error: "Room not found" });
    if (room.ai) return ack?.({ ok: false, error: "This room is AI only and already full" });
    if (room.players.size >= 2) return ack?.({ ok: false, error: "Room is full" });

    socket.join(code);
    room.players.set(socket.id, { name: name?.trim() || "Player" });
    room.status = room.players.size === 2 ? "playing" : "lobby";
    currentRoom = code;
    ack?.({ ok: true, code });
    slog(`room:join ok ${code} by ${sid} now players=${room.players.size} status=${room.status}`);
    broadcast(code, "join");
    bumpAfk(code, "join");
    if (room.status === "playing" && room.players.size === 2) startRound(code);
  });

  socket.on("game:submit", async ({ word }, ack) => {
    const code = currentRoom;
    const room = getRoom(code);
    slog(`game:submit ${code} by ${sid} word="${String(word)}"`);
    if (!room || room.closing) return ack?.({ ok: false, error: "No room" });
    if (room.status !== "playing") return ack?.({ ok: false, error: "Game is not active" });
    if (!room.players.has(socket.id)) return ack?.({ ok: false, error: "Not in room" });

    const clean = String(word || "").trim();
    if (!clean) return ack?.({ ok: false, error: "Word cannot be empty" });

    // block repeats from PREVIOUS ROUNDS only, so matching this round is allowed
    const usedHistory = getUsedWordsFromHistory(room);
    if (usedHistory.includes(clean.toLowerCase())) {
      return ack?.({ ok: false, error: "That word was already used earlier in this room" });
    }

    // record the player’s submission for this round
    room.submissions[socket.id] = clean;

    bumpAfk(code, "submit");
    ack?.({ ok: true });

    // If AI room, generate bot reply now unless already present
    if (room.ai && !room.submissions[room.botId]) {
      await maybeMakeBotSubmission(room);
    }

    // Reveal when all submissions present
    if (Object.keys(room.submissions).length === room.players.size) {
      const roundNum = room.history.length + 1;
      const pairs = Array.from(room.players.keys()).map((id) => ({
        id,
        name: room.players.get(id)?.name || "Player",
        word: room.submissions[id],
      }));

      clearRoundTimer(room);
      slog(`reveal on submit ${code} round=${roundNum}`);
      io.to(code).emit("game:reveal", { round: roundNum, pairs });
      room.history.push({ round: roundNum, pairs });

      const unique = new Set(pairs.map((p) => p.word.toLowerCase()));
      const allReal = pairs.every((p) => p.word && p.word.toLowerCase() !== "(no guess)");

      if (allReal && unique.size === 1) {
        room.status = "won";
        room.winnerRound = roundNum;
        slog(`game:win on submit ${code} round=${roundNum} word="${pairs[0].word}"`);
        io.to(code).emit("game:win", { round: roundNum, word: pairs[0].word });
        broadcast(code, "winOnSubmit");
      } else {
        broadcast(code, "postSubmit");
        startRound(code);
      }
    } else {
      socket.to(code).emit("game:waiting", { playerId: socket.id });
    }
  });

  socket.on("game:rematch:ready", () => {
    const code = currentRoom;
    const room = getRoom(code);
    slog(`rematch:ready ${code} by ${sid}`);
    if (!room || room.closing) return;
    if (room.status !== "won") return;

    // For AI rooms, only the human needs to press ready
    if (room.ai) {
      room.history = [];
      room.submissions = {};
      room.status = "playing";
      room.winnerRound = null;
      room.rematchReady = new Set();
      room.prevBot = null;
      io.to(code).emit("game:restart");
      broadcast(code, "restartAI");
      startRound(code);
      return;
    }

    // Normal 2 human room
    if (room.players.size !== 2) return;
    room.rematchReady.add(socket.id);
    bumpAfk(code, "rematchReady");

    if (room.rematchReady.size === 2) {
      slog(`rematch:restart ${code}`);
      room.history = [];
      room.submissions = {};
      room.status = "playing";
      room.winnerRound = null;
      room.rematchReady.clear();
      io.to(code).emit("game:restart");
      broadcast(code, "restart");
      startRound(code);
      return;
    }
    broadcast(code, "rematchWait");
  });

  function notifyPartnerAndClose(reasonText) {
    const code = currentRoom;
    const room = getRoom(code);
    slog(`notifyPartnerAndClose ${code} by ${sid} reason="${reasonText}"`);
    if (!room || room.closing) return;

    room.closing = true;

    const partnerId = getPartnerId(room, socket.id);
    if (partnerId) {
      slog(`emit partner:left:modal to partner ${partnerId.slice(-4)} in ${code}`);
      io.to(partnerId).emit("partner:left:modal", { text: reasonText });
    }

    socket.emit("room:left");
    socket.leave(code);

    setTimeout(() => { closeRoom(code, reasonText, null); }, 0);
    currentRoom = null;
  }

  socket.on("game:return:lobby", () => { notifyPartnerAndClose("Your teammate returned to the lobby"); });
  socket.on("room:leave", () => { notifyPartnerAndClose("Your teammate left the room"); });

  socket.on("disconnect", () => {
    const code = currentRoom;
    const room = getRoom(code);
    slog(`socket disconnect ${sid} room=${code}`);
    if (!room || room.closing) return;

    room.closing = true;
    const partnerId = getPartnerId(room, socket.id);
    if (partnerId) {
      slog(`emit partner:left:modal due to disconnect to ${partnerId.slice(-4)} in ${code}`);
      io.to(partnerId).emit("partner:left:modal", { text: "Your teammate disconnected" });
    }
    setTimeout(() => { closeRoom(code, "Your teammate disconnected", null); }, 0);
    currentRoom = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[server] listening on ${PORT}`);
  console.log(`[server] health endpoint ready at GET /healthz`);
});