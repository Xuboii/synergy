// public/client.js
(() => {
  document.addEventListener("DOMContentLoaded", () => {
    // ---------- DOM ----------
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
    const btnBackLobby    = document.getElementById("backToLobbyBtn");
    const btnRematch      = document.getElementById("rematchBtn");
    const elRematchMsg    = document.getElementById("rematchMsg");
    const elAuthMsg       = document.getElementById("authMsg");

    const req = [
      elLobby, elGame, elResults, elStatus, elRoomLabel, elRoomCodeHdr, btnCopyHdr,
      inName, btnCreate, btnCreateAI, inJoinCode, btnJoin, elLobbyRoom,
      elLobbyRoomCode, btnCopyLobby, btnLeaveLobby, btnLeaveGame,
      elPlayers, elCountdown, formWord, inWord, elWaitMsg, elHistoryWrap,
      elResultTitle, elResultSubtitle, btnBackLobby, btnRematch
    ];
    if (req.some(x => !x)) {
      console.error("[client] Missing DOM nodes. Check IDs in index.html");
      return;
    }

    // ---------- helpers ----------
    const setText = (el, t) => (el.textContent = t ?? "");
    const show = el => el.classList.remove("hidden");
    const hide = el => el.classList.add("hidden");

    function viewLobby()   { show(elLobby); hide(elGame); hide(elResults); }
    function viewGame()    { hide(elLobby); show(elGame); hide(elResults); }
    function viewResults() { hide(elLobby); hide(elGame); show(elResults); }

    function showResults(title, subtitle, showRematch = true) {
      setText(elResultTitle, title || "Room closed");
      setText(elResultSubtitle, subtitle || "");
      setText(elRematchMsg, "");
      viewResults();
      btnRematch.style.display = showRematch ? "" : "none";
    }

    let currentRoom = null;
    let submitLocked = false;
    let timerId = null;
    let playerNames = ["Player A", "Player B"];

    function resetRoundUI() {
      if (timerId) clearInterval(timerId);
      setText(elCountdown, "30s left");
      setText(elWaitMsg, "");                // clear message
      show(elCountdown);
      // keep input disabled until playing
    }

    // Only start ticking when server sends a deadline
    function startTimer(deadlineMs) {
      if (timerId) clearInterval(timerId);
      const tick = () => {
        const left = Math.max(0, Math.floor((deadlineMs - Date.now()) / 1000));
        elCountdown.textContent = `${left}s left`;
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
      table.className = "table";
      const [nameA, nameB] = playerNames;
      table.innerHTML = `<thead>
        <tr><th>Round</th><th>${nameA}</th><th>${nameB}</th></tr>
      </thead>`;
      const tbody = document.createElement("tbody");
      (history || []).forEach(r => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="col-round">${r.round ?? ""}</td>
          <td class="col-word">${r.human ?? ""}</td>
          <td class="col-word">${r.ai ?? ""}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      elHistoryWrap.appendChild(table);
    }

    function copyCode() {
      if (!currentRoom || !navigator.clipboard) return;
      navigator.clipboard.writeText(currentRoom).catch(() => {});
    }

    btnCopyHdr.addEventListener("click", copyCode);
    btnCopyLobby.addEventListener("click", copyCode);

    // ---------- socket ----------
    const socket = io();

    // Countdown banner
    socket.on("game:countdown", ({ seconds }) => {
      setText(elWaitMsg, "");                // ensure no "waiting..." text
      elStatus.style.color = "#ffcc00";
      elStatus.style.fontWeight = "600";
      if (seconds >= 0) {
        elStatus.textContent = `Game starts in ${seconds}...`;
        setText(elCountdown, "30s left");
      } else {
        elStatus.textContent = "Go!";
        setTimeout(() => {
          setText(elStatus, "Playing");
          elStatus.style.color = "#00ff88";
        }, 500);
      }
    });


    socket.on("room:update", payload => {
      viewGame();

      if (payload.code) setRoomCode(payload.code);

      if (payload.status) {
        switch (payload.status) {
          case "waiting":
            elStatus.textContent = "Waiting for teammate…";
            elStatus.style.color = "#8888ff";
            lockSubmit(true, "");
            break;
          case "countdown":
            elStatus.textContent = "Game starting soon…";
            elStatus.style.color = "#ffcc00";
            lockSubmit(true, "");
            break;
          case "playing":
            elStatus.textContent = "Playing";
            elStatus.style.color = "#00ff88";
            lockSubmit(false, "");
            break;
          default:
            elStatus.textContent = payload.status;
            elStatus.style.color = "#ffffff";
        }
      }

      if (payload.status === "waiting" || payload.status === "countdown") {
        if (timerId) clearInterval(timerId);
        setText(elCountdown, "30s left");
        setText(elWaitMsg, "");
      } else if (payload.status === "playing" && payload.deadline) {
        startTimer(payload.deadline);
      }

      if (payload.players) {
        renderPlayers(payload.players);
        const a = payload.players[0]?.name || "Player A";
        const b = payload.players[1]?.name || "Player B";
        playerNames = [a, b];
      }
      if (payload.history) renderHistory(payload.history);

      const tag = payload.tag || "";
      if (["postSubmit", "roundStart", "join", "createAI", "rematchBegin"].includes(tag)) {
        if (payload.status === "playing") lockSubmit(false, "");
      }
      setText(elAuthMsg, "");
    });

    socket.on("game:win", ({ round, word }) => {
      lockSubmit(true, "");
      if (timerId) clearInterval(timerId);
      showResults("Room closed", `You matched on round ${round} with "${word}".`, true);
    });

    socket.on("rematch:status", ({ readyCount, total }) => {
      setText(elRematchMsg, `Rematch ready: ${readyCount}/${total}`);
    });

    socket.on("rematch:begin", () => {
      setText(elRematchMsg, "");
      viewGame();
    });

    socket.on("room:closed", info => {
      lockSubmit(true, info?.text || "Room closed");
      if (timerId) clearInterval(timerId);
      showResults("Room closed", info?.text || "", false);
      setRoomCode(null);
    });

    // Instantly return to lobby if player intentionally left
    socket.on("room:left", () => {
      if (timerId) clearInterval(timerId);
      setRoomCode(null);
      lockSubmit(false, "");
      viewLobby();
    });

    // show duplicate word error and unlock input
    socket.on("game:error", ({ text }) => {
      setText(elWaitMsg, text || "Invalid word");
      lockSubmit(false, elWaitMsg.textContent);
      setTimeout(() => {
        if (elWaitMsg.textContent === text) setText(elWaitMsg, "");
      }, 2000);
    });

    // ---------- lobby actions ----------
    btnCreate.addEventListener("click", () => {
      const name = (inName.value || "").trim();
      resetRoundUI();
      socket.emit("room:create", { name });
    });

    btnCreateAI.addEventListener("click", () => {
      const name = (inName.value || "").trim();
      resetRoundUI();
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
      socket.emit("rematch:leave");
      setRoomCode(null);
      viewLobby();
    });

    btnRematch.addEventListener("click", () => {
      socket.emit("rematch:request");
      setText(elRematchMsg, "Waiting for your teammate…");
    });

    // ---------- word submit ----------
    formWord.addEventListener("submit", e => {
      e.preventDefault();
      if (submitLocked) return;
      const w = (inWord.value || "").trim();
      if (!w) return;
      socket.emit("game:submit", { word: w });
      inWord.value = "";
      lockSubmit(true, "Waiting for teammate…"); // only here we show the text
    });

    // start at lobby
    viewLobby();
  });
})();
