"use strict";

/* Auction 8 P2P UI adapter.
   The room host owns every mutation; guests send commands over WebRTC and this
   adapter renders personalized authoritative snapshots. */
(() => {
  const FILE_SERVER_URL = "http://127.0.0.1:8788";
  const RESUME_PREFIX = "auction8.network.resume.";
  const LAST_ROOM_KEY = "auction8.network.lastRoom";
  const ROOM_LENGTH = 5;
  const MAX_PLAYERS = 8;
  const ERROR_MESSAGES = Object.freeze({
    BAD_REQUEST: "요청 형식이 올바르지 않습니다.",
    ALREADY_IN_ROOM: "이미 다른 방에 들어가 있습니다.",
    ROOM_NOT_FOUND: "방을 찾지 못했습니다. 코드를 다시 확인해 주세요.",
    ROOM_FULL: "이 방은 이미 가득 찼습니다.",
    ROOM_STARTED: "이미 경매가 시작된 방입니다.",
    INVALID_RESUME_TOKEN: "재접속 정보가 만료되었습니다. 새로 참가해 주세요.",
    NOT_IN_ROOM: "현재 방 연결을 확인할 수 없습니다.",
    NOT_HOST: "호스트만 경매를 시작할 수 있습니다.",
    INVALID_PHASE: "지금은 이 동작을 할 수 없습니다.",
    NOT_YOUR_TURN: "아직 내 차례가 아닙니다.",
    INSUFFICIENT_FUNDS: "보유 자금이 부족합니다.",
    INVALID_RAISE: "선택할 수 없는 호가입니다.",
    STALE_REVISION: "최신 경매 상태를 다시 불러왔습니다. 한 번 더 눌러 주세요.",
    MESSAGE_EMPTY: "보낼 메시지를 입력해 주세요.",
    INTERNAL_ERROR: "서버 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요."
  });

  const createButton = document.getElementById("enterLobbyBtn");
  const joinButton = document.getElementById("joinRoomBtn");
  const soloButton = document.getElementById("quickStartBtn");
  const roomInput = document.getElementById("roomCodeInput");
  const startButton = document.getElementById("startGameBtn");
  const backButton = document.getElementById("backStartBtn");
  const againButton = document.getElementById("againBtn");
  const homeButton = document.getElementById("homeBtn");

  const soloHandlers = {
    quick: soloButton?.onclick,
    start: startButton?.onclick,
    back: backButton?.onclick,
    again: againButton?.onclick,
    home: homeButton?.onclick,
    raise: humanRaise,
    allIn: humanAllIn,
    fold: humanFold,
    renderControl
  };

  const network = {
    socket: null,
    session: null,
    presence: null,
    revision: 0,
    deadlineAt: 0,
    clockTimer: null,
    busy: false,
    resuming: false,
    migrating: false,
    lastProfile: null,
    lastPhase: null
  };

  function configuredServerUrl() {
    const value = String(
      window.__AUCTION8_SERVER_URL__ ||
      document.querySelector('meta[name="auction8-server-url"]')?.content ||
      ""
    ).trim();
    if (!value || /%VITE_|\{\{|\$\{/i.test(value)) return "";
    try {
      const parsed = new URL(value, location.href);
      return /^https?:$/.test(parsed.protocol) ? parsed.origin : "";
    } catch (_) {
      return "";
    }
  }

  function isTossRuntime() {
    return /toss/i.test(location.hostname) || /toss/i.test(navigator.userAgent || "") || Boolean(window.ReactNativeWebView);
  }

  function serverUrl() {
    if (window.Auction8P2P) return "p2p-host";
    const configured = configuredServerUrl();
    if (configured) return isTossRuntime() && !configured.startsWith("https://") ? "" : configured;
    const localDevHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
    if (location.protocol === "file:" || (localDevHost && location.port && location.port !== "8788")) return FILE_SERVER_URL;
    if (isTossRuntime()) return "";
    return location.origin;
  }

  function cleanRoomCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-HJ-NP-Z2-9]/g, "")
      .slice(0, ROOM_LENGTH);
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function safeColor(value, fallback = "#60758e") {
    const color = String(value || "");
    return /^(#[0-9a-f]{3,8}|hsl\([\d\s.,%+-]+\)|rgb\([\d\s.,%+-]+\))$/i.test(color) ? color : fallback;
  }

  function storageGet(key) {
    try { return safeStorage.getItem(key); } catch (_) { return null; }
  }

  function storageSet(key, value) {
    try { safeStorage.setItem(key, value); } catch (_) { /* storage is optional */ }
  }

  function resumeTokenFor(roomCode) {
    return storageGet(RESUME_PREFIX + cleanRoomCode(roomCode)) || undefined;
  }

  function avatarSources() {
    return [...document.querySelectorAll("#avatarPicker [data-avatar] img")].map(image => image.src);
  }

  function avatarIndexFromPicker() {
    return safeNumber(document.querySelector("#avatarPicker [data-avatar].selected")?.dataset.avatar, 0);
  }

  function avatarMarkup(raw, label = "") {
    const sources = avatarSources();
    const index = clamp(Math.trunc(safeNumber(raw?.avatarIndex, 0)), 0, Math.max(0, sources.length - 1));
    const source = sources[index];
    if (source) return `<img class="avatar-face" src="${source}" alt="${esc(label)}">`;
    const fallback = typeof raw?.avatar === "string" && raw.avatar.length <= 8 ? raw.avatar : "◇";
    return esc(fallback);
  }

  function profileFromForm() {
    const name = (document.getElementById("nicknameInput")?.value || "수집가").trim().slice(0, 12) || "수집가";
    return {
      name,
      avatarIndex: avatarIndexFromPicker(),
      difficulty: document.getElementById("difficultySelect")?.value || "standard"
    };
  }

  function setBusy(busy) {
    network.busy = busy;
    if (createButton) createButton.disabled = busy;
    if (joinButton) joinButton.disabled = busy;
    if (roomInput) roomInput.disabled = busy;
  }

  function setStatus(message, kind = "idle") {
    const startStatus = document.getElementById("networkStatus");
    if (startStatus) {
      startStatus.className = `network-status ${kind}`;
      const text = startStatus.querySelector("span");
      if (text) text.textContent = message;
    }

    const connected = kind === "online";
    const lobbyStatus = document.getElementById("networkLobbyStatus");
    const gameStatus = document.getElementById("networkGameStatus");
    [lobbyStatus, gameStatus].forEach(element => {
      if (!element) return;
      element.classList.toggle("green", connected);
      element.classList.toggle("red", kind === "error");
      const compactMessage = connected
        ? (element === lobbyStatus ? "연결됨" : `동기화 ${network.revision}`)
        : message;
      element.innerHTML = `<i class="online-dot"></i>${esc(compactMessage)}`;
    });
  }

  function notifyError(title, error) {
    const rawMessage = typeof error === "string" ? error : error?.message || "";
    const message = ERROR_MESSAGES[rawMessage] || rawMessage || "잠시 후 다시 시도해 주세요.";
    setStatus(message, "error");
    toast(title, message, "bad");
    tone("bad");
  }

  function ensureSocket() {
    if (network.socket) return network.socket;
    if (typeof window.io !== "function") throw new Error("온라인 연결 모듈을 찾지 못했습니다. 혼자 연습은 바로 이용할 수 있습니다.");
    const target = serverUrl();
    if (!target) throw new Error("P2P 연결을 시작할 수 없습니다.");

    const socket = window.io(target, {
      autoConnect: false,
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 650,
      reconnectionDelayMax: 4000,
      timeout: 7000
    });

    socket.on("connect", () => {
      setStatus(networkActive ? "방장에게 다시 연결 중" : "P2P 준비됨", networkActive ? "waiting" : "online");
      if (networkActive && network.session && !network.busy && !network.resuming) resumeSession();
    });
    socket.on("disconnect", () => {
      if (networkActive && socket.roomClosed) setStatus("방장이 나가 방이 종료되었습니다", "error");
      else if (networkActive && (socket.migrating || network.migrating)) setStatus("다음 방장에게 경매 넘기는 중", "waiting");
      else if (networkActive) setStatus("연결 복구 중", "waiting");
      else setStatus("P2P 연결 끊김", "error");
    });
    socket.on("connect_error", () => {
      setStatus("P2P 연결 실패 · 네트워크를 확인하세요", "error");
    });
    socket.io.on("reconnect_attempt", () => {
      if (networkActive) setStatus("재연결 중", "waiting");
    });
    socket.on("session", applySession);
    socket.on("presence", applyPresence);
    socket.on("snapshot", applySnapshot);
    socket.on("migration", applyMigration);
    socket.on("command:error", payload => notifyError("요청 실패", payload?.error || payload?.message));
    network.socket = socket;
    return socket;
  }

  function connectSocket(socket) {
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off("connect", onConnect);
        socket.off("connect_error", onError);
        error ? reject(error) : resolve();
      };
      const onConnect = () => finish();
      const onError = () => finish(new Error("P2P 연결을 준비할 수 없습니다."));
      const timer = setTimeout(() => finish(new Error("P2P 연결 준비가 늦습니다.")), 8000);
      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
      socket.connect();
    });
  }

  function emitAck(eventName, payload, timeout = 8000) {
    const socket = network.socket;
    return new Promise((resolve, reject) => {
      if (!socket?.connected) return reject(new Error("P2P 연결이 끊겼습니다."));
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("방장의 응답이 늦습니다. 다시 시도해 주세요."));
      }, timeout);
      socket.emit(eventName, payload, acknowledgement => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(acknowledgement || { ok: false, error: "방장이 요청을 확인하지 못했습니다." });
      });
    });
  }

  function persistSession(session) {
    const roomCode = cleanRoomCode(session?.roomCode);
    if (!roomCode) return;
    storageSet(LAST_ROOM_KEY, roomCode);
    if (session.resumeToken) storageSet(RESUME_PREFIX + roomCode, session.resumeToken);
    if (roomInput) roomInput.value = roomCode;
  }

  function applySession(payload) {
    const session = payload?.session || payload;
    if (!session?.roomCode || !session?.playerId) return;
    network.session = { ...(network.session || {}), ...session, roomCode: cleanRoomCode(session.roomCode) };
    network.migrating = false;
    network.revision = Math.max(network.revision, safeNumber(session.revision, 0));
    localPlayerId = String(session.playerId);
    networkActive = true;
    document.body.classList.add("network-active");
    persistSession(network.session);
    const roomPill = document.getElementById("roomCodePill");
    if (roomPill) roomPill.textContent = `ROOM ${network.session.roomCode}`;
    setStatus(`ROOM ${network.session.roomCode} · 연결됨`, "online");
    updateHostStartPermission();
  }

  function applyMigration(payload = {}) {
    const phase = String(payload.phase || "electing");
    const successorId = String(payload.successorId || "");
    const localSuccessor = Boolean(successorId && successorId === localPlayerId);
    if (phase === "promoted") {
      network.migrating = false;
      if (network.session && payload.hostId) network.session.hostId = String(payload.hostId);
      const localHost = String(payload.hostId || "") === localPlayerId;
      setStatus(localHost ? "내가 새 방장 · 경매 계속" : "새 방장 연결 완료", "online");
      updateHostStartPermission(payload.hostId);
      return;
    }
    network.migrating = true;
    if (phase === "claiming" && localSuccessor) setStatus("내 기기에서 경매 이어받는 중", "waiting");
    else setStatus("다음 방장에게 경매 넘기는 중", "waiting");
    updateHostStartPermission();
  }

  async function enterOnline(mode) {
    if (network.busy) return;
    const profile = profileFromForm();
    const roomCode = cleanRoomCode(roomInput?.value);
    if (mode === "join" && roomCode.length !== ROOM_LENGTH) {
      roomInput?.focus();
      return notifyError("방 코드 확인", "5자리 방 코드를 입력해 주세요.");
    }

    setBusy(true);
    setStatus(mode === "create" ? "새 방 만드는 중" : "방 찾는 중", "waiting");
    ensureBgm();
    try {
      const socket = ensureSocket();
      await connectSocket(socket);
      network.lastProfile = profile;
      const eventName = mode === "create" ? "room:create" : "room:join";
      const payload = mode === "create"
        ? { profile }
        : { roomCode, profile };
      const acknowledgement = await emitAck(eventName, payload);
      if (!acknowledgement?.ok || !acknowledgement.session) {
        throw new Error(acknowledgement?.error || "방에 입장하지 못했습니다.");
      }
      applySession(acknowledgement.session);
      renderNetworkLobby(network.presence?.players || []);
      show("lobbyScreen");
      tone("good");
    } catch (error) {
      if (!network.session) {
        networkActive = false;
        document.body.classList.remove("network-active");
      }
      notifyError(mode === "create" ? "방 만들기 실패" : "참가 실패", error);
    } finally {
      setBusy(false);
    }
  }

  async function resumeSession() {
    const roomCode = cleanRoomCode(network.session?.roomCode);
    const resumeToken = network.session?.resumeToken || resumeTokenFor(roomCode);
    if (!roomCode || !resumeToken || !network.socket?.connected) return;
    network.resuming = true;
    try {
      const acknowledgement = await emitAck("room:join", {
        roomCode,
        profile: network.lastProfile || profileFromForm(),
        resumeToken
      }, 40_000);
      if (!acknowledgement?.ok || !acknowledgement.session) throw new Error(acknowledgement?.error || "재접속에 실패했습니다.");
      applySession(acknowledgement.session);
      setStatus(`ROOM ${roomCode} · 재연결됨`, "online");
    } catch (error) {
      notifyError("재연결 실패", error);
    } finally {
      network.resuming = false;
    }
  }

  function emptyPlayer(raw = {}) {
    const id = String(raw.id || raw.playerId || "");
    const name = String(raw.name || (id === localPlayerId ? network.lastProfile?.name : "수집가") || "수집가").slice(0, 20);
    return {
      id,
      name,
      avatarIndex: safeNumber(raw.avatarIndex, 0),
      avatar: avatarMarkup(raw, name),
      avatarSrc: avatarSources()[clamp(Math.trunc(safeNumber(raw.avatarIndex, 0)), 0, 7)] || "",
      color: safeColor(raw.color, id === localPlayerId ? "#d7a74c" : "#60758e"),
      persona: id === localPlayerId ? "당신" : String(raw.persona || "온라인 수집가").slice(0, 32),
      isHuman: raw.isHuman !== false,
      online: raw.online !== false,
      ready: raw.ready !== false,
      cash: safeNumber(raw.cash, START_CASH),
      collection: [],
      knownPrices: {},
      appraisalTokens: safeNumber(raw.appraisalTokens, 0),
      compareTokens: safeNumber(raw.compareTokens, 0),
      forceTokens: safeNumber(raw.forceTokens, 0),
      protectedItems: Array.isArray(raw.protectedItems) ? [...raw.protectedItems] : [],
      spend: safeNumber(raw.spend, 0),
      wins: safeNumber(raw.wins, 0),
      trades: safeNumber(raw.trades, 0),
      totalValue: Number.isFinite(Number(raw.totalValue)) ? Number(raw.totalValue) : undefined,
      risk: 1,
      skill: 1,
      trade: .5,
      _values: {},
      _maxBids: {}
    };
  }

  function mergeIdentity(playerData, presencePlayer) {
    if (!presencePlayer) return playerData;
    const identity = emptyPlayer({ ...playerData, ...presencePlayer });
    return {
      ...playerData,
      name: identity.name,
      avatarIndex: identity.avatarIndex,
      avatar: identity.avatar,
      avatarSrc: identity.avatarSrc,
      color: identity.color,
      persona: identity.persona,
      isHuman: presencePlayer.isHuman !== false,
      online: presencePlayer.online !== false,
      ready: presencePlayer.ready !== false
    };
  }

  function renderNetworkLobby(playersInput) {
    const root = document.getElementById("seatGrid");
    if (!root) return;
    const presencePlayers = Array.isArray(playersInput) ? playersInput : [];
    const players = presencePlayers.length
      ? presencePlayers.map(raw => emptyPlayer(raw))
      : (network.presence?.players || []).map(raw => emptyPlayer(raw));
    const hostId = String(network.presence?.hostId || network.session?.hostId || state?.hostId || "");
    const connected = players.filter(playerData => playerData.online).length;
    const seats = [...players];
    while (seats.length < MAX_PLAYERS) seats.push(null);
    root.innerHTML = seats.slice(0, MAX_PLAYERS).map((playerData, index) => {
      if (!playerData) {
        return `<article class="seat network-seat-empty"><div class="seat-avatar">${index + 1}</div><div><b>참가 대기</b><small>방 코드를 공유하세요</small></div><div class="seat-right"><span class="pill">비어 있음</span></div></article>`;
      }
      const mine = playerData.id === localPlayerId;
      const isHost = playerData.id === hostId;
      return `<article class="seat ${mine ? "network-seat-mine" : ""}" style="--seat:${playerData.color}"><div class="seat-avatar">${playerData.avatar}</div><div><b>${esc(playerData.name)} ${isHost ? '<span class="pill gold">HOST</span>' : ""} ${mine ? '<span class="pill blue">나</span>' : ""}</b><small>${esc(playerData.persona)}</small></div><div class="seat-right"><span class="pill ${playerData.online ? "green" : "red"}"><i class="online-dot"></i>${playerData.online ? "접속" : "연결 끊김"}</span><small>${playerData.ready ? "준비됨" : "입장 중"}</small></div></article>`;
    }).join("");

    const heading = document.querySelector(".lobby-main > header h3");
    const readyPill = document.querySelector(".lobby-main > header .pill");
    if (heading) heading.textContent = `참가자 ${players.length}명`;
    if (readyPill) readyPill.textContent = `${connected}명 연결`;
    const countdown = document.getElementById("lobbyCountdown");
    if (countdown) countdown.textContent = localPlayerId === hostId ? "시작할 준비가 되면 눌러 주세요" : "호스트가 시작합니다";
    updateHostStartPermission(hostId);
  }

  function updateHostStartPermission(hostIdInput) {
    if (!startButton) return;
    if (!networkActive) {
      startButton.disabled = false;
      startButton.textContent = "경매 시작";
      return;
    }
    const hostId = String(hostIdInput || network.presence?.hostId || network.session?.hostId || state?.hostId || "");
    const isHost = Boolean(hostId && localPlayerId === hostId);
    startButton.disabled = !isHost || !network.socket?.connected;
    startButton.textContent = isHost ? "경매 시작" : "호스트가 시작합니다";
  }

  function applyPresence(payload) {
    const presence = payload?.presence || payload;
    if (!presence || !Array.isArray(presence.players)) return;
    const previousHostId = String(network.presence?.hostId || network.session?.hostId || "");
    network.presence = {
      ...presence,
      roomCode: cleanRoomCode(presence.roomCode || network.session?.roomCode),
      hostId: String(presence.hostId || network.session?.hostId || "")
    };
    network.revision = Math.max(network.revision, safeNumber(presence.revision, 0));
    if (network.session) network.session.hostId = network.presence.hostId;
    if (network.migrating && network.presence.hostId && network.presence.hostId !== previousHostId) {
      network.migrating = false;
    }

    if (state?.players?.length) {
      const presenceById = new Map(presence.players.map(raw => [String(raw.id || raw.playerId), raw]));
      state.players = state.players.map(playerData => mergeIdentity(playerData, presenceById.get(playerData.id)));
      state.hostId = network.presence.hostId || state.hostId;
      if (document.getElementById("gameScreen")?.classList.contains("active")) {
        renderPlayers();
        renderHeader();
      }
    }
    if (document.getElementById("lobbyScreen")?.classList.contains("active")) renderNetworkLobby(presence.players);
    const online = presence.players.filter(playerData => playerData.online !== false).length;
    setStatus(`ROOM ${network.presence.roomCode || network.session?.roomCode} · ${online}명 연결`, "online");
  }

  function publicCatalogLot(id) {
    const source = LOTS.find(item => String(item.id) === String(id));
    if (!source) return null;
    return {
      ...source,
      priceKRW: 0,
      priceLabel: "비공개",
      originalPrice: undefined,
      originalPriceLabel: undefined,
      clues: [],
      learningNote: ""
    };
  }

  function sealedLot(index) {
    return {
      id: null,
      sealed: true,
      order: index,
      name: "비공개",
      image: "",
      category: "비공개",
      maker: "비공개",
      itemYear: "-",
      auctionHouse: "-",
      location: "-",
      saleDate: "-",
      lotNo: "-",
      material: "-",
      condition: "-",
      provenance: "-",
      description: "아직 공개되지 않은 로트입니다.",
      recordLabel: "봉인",
      priceKRW: 0,
      priceLabel: "비공개",
      clues: [],
      revealedClues: 0,
      clueIndex: -1,
      ownerId: null,
      soldBid: null,
      sold: false
    };
  }

  function valueFromCollection(values, id) {
    if (!values) return undefined;
    if (Array.isArray(values)) return values.find(value => String(value?.id || value?.lotId) === String(id));
    return values[id];
  }

  function privateValueFor(snapshot, id) {
    const finalValue = valueFromCollection(snapshot.finalValues, id);
    return finalValue !== undefined ? finalValue : valueFromCollection(snapshot.privateValues, id);
  }

  function normalizePrivateValue(value) {
    if (Number.isFinite(Number(value))) return { priceKRW: Number(value), priceLabel: wonExact(Number(value)) };
    if (!value || typeof value !== "object") return null;
    const amount = safeNumber(value.priceKRW ?? value.value ?? value.amount, NaN);
    if (!Number.isFinite(amount)) return null;
    return { priceKRW: amount, priceLabel: String(value.priceLabel || wonExact(amount)) };
  }

  function publicCurrentLot(snapshot, id) {
    const current = snapshot.currentLot && typeof snapshot.currentLot === "object" ? snapshot.currentLot : {};
    const clone = { ...current };
    delete clone.priceKRW;
    delete clone.priceLabel;
    delete clone.originalPrice;
    delete clone.originalPriceLabel;
    delete clone.privateValue;
    clone.id = id;
    clone.clues = Array.isArray(current.clues) ? current.clues.map(value => String(value).slice(0, 300)) : [];
    return clone;
  }

  function collectionIds(rawPlayer) {
    if (!Array.isArray(rawPlayer?.collection)) return [];
    return rawPlayer.collection.map(item => typeof item === "string" ? item : item?.id || item?.lotId).filter(Boolean).map(String);
  }

  function materializeSnapshot(snapshot) {
    const phase = String(snapshot.phase || "LOBBY").toUpperCase();
    const current = clamp(Math.trunc(safeNumber(snapshot.current, 0)), 0, MAX_PLAYERS - 1);
    const slotInput = Array.isArray(snapshot.lots) ? snapshot.lots.slice(0, MAX_PLAYERS) : [];
    while (slotInput.length < MAX_PLAYERS) slotInput.push(null);

    const presenceById = new Map((network.presence?.players || []).map(raw => [String(raw.id || raw.playerId), raw]));
    const rawPlayers = Array.isArray(snapshot.players) ? snapshot.players : [];
    const players = rawPlayers.map(raw => mergeIdentity(emptyPlayer(raw), presenceById.get(String(raw.id || raw.playerId))));
    if (!players.some(playerData => playerData.id === localPlayerId)) {
      const localPresence = presenceById.get(localPlayerId) || { id: localPlayerId, ...network.lastProfile };
      players.push(emptyPlayer(localPresence));
    }

    const ownerByLot = new Map();
    rawPlayers.forEach(raw => collectionIds(raw).forEach(id => ownerByLot.set(id, String(raw.id || raw.playerId))));
    const lotStateById = new Map((Array.isArray(snapshot.lotStates) ? snapshot.lotStates : []).map(lotState => [String(lotState?.id || lotState?.lotId || ""), lotState]));
    const currentLotId = String(snapshot.currentLot?.id || snapshot.currentLot?.lotId || (typeof slotInput[current] === "string" ? slotInput[current] : slotInput[current]?.id || ""));

    const lots = slotInput.map((slot, index) => {
      const slotId = typeof slot === "string" ? slot : slot?.id || slot?.lotId;
      const id = String(index === current && currentLotId ? currentLotId : slotId || "");
      if (!id) return sealedLot(index);
      const catalog = publicCatalogLot(id) || sealedLot(index);
      const publicData = index === current ? publicCurrentLot(snapshot, id) : {};
      const privateValue = normalizePrivateValue(privateValueFor(snapshot, id));
      const result = lotStateById.get(id) || snapshot.results?.[id] || {};
      const ownerId = String(slot?.ownerId || publicData.ownerId || result.ownerId || ownerByLot.get(id) || "") || null;
      const soldBid = safeNumber(slot?.soldBid ?? publicData.soldBid ?? result.soldBid, 0);
      const publiclyRevealedClues = Array.isArray(publicData.clues) ? publicData.clues : [];
      const soldState = slot?.sold ?? publicData.sold ?? result.sold ?? Boolean(ownerId);
      return {
        ...catalog,
        ...publicData,
        id,
        order: index,
        ownerId,
        soldBid,
        sold: Boolean(soldState || index < current || (index === current && phase === "SOLD")),
        priceKRW: privateValue?.priceKRW || 0,
        priceLabel: privateValue?.priceLabel || "비공개",
        clues: publiclyRevealedClues,
        revealedClues: publiclyRevealedClues.length,
        clueIndex: publiclyRevealedClues.length ? publiclyRevealedClues.length - 1 : -1,
        sealed: false
      };
    });

    const lotsById = new Map(lots.filter(item => item.id).map(item => [String(item.id), item]));
    rawPlayers.forEach(raw => {
      const id = String(raw.id || raw.playerId);
      const playerData = players.find(item => item.id === id);
      if (!playerData) return;
      playerData.collection = collectionIds(raw).map(lotId => lotsById.get(lotId)).filter(Boolean);
      playerData.knownPrices = Object.fromEntries(playerData.collection.filter(item => item.priceKRW > 0).map(item => [item.id, item.priceKRW]));
    });

    const seconds = secondsUntil(snapshot.deadlineAt);
    const auctionRaw = snapshot.auction && typeof snapshot.auction === "object" ? snapshot.auction : null;
    const auction = auctionRaw ? {
      ...auctionRaw,
      token: safeNumber(auctionRaw.token, safeNumber(snapshot.revision, 0)),
      order: Array.isArray(auctionRaw.order) ? [...auctionRaw.order] : players.map(playerData => playerData.id),
      activeIds: Array.isArray(auctionRaw.activeIds) ? [...auctionRaw.activeIds].map(String) : [],
      foldedIds: Array.isArray(auctionRaw.foldedIds) ? [...auctionRaw.foldedIds].map(String) : [],
      currentBid: safeNumber(auctionRaw.currentBid, 0),
      highBidderId: auctionRaw.highBidderId ? String(auctionRaw.highBidderId) : null,
      turnPlayerId: auctionRaw.turnPlayerId ? String(auctionRaw.turnPlayerId) : null,
      awaitingHuman: String(auctionRaw.turnPlayerId || "") === localPlayerId,
      seconds,
      history: Array.isArray(auctionRaw.history) ? auctionRaw.history.map(entry => ({ ...entry, id: String(entry.id || entry.playerId || "") })) : [],
      finished: Boolean(auctionRaw.finished)
    } : null;

    const playersById = new Map(players.map(playerData => [playerData.id, playerData]));
    const chatMessages = (Array.isArray(snapshot.chatMessages) ? snapshot.chatMessages : []).map(message => {
      const senderId = String(message.senderId || message.playerId || message.id || "system");
      const sender = playersById.get(senderId);
      return {
        id: senderId,
        name: String(message.name || sender?.name || "경매 진행").slice(0, 30),
        avatar: sender?.avatar || (senderId === "system" ? "◆" : avatarMarkup(message, message.name)),
        text: String(message.text || message.message || "").slice(0, 100),
        time: formatMessageTime(message.sentAt || message.time || message.createdAt || message.at),
        kind: message.kind || (senderId === "system" ? "system" : "player")
      };
    });

    const revision = safeNumber(snapshot.revision, network.revision);
    const hostId = String(snapshot.hostId || network.presence?.hostId || network.session?.hostId || "");
    return {
      room: cleanRoomCode(snapshot.room || snapshot.roomCode || network.session?.roomCode),
      revision,
      difficulty: String(snapshot.difficulty || "standard"),
      players,
      lots,
      phase,
      current,
      auction,
      deadlineAt: normalizeDeadline(snapshot.deadlineAt),
      previewSeconds: phase === "PREVIEW" ? seconds : 0,
      liveSeconds: phase === "LIVE" ? seconds : 0,
      soldSeconds: phase === "SOLD" ? seconds : 0,
      marketSeconds: phase === "MARKET" ? seconds : 0,
      trade: { myItemId: null, targetItemId: null, extra: 0 },
      hostId,
      leaderId: hostId,
      successors: players.filter(playerData => playerData.id !== hostId).map(playerData => playerData.id),
      term: safeNumber(snapshot.term, 1),
      eventSeq: revision,
      stateHash: `NET${Math.trunc(revision).toString(16).toUpperCase().padStart(3, "0").slice(-3)}`,
      events: [],
      chatMessages,
      migrating: false
    };
  }

  function normalizeDeadline(value) {
    if (value == null || value === "") return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function secondsUntil(value) {
    const deadline = normalizeDeadline(value);
    return deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : 0;
  }

  function formatMessageTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return String(value || "").slice(0, 8);
    return date.toLocaleTimeString("ko-KR", { hour12: false, hour: "2-digit", minute: "2-digit" });
  }

  function updateDeadlineClock() {
    if (!networkActive || !state || !network.deadlineAt) return;
    const seconds = secondsUntil(network.deadlineAt);
    let changed = false;
    if (state.phase === "PREVIEW" && state.previewSeconds !== seconds) { state.previewSeconds = seconds; changed = true; }
    if (state.phase === "LIVE") {
      if (state.liveSeconds !== seconds) { state.liveSeconds = seconds; changed = true; }
      if (state.auction && state.auction.seconds !== seconds) { state.auction.seconds = seconds; changed = true; }
    }
    if (state.phase === "SOLD" && state.soldSeconds !== seconds) { state.soldSeconds = seconds; changed = true; }
    if (state.phase === "MARKET" && state.marketSeconds !== seconds) { state.marketSeconds = seconds; changed = true; }
    if (changed && document.getElementById("gameScreen")?.classList.contains("active")) renderHeader();
  }

  function restartDeadlineClock(deadlineAt) {
    network.deadlineAt = normalizeDeadline(deadlineAt);
    clearInterval(network.clockTimer);
    network.clockTimer = null;
    if (!network.deadlineAt) return;
    updateDeadlineClock();
    network.clockTimer = setInterval(updateDeadlineClock, 250);
  }

  function applySnapshot(payload) {
    const snapshot = payload?.snapshot || payload;
    if (!snapshot || typeof snapshot !== "object") return;
    const incomingRevision = safeNumber(snapshot.revision, 0);
    if (incomingRevision && incomingRevision < network.revision) return;
    if (snapshot.room || snapshot.roomCode) {
      const roomCode = cleanRoomCode(snapshot.room || snapshot.roomCode);
      if (network.session && roomCode && roomCode !== network.session.roomCode) return;
    }
    network.revision = Math.max(network.revision, incomingRevision);
    const previousPhase = state?.phase || network.lastPhase;
    state = materializeSnapshot(snapshot);
    network.lastPhase = state.phase;
    network.deadlineAt = state.deadlineAt;

    if (state.phase === "LOBBY" || state.phase === "WAITING") {
      show("lobbyScreen");
      renderNetworkLobby(network.presence?.players || snapshot.players || []);
    } else if (state.phase === "FINAL") {
      renderNetworkFinal(previousPhase);
    } else {
      const soldModal = document.querySelector("#modal #soldNext");
      if (soldModal && previousPhase !== state.phase) document.getElementById("modalOverlay")?.classList.remove("show");
      document.getElementById("curatorCinematic")?.classList.remove("show");
      show("gameScreen");
      try { render(); } catch (error) {
        console.error("Auction 8 snapshot render failed", error);
        notifyError("화면 동기화 오류", "최신 상태를 다시 기다리고 있습니다.");
      }
    }
    restartDeadlineClock(snapshot.deadlineAt);
    updateHostStartPermission(state.hostId);
    setStatus(`ROOM ${state.room || network.session?.roomCode} · 동기화 ${network.revision}`, "online");
    if (previousPhase !== state.phase && state.phase === "LIVE") tone("round");
  }

  function playerScore(playerData) {
    return Number.isFinite(playerData.totalValue) ? playerData.totalValue : collectionValue(playerData);
  }

  function renderNetworkFinal(previousPhase) {
    const ranked = [...state.players].sort((a, b) => playerScore(b) - playerScore(a) || b.cash - a.cash);
    const winner = ranked[0];
    if (!winner) return;
    document.getElementById("winnerTitle").textContent = winner.name;
    document.getElementById("winnerDesc").textContent = `${wonExact(playerScore(winner))} · ${winner.collection.length}점`;
    const top = ranked.slice(0, 3);
    const display = [top[1], top[0], top[2]].filter(Boolean);
    document.getElementById("podium").innerHTML = display.map(playerData => {
      const place = ranked.indexOf(playerData) + 1;
      const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : "🥉";
      const best = [...playerData.collection].sort((a, b) => b.priceKRW - a.priceKRW)[0];
      return `<article class="podium-card ${place === 1 ? "first" : ""}" style="--seat:${playerData.color}"><div class="podium-avatar">${playerData.avatar}</div><b>${medal} ${esc(playerData.name)}</b><span>${best ? esc(best.name) : "없음"} · ${playerData.collection.length}점</span><div class="podium-score">${wonExact(playerScore(playerData))}</div></article>`;
    }).join("");
    document.getElementById("awardGrid").innerHTML = "";
    document.getElementById("finalLots").innerHTML = state.lots.filter(item => item.id).map((item, index) => {
      const owner = item.ownerId ? player(item.ownerId) : null;
      return `<article class="final-lot"><img src="${item.image}" alt=""><div><b>${index + 1} · ${esc(item.name)}</b><strong>${item.priceKRW ? esc(item.priceLabel) : "공개 대기"}</strong><span>${owner ? `${owner.avatar} ${esc(owner.name)} · ${wonShort(item.soldBid)}` : "유찰"}</span></div></article>`;
    }).join("");
    if (againButton) againButton.textContent = "새 방 만들기";
    if (homeButton) homeButton.textContent = "처음으로";
    show("finalScreen");
    if (previousPhase !== "FINAL") tone("victory");
  }

  function commandId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `${localPlayerId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function sendCommand(type, payload = {}) {
    if (!networkActive) return false;
    if (!network.socket?.connected) {
      notifyError("연결 확인", "방장과 다시 연결하는 중입니다.");
      return false;
    }
    const envelope = {
      commandId: commandId(),
      type,
      payload,
      expectedRevision: safeNumber(network.revision, 0)
    };
    network.socket.emit("command", envelope, acknowledgement => {
      if (!acknowledgement) return;
      if (!acknowledgement.ok) return notifyError("요청 거절", acknowledgement.error || "현재 상태에서는 실행할 수 없습니다.");
      network.revision = Math.max(network.revision, safeNumber(acknowledgement.revision, network.revision));
    });
    return true;
  }

  function deactivateNetwork(disconnect = true) {
    networkActive = false;
    localPlayerId = "p0";
    document.body.classList.remove("network-active");
    clearInterval(network.clockTimer);
    network.clockTimer = null;
    network.deadlineAt = 0;
    network.presence = null;
    network.session = null;
    network.revision = 0;
    network.migrating = false;
    network.lastPhase = null;
    if (disconnect && network.socket) network.socket.disconnect();
    if (againButton) againButton.textContent = "다시 하기";
    if (homeButton) homeButton.textContent = "처음으로";
    setStatus("P2P 방을 만들거나 참가하세요", "idle");
    updateHostStartPermission();
  }

  humanRaise = function(increment) {
    if (!networkActive) return soloHandlers.raise(increment);
    if (state?.phase !== "LIVE" || state.auction?.turnPlayerId !== localPlayerId) return false;
    return sendCommand("BID_RAISE", { increment: safeNumber(increment, RAISE_SMALL) });
  };

  humanAllIn = function() {
    if (!networkActive) return soloHandlers.allIn();
    if (state?.phase !== "LIVE" || state.auction?.turnPlayerId !== localPlayerId) return false;
    return sendCommand("BID_ALL_IN", {});
  };

  humanFold = function() {
    if (!networkActive) return soloHandlers.fold();
    if (state?.phase !== "LIVE" || state.auction?.turnPlayerId !== localPlayerId) return false;
    return sendCommand("BID_FOLD", {});
  };

  renderControl = function() {
    if (!networkActive || state?.phase !== "PREVIEW") return soloHandlers.renderControl();
    const body = document.getElementById("controlBody");
    const phasePill = document.getElementById("phasePill");
    const title = document.getElementById("controlTitle");
    const currentLot = lot();
    const clues = Array.isArray(currentLot?.clues) ? currentLot.clues : [];
    const latestClue = clues[clues.length - 1];
    if (title) title.textContent = `나의 패널 · ${human()?.name || "수집가"}`;
    if (phasePill) phasePill.textContent = "ONLINE";
    if (!body) return;
    body.innerHTML = `${resourcesHTML()}<div class="auto-flow-card network-preview-card"><div class="auto-flow-head"><span>HOST P2P SYNC</span><b>${formatClock(state.previewSeconds)}</b></div><h4>곧 경매가 시작됩니다</h4><p>방장 기기가 시간·입찰·낙찰을 맞춰 모두에게 같은 상태를 보냅니다.</p>${latestClue ? `<div class="auto-clues"><div class="auto-clue"><b>최신 단서</b><br>${esc(latestClue)}</div></div>` : '<div class="auto-clue locked">🔒 공개 단서를 기다리는 중</div>'}</div>${collectionMiniHTML()}`;
  };

  document.addEventListener("submit", event => {
    if (!networkActive || event.target?.id !== "chatForm") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const input = document.getElementById("chatInput");
    const text = String(input?.value || "").trim().slice(0, 80);
    if (!text) return;
    if (sendCommand("CHAT_SEND", { text })) {
      input.value = "";
      tone("info");
    }
  }, true);

  document.addEventListener("click", event => {
    if (!networkActive) return;
    const emoteButton = event.target.closest(".chat-compose [data-emote]");
    if (!emoteButton) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    sendCommand("CHAT_SEND", { text: String(emoteButton.dataset.emote || "").slice(0, 16) });
    tone("info");
  }, true);

  if (createButton) createButton.onclick = () => enterOnline("create");
  if (joinButton) joinButton.onclick = () => enterOnline("join");
  if (roomInput) {
    roomInput.value = cleanRoomCode(storageGet(LAST_ROOM_KEY));
    roomInput.addEventListener("input", () => { roomInput.value = cleanRoomCode(roomInput.value); });
    roomInput.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();
        enterOnline("join");
      }
    });
  }
  if (soloButton) soloButton.onclick = function(event) {
    deactivateNetwork(true);
    return soloHandlers.quick?.call(this, event);
  };
  if (startButton) startButton.onclick = function(event) {
    if (networkActive) return sendCommand("GAME_START", {});
    return soloHandlers.start?.call(this, event);
  };
  if (backButton) backButton.onclick = function(event) {
    if (networkActive) {
      deactivateNetwork(true);
      show("startScreen");
      return;
    }
    return soloHandlers.back?.call(this, event);
  };
  if (againButton) againButton.onclick = function(event) {
    if (networkActive && state?.phase === "FINAL") {
      deactivateNetwork(true);
      return enterOnline("create");
    }
    if (networkActive) return sendCommand("GAME_START", {});
    return soloHandlers.again?.call(this, event);
  };
  if (homeButton) homeButton.onclick = function(event) {
    if (networkActive) {
      deactivateNetwork(true);
      show("startScreen");
      return;
    }
    return soloHandlers.home?.call(this, event);
  };

  document.getElementById("roomCodePill")?.addEventListener("click", async () => {
    if (!networkActive || !network.session?.roomCode) return;
    try {
      await navigator.clipboard.writeText(network.session.roomCode);
      toast("방 코드 복사", network.session.roomCode, "good");
      tone("info");
    } catch (_) {
      toast("방 코드", network.session.roomCode, "good");
    }
  });

  window.Auction8Network = Object.freeze({
    get active() { return networkActive; },
    get session() { return network.session ? { ...network.session } : null; },
    get revision() { return network.revision; },
    sendCommand,
    createRoom: () => enterOnline("create"),
    joinRoom: roomCode => {
      if (roomInput && roomCode) roomInput.value = cleanRoomCode(roomCode);
      return enterOnline("join");
    },
    disconnect: () => deactivateNetwork(true)
  });

  if (typeof window.io !== "function") {
    setStatus("P2P 모듈 준비 중 · 혼자 연습 가능", "waiting");
  } else if (roomInput?.value) {
    setStatus(`최근 방 ${roomInput.value} · 참가로 재연결`, "idle");
  } else {
    setStatus("P2P 방을 만들거나 참가하세요", "idle");
  }
})();
