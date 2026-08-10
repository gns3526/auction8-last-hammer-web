(() => {
  // server/protocol.mjs
  var COMMAND_TYPES = Object.freeze({
    GAME_START: "GAME_START",
    BID_RAISE: "BID_RAISE",
    BID_ALL_IN: "BID_ALL_IN",
    BID_FOLD: "BID_FOLD",
    CHAT_SEND: "CHAT_SEND"
  });
  var COMMAND_TYPE_SET = new Set(Object.values(COMMAND_TYPES));
  var ERROR_CODES = Object.freeze({
    BAD_REQUEST: "BAD_REQUEST",
    ALREADY_IN_ROOM: "ALREADY_IN_ROOM",
    ROOM_NOT_FOUND: "ROOM_NOT_FOUND",
    ROOM_FULL: "ROOM_FULL",
    ROOM_STARTED: "ROOM_STARTED",
    INVALID_RESUME_TOKEN: "INVALID_RESUME_TOKEN",
    NOT_IN_ROOM: "NOT_IN_ROOM",
    NOT_HOST: "NOT_HOST",
    INVALID_PHASE: "INVALID_PHASE",
    NOT_YOUR_TURN: "NOT_YOUR_TURN",
    INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
    INVALID_RAISE: "INVALID_RAISE",
    STALE_REVISION: "STALE_REVISION",
    MESSAGE_EMPTY: "MESSAGE_EMPTY",
    INTERNAL_ERROR: "INTERNAL_ERROR"
  });
  var AVATARS = ["\u{1F464}", "\u{1F98A}", "\u{1F42F}", "\u{1F98B}", "\u{1F981}", "\u{1F408}", "\u{1F43A}", "\u{1F9A2}"];
  var COLORS = ["#d7a74c", "#5478ad", "#b15c3d", "#7d5ab3", "#a88738", "#bb637c", "#5e6b81", "#4d8c7a"];
  var QUICK_REACTIONS = /* @__PURE__ */ new Set(["\u{1F44D}", "\u{1F44F}", "\u{1F62E}", "\u{1F914}", "\u{1F525}", "\u{1F60E}", "\u{1F4B0}", "\u{1F440}"]);
  function cleanText(value, maxLength) {
    return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }
  function normalizeProfile(profile = {}, seatIndex = 0) {
    const avatarIndex = Number.isInteger(profile.avatarIndex) ? Math.max(0, Math.min(AVATARS.length - 1, profile.avatarIndex)) : seatIndex % AVATARS.length;
    const requestedColor = cleanText(profile.color, 16);
    const requestedName = cleanText(profile.name, 16);
    return {
      name: /^입찰자 [0-9]{4}$/.test(requestedName) ? requestedName : `\uC785\uCC30\uC790 ${String(seatIndex + 1).padStart(4, "0")}`,
      avatarIndex,
      avatar: cleanText(profile.avatar, 8) || AVATARS[avatarIndex],
      color: /^#[0-9a-f]{6}$/i.test(requestedColor) ? requestedColor : COLORS[avatarIndex],
      persona: "\uC2E4\uC2DC\uAC04 \uC218\uC9D1\uAC00"
    };
  }
  function normalizeChatMessage(value) {
    const reaction = cleanText(value, 8);
    return QUICK_REACTIONS.has(reaction) ? reaction : "";
  }
  function validateCommand(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, error: ERROR_CODES.BAD_REQUEST };
    }
    const commandId = cleanText(raw.commandId, 96);
    if (!/^[A-Za-z0-9:_-]{1,96}$/.test(commandId)) {
      return { ok: false, error: ERROR_CODES.BAD_REQUEST };
    }
    if (!COMMAND_TYPE_SET.has(raw.type)) {
      return { ok: false, error: ERROR_CODES.BAD_REQUEST };
    }
    if (!Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) {
      return { ok: false, error: ERROR_CODES.BAD_REQUEST };
    }
    const payload = raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload) ? raw.payload : {};
    return {
      ok: true,
      command: { commandId, type: raw.type, expectedRevision: raw.expectedRevision, payload }
    };
  }
  function ackError(error, revision = 0, details) {
    return { ok: false, error, revision, ...details ? { details } : {} };
  }
  function ackOk(commandId, revision) {
    return { ok: true, commandId, revision };
  }

  // server/game-engine.mjs
  function portableRandomInt(maxExclusive) {
    const max = Math.floor(Number(maxExclusive));
    if (!Number.isSafeInteger(max) || max <= 0) throw new RangeError("maxExclusive must be positive");
    const cryptoObject = globalThis.crypto;
    if (cryptoObject?.getRandomValues) {
      const limit = Math.floor(4294967296 / max) * max;
      const buffer = new Uint32Array(1);
      do
        cryptoObject.getRandomValues(buffer);
      while (buffer[0] >= limit);
      return buffer[0] % max;
    }
    return Math.floor(Math.random() * max);
  }
  var BID_UNIT = 1e8;
  var START_CASH = 100 * BID_UNIT;
  var MIN_RAISE = 5 * BID_UNIT;
  var ALLOWED_RAISES = new Set([5, 10, 20].map((units) => units * BID_UNIT));
  var MATCH_LOT_COUNT = 8;
  var MAX_PLAYERS = 8;
  var BOT_PROFILES = [
    ["\uC18C\uD53C\uC544", "\u{1F9A2}", "#5478ad", "\uB0C9\uC815\uD55C \uAC10\uC815\uC0AC", 0.9],
    ["\uB9C8\uB974\uCF54", "\u{1F98A}", "#b15c3d", "\uACF5\uACA9\uC801\uC778 \uC218\uC9D1\uAC00", 1.22],
    ["\uB3C4\uC724", "\u{1F42F}", "#bd8a32", "\uD55C \uBC29 \uC2B9\uBD80\uC0AC", 1.3],
    ["\uC5D8\uB9AC\uC790", "\u{1F98B}", "#7d5ab3", "\uAD50\uD658 \uC804\uBB38 \uD611\uC0C1\uAC00", 1.03],
    ["\uC544\uC11C", "\u{1F981}", "#a88738", "\uBE0C\uB79C\uB4DC \uBCF4\uC218\uD30C", 0.86],
    ["\uBBF8\uB098", "\u{1F408}", "#bb637c", "\uBC18\uC804 \uAD00\uCC30\uC790", 1.04],
    ["\uB8E8\uCE74", "\u{1F43A}", "#5e6b81", "\uD6C4\uBC18 \uACBD\uB9E4 \uC804\uBB38\uAC00", 1.14]
  ];
  function createHumanPlayer(id, profile, joinedAt) {
    return {
      id,
      ...profile,
      isHuman: true,
      isBot: false,
      online: true,
      ready: true,
      joinedAt,
      cash: START_CASH,
      collection: [],
      knownPrices: {},
      spend: 0,
      wins: 0
    };
  }
  function fillBots(players) {
    const result = [...players];
    let botIndex = 0;
    while (result.length < MAX_PLAYERS) {
      const [name, avatar, color, persona, risk] = BOT_PROFILES[botIndex % BOT_PROFILES.length];
      result.push({
        id: `bot-${botIndex + 1}`,
        name,
        avatar,
        avatarIndex: (botIndex + 1) % 8,
        color,
        persona,
        risk,
        isHuman: false,
        isBot: true,
        online: true,
        ready: true,
        joinedAt: Number.MAX_SAFE_INTEGER - BOT_PROFILES.length + botIndex,
        cash: START_CASH,
        collection: [],
        knownPrices: {},
        spend: 0,
        wins: 0
      });
      botIndex += 1;
    }
    return result;
  }
  function shuffle(values, pickInt = portableRandomInt) {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swapIndex = pickInt(index + 1);
      [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
    }
    return result;
  }
  function selectMatchLots(catalog, pickInt = portableRandomInt) {
    const bands = [
      catalog.filter((lot) => lot.priceKRW < 5e8),
      catalog.filter((lot) => lot.priceKRW >= 5e8 && lot.priceKRW < 2e9),
      catalog.filter((lot) => lot.priceKRW >= 2e9 && lot.priceKRW < 8e9),
      catalog.filter((lot) => lot.priceKRW >= 8e9 && lot.priceKRW < 2e10),
      catalog.filter((lot) => lot.priceKRW >= 2e10)
    ];
    const quotas = [1, 2, 2, 2, 1];
    const picked = [];
    const pickedIds = /* @__PURE__ */ new Set();
    bands.forEach((band, bandIndex) => {
      for (const lot of shuffle(band, pickInt)) {
        if (pickedIds.has(lot.id)) continue;
        picked.push(lot);
        pickedIds.add(lot.id);
        if (picked.filter((item) => band.includes(item)).length >= quotas[bandIndex]) break;
      }
    });
    for (const lot of shuffle(catalog, pickInt)) {
      if (picked.length >= MATCH_LOT_COUNT) break;
      if (pickedIds.has(lot.id)) continue;
      picked.push(lot);
      pickedIds.add(lot.id);
    }
    if (picked.length !== MATCH_LOT_COUNT) throw new Error("Could not select eight unique lots");
    return shuffle(picked, pickInt).slice(0, MATCH_LOT_COUNT);
  }
  function createLobbyState(roomCode, hostPlayer, now) {
    return {
      room: roomCode,
      difficulty: "standard",
      revision: 0,
      term: 1,
      phase: "LOBBY",
      current: -1,
      hostId: hostPlayer.id,
      players: [hostPlayer],
      selectedLotIds: [],
      lotResults: {},
      revealedClueCount: 0,
      auction: null,
      deadlineAt: null,
      chatMessages: [],
      createdAt: now,
      finishedAt: null
    };
  }
  function publicLot(lot, revealedClueCount = 0) {
    return {
      id: lot.id,
      clues: lot.clues.slice(0, Math.max(0, revealedClueCount))
    };
  }
  function privateLotValue(lot) {
    return {
      id: lot.id,
      priceKRW: lot.priceKRW,
      priceLabel: lot.priceLabel ?? `\u20A9${lot.priceKRW.toLocaleString("ko-KR")}`,
      originalCurrency: lot.originalCurrency ?? null,
      originalPrice: lot.originalPrice ?? null,
      originalPriceLabel: lot.originalPriceLabel ?? null,
      learningNote: lot.learningNote ?? null,
      source: lot.source ?? null,
      sourceLabel: lot.sourceLabel ?? lot.auctionHouse ?? null,
      clues: [...lot.clues]
    };
  }
  function applyHumanAuctionCommand(state, player, command) {
    const auction = state.auction;
    if (state.phase !== "LIVE" || !auction) return { ok: false, error: ERROR_CODES.INVALID_PHASE };
    if (auction.turnPlayerId !== player.id || !auction.activeIds.includes(player.id)) {
      return { ok: false, error: ERROR_CODES.NOT_YOUR_TURN };
    }
    if (command.type === COMMAND_TYPES.BID_FOLD) {
      auction.activeIds = auction.activeIds.filter((id) => id !== player.id);
      if (!auction.foldedIds.includes(player.id)) auction.foldedIds.push(player.id);
      auction.history.unshift({ id: player.id, type: "fold", reason: "player" });
      auction.turnPlayerId = null;
      return { ok: true, action: "fold" };
    }
    let target;
    if (command.type === COMMAND_TYPES.BID_ALL_IN) {
      target = player.cash;
    } else if (command.type === COMMAND_TYPES.BID_RAISE) {
      const increment = Number(command.payload.increment);
      if (!ALLOWED_RAISES.has(increment)) return { ok: false, error: ERROR_CODES.INVALID_RAISE };
      target = auction.currentBid + increment;
    } else {
      return { ok: false, error: ERROR_CODES.BAD_REQUEST };
    }
    if (target > player.cash) return { ok: false, error: ERROR_CODES.INSUFFICIENT_FUNDS };
    if (target < auction.currentBid + MIN_RAISE) return { ok: false, error: ERROR_CODES.INVALID_RAISE };
    const oldBid = auction.currentBid;
    auction.currentBid = target;
    auction.highBidderId = player.id;
    auction.turnPlayerId = null;
    auction.history.unshift({
      id: player.id,
      type: "raise",
      amount: target,
      increment: target - oldBid
    });
    return { ok: true, action: "raise" };
  }
  function chooseBotAction(state, player, lot, random = Math.random) {
    const auction = state.auction;
    const next = auction.currentBid + MIN_RAISE;
    if (next > player.cash) return { type: "fold" };
    const valueFactor = 0.42 + random() * 0.42;
    const risk = Number(player.risk) || 1;
    const maxBid = Math.min(player.cash, Math.max(MIN_RAISE, Math.floor(lot.priceKRW * valueFactor * risk / MIN_RAISE) * MIN_RAISE));
    if (next > maxBid && random() > 0.08) return { type: "fold" };
    const increments = [...ALLOWED_RAISES].filter((increment2) => auction.currentBid + increment2 <= player.cash && auction.currentBid + increment2 <= Math.max(next, maxBid));
    const increment = increments.length ? increments[Math.floor(random() * increments.length)] : MIN_RAISE;
    return { type: "raise", increment };
  }

  // server/room.mjs
  var DEFAULT_DURATIONS = Object.freeze({
    previewMs: 14e3,
    humanTurnMs: 12e3,
    botThinkMs: 650,
    soldMs: 4e3,
    reconnectGraceMs: 25e3
  });
  var AUTHORITY_CHECKPOINT_VERSION = 2;
  var RESUME_TOKEN_MAX_LENGTH = 256;
  var SESSION_VERIFIER_PATTERN = /^[0-9a-f]{64}$/;
  var SESSION_VERIFIER_DOMAIN = "auction8:resume-token:v1\0";
  function cloneCheckpointValue(value) {
    if (typeof structuredClone === "function") return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }
  function playerProfile(player) {
    return {
      name: player.name,
      avatar: player.avatar,
      avatarIndex: player.avatarIndex,
      color: player.color,
      persona: player.persona
    };
  }
  function assertCheckpoint(condition, message) {
    if (!condition) throw new Error(`Invalid authority checkpoint: ${message}`);
  }
  async function createSessionVerifier(roomCode, resumeToken) {
    if (typeof resumeToken !== "string" || !resumeToken || resumeToken.length > RESUME_TOKEN_MAX_LENGTH) return "";
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error("SHA-256 session verification is unavailable");
    const material = new TextEncoder().encode(`${SESSION_VERIFIER_DOMAIN}${roomCode}\0${resumeToken}`);
    const digest = new Uint8Array(await subtle.digest("SHA-256", material));
    return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function createResumeToken() {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }
  function createPlayerId() {
    const uuid = globalThis.crypto.randomUUID?.() || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    return `p-${uuid.replaceAll("-", "").slice(0, 16)}`;
  }
  var AuctionRoom = class _AuctionRoom {
    constructor({ code, catalog, hostId, hostProfile, now = Date.now, durations = {}, onChange }) {
      this.code = code;
      this.catalog = catalog;
      this.catalogById = new Map(catalog.map((lot) => [lot.id, lot]));
      this.now = now;
      this.durations = { ...DEFAULT_DURATIONS, ...durations };
      this.onChange = typeof onChange === "function" ? onChange : () => {
      };
      this.sessions = /* @__PURE__ */ new Map();
      this.socketIdByPlayer = /* @__PURE__ */ new Map();
      this.processedCommands = /* @__PURE__ */ new Map();
      this.phaseTimers = /* @__PURE__ */ new Set();
      this.disconnectTimers = /* @__PURE__ */ new Map();
      this.timerGeneration = 0;
      const host = createHumanPlayer(hostId, hostProfile, this.now());
      this.state = createLobbyState(code, host, this.now());
    }
    /**
     * Rebuild an authoritative room on the elected successor. Active matches only
     * carry the eight sealed match lots; lobby recovery uses the successor's local
     * full catalog instead of sending all 500 lots over the data channel.
     */
    static restore({ checkpoint, newHostId, fallbackCatalog = [], now = Date.now, durations = {}, onChange }) {
      assertCheckpoint(checkpoint && typeof checkpoint === "object", "payload is missing");
      assertCheckpoint(checkpoint.version === AUTHORITY_CHECKPOINT_VERSION, "unsupported version");
      assertCheckpoint(typeof checkpoint.roomCode === "string" && checkpoint.roomCode.length > 0, "room code is missing");
      assertCheckpoint(checkpoint.state && typeof checkpoint.state === "object", "state is missing");
      const state = cloneCheckpointValue(checkpoint.state);
      assertCheckpoint(state.room === checkpoint.roomCode, "room code does not match state");
      assertCheckpoint(Array.isArray(state.players), "players are missing");
      assertCheckpoint(Array.isArray(state.selectedLotIds), "selected lots are missing");
      const electedHost = state.players.find((player) => player.id === newHostId);
      assertCheckpoint(electedHost?.isHuman, "new host is not a human room member");
      const selectedIds = [...new Set(state.selectedLotIds)];
      assertCheckpoint(selectedIds.length === state.selectedLotIds.length, "selected lot ids are duplicated");
      if (state.phase === "LOBBY") {
        assertCheckpoint(selectedIds.length === 0, "lobby unexpectedly contains selected lots");
      } else {
        assertCheckpoint(selectedIds.length === MATCH_LOT_COUNT, "active match does not contain eight selected lots");
      }
      let catalog;
      if (selectedIds.length > 0) {
        const checkpointCatalog = Array.isArray(checkpoint.catalog) ? checkpoint.catalog : [];
        const catalogById = new Map(checkpointCatalog.map((lot) => [lot?.id, lot]));
        assertCheckpoint(checkpointCatalog.length === selectedIds.length, "active catalog contains extra lots");
        assertCheckpoint(catalogById.size === selectedIds.length, "active catalog is not compact or complete");
        assertCheckpoint(selectedIds.every((id) => catalogById.has(id)), "a selected lot is missing");
        catalog = selectedIds.map((id) => cloneCheckpointValue(catalogById.get(id)));
      } else {
        assertCheckpoint(Array.isArray(fallbackCatalog) && fallbackCatalog.length >= MATCH_LOT_COUNT, "lobby fallback catalog is missing");
        catalog = cloneCheckpointValue(fallbackCatalog);
      }
      const room = new _AuctionRoom({
        code: checkpoint.roomCode,
        catalog,
        hostId: newHostId,
        hostProfile: playerProfile(electedHost),
        now,
        durations,
        onChange
      });
      state.hostId = newHostId;
      state.term = Math.max(1, Number.isSafeInteger(state.term) ? state.term : 1) + 1;
      state.revision = Math.max(0, Number.isSafeInteger(state.revision) ? state.revision : 0) + 1;
      for (const player of state.players) {
        if (player.isHuman) player.online = player.id === newHostId;
      }
      room.state = state;
      const sessionEntries = Array.isArray(checkpoint.sessionVerifiers) ? checkpoint.sessionVerifiers : [];
      const seenSessionVerifiers = /* @__PURE__ */ new Set();
      for (const entry of sessionEntries) {
        assertCheckpoint(Array.isArray(entry) && entry.length === 2, "session entry is malformed");
        const [verifier, playerId] = entry;
        assertCheckpoint(typeof verifier === "string" && SESSION_VERIFIER_PATTERN.test(verifier), "session verifier is malformed");
        assertCheckpoint(!seenSessionVerifiers.has(verifier), "session verifier is duplicated");
        seenSessionVerifiers.add(verifier);
        assertCheckpoint(state.players.some((player) => player.id === playerId && player.isHuman), "session player is missing");
      }
      room.sessions = new Map(cloneCheckpointValue(sessionEntries));
      const processedEntries = Array.isArray(checkpoint.processedCommands) ? checkpoint.processedCommands : [];
      room.processedCommands = new Map(cloneCheckpointValue(processedEntries));
      for (const player of state.players) {
        if (player.isHuman && player.id !== newHostId) room.scheduleDisconnectExpiry(player.id);
      }
      room.resumePhaseTimers();
      return room;
    }
    exportCheckpoint() {
      const selectedIds = [...new Set(this.state.selectedLotIds)];
      const catalog = selectedIds.map((id) => {
        const lot = this.catalogById.get(id);
        if (!lot) throw new Error(`Cannot checkpoint missing selected lot: ${id}`);
        return cloneCheckpointValue(lot);
      });
      return {
        version: AUTHORITY_CHECKPOINT_VERSION,
        roomCode: this.code,
        capturedAt: this.now(),
        state: cloneCheckpointValue(this.state),
        catalog,
        // Only one-way, room-scoped SHA-256 verifiers cross the data channel.
        // A recipient cannot replay one as a resume token because sessionPlayer
        // hashes every presented token before looking it up.
        sessionVerifiers: cloneCheckpointValue([...this.sessions.entries()]),
        processedCommands: cloneCheckpointValue([...this.processedCommands.entries()])
      };
    }
    humanPlayers() {
      return this.state.players.filter((player) => player.isHuman);
    }
    player(playerId) {
      return this.state.players.find((candidate) => candidate.id === playerId);
    }
    async registerSession(resumeToken, playerId) {
      const verifier = await createSessionVerifier(this.code, resumeToken);
      if (!verifier) throw new Error("Invalid resume token");
      this.sessions.set(verifier, playerId);
    }
    async sessionPlayer(resumeToken) {
      const verifier = await createSessionVerifier(this.code, resumeToken);
      return verifier ? this.sessions.get(verifier) ?? null : null;
    }
    addHuman(playerId, profile) {
      if (this.state.phase !== "LOBBY") return { ok: false, error: ERROR_CODES.ROOM_STARTED };
      if (this.humanPlayers().length >= MAX_PLAYERS) return { ok: false, error: ERROR_CODES.ROOM_FULL };
      const player = createHumanPlayer(playerId, profile, this.now());
      this.state.players.push(player);
      this.touch({ presence: true });
      return { ok: true, player };
    }
    attachSocket(playerId, socketId) {
      const player = this.player(playerId);
      if (!player || !player.isHuman) return false;
      const previousSocketId = this.socketIdByPlayer.get(playerId) ?? null;
      this.socketIdByPlayer.set(playerId, socketId);
      const timer = this.disconnectTimers.get(playerId);
      if (timer) clearTimeout(timer);
      this.disconnectTimers.delete(playerId);
      const changed = !player.online;
      player.online = true;
      if (changed) this.touch({ presence: true });
      return previousSocketId;
    }
    detachSocket(playerId, socketId) {
      if (this.socketIdByPlayer.get(playerId) !== socketId) return;
      this.socketIdByPlayer.delete(playerId);
      const player = this.player(playerId);
      if (!player || !player.isHuman || !player.online) return;
      player.online = false;
      this.touch({ presence: true });
      this.scheduleDisconnectExpiry(playerId);
    }
    scheduleDisconnectExpiry(playerId) {
      const existing = this.disconnectTimers.get(playerId);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        this.disconnectTimers.delete(playerId);
        this.expireDisconnectedPlayer(playerId);
      }, this.durations.reconnectGraceMs);
      timer.unref?.();
      this.disconnectTimers.set(playerId, timer);
    }
    expireDisconnectedPlayer(playerId) {
      const player = this.player(playerId);
      if (!player || player.online) return;
      let changed = false;
      if (this.state.phase === "LOBBY") {
        this.state.players = this.state.players.filter((candidate) => candidate.id !== playerId);
        for (const [token, id] of this.sessions) {
          if (id === playerId) this.sessions.delete(token);
        }
        changed = true;
      }
      if (this.state.hostId === playerId) {
        const successor = this.humanPlayers().filter((candidate) => candidate.online && candidate.id !== playerId).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (successor) {
          this.state.hostId = successor.id;
          changed = true;
        }
      }
      if (changed) this.touch({ presence: true });
    }
    touch({ presence = false } = {}) {
      this.state.revision += 1;
      this.onChange(this, { presence });
      return this.state.revision;
    }
    rememberCommand(playerId, commandId, ack) {
      const key = `${playerId}:${commandId}`;
      this.processedCommands.set(key, ack);
      while (this.processedCommands.size > 2048) {
        this.processedCommands.delete(this.processedCommands.keys().next().value);
      }
    }
    commandResult(playerId, command) {
      const key = `${playerId}:${command.commandId}`;
      const previous = this.processedCommands.get(key);
      if (previous) return previous;
      const finish = (ack) => {
        this.rememberCommand(playerId, command.commandId, ack);
        return ack;
      };
      if (command.type !== COMMAND_TYPES.CHAT_SEND && command.expectedRevision !== this.state.revision) {
        return finish(ackError(ERROR_CODES.STALE_REVISION, this.state.revision));
      }
      const player = this.player(playerId);
      if (!player || !player.isHuman) return finish(ackError(ERROR_CODES.NOT_IN_ROOM, this.state.revision));
      if (command.type === COMMAND_TYPES.GAME_START) {
        if (this.state.hostId !== playerId) return finish(ackError(ERROR_CODES.NOT_HOST, this.state.revision));
        if (this.state.phase !== "LOBBY") return finish(ackError(ERROR_CODES.INVALID_PHASE, this.state.revision));
        this.startGame();
        return finish(ackOk(command.commandId, this.state.revision));
      }
      if (command.type === COMMAND_TYPES.CHAT_SEND) {
        const text = normalizeChatMessage(command.payload.text);
        if (!text) return finish(ackError(ERROR_CODES.MESSAGE_EMPTY, this.state.revision));
        this.state.chatMessages.push({
          id: `${this.state.revision + 1}:${command.commandId}`,
          playerId,
          name: player.name,
          avatar: player.avatar,
          text,
          createdAt: this.now()
        });
        this.state.chatMessages = this.state.chatMessages.slice(-50);
        this.touch();
        return finish(ackOk(command.commandId, this.state.revision));
      }
      const applied = applyHumanAuctionCommand(this.state, player, command);
      if (!applied.ok) return finish(ackError(applied.error, this.state.revision));
      this.clearPhaseTimers();
      this.state.deadlineAt = null;
      this.advanceTurnOrSettle();
      this.touch();
      return finish(ackOk(command.commandId, this.state.revision));
    }
    startGame() {
      this.state.players = fillBots(this.state.players);
      this.state.selectedLotIds = selectMatchLots(this.catalog).map((lot) => lot.id);
      this.state.lotResults = {};
      this.state.current = 0;
      this.beginPreview();
      this.touch({ presence: true });
    }
    currentLot() {
      return this.catalogById.get(this.state.selectedLotIds[this.state.current]);
    }
    clearPhaseTimers() {
      this.timerGeneration += 1;
      for (const timer of this.phaseTimers) clearTimeout(timer);
      this.phaseTimers.clear();
    }
    schedulePhaseTask(callback, delayMs) {
      const generation = this.timerGeneration;
      const timer = setTimeout(() => {
        this.phaseTimers.delete(timer);
        if (generation !== this.timerGeneration) return;
        callback();
      }, Math.max(0, delayMs));
      timer.unref?.();
      this.phaseTimers.add(timer);
      return timer;
    }
    resumePhaseTimers() {
      this.clearPhaseTimers();
      const deadlineAt = Number(this.state.deadlineAt);
      const remainingMs = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - this.now()) : 0;
      if (this.state.phase === "PREVIEW") {
        const clueCount = Math.min(3, this.currentLot()?.clues?.length ?? 0);
        this.state.revealedClueCount = Math.max(0, Math.min(clueCount, Number(this.state.revealedClueCount) || 0));
        const missingClues = clueCount - this.state.revealedClueCount;
        if (remainingMs > 0) {
          for (let index = 0; index < missingClues; index += 1) {
            const delay = Math.max(1, Math.floor(remainingMs * (index + 1) / (missingClues + 1)));
            this.schedulePhaseTask(() => {
              if (this.state.phase !== "PREVIEW") return;
              this.state.revealedClueCount = Math.min(clueCount, this.state.revealedClueCount + 1);
              this.touch();
            }, delay);
          }
        }
        this.schedulePhaseTask(() => {
          if (this.state.phase !== "PREVIEW") return;
          this.state.revealedClueCount = clueCount;
          this.beginLive();
          this.touch();
        }, remainingMs);
        return;
      }
      if (this.state.phase === "LIVE") {
        const actorId = this.state.auction?.turnPlayerId ?? null;
        if (actorId) {
          this.schedulePhaseTask(() => this.handleTurnDeadline(actorId), remainingMs);
        } else {
          this.schedulePhaseTask(() => {
            if (this.state.phase !== "LIVE") return;
            this.state.deadlineAt = null;
            this.advanceTurnOrSettle();
            this.touch();
          }, 0);
        }
        return;
      }
      if (this.state.phase === "SOLD") {
        this.schedulePhaseTask(() => this.advanceAfterSold(), remainingMs);
      }
    }
    beginPreview() {
      this.clearPhaseTimers();
      this.state.phase = "PREVIEW";
      this.state.auction = null;
      this.state.revealedClueCount = 0;
      this.state.deadlineAt = this.now() + this.durations.previewMs;
      const clueCount = Math.min(3, this.currentLot()?.clues?.length ?? 0);
      for (let index = 0; index < clueCount; index += 1) {
        const delay = Math.max(1, Math.floor(this.durations.previewMs * (index + 1) / (clueCount + 1)));
        this.schedulePhaseTask(() => {
          if (this.state.phase !== "PREVIEW") return;
          this.state.revealedClueCount = Math.min(clueCount, this.state.revealedClueCount + 1);
          this.touch();
        }, delay);
      }
      this.schedulePhaseTask(() => {
        if (this.state.phase !== "PREVIEW") return;
        this.state.revealedClueCount = clueCount;
        this.beginLive();
        this.touch();
      }, this.durations.previewMs);
    }
    beginLive() {
      this.clearPhaseTimers();
      const players = this.state.players;
      const offset = this.state.current % players.length;
      const order = [...players.slice(offset), ...players.slice(0, offset)].map((player) => player.id);
      const activeIds = order.filter((id) => this.player(id)?.cash >= MIN_RAISE);
      this.state.phase = "LIVE";
      this.state.deadlineAt = null;
      this.state.auction = {
        order,
        activeIds,
        foldedIds: [],
        currentBid: 0,
        highBidderId: null,
        turnPlayerId: null,
        cursor: 0,
        history: [],
        finished: false
      };
      this.advanceTurnOrSettle();
    }
    advanceTurnOrSettle() {
      const auction = this.state.auction;
      if (!auction || auction.finished) return;
      if (auction.highBidderId && auction.activeIds.length === 1) {
        this.enterSold(auction.highBidderId);
        return;
      }
      if (auction.activeIds.length === 0) {
        this.enterUnsold();
        return;
      }
      let actor = null;
      let guard = 0;
      while (guard < auction.order.length * 3) {
        const id = auction.order[auction.cursor % auction.order.length];
        auction.cursor = (auction.cursor + 1) % auction.order.length;
        guard += 1;
        if (!auction.activeIds.includes(id) || id === auction.highBidderId) continue;
        const candidate = this.player(id);
        if (!candidate || candidate.cash < auction.currentBid + MIN_RAISE) {
          auction.activeIds = auction.activeIds.filter((activeId) => activeId !== id);
          if (!auction.foldedIds.includes(id)) auction.foldedIds.push(id);
          auction.history.unshift({ id, type: "fold", reason: "funds" });
          if (auction.highBidderId && auction.activeIds.length === 1) {
            this.enterSold(auction.highBidderId);
            return;
          }
          if (auction.activeIds.length === 0) {
            this.enterUnsold();
            return;
          }
          continue;
        }
        actor = candidate;
        break;
      }
      if (!actor) {
        if (auction.highBidderId) this.enterSold(auction.highBidderId);
        else this.enterUnsold();
        return;
      }
      auction.turnPlayerId = actor.id;
      const delay = actor.isBot ? this.durations.botThinkMs : this.durations.humanTurnMs;
      this.state.deadlineAt = this.now() + delay;
      this.schedulePhaseTask(() => this.handleTurnDeadline(actor.id), delay);
    }
    handleTurnDeadline(playerId) {
      if (this.state.phase !== "LIVE" || this.state.auction?.turnPlayerId !== playerId) return;
      const player = this.player(playerId);
      if (!player) return;
      if (player.isBot) this.applyBotAction(player);
      else {
        this.state.auction.activeIds = this.state.auction.activeIds.filter((id) => id !== player.id);
        if (!this.state.auction.foldedIds.includes(player.id)) this.state.auction.foldedIds.push(player.id);
        this.state.auction.history.unshift({ id: player.id, type: "fold", reason: "timeout" });
        this.state.auction.turnPlayerId = null;
      }
      this.state.deadlineAt = null;
      this.advanceTurnOrSettle();
      this.touch();
    }
    applyBotAction(player) {
      const auction = this.state.auction;
      const decision = chooseBotAction(this.state, player, this.currentLot());
      if (decision.type === "fold") {
        auction.activeIds = auction.activeIds.filter((id) => id !== player.id);
        if (!auction.foldedIds.includes(player.id)) auction.foldedIds.push(player.id);
        auction.history.unshift({ id: player.id, type: "fold", reason: "bot" });
      } else {
        const oldBid = auction.currentBid;
        const allowedIncrement = ALLOWED_RAISES.has(decision.increment) ? decision.increment : MIN_RAISE;
        const target = Math.min(player.cash, oldBid + allowedIncrement);
        if (target < oldBid + MIN_RAISE) {
          auction.activeIds = auction.activeIds.filter((id) => id !== player.id);
          if (!auction.foldedIds.includes(player.id)) auction.foldedIds.push(player.id);
          auction.history.unshift({ id: player.id, type: "fold", reason: "funds" });
        } else {
          auction.currentBid = target;
          auction.highBidderId = player.id;
          auction.history.unshift({ id: player.id, type: "raise", amount: target, increment: target - oldBid });
        }
      }
      auction.turnPlayerId = null;
    }
    enterSold(winnerId) {
      this.clearPhaseTimers();
      const auction = this.state.auction;
      const lot = this.currentLot();
      auction.finished = true;
      auction.turnPlayerId = null;
      const winner = this.player(winnerId);
      winner.cash -= auction.currentBid;
      winner.spend += auction.currentBid;
      winner.wins += 1;
      winner.collection.push(lot.id);
      winner.knownPrices[lot.id] = lot.priceKRW;
      this.state.lotResults[lot.id] = {
        ownerId: winner.id,
        soldBid: auction.currentBid,
        sold: true
      };
      this.state.phase = "SOLD";
      this.state.deadlineAt = this.now() + this.durations.soldMs;
      this.schedulePhaseTask(() => this.advanceAfterSold(), this.durations.soldMs);
    }
    enterUnsold() {
      this.clearPhaseTimers();
      const lot = this.currentLot();
      if (this.state.auction) {
        this.state.auction.finished = true;
        this.state.auction.turnPlayerId = null;
      }
      this.state.lotResults[lot.id] = { ownerId: null, soldBid: 0, sold: true };
      this.state.phase = "SOLD";
      this.state.deadlineAt = this.now() + this.durations.soldMs;
      this.schedulePhaseTask(() => this.advanceAfterSold(), this.durations.soldMs);
    }
    advanceAfterSold() {
      if (this.state.phase !== "SOLD") return;
      if (this.state.current + 1 >= Math.min(MATCH_LOT_COUNT, this.state.selectedLotIds.length)) {
        this.clearPhaseTimers();
        this.state.phase = "FINAL";
        this.state.auction = null;
        this.state.deadlineAt = null;
        this.state.finishedAt = this.now();
        this.touch();
        return;
      }
      this.state.current += 1;
      this.beginPreview();
      this.touch();
    }
    close() {
      this.clearPhaseTimers();
      for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
      this.disconnectTimers.clear();
    }
  };

  // server/views.mjs
  function remainingSeconds(deadlineAt, now) {
    if (!deadlineAt) return 0;
    return Math.max(0, Math.ceil((deadlineAt - now) / 1e3));
  }
  function publicPlayer(player, state, viewerId) {
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      avatarIndex: player.avatarIndex,
      color: player.color,
      persona: player.persona,
      online: player.online,
      ready: player.ready,
      isHost: player.id === state.hostId,
      isHuman: player.isHuman,
      isBot: player.isBot,
      cash: player.cash,
      collection: [...player.collection],
      knownPrices: player.id === viewerId ? { ...player.knownPrices } : {},
      spend: player.spend,
      wins: player.wins,
      appraisalTokens: 0,
      compareTokens: 0,
      forceTokens: 0
    };
  }
  function buildPresence(room) {
    const state = room.state;
    return {
      roomCode: state.room,
      hostId: state.hostId,
      term: state.term,
      revision: state.revision,
      players: state.players.map((player) => ({
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        avatarIndex: player.avatarIndex,
        color: player.color,
        persona: player.persona,
        online: player.online,
        ready: player.ready,
        isHost: player.id === state.hostId,
        isHuman: player.isHuman,
        isBot: player.isBot
      }))
    };
  }
  function buildSnapshot(room, viewerId, now = Date.now()) {
    const state = room.state;
    const currentLotId = state.current >= 0 ? state.selectedLotIds[state.current] : null;
    const currentLot = currentLotId ? room.catalogById.get(currentLotId) : null;
    const viewer = state.players.find((player) => player.id === viewerId);
    const privateValues = {};
    for (const lotId of viewer?.collection ?? []) {
      const item = room.catalogById.get(lotId);
      if (item) privateValues[lotId] = privateLotValue(item);
    }
    if (state.phase === "FINAL") {
      for (const lotId of state.selectedLotIds) {
        const item = room.catalogById.get(lotId);
        if (item) privateValues[lotId] = privateLotValue(item);
      }
    }
    const revealedLots = state.selectedLotIds.map((id, index) => index <= state.current ? id : null);
    const lotStates = revealedLots.filter(Boolean).map((id, order) => ({ id, order, ...state.lotResults[id] ?? { ownerId: null, soldBid: null, sold: false } }));
    const auction = state.auction ? {
      order: [...state.auction.order],
      activeIds: [...state.auction.activeIds],
      foldedIds: [...state.auction.foldedIds],
      currentBid: state.auction.currentBid,
      highBidderId: state.auction.highBidderId,
      turnPlayerId: state.auction.turnPlayerId,
      history: state.auction.history.slice(0, 40).map((entry) => ({ ...entry })),
      seconds: remainingSeconds(state.deadlineAt, now),
      finished: Boolean(state.auction.finished)
    } : null;
    return {
      room: state.room,
      revision: state.revision,
      term: state.term,
      phase: state.phase,
      current: state.current,
      hostId: state.hostId,
      difficulty: state.difficulty,
      players: state.players.map((player) => publicPlayer(player, state, viewerId)),
      lots: revealedLots,
      lotStates,
      currentLot: currentLot ? publicLot(currentLot, state.revealedClueCount) : null,
      auction,
      deadlineAt: state.deadlineAt,
      chatMessages: state.chatMessages.map((message) => ({ ...message })),
      privateValues
    };
  }

  // p2p-client.mjs
  var PROTOCOL_VERSION = 1;
  var ROOM_LENGTH = 5;
  var ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  var PEER_PREFIX = "a8lh-v1-";
  var CONNECTION_LABEL = "auction8-game-v1";
  var REQUEST_TIMEOUT_MS = 8e3;
  var MAX_WIRE_BYTES = 768 * 1024;
  var MAX_COMMAND_BYTES = 4 * 1024;
  var HEARTBEAT_INTERVAL_MS = 4e3;
  var HOST_TIMEOUT_MS = 12e3;
  var MIGRATION_CLAIM_WINDOW_MS = 3e4;
  var MIGRATION_RECONNECT_WINDOW_MS = 32e3;
  var Emitter = class {
    constructor() {
      this.listeners = /* @__PURE__ */ new Map();
    }
    on(name, handler) {
      if (typeof handler !== "function") return this;
      const bucket = this.listeners.get(name) || /* @__PURE__ */ new Set();
      bucket.add(handler);
      this.listeners.set(name, bucket);
      return this;
    }
    once(name, handler) {
      const wrapped = (...args) => {
        this.off(name, wrapped);
        handler(...args);
      };
      return this.on(name, wrapped);
    }
    off(name, handler) {
      if (!handler) this.listeners.delete(name);
      else this.listeners.get(name)?.delete(handler);
      return this;
    }
    dispatch(name, ...args) {
      for (const handler of [...this.listeners.get(name) || []]) {
        try {
          handler(...args);
        } catch (error) {
          console.error(`[Auction8 P2P] ${name} listener failed`, error);
        }
      }
    }
  };
  function randomInt(maxExclusive) {
    const max = Math.max(1, Math.floor(maxExclusive));
    const limit = Math.floor(4294967296 / max) * max;
    const buffer = new Uint32Array(1);
    do
      crypto.getRandomValues(buffer);
    while (buffer[0] >= limit);
    return buffer[0] % max;
  }
  function randomRoomCode() {
    return Array.from({ length: ROOM_LENGTH }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join("");
  }
  function cleanRoomCode(value) {
    return String(value || "").toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, "").slice(0, ROOM_LENGTH);
  }
  function hostPeerId(roomCode) {
    return `${PEER_PREFIX}${cleanRoomCode(roomCode).toLowerCase()}`;
  }
  function requestId() {
    return crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  function wireSize(value) {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch (_) {
      return Number.POSITIVE_INFINITY;
    }
  }
  function sendWire(connection, envelope) {
    if (!connection?.open || wireSize(envelope) > MAX_WIRE_BYTES) return false;
    try {
      connection.send(envelope);
      return true;
    } catch (_) {
      return false;
    }
  }
  function peerErrorMessage(error, joining = false) {
    const type = String(error?.type || "");
    if (type === "peer-unavailable") return joining ? "ROOM_NOT_FOUND" : "P2P \uC0C1\uB300\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.";
    if (type === "unavailable-id") return "\uBC29 \uCF54\uB4DC\uAC00 \uC774\uBBF8 \uC0AC\uC6A9 \uC911\uC785\uB2C8\uB2E4.";
    if (type === "browser-incompatible") return "\uC774 \uBE0C\uB77C\uC6B0\uC800\uB294 P2P \uC5F0\uACB0\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.";
    if (type === "webrtc") return "\uD1B5\uC2E0\uB9DD\uC5D0\uC11C \uC9C1\uC811 \uC5F0\uACB0\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4. Wi-Fi\uC640 \uBAA8\uBC14\uC77C \uB370\uC774\uD130\uB97C \uBC14\uAFD4 \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.";
    if (["network", "server-error", "socket-error", "socket-closed"].includes(type)) {
      return "P2P \uC5F0\uACB0 \uC2E0\uD638\uAC00 \uB04A\uACBC\uC2B5\uB2C8\uB2E4. \uB124\uD2B8\uC6CC\uD06C\uB97C \uD655\uC778\uD574 \uC8FC\uC138\uC694.";
    }
    return String(error?.message || "P2P \uC5F0\uACB0\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4.");
  }
  function waitForPeerOpen(peer, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (peer.open) return Promise.resolve(peer.id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("P2P \uC5F0\uACB0 \uC900\uBE44 \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.")), timeoutMs);
      const onOpen = (id) => finish(null, id);
      const onError = (error) => finish(error);
      const finish = (error, id) => {
        clearTimeout(timer);
        peer.off?.("open", onOpen);
        peer.off?.("error", onError);
        error ? reject(error) : resolve(id);
      };
      peer.on("open", onOpen);
      peer.on("error", onError);
    });
  }
  function waitForConnectionOpen(connection, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (connection.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("\uBC29\uC7A5\uACFC \uC5F0\uACB0\uD558\uB294 \uB370 \uC2DC\uAC04\uC774 \uC624\uB798 \uAC78\uB9BD\uB2C8\uB2E4.")), timeoutMs);
      const onOpen = () => finish();
      const onError = (error) => finish(error);
      const onClose = () => finish(new Error("\uBC29\uC7A5 \uC5F0\uACB0\uC774 \uB2EB\uD614\uC2B5\uB2C8\uB2E4."));
      const finish = (error) => {
        clearTimeout(timer);
        connection.off?.("open", onOpen);
        connection.off?.("error", onError);
        connection.off?.("close", onClose);
        error ? reject(error) : resolve();
      };
      connection.on("open", onOpen);
      connection.on("error", onError);
      connection.on("close", onClose);
    });
  }
  function waitMs(delay) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, delay)));
  }
  function sourceCatalog() {
    if (typeof LOTS !== "undefined" && Array.isArray(LOTS)) return LOTS;
    if (Array.isArray(globalThis.AUCTION8_LOTS)) return globalThis.AUCTION8_LOTS;
    throw new Error("500\uAC1C \uACBD\uB9E4\uD488 \uBAA9\uB85D\uC744 \uBD88\uB7EC\uC624\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
  }
  function randomizePracticePrice(basePrice) {
    const multiplier = 0.75 + randomInt(601) / 1e3;
    const unit = 1e8;
    return Math.max(unit, Math.round(Number(basePrice) * multiplier / unit) * unit);
  }
  function createSessionCatalog() {
    return sourceCatalog().map((lot) => {
      if (lot.practiceOnly !== true) return { ...lot, clues: [...lot.clues || []] };
      const priceKRW = randomizePracticePrice(lot.priceKRW);
      return {
        ...lot,
        priceKRW,
        priceLabel: `\uAC8C\uC784 \uAC10\uC815\uAC00 \xB7 \u20A9${priceKRW.toLocaleString("ko-KR")}`,
        pricingMode: "room-secret-practice",
        clues: [...lot.clues || []]
      };
    });
  }
  function sessionPayload(room, playerId, resumeToken) {
    return {
      roomCode: room.code,
      playerId,
      hostId: room.state.hostId,
      resumeToken,
      revision: room.state.revision,
      term: Number(room.state.term) || 1,
      transport: "webrtc-p2p"
    };
  }
  var Auction8P2PSocket = class extends Emitter {
    constructor() {
      super();
      this.io = new Emitter();
      this.connected = false;
      this.manualClose = false;
      this.roomClosed = false;
      this.role = null;
      this.peer = null;
      this.connection = null;
      this.room = null;
      this.roomCode = "";
      this.localPlayerId = "";
      this.resumeToken = "";
      this.pendingRequests = /* @__PURE__ */ new Map();
      this.hostConnections = /* @__PURE__ */ new Map();
      this.heartbeatTimer = null;
      this.lastPongAt = 0;
      this.suspendBroadcast = false;
      this.pendingBroadcast = false;
      this.successorId = "";
      this.authorityCheckpoint = null;
      this.authorityTerm = 1;
      this.authorityRevision = 0;
      this.migrationExpected = false;
      this.migrating = false;
      this.promoting = false;
      this.probingHost = false;
      this.reconnectTimer = null;
      this.transportGeneration = 0;
    }
    connect() {
      if (this.connected) return this;
      this.manualClose = false;
      this.roomClosed = false;
      this.connected = true;
      queueMicrotask(() => this.dispatch("connect"));
      return this;
    }
    emit(name, payload, acknowledgement) {
      if (name === "room:create") {
        this.createRoom(payload).then(acknowledgement).catch((error) => acknowledgement?.({ ok: false, error: peerErrorMessage(error) }));
        return this;
      }
      if (name === "room:join") {
        this.joinRoom(payload).then(acknowledgement).catch((error) => acknowledgement?.({ ok: false, error: peerErrorMessage(error, true) }));
        return this;
      }
      if (name === "command") {
        this.command(payload).then(acknowledgement).catch((error) => acknowledgement?.({ ok: false, error: String(error?.message || error) }));
        return this;
      }
      return this;
    }
    disconnect() {
      if (!this.connected && !this.peer && !this.connection && !this.promoting && !this.probingHost && !this.reconnectTimer) return this;
      this.manualClose = true;
      if (this.role === "host") {
        const successorId = this.electSuccessorId();
        if (successorId) {
          this.broadcastAuthority(true);
          for (const { connection } of this.hostConnections.values()) {
            sendWire(connection, {
              v: PROTOCOL_VERSION,
              kind: "HOST_HANDOFF",
              payload: this.authorityStatus(successorId)
            });
          }
        } else {
          for (const { connection } of this.hostConnections.values()) {
            sendWire(connection, { v: PROTOCOL_VERSION, kind: "ROOM_CLOSED", payload: { reason: "\uBC29\uC7A5\uC774 \uBC29\uC744 \uC885\uB8CC\uD588\uC2B5\uB2C8\uB2E4." } });
          }
        }
        this.room?.close();
      }
      this.cleanupTransport();
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.dispatch("disconnect", "io client disconnect");
      return this;
    }
    cleanupTransport() {
      this.transportGeneration += 1;
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.lastPongAt = 0;
      for (const pending of this.pendingRequests.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("P2P \uC5F0\uACB0\uC774 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."));
      }
      this.pendingRequests.clear();
      try {
        this.connection?.close();
      } catch (_) {
      }
      this.connection = null;
      for (const { connection, authTimer } of this.hostConnections.values()) {
        clearTimeout(authTimer);
        try {
          connection.close();
        } catch (_) {
        }
      }
      this.hostConnections.clear();
      try {
        this.peer?.destroy();
      } catch (_) {
      }
      this.peer = null;
      this.room = null;
      this.role = null;
    }
    async createRoom(payload = {}) {
      if (!this.connected) throw new Error("P2P \uC5F0\uACB0\uC774 \uC900\uBE44\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
      if (typeof globalThis.Peer !== "function") throw new Error("P2P \uC5F0\uACB0 \uBAA8\uB4C8\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      if (!globalThis.RTCPeerConnection) throw new Error("\uC774 \uBE0C\uB77C\uC6B0\uC800\uB294 P2P \uC5F0\uACB0\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      this.cleanupTransport();
      let peer;
      let roomCode;
      let lastError;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        roomCode = randomRoomCode();
        peer = new globalThis.Peer(hostPeerId(roomCode), { debug: 1 });
        try {
          await waitForPeerOpen(peer);
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          try {
            peer.destroy();
          } catch (_) {
          }
          if (String(error?.type || "") !== "unavailable-id") break;
        }
      }
      if (lastError || !peer?.open) throw lastError || new Error("\uBC29 \uCF54\uB4DC\uB97C \uB9CC\uB4E4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      this.peer = peer;
      this.role = "host";
      this.migrationExpected = false;
      this.migrating = false;
      this.promoting = false;
      this.probingHost = false;
      this.successorId = "";
      this.authorityCheckpoint = null;
      this.authorityTerm = 1;
      this.authorityRevision = 0;
      this.roomCode = roomCode;
      this.localPlayerId = createPlayerId();
      this.resumeToken = createResumeToken();
      const rawProfile = payload.profile || {};
      const profile = normalizeProfile(rawProfile, 0);
      this.room = new AuctionRoom({
        code: roomCode,
        catalog: createSessionCatalog(),
        hostId: this.localPlayerId,
        hostProfile: profile,
        onChange: () => this.onRoomChange()
      });
      this.room.state.difficulty = String(rawProfile.difficulty || "standard");
      await this.room.registerSession(this.resumeToken, this.localPlayerId);
      this.bindHostPeer(peer);
      const session = sessionPayload(this.room, this.localPlayerId, this.resumeToken);
      setTimeout(() => this.broadcastRoom(true), 0);
      return { ok: true, session };
    }
    bindHostPeer(peer) {
      peer.on("connection", (connection) => {
        if (connection.label !== CONNECTION_LABEL) {
          connection.on("open", () => connection.close());
          return;
        }
        this.bindIncomingConnection(connection);
      });
      peer.on("disconnected", () => {
        if (!this.manualClose && !peer.destroyed) {
          try {
            peer.reconnect();
          } catch (_) {
          }
        }
      });
      peer.on("error", (error) => {
        if (!this.manualClose && !["peer-unavailable", "unavailable-id"].includes(String(error?.type || ""))) {
          this.dispatch("command:error", { error: peerErrorMessage(error) });
        }
      });
    }
    bindIncomingConnection(connection) {
      const record = { connection, playerId: null, authenticating: false, authTimer: null };
      record.authTimer = setTimeout(() => {
        if (!record.playerId) connection.close();
      }, REQUEST_TIMEOUT_MS);
      this.hostConnections.set(connection.peer, record);
      connection.on("data", (envelope) => {
        void this.handleHostWire(record, envelope).catch((error) => {
          console.error("[Auction8 P2P] host request failed", error);
          this.sendHostAck(
            record.connection,
            envelope?.requestId,
            ackError("INTERNAL_ERROR", this.room?.state.revision || 0)
          );
        });
      });
      connection.on("close", () => {
        clearTimeout(record.authTimer);
        if (this.hostConnections.get(connection.peer)?.connection !== connection) return;
        this.hostConnections.delete(connection.peer);
        if (record.playerId) this.room?.detachSocket(record.playerId, connection.peer);
      });
      connection.on("error", () => {
        if (record.playerId) this.room?.detachSocket(record.playerId, connection.peer);
      });
    }
    async handleHostWire(record, envelope) {
      if (!envelope || envelope.v !== PROTOCOL_VERSION || typeof envelope.kind !== "string" || wireSize(envelope) > MAX_WIRE_BYTES) {
        return this.sendHostAck(record.connection, envelope?.requestId, ackError("BAD_REQUEST", this.room?.state.revision || 0));
      }
      if (envelope.kind === "JOIN") return this.handleJoinRequest(record, envelope);
      if (envelope.kind === "COMMAND") return this.handleCommandRequest(record, envelope);
      if (envelope.kind === "PING") {
        return sendWire(record.connection, { v: PROTOCOL_VERSION, kind: "PONG", requestId: envelope.requestId, payload: { at: Date.now() } });
      }
      this.sendHostAck(record.connection, envelope.requestId, ackError("BAD_REQUEST", this.room?.state.revision || 0));
    }
    async handleJoinRequest(record, envelope) {
      if (!this.room || cleanRoomCode(envelope.payload?.roomCode) !== this.roomCode) {
        return this.sendHostAck(record.connection, envelope.requestId, { ok: false, error: "ROOM_NOT_FOUND" });
      }
      if (record.playerId || record.authenticating) {
        return this.sendHostAck(record.connection, envelope.requestId, { ok: false, error: "ALREADY_IN_ROOM" });
      }
      record.authenticating = true;
      const requestedToken = String(envelope.payload?.resumeToken || "").slice(0, 256);
      let token = requestedToken;
      this.suspendBroadcast = true;
      try {
        let playerId = requestedToken ? await this.room.sessionPlayer(requestedToken) : null;
        if (requestedToken && !playerId) {
          return this.sendHostAck(record.connection, envelope.requestId, { ok: false, error: "INVALID_RESUME_TOKEN" });
        }
        if (!playerId) {
          playerId = createPlayerId();
          const profile = normalizeProfile(envelope.payload?.profile || {}, this.room.humanPlayers().length);
          const result = this.room.addHuman(playerId, profile);
          if (!result.ok) return this.sendHostAck(record.connection, envelope.requestId, result);
          token = createResumeToken();
          await this.room.registerSession(token, playerId);
        }
        const previousPeer = this.room.attachSocket(playerId, record.connection.peer);
        if (previousPeer && previousPeer !== record.connection.peer) {
          this.hostConnections.get(previousPeer)?.connection?.close();
        }
        record.playerId = playerId;
        clearTimeout(record.authTimer);
        const session = sessionPayload(this.room, playerId, token);
        this.sendHostAck(record.connection, envelope.requestId, { ok: true, session });
      } finally {
        record.authenticating = false;
        this.suspendBroadcast = false;
        setTimeout(() => this.broadcastRoom(true), 0);
      }
    }
    handleCommandRequest(record, envelope) {
      if (!record.playerId || !this.room) {
        return this.sendHostAck(record.connection, envelope.requestId, ackError("NOT_IN_ROOM", this.room?.state.revision || 0));
      }
      if (wireSize(envelope.payload) > MAX_COMMAND_BYTES) {
        return this.sendHostAck(record.connection, envelope.requestId, ackError("BAD_REQUEST", this.room.state.revision));
      }
      const validation = validateCommand(envelope.payload);
      const result = validation.ok ? this.room.commandResult(record.playerId, validation.command) : ackError(validation.error, this.room.state.revision);
      this.sendHostAck(record.connection, envelope.requestId, result);
    }
    sendHostAck(connection, id, payload) {
      if (!id) return false;
      return sendWire(connection, { v: PROTOCOL_VERSION, kind: "ACK", requestId: id, payload });
    }
    onRoomChange() {
      if (this.suspendBroadcast) {
        this.pendingBroadcast = true;
        return;
      }
      this.broadcastRoom(true);
    }
    broadcastRoom(includePresence = false) {
      if (!this.room || this.role !== "host") return;
      this.pendingBroadcast = false;
      const presence = buildPresence(this.room);
      this.broadcastAuthority();
      if (includePresence) this.dispatch("presence", { presence });
      this.dispatch("snapshot", { snapshot: buildSnapshot(this.room, this.localPlayerId) });
      for (const record of this.hostConnections.values()) {
        if (!record.playerId || !record.connection.open) continue;
        if (includePresence) this.sendEvent(record.connection, "presence", { presence });
        this.sendEvent(record.connection, "snapshot", { snapshot: buildSnapshot(this.room, record.playerId) });
      }
    }
    electSuccessorId() {
      if (!this.room || this.role !== "host") return "";
      const hostId = String(this.room.state.hostId || this.localPlayerId || "");
      const candidates = this.room.humanPlayers().map((player, index) => ({ player, index })).filter(({ player }) => player.online !== false && player.id !== hostId).sort((left, right) => {
        const leftJoined = Number(left.player.joinedAt);
        const rightJoined = Number(right.player.joinedAt);
        if (Number.isFinite(leftJoined) && Number.isFinite(rightJoined) && leftJoined !== rightJoined) {
          return leftJoined - rightJoined;
        }
        return left.index - right.index;
      });
      return String(candidates[0]?.player?.id || "");
    }
    authorityStatus(successorId = this.electSuccessorId()) {
      return {
        roomCode: this.roomCode,
        hostId: String(this.room?.state.hostId || this.localPlayerId || ""),
        successorId: String(successorId || ""),
        term: Number(this.room?.state.term) || 1,
        revision: Number(this.room?.state.revision) || 0,
        capturedAt: Date.now()
      };
    }
    broadcastAuthority(forceCheckpoint = false) {
      if (!this.room || this.role !== "host") return;
      const successorId = this.electSuccessorId();
      this.successorId = successorId;
      const status = this.authorityStatus(successorId);
      let checkpoint = null;
      if (successorId && typeof this.room.exportCheckpoint === "function") {
        try {
          checkpoint = this.room.exportCheckpoint();
        } catch (error) {
          console.error("[Auction8 P2P] authority checkpoint failed", error);
        }
      }
      for (const record of this.hostConnections.values()) {
        if (!record.playerId || !record.connection.open) continue;
        if (record.playerId === successorId) {
          if (!checkpoint) continue;
          const sent = sendWire(record.connection, {
            v: PROTOCOL_VERSION,
            kind: "AUTHORITY_CHECKPOINT",
            payload: { ...status, checkpoint }
          });
          if (!sent && forceCheckpoint) {
            console.error("[Auction8 P2P] final authority checkpoint could not be sent");
          }
          continue;
        }
        sendWire(record.connection, { v: PROTOCOL_VERSION, kind: "AUTHORITY_STATUS", payload: status });
      }
    }
    sendEvent(connection, event, payload) {
      return sendWire(connection, { v: PROTOCOL_VERSION, kind: "EVENT", payload: { event, payload } });
    }
    async joinRoom(payload = {}) {
      if (!this.connected) throw new Error("P2P \uC5F0\uACB0\uC774 \uC900\uBE44\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
      if (typeof globalThis.Peer !== "function") throw new Error("P2P \uC5F0\uACB0 \uBAA8\uB4C8\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
      if (!globalThis.RTCPeerConnection) throw new Error("\uC774 \uBE0C\uB77C\uC6B0\uC800\uB294 P2P \uC5F0\uACB0\uC744 \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      const roomCode = cleanRoomCode(payload.roomCode);
      if (roomCode.length !== ROOM_LENGTH) return { ok: false, error: "ROOM_NOT_FOUND" };
      this.roomCode = roomCode;
      const resumeToken = String(payload.resumeToken || "");
      const retryMigration = Boolean(this.migrationExpected && resumeToken);
      const retryDeadline = Date.now() + MIGRATION_RECONNECT_WINDOW_MS;
      let attempt = 0;
      while (!this.manualClose) {
        this.cleanupTransport();
        this.role = "guest";
        const peer = new globalThis.Peer(void 0, { debug: 1 });
        this.peer = peer;
        try {
          await waitForPeerOpen(peer);
          const connection = peer.connect(hostPeerId(roomCode), {
            label: CONNECTION_LABEL,
            // PeerJS binary serialization chunks large authority checkpoints;
            // JSON channels reject some active eight-lot snapshots as one frame.
            serialization: "binary",
            reliable: true,
            metadata: { v: PROTOCOL_VERSION, roomCode }
          });
          this.connection = connection;
          this.bindGuestConnection(connection);
          await waitForConnectionOpen(connection);
          const result = await this.requestHost("JOIN", {
            roomCode,
            profile: payload.profile || {},
            resumeToken
          });
          if (result?.ok && result.session) {
            this.localPlayerId = result.session.playerId;
            this.resumeToken = result.session.resumeToken;
            this.migrationExpected = false;
            this.migrating = false;
            return result;
          }
          if (!(retryMigration && result?.error === "ROOM_NOT_FOUND" && Date.now() < retryDeadline)) {
            return result;
          }
          const notReady = new Error("\uC0C8 \uBC29\uC7A5\uC774 \uC544\uC9C1 \uBC29\uC744 \uBCF5\uAD6C\uD558\uB294 \uC911\uC785\uB2C8\uB2E4.");
          notReady.type = "peer-unavailable";
          throw notReady;
        } catch (error) {
          this.cleanupTransport();
          const errorType = String(error?.type || "");
          const permanent = ["browser-incompatible", "invalid-id"].includes(errorType);
          const retryFinished = !retryMigration || permanent || this.manualClose || Date.now() >= retryDeadline;
          if (retryFinished) {
            this.connected = Boolean(!retryMigration && !this.manualClose);
            if (retryMigration && !this.manualClose) {
              this.migrating = false;
              this.dispatch("disconnect", "migration failed");
            }
            throw error;
          }
          this.connected = true;
          attempt += 1;
          this.io.dispatch("reconnect_attempt");
          await waitMs(Math.min(1500, 450 + attempt * 175));
        }
      }
      throw new Error("P2P \uC5F0\uACB0\uC774 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
    }
    bindGuestConnection(connection) {
      const generation = this.transportGeneration;
      const isCurrent = () => generation === this.transportGeneration && connection === this.connection;
      const startHeartbeat = () => {
        if (isCurrent()) this.startGuestHeartbeat();
      };
      if (connection.open) startHeartbeat();
      else connection.once("open", startHeartbeat);
      connection.on("data", (envelope) => {
        if (isCurrent()) this.handleGuestWire(envelope);
      });
      connection.on("close", () => {
        if (isCurrent()) this.handleGuestDisconnect(true, "close");
      });
      connection.on("error", (error) => {
        if (isCurrent() && !this.manualClose && !this.roomClosed && !this.migrationExpected) {
          this.dispatch("command:error", { error: peerErrorMessage(error, true) });
        }
      });
      this.peer?.on("disconnected", () => {
        if (isCurrent() && !this.manualClose && !this.peer?.destroyed) {
          try {
            this.peer.reconnect();
          } catch (_) {
          }
        }
      });
    }
    handleGuestWire(envelope) {
      if (!envelope || envelope.v !== PROTOCOL_VERSION || wireSize(envelope) > MAX_WIRE_BYTES) return;
      if (envelope.kind === "ACK") {
        const pending = this.pendingRequests.get(envelope.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(envelope.requestId);
        pending.resolve(envelope.payload);
        return;
      }
      if (envelope.kind === "PONG") {
        this.lastPongAt = Date.now();
        return;
      }
      if (envelope.kind === "EVENT") {
        const event = String(envelope.payload?.event || "");
        if (["session", "presence", "snapshot", "command:error"].includes(event)) {
          this.dispatch(event, envelope.payload?.payload);
        }
        return;
      }
      if (envelope.kind === "AUTHORITY_STATUS") {
        this.acceptAuthorityStatus(envelope.payload);
        return;
      }
      if (envelope.kind === "AUTHORITY_CHECKPOINT") {
        const status = this.acceptAuthorityStatus(envelope.payload);
        if (status && (!this.localPlayerId || status.successorId === this.localPlayerId) && envelope.payload?.checkpoint) {
          this.authorityCheckpoint = {
            checkpoint: envelope.payload.checkpoint,
            term: status.term,
            revision: status.revision,
            capturedAt: Number(envelope.payload.capturedAt) || Date.now()
          };
        }
        return;
      }
      if (envelope.kind === "HOST_HANDOFF") {
        const status = this.acceptAuthorityStatus(envelope.payload);
        if (!status?.successorId) return;
        this.migrationExpected = true;
        this.migrating = true;
        this.dispatch("migration", { ...status, phase: "electing" });
        this.handleGuestDisconnect(true, "handoff");
        try {
          this.connection?.close();
        } catch (_) {
        }
        return;
      }
      if (envelope.kind === "ROOM_CLOSED") {
        this.roomClosed = true;
        this.dispatch("command:error", { error: String(envelope.payload?.reason || "\uBC29\uC7A5\uC774 \uB098\uAC00 \uBC29\uC774 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.") });
        this.handleGuestDisconnect(false, "closed");
      }
    }
    acceptAuthorityStatus(payload = {}) {
      const roomCode = cleanRoomCode(payload.roomCode || this.roomCode);
      if (!roomCode || roomCode !== this.roomCode) return null;
      const term = Math.max(1, Number(payload.term) || 1);
      const revision = Math.max(0, Number(payload.revision) || 0);
      if (term < this.authorityTerm || term === this.authorityTerm && revision < this.authorityRevision) return null;
      this.authorityTerm = term;
      this.authorityRevision = revision;
      this.successorId = String(payload.successorId || "");
      if (this.localPlayerId && this.successorId !== this.localPlayerId) this.authorityCheckpoint = null;
      return {
        roomCode,
        hostId: String(payload.hostId || ""),
        successorId: this.successorId,
        term,
        revision
      };
    }
    handleGuestDisconnect(allowReconnect = true, cause = "close") {
      if (this.manualClose || this.promoting || this.probingHost) return;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.dispatch("disconnect", this.roomClosed ? "host closed" : "transport close");
      if (!allowReconnect || this.roomClosed || !this.resumeToken) return;
      if (this.successorId) {
        this.migrationExpected = true;
        this.migrating = true;
        this.dispatch("migration", {
          roomCode: this.roomCode,
          hostId: "",
          successorId: this.successorId,
          term: this.authorityTerm,
          revision: this.authorityRevision,
          phase: "electing"
        });
      }
      if (this.successorId === this.localPlayerId && this.authorityCheckpoint) {
        if (cause === "close") void this.probeHostThenPromote();
        else void this.promoteToHost();
        return;
      }
      if (!this.reconnectTimer) {
        const delay = this.successorId ? 1150 : 900;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (this.manualClose || this.roomClosed || this.connected) return;
          this.io.dispatch("reconnect_attempt");
          this.connect();
        }, delay);
      }
    }
    async probeHostThenPromote() {
      if (this.probingHost || this.promoting || this.manualClose || !this.authorityCheckpoint) return;
      this.probingHost = true;
      const roomCode = this.roomCode;
      const playerId = this.localPlayerId;
      const resumeToken = this.resumeToken;
      let recovered = false;
      try {
        this.cleanupTransport();
        this.role = "guest";
        const peer = new globalThis.Peer(void 0, { debug: 1 });
        this.peer = peer;
        await waitForPeerOpen(peer, 3e3);
        const connection = peer.connect(hostPeerId(roomCode), {
          label: CONNECTION_LABEL,
          serialization: "binary",
          reliable: true,
          metadata: { v: PROTOCOL_VERSION, roomCode }
        });
        this.connection = connection;
        this.bindGuestConnection(connection);
        await waitForConnectionOpen(connection, 3e3);
        const result = await this.requestHost("JOIN", { roomCode, profile: {}, resumeToken }, 3e3);
        if (!result?.ok || !result.session || result.session.playerId !== playerId) {
          throw new Error(result?.error || "\uAE30\uC874 \uBC29\uC7A5\uC5D0\uAC8C \uC7AC\uC811\uC18D\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
        }
        this.localPlayerId = result.session.playerId;
        this.resumeToken = result.session.resumeToken;
        this.connected = true;
        this.migrationExpected = false;
        this.migrating = false;
        recovered = true;
        this.dispatch("session", { session: result.session });
      } catch (_) {
        this.cleanupTransport();
      } finally {
        this.probingHost = false;
      }
      if (!recovered && !this.manualClose) await this.promoteToHost();
    }
    async claimMigratedHostPeer() {
      const deadline = Date.now() + MIGRATION_CLAIM_WINDOW_MS;
      let attempt = 0;
      let lastError = null;
      while (!this.manualClose && Date.now() < deadline) {
        const peer = new globalThis.Peer(hostPeerId(this.roomCode), { debug: 1 });
        this.peer = peer;
        try {
          await waitForPeerOpen(peer, Math.min(5e3, Math.max(1e3, deadline - Date.now())));
          return peer;
        } catch (error) {
          lastError = error;
          try {
            peer.destroy();
          } catch (_) {
          }
          if (this.peer === peer) this.peer = null;
          attempt += 1;
          if (this.manualClose || Date.now() >= deadline) break;
          await waitMs(Math.min(1800, 250 + attempt * 225));
        }
      }
      throw lastError || new Error("\uC0C8 \uBC29\uC7A5 \uC5F0\uACB0\uC744 \uC5F4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
    }
    async promoteToHost() {
      if (this.promoting || this.manualClose || !this.authorityCheckpoint) return;
      if (this.successorId !== this.localPlayerId) return;
      this.promoting = true;
      this.migrating = true;
      this.migrationExpected = true;
      const saved = this.authorityCheckpoint;
      if (saved.term !== this.authorityTerm || saved.revision !== this.authorityRevision) {
        this.promoting = false;
        this.migrating = false;
        this.roomClosed = true;
        this.connected = false;
        this.dispatch("command:error", { error: "\uCD5C\uC2E0 \uACBD\uB9E4 \uC0C1\uD0DC\uB97C \uBC1B\uC9C0 \uBABB\uD574 \uC548\uC804\uD558\uAC8C \uBC29\uC7A5\uC744 \uC2B9\uACC4\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4." });
        this.dispatch("disconnect", "stale migration checkpoint");
        return;
      }
      const playerId = this.localPlayerId;
      const resumeToken = this.resumeToken;
      this.dispatch("migration", {
        roomCode: this.roomCode,
        successorId: playerId,
        term: saved.term,
        revision: saved.revision,
        phase: "claiming"
      });
      this.cleanupTransport();
      try {
        if (typeof AuctionRoom.restore !== "function") throw new Error("\uBC29\uC7A5 \uC2B9\uACC4 \uBAA8\uB4C8\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
        const peer = await this.claimMigratedHostPeer();
        const room = await AuctionRoom.restore({
          checkpoint: saved.checkpoint,
          newHostId: playerId,
          fallbackCatalog: createSessionCatalog(),
          now: Date.now,
          onChange: () => this.onRoomChange()
        });
        if (!room) throw new Error("\uCD5C\uC2E0 \uACBD\uB9E4 \uC0C1\uD0DC\uB97C \uBCF5\uAD6C\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.");
        this.peer = peer;
        this.room = room;
        this.role = "host";
        this.roomCode = cleanRoomCode(room.code || room.state?.room || this.roomCode);
        this.localPlayerId = playerId;
        this.resumeToken = resumeToken;
        this.manualClose = false;
        this.roomClosed = false;
        this.connected = true;
        this.migrationExpected = false;
        this.migrating = false;
        this.promoting = false;
        this.successorId = "";
        this.authorityCheckpoint = null;
        this.authorityTerm = Number(room.state?.term) || saved.term + 1;
        this.authorityRevision = Number(room.state?.revision) || saved.revision;
        if (!await room.sessionPlayer(resumeToken)) await room.registerSession(resumeToken, playerId);
        this.bindHostPeer(peer);
        this.suspendBroadcast = true;
        room.attachSocket(playerId, `host:${peer.id}`);
        this.suspendBroadcast = false;
        this.pendingBroadcast = false;
        const session = sessionPayload(room, playerId, resumeToken);
        this.dispatch("session", { session });
        this.dispatch("migration", {
          roomCode: this.roomCode,
          hostId: playerId,
          successorId: this.electSuccessorId(),
          term: this.authorityTerm,
          revision: room.state.revision,
          phase: "promoted"
        });
        this.broadcastRoom(true);
      } catch (error) {
        if (this.manualClose) {
          this.promoting = false;
          this.migrating = false;
          this.cleanupTransport();
          return;
        }
        this.promoting = false;
        this.migrating = false;
        this.roomClosed = true;
        this.connected = false;
        this.cleanupTransport();
        this.dispatch("command:error", { error: `\uBC29\uC7A5 \uC2B9\uACC4\uC5D0 \uC2E4\uD328\uD588\uC2B5\uB2C8\uB2E4. ${peerErrorMessage(error)}` });
        this.dispatch("disconnect", "migration failed");
      }
    }
    startGuestHeartbeat() {
      clearInterval(this.heartbeatTimer);
      this.lastPongAt = Date.now();
      const tick = () => {
        if (this.manualClose || this.roomClosed || !this.connection?.open) return;
        if (Date.now() - this.lastPongAt > HOST_TIMEOUT_MS) {
          if (!this.successorId) {
            this.dispatch("command:error", { error: "\uBC29\uC7A5 \uC5F0\uACB0\uC774 \uB04A\uACA8 \uC7AC\uC5F0\uACB0\uC744 \uC2DC\uB3C4\uD569\uB2C8\uB2E4." });
          }
          this.handleGuestDisconnect(true, "timeout");
          try {
            this.connection?.close();
          } catch (_) {
          }
          return;
        }
        sendWire(this.connection, {
          v: PROTOCOL_VERSION,
          kind: "PING",
          requestId: requestId(),
          payload: { at: Date.now() }
        });
      };
      this.heartbeatTimer = setInterval(tick, HEARTBEAT_INTERVAL_MS);
      tick();
    }
    requestHost(kind, payload, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (!this.connection?.open) return Promise.reject(new Error("\uBC29\uC7A5\uACFC \uC5F0\uACB0\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4."));
      const id = requestId();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingRequests.delete(id);
          reject(new Error("\uBC29\uC7A5\uC758 \uC751\uB2F5\uC774 \uB2A6\uC2B5\uB2C8\uB2E4. \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694."));
        }, timeoutMs);
        this.pendingRequests.set(id, { resolve, reject, timer });
        if (!sendWire(this.connection, { v: PROTOCOL_VERSION, kind, requestId: id, payload })) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(new Error("P2P \uBA54\uC2DC\uC9C0\uB97C \uBCF4\uB0B4\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4."));
        }
      });
    }
    async command(rawCommand) {
      if (this.role === "host") {
        if (!this.room) return ackError("NOT_IN_ROOM", 0);
        const validation = validateCommand(rawCommand);
        return validation.ok ? this.room.commandResult(this.localPlayerId, validation.command) : ackError(validation.error, this.room.state.revision);
      }
      if (this.role === "guest") return this.requestHost("COMMAND", rawCommand);
      return ackError("NOT_IN_ROOM", 0);
    }
  };
  var sockets = /* @__PURE__ */ new Set();
  globalThis.io = function auction8P2PFactory() {
    const socket = new Auction8P2PSocket();
    sockets.add(socket);
    return socket;
  };
  globalThis.Auction8P2P = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    signaling: "PeerJS Cloud",
    topology: "host-star",
    closeAll() {
      for (const socket of sockets) socket.disconnect();
    }
  });
  globalThis.addEventListener?.("pagehide", (event) => {
    if (event?.persisted) return;
    for (const socket of sockets) socket.disconnect();
  });
})();
