// public/client.js
(() => {
  document.addEventListener("DOMContentLoaded", () => {
    // ----- DOM -----
    const elLobby         = document.getElementById("lobby");
    const elGame          = document.getElementById("game");
    const elResults       = document.getElementById("results");

    const elStatus        = document.getElementById("status");
    const elRoomLabel     = document.getElementById("roomLabel");
    const elRoomCodeHdr   = document.getElementById("roomCode");
    const btnCopyHdr      = document.getElementById("copyHeaderCode");

    const inName          = document.getElementById("name");
    const btnCreate       = document.getElementById("createBtn");
    const btnCreateAI     = document.getElementById("createAIBtn");
    const inJoinCode      = document.getElementById("joinCode");
    const btnJoin         = document.getElementById("joinBtn");

    const elLobbyRoom     = document.getElementById("lobbyRoom");
    const elLobbyRoomCode = document.getElementById("lobbyRoomCode");
    const btnCopyLobby    = document.getElementById("copyLobbyCode");
    const btnLeaveLobby   = document.getElementById("leaveBtnLobby");

    const btnLeaveGame    = document.getElementById("leaveBtn");

    const elPlayers       = document.getElementById("players");
    const elCountdown     = document.getElementById("countdown");
    const formWord        = document.getElementById("wordForm");
    const inWord          = document.getElementById("wordInput");
    const elWaitMsg       = document.getElementById("waitMsg");
    const elHistoryWrap   = document.getElementById("historyTable");

    const elResultTitle   = document.getElementById("resultTitle");
    const elResultSubtitle= document.getElementById("resultSubtitle");
    const elResultsBtns   = document.getElementById("resultsButtons");
    const btnBackLobby    = document.getElementById("backToLobbyBtn");
    const btnRematch      = document.getElementById("rematchBtn");
    const elAuthMsg       = document.getElementById("authMsg");

    const req = [
      elLobby, elGame, elResults, elStatus, elRoomLabel, elRoomCodeHdr, btnCopyHdr,
      inName, btnCreate, btnCreateAI, inJoinCode, btnJoin, elLobbyRoom,
      elLobbyRoomCode, btnCopyLobby, btnLeaveLobby, btnLeaveGame,
      elPlayers, elCountdown, formWord, inWord, elWaitMsg, elHistoryWrap,
      elResultTitle, elResultSubtitle, elResultsBtns, btnBackLobby, btnRematch
    ];
    if (req.some(x => !x)) {
      console.error("[client] Missing DOM nodes. Check IDs in index.html");
      return;
    }

    // ----- helpers -----
    const setText = (el, t) => (el.textContent = t ?? "");
    const show = el => el.classList.remove("hidden");
    const hide = el => el.classList.add("hidden");

    function viewLobby()   { show(elLobby); hide(elGame); hide(elResults); }
    function viewGame()    { hide(elLobby); show(elGame); hide(elResults); }
    function viewResults() { hide(elLobby); hide(elGame); show(elResults); }

    let currentRoom = null;
    let submitLocked = false;
    let timerId = null;
    function startTimer(deadlineMs) {
      if (timerId) clearInterval(timerId);
      const tick = () => {
        const left = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
        setText(elCountdown, left);
      };
      tick();
      timerId = setInterval(tick, 250);
    }

    function setRoomCode(code) {
      currentRoom = code || null;
      if (currentRoom) {
        setText(elRoomCodeHdr, currentRoom);
        setText(elLobbyRoomCode, currentRoom);
        show(elRoomLabel);
        show(elLobbyRoom);
      } else {
        setText(elRoomCodeHdr, "");
        setText(elLobbyRoomCode, "------");
        hide(elRoomLabel);
        hide(elLobbyRoom);
      }
    }

    function lockSubmit(lock, msg = "") {
      submitLocked = !!lock;
      inWord.disabled = submitLocked;
      const btn = formWord.querySelector("button[type=submit]");
      if (btn) btn.disabled = submitLocked;
      setText(elWaitMsg, msg);
    }

    function renderPlayers(players) {
      elPlayers.innerHTML = "";
      (players || []).forEach(p => {
        const li = document.createElement("li");
        li.textContent = p?.name || "Player";
        elPlayers.appendChild(li);
      });
    }

    function renderHistory(history) {
      elHistoryWrap.innerHTML = "";
      const table = document.createElement("table");
      // use the CSS class that actually has styles
      table.className = "table";
      table.innerHTML = "<thead><tr><th>Round</th><th>Player</th><th>AI</th></tr></thead>";
      const tbody = document.createElement("tbody");
      (history || []).forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td class="col-round">${r.round ?? ""}</td><td class="col-word">${r.human ?? ""}</td><td class="col-word">${r.ai ?? ""}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      elHistoryWrap.appendChild(table);
    }

    function copyCode() {
      if (!currentRoom || !navigator.clipboard) return;
      navigator.clipboard.writeText(currentRoom).catch(() => {});
      // small “copied” feedback near the header code
      const span = document.createElement("span");
      span.className = "copied-indicator";
      span.textContent = "Copied";
      btnCopyHdr.after(span);
      setTimeout(() => span.classList.add("fade-out"), 500);
      setTimeout(() => span.remove(), 900);
    }

    btnCopyHdr.addEventListener("click", copyCode);
    btnCopyLobby.addEventListener("click", copyCode);

    // ----- socket -----
    const socket = io();

    socket.on("room:update", payload => {
      // entering a room moves to Game view
      viewGame();

      if (payload.code) setRoomCode(payload.code);
      if (payload.status) setText(elStatus, payload.status);
      if (payload.players) renderPlayers(payload.players);
      if (payload.history) renderHistory(payload.history);
      if (payload.deadline) startTimer(payload.deadline);

      // after certain tags, unlock input
      const tag = payload.tag || "";
      if (["postSubmit", "roundStart", "join", "createAI"].includes(tag)) {
        lockSubmit(false, "");
      }
      setText(elAuthMsg, "");
    });

    socket.on("room:closed", info => {
      // Show a simple results screen with a single “Return to lobby”
      setText(elResultTitle, "Room closed");
      setText(elResultSubtitle, info?.text || "");
      hide(btnRematch);
      show(btnBackLobby);
      viewResults();
      if (timerId) clearInterval(timerId);
      setRoomCode(null);
      lockSubmit(true, info?.text || "Room closed");
    });

    socket.on("auth:error", info => {
      setText(elAuthMsg, info?.text === "bad-room" ? "Room not found" : "Unable to join");
    });

    // ----- lobby actions -----
    btnCreate.addEventListener("click", () => {
      const name = (inName.value || "").trim();
      socket.emit("room:create", { name });
    });

    btnCreateAI.addEventListener("click", () => {
      const name = (inName.value || "").trim();
      socket.emit("room:create:ai", { name });
    });

    btnJoin.addEventListener("click", () => {
      const code = (inJoinCode.value || "").trim();
      const name = (inName.value || "").trim();
      if (!code) return setText(elAuthMsg, "Enter a code to join");
      socket.emit("room:join", { code, name });
    });

    btnLeaveLobby.addEventListener("click", () => {
      socket.emit("room:leave");
      setRoomCode(null);
      viewLobby();
    });

    btnLeaveGame.addEventListener("click", () => {
      socket.emit("room:leave");
      setRoomCode(null);
      viewLobby();
    });

    btnBackLobby.addEventListener("click", () => {
      setRoomCode(null);
      viewLobby();
    });

    // no rematch flow on server yet, so hide button behavior
    btnRematch.addEventListener("click", () => {
      // could emit a custom event in the future
      setRoomCode(null);
      viewLobby();
    });

    // ----- word submit -----
    formWord.addEventListener("submit", e => {
      e.preventDefault();
      if (submitLocked) return;
      const w = (inWord.value || "").trim();
      if (!w) return;
      socket.emit("game:submit", { word: w });
      inWord.value = "";
      lockSubmit(true, "Waiting for teammate…");
    });

    // start at lobby
    viewLobby();
  });
})();
