// public/client.js
const DEBUG = false;
const socket = io();

const $ = s => document.querySelector(s);

// sections
const lobby = $("#lobby");
const game = $("#game");
const results = $("#results");

// header room
const roomLabel = $("#roomLabel");
const roomCodeEl = $("#roomCode");
const copyHeaderCode = $("#copyHeaderCode");

// lobby controls
const auth = {
  name: $("#name"),
  createBtn: $("#createBtn"),
  createAIBtn: $("#createAIBtn"),
  joinCode: $("#joinCode"),
  joinBtn: $("#joinBtn"),
  msg: $("#authMsg"),
};
const lobbyRoom = $("#lobbyRoom");
const lobbyRoomCode = $("#lobbyRoomCode");
const copyLobbyCode = $("#copyLobbyCode");
const leaveBtnLobby = $("#leaveBtnLobby");

// game controls
const ui = {
  status: $("#status"),
  players: $("#players"),
  waitMsg: $("#waitMsg"),
  leaveBtn: $("#leaveBtn"),
  wordForm: $("#wordForm"),
  wordInput: $("#wordInput"),
  resultTitle: $("#resultTitle"),
  resultSubtitle: $("#resultSubtitle"),
  resultsButtons: $("#resultsButtons"),
  rematchBtn: $("#rematchBtn"),
  backToLobbyBtn: $("#backToLobbyBtn"),
  rematchMsg: $("#rematchMsg"),
  historyTable: $("#historyTable"),
  countdown: $("#countdown"),
};

// ----- debug helpers -----
function ts() {
  const d = new Date();
  return d.toISOString().split("T")[1].replace("Z", "");
}
function clog(...a) {
  if (!DEBUG) return;
  console.log(`[C ${ts()}]`, ...a);
}

let currentRoom = null;
let submittedThisRound = false;
let myId = null;
let playerOrder = [];
let lastHistoryLen = 0;

// terminal lock so nothing can override the modal
let terminalScreen = null; // null | "partner-left" | "afk"

// ===== timers =====
let deadline = null;
let tickInterval = null;
function setCountdown(msEpoch) {
  deadline = msEpoch;
  if (tickInterval) clearInterval(tickInterval);
  if (!deadline) { ui.countdown.textContent = "30"; return; }
  const tick = () => {
    const left = Math.max(0, Math.floor((deadline - Date.now()) / 1000));
    ui.countdown.textContent = String(left);
    if (left <= 0) clearInterval(tickInterval);
  };
  tick();
  tickInterval = setInterval(tick, 250);
}

// ===== copy helpers =====
function copy(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    const span = document.createElement("span");
    span.textContent = "Copied!";
    span.className = "copied-indicator";
    el.parentElement.appendChild(span);
    setTimeout(() => { span.classList.add("fade-out"); setTimeout(() => span.remove(), 400); }, 900);
  }).catch(() => {});
}

// ===== UI switches =====
function hardResetInputs() {
  auth.name.value = "";
  auth.joinCode.value = "";
  lobbyRoomCode.textContent = "";
  roomCodeEl.textContent = "";
}
function showLobby() {
  clog("UI showLobby");
  lobby.classList.remove("hidden");
  game.classList.add("hidden");
  results.classList.add("hidden");
  roomLabel.classList.add("hidden");
  lobbyRoom.classList.toggle("hidden", !currentRoom);
}
function showGame() {
  clog("UI showGame");
  lobby.classList.add("hidden");
  results.classList.add("hidden");
  game.classList.remove("hidden");
  roomLabel.classList.remove("hidden");
  lobbyRoom.classList.add("hidden");
}
function showResults() {
  clog("UI showResults");
  lobby.classList.add("hidden");
  game.classList.add("hidden");
  results.classList.remove("hidden");
  roomLabel.classList.add("hidden");
  lobbyRoom.classList.add("hidden");
}

// ===== actions =====
auth.createBtn.onclick = () => {
  const name = auth.name.value.trim() || "Player";
  clog("click create room name=", name);
  socket.emit("room:create", { name }, res => {
    clog("ack room:create", res);
    if (!res?.ok) { auth.msg.textContent = res?.error || "Could not create room"; return; }
    currentRoom = res.code;
    roomCodeEl.textContent = res.code;
    lobbyRoomCode.textContent = res.code;
    lobbyRoom.classList.remove("hidden");
    showLobby();
  });
};

// Create a room that immediately pairs you with an AI
createAIBtn.onclick = () => {
  const name = auth.name.value.trim() || "Player";
  clog("click create AI room name=", name);
  socket.emit("room:create:ai", { name }, res => {
    clog("ack room:create:ai", res);
    if (!res?.ok) { auth.msg.textContent = res?.error || "Could not create AI room"; return; }
    currentRoom = res.code;
    roomCodeEl.textContent = res.code;
    lobbyRoomCode.textContent = res.code;
    lobbyRoom.classList.remove("hidden");
    // The server starts the round right away for AI rooms, so we let normal room:update move the UI to Game
  });
};

auth.joinBtn.onclick = () => {
  const code = auth.joinCode.value.trim().toUpperCase();
  const name = auth.name.value.trim() || "Player";
  clog("click join room", code, name);
  if (!code) { auth.msg.textContent = "Enter a room code"; return; }
  socket.emit("room:join", { code, name }, res => {
    clog("ack room:join", res);
    if (!res?.ok) { auth.msg.textContent = res?.error || "Could not join"; return; }
    currentRoom = res.code;
    roomCodeEl.textContent = res.code;
    lobbyRoomCode.textContent = res.code;
    lobbyRoom.classList.remove("hidden");
  });
};

leaveBtnLobby.onclick = () => {
  clog("click leaveBtnLobby");
  socket.emit("room:leave");
  terminalScreen = null;
  currentRoom = null;
  hardResetInputs();
  resetUI();
  showLobby();
};

copyLobbyCode.onclick = (e) => {
  const c = lobbyRoomCode.textContent.trim();
  if (c) copy(c, e.currentTarget);
};
copyHeaderCode.onclick = (e) => {
  const c = roomCodeEl.textContent.trim();
  if (c) copy(c, e.currentTarget);
};

ui.leaveBtn.onclick = () => {
  clog("click leave in game");
  socket.emit("room:leave");
  terminalScreen = null;
  currentRoom = null;
  hardResetInputs();
  resetUI();
  showLobby();
};

ui.wordForm.onsubmit = e => {
  e.preventDefault();
  if (submittedThisRound) return;
  const word = ui.wordInput.value.trim();
  if (!word) return;
  clog("submit word", word);
  socket.emit("game:submit", { word }, res => {
    clog("ack game:submit", res);
    if (!res?.ok) { ui.waitMsg.textContent = res?.error || "Submit failed"; return; }
    submittedThisRound = true;
    ui.waitMsg.textContent = "Waiting for your teammate";
    ui.wordInput.value = "";
  });
};

ui.rematchBtn.onclick = () => {
  if (terminalScreen) { clog("ignore rematch during terminal"); return; }
  clog("click rematch");
  ui.rematchBtn.disabled = true;
  ui.rematchMsg.textContent = "You are ready. Waiting for your teammate";
  socket.emit("game:rematch:ready");
};

// IMPORTANT FIX: always emit when leaving from the results screen.
// If terminalScreen is set, it means we are already on the partner-left or AFK modal,
// so just clean up locally. Otherwise, tell the server to notify the partner and close the room.
ui.backToLobbyBtn.onclick = () => {
  clog("click backToLobbyBtn, terminalScreen=", terminalScreen, "currentRoom=", currentRoom);
  if (!terminalScreen && currentRoom) {
    clog("emit game:return:lobby");
    socket.emit("game:return:lobby");
    // The server will emit partner:left:modal to the other player and room:left to us.
    return;
  }
  // Terminal modal case, or no room
  terminalScreen = null;
  currentRoom = null;
  hardResetInputs();
  resetUI();
  showLobby();
  attachCoreListeners(); // rebind after terminal state
};

socket.on("connect", () => { myId = socket.id; clog("socket connect", myId); });

// ===== rendering =====
function renderPlayers(list) {
  ui.players.innerHTML = "";
  list.forEach(p => {
    const li = document.createElement("li");
    li.textContent = p.name;
    ui.players.appendChild(li);
  });
}
function renderStatus(status) {
  ui.status.textContent = status === "playing" ? "In Game" : status;
}
function computePlayerOrder(snap) {
  if (snap.players.length >= 1) playerOrder = snap.players.map(p => p.id).slice(0, 2);
  else playerOrder = [];
}
function renderHistoryTable(snap) {
  computePlayerOrder(snap);
  const [id1, id2] = playerOrder;
  const p1 = snap.players.find(p => p.id === id1);
  const p2 = snap.players.find(p => p.id === id2);
  const name1 = p1?.name || "Player 1";
  const name2 = p2?.name || "Player 2";
  let html = `
    <table class="table">
      <thead><tr><th>Round</th><th>${name1}</th><th>${name2}</th></tr></thead>
      <tbody>`;
  snap.history.forEach(r => {
    const byId = {}; r.pairs.forEach(p => { byId[p.id] = p.word; });
    const w1 = id1 ? (byId[id1] ?? "") : "";
    const w2 = id2 ? (byId[id2] ?? "") : "";
    html += `<tr>
      <td class="col-round">${r.round}</td>
      <td class="col-word"><span class="tag">${name1}</span><span class="guess">${w1}</span></td>
      <td class="col-word"><span class="tag">${name2}</span><span class="guess">${w2}</span></td>
    </tr>`;
  });
  html += `</tbody></table>`;
  ui.historyTable.innerHTML = html;
}

// ===== named handlers so we can detach on terminal =====
function onRoomUpdate(snap) {
  if (terminalScreen) { clog("room:update ignored due to terminal"); return; }

  clog("room:update status=", snap.status, "players=", snap.players.length, "code=", snap.code);

  if (snap.status === "playing") showGame();
  else if (snap.status === "won") showResults();
  else showLobby();

  renderPlayers(snap.players);
  renderStatus(snap.status);

  if (snap.status === "playing") {
    roomCodeEl.textContent = snap.code;
    roomLabel.classList.remove("hidden");
  }
  if (!currentRoom) currentRoom = snap.code;
  lobbyRoomCode.textContent = currentRoom || "";
  if (currentRoom && snap.status !== "playing" && snap.status !== "won") {
    lobbyRoom.classList.remove("hidden");
  }

  renderHistoryTable(snap);

  if (snap.history.length !== lastHistoryLen) {
    submittedThisRound = false;
    ui.waitMsg.textContent = "";
    lastHistoryLen = snap.history.length;
  }

  if (snap.deadline) setCountdown(snap.deadline);

  if (snap.status === "won") {
    const ready = new Set(snap.rematchReady || []);
    const myReady = ready.has(myId);
    if (ready.size === 0) { ui.rematchBtn.disabled = false; ui.rematchMsg.textContent = ""; }
    else if (ready.size === 1) {
      ui.rematchBtn.disabled = myReady;
      ui.rematchMsg.textContent = myReady ? "You are ready. Waiting for your teammate" : "Your teammate is ready";
    } else {
      ui.rematchBtn.disabled = true;
      ui.rematchMsg.textContent = "Both ready. Restarting";
    }
  }
}

function onGameRound({ deadline }) { clog("game:round deadline set"); setCountdown(deadline); }

function onGameWin({ round, word }) {
  if (terminalScreen) { clog("game:win ignored due to terminal"); return; }
  clog("game:win round=", round, "word=", word);
  ui.resultTitle.textContent = `You matched on round ${round}`;
  ui.resultSubtitle.textContent = `Winning word: "${word}"`;
  ui.resultsButtons.classList.remove("hidden");
  ui.rematchBtn.classList.remove("hidden");
  ui.backToLobbyBtn.classList.remove("hidden");
  showResults();
}

function onGameRestart() {
  if (terminalScreen) { clog("game:restart ignored due to terminal"); return; }
  clog("game:restart showGame");
  ui.waitMsg.textContent = "";
  submittedThisRound = false;
  ui.rematchBtn.disabled = false;
  ui.rematchMsg.textContent = "";
  lastHistoryLen = 0;
  setCountdown(null);
  showGame();
}

function enterTerminalScreen(type, title, subtitle) {
  terminalScreen = type;
  clog("enterTerminalScreen", type, "title=", title, "subtitle=", subtitle);

  socket.off("room:update", onRoomUpdate);
  socket.off("game:restart", onGameRestart);
  socket.off("game:win", onGameWin);
  socket.off("game:round", onGameRound);

  ui.rematchBtn.disabled = true;
  ui.wordForm.onsubmit = e => e.preventDefault();

  ui.resultTitle.textContent = title;
  ui.resultSubtitle.textContent = subtitle || "";
  ui.resultsButtons.classList.remove("hidden");
  ui.rematchBtn.classList.add("hidden");
  ui.backToLobbyBtn.classList.remove("hidden");
  ui.rematchMsg.textContent = "";
  showResults();
}

function onPartnerLeftModal({ text }) {
  clog("partner:left:modal received text=", text);
  enterTerminalScreen("partner-left", "Your teammate left", text || "Room closed");
}

function onRoomClosed({ text, reason }) {
  clog("room:closed received reason=", reason, "text=", text, "terminalScreen=", terminalScreen);
  if (terminalScreen) return;
  if (reason === "afk") {
    enterTerminalScreen("afk", "Inactive too long", "You have been inactive for too long");
    return;
  }
  enterTerminalScreen("partner-left", "Your teammate left", text || "Room closed");
}

// attach once at load, and reattach after leaving terminal
function attachCoreListeners() {
  clog("attachCoreListeners");
  socket.off("room:update");   socket.on("room:update", onRoomUpdate);
  socket.off("game:round");    socket.on("game:round", onGameRound);
  socket.off("game:win");      socket.on("game:win", onGameWin);
  socket.off("game:restart");  socket.on("game:restart", onGameRestart);
  socket.off("partner:left:modal"); socket.on("partner:left:modal", onPartnerLeftModal);
  socket.off("room:closed");   socket.on("room:closed", onRoomClosed);
  socket.off("partner:left");  socket.on("partner:left", ({ text }) => onPartnerLeftModal({ text }));
}
attachCoreListeners();

socket.on("room:left", () => {
  clog("room:left self cleanup");
  terminalScreen = null;
  currentRoom = null;
  hardResetInputs();
  resetUI();
  showLobby();
  attachCoreListeners();
});

socket.on("room:notice", ({ text }) => { ui.waitMsg.textContent = text; });

function resetUI() {
  clog("resetUI");
  ui.players.innerHTML = "";
  ui.waitMsg.textContent = "";
  ui.rematchMsg.textContent = "";
  ui.rematchBtn.disabled = false;
  submittedThisRound = false;
  roomCodeEl.textContent = "";
  lobbyRoom.classList.add("hidden");
  playerOrder = [];
  lastHistoryLen = 0;
  ui.historyTable.innerHTML = "";
  setCountdown(null);
}
