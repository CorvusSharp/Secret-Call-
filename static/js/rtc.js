"use strict";

import { $, $$, toast, showModal, showNet, hideNet } from "./ui.js";

/* =========================================================================
   Emoji & Mentions
   ========================================================================= */
const emojiBtn = document.getElementById("emoji-btn");
const emojiPop = document.getElementById("emoji-pop");
const mentionBox = document.getElementById("mentions-suggest");
const chatLog = document.getElementById("chat-log");
const chatInput = document.getElementById("chat-input");
const chatSend = document.getElementById("chat-send");

const EMOJIS =
  "👍,👎,🙂,😉,😊,😂,🤣,😮,😢,😡,❤,🔥,✨,🎉,✅,❌,⭐,🚀,🎧,🎵,☎,💡,🧠,💬,🍀,☕,🍕,🍎".split(
    ","
  );

function buildEmojiPop() {
  if (!emojiPop) return;
  emojiPop.innerHTML = "";

  const hdr = document.createElement("div");
  hdr.className = "emoji-pop__hdr";

  const title = document.createElement("div");
  title.className = "emoji-pop__title";
  title.textContent = "Эмодзи";

  const close = document.createElement("button");
  close.type = "button";
  close.className = "emoji-pop__close";
  close.textContent = "×";
  close.title = "Закрыть";
  close.addEventListener("click", () => {
    emojiPop.hidden = true;
    chatInput?.focus();
  });

  hdr.appendChild(title);
  hdr.appendChild(close);
  emojiPop.appendChild(hdr);
  emojiPop.appendChild(document.createElement("hr"));

  EMOJIS.forEach((e) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.addEventListener("click", () => {
      if (chatInput) {
        insertAtCursor(chatInput, e);
        emojiPop.hidden = true;
        chatInput.focus();
      }
    });
    emojiPop.appendChild(b);
  });
}

function insertAtCursor(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const val = input.value;
  input.value = val.slice(0, start) + text + val.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event("input"));
}

emojiBtn?.addEventListener("click", () => {
  if (!emojiPop) return;
  if (emojiPop.hidden) buildEmojiPop();
  emojiPop.hidden = !emojiPop.hidden;
});

document.addEventListener("click", (e) => {
  if (emojiPop && !emojiPop.hidden && !emojiPop.contains(e.target) && e.target !== emojiBtn)
    emojiPop.hidden = true;
  if (mentionBox && !mentionBox.hidden && !mentionBox.contains(e.target))
    mentionBox.hidden = true;
});

// РОСТЕР для @упоминаний
let rosterById = new Map();

function updateRoster(roster) {
  rosterById = new Map((roster || []).map((p) => [p.id, (p.name || "").trim()]));
  refreshPeerNames();
}

function refreshPeerNames() {
  for (const [id, name] of rosterById.entries()) {
    const root = document.getElementById("peer-" + id);
    if (!root) continue;
    const label = root.querySelector(".peer__name");
    if (label) label.textContent = name || id.slice(0, 6);
  }
}

function currentWordAtCaret(input) {
  const pos = input.selectionStart ?? input.value.length;
  const left = input.value.slice(0, pos);
  const m = left.match(/(^|\s)(@[\w\-]{0,32})$/);
  if (!m) return null;
  return { start: pos - m[2].length, end: pos, token: m[2] };
}

function showMentionSuggest(prefix) {
  if (!mentionBox) return;
  const q = prefix.slice(1).toLowerCase();
  const opts = [];
  for (const [id, name] of rosterById.entries()) {
    const shortId = id.slice(0, 6);
    const label = name || shortId;
    if (!q || label.toLowerCase().includes(q) || shortId.startsWith(q)) {
      opts.push({ id, name, label });
    }
  }
  if (!opts.length) {
    mentionBox.hidden = true;
    return;
  }
  mentionBox.innerHTML = "";
  opts.slice(0, 20).forEach((o, idx) => {
    const div = document.createElement("div");
    div.className = "opt" + (idx === 0 ? " active" : "");
    div.textContent = "@" + (o.name || o.id.slice(0, 6));
    div.dataset.id = o.id;
    div.addEventListener("click", () => applyMentionFromBox(o.id, o.name));
    mentionBox.appendChild(div);
  });
  mentionBox.hidden = false;
}

function applyMentionFromBox(id, name) {
  if (!chatInput) return;
  const cur = currentWordAtCaret(chatInput);
  if (!cur) return;
  const label = "@" + (name || id.slice(0, 6));
  const val = chatInput.value;
  chatInput.value = val.slice(0, cur.start) + label + val.slice(cur.end);
  chatInput.focus();
  if (mentionBox) mentionBox.hidden = true;
}

chatInput?.addEventListener("input", () => {
  if (!chatInput || !mentionBox) return;
  const cur = currentWordAtCaret(chatInput);
  if (cur) showMentionSuggest(cur.token);
  else mentionBox.hidden = true;
});

chatInput?.addEventListener("keydown", (e) => {
  if (!mentionBox || mentionBox.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
    e.preventDefault();
    const items = Array.from(mentionBox.querySelectorAll(".opt"));
    if (!items.length) return;
    let idx = items.findIndex((x) => x.classList.contains("active"));
    if (idx < 0) idx = 0;
    if (e.key === "ArrowDown") idx = Math.min(idx + 1, items.length - 1);
    if (e.key === "ArrowUp") idx = Math.max(idx - 1, 0);
    items.forEach((x, i) => x.classList.toggle("active", i === idx));
    if (e.key === "Enter") {
      const el = items[idx];
      applyMentionFromBox(el.dataset.id, el.textContent.slice(1));
    }
  }
});

function extractMentions(text) {
  const ids = [];
  const re = /@([\w\-]{1,32})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].toLowerCase();
    for (const [id, name] of rosterById.entries()) {
      const shortId = id.slice(0, 6).toLowerCase();
      if ((name && name.toLowerCase() === label) || shortId === label) {
        ids.push(id);
        break;
      }
    }
  }
  return Array.from(new Set(ids));
}

function fmtTime(ts) {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function appendChat({ from: fromId, name, text, ts }) {
  if (!chatLog) return;
  const mine = fromId === myId;
  const row = document.createElement("div");
  row.className = "chat__msg" + (mine ? " mine" : "");
  const meta = document.createElement("span");
  meta.className = "meta";
  const who = name ? name : fromId ? fromId.slice(0, 6) : "anon";
  meta.textContent = `${who} · ${fmtTime(ts)}`;

  const body = document.createElement("span");
  body.className = "body";
  body.textContent = " " + text;
  row.appendChild(meta);
  row.appendChild(body);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat() {
  const text = (chatInput?.value || "").slice(0, 500).trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  const mentions = extractMentions(text);
  ws.send(JSON.stringify({ type: "chat", text, mentions }));
  if (chatInput) chatInput.value = "";
}
chatSend?.addEventListener("click", sendChat);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

/* =========================================================================
   WebSocket + WebRTC
   ========================================================================= */
const peersEl = document.getElementById("peers");
const nameEl = document.getElementById("name");
const joinBtn = document.getElementById("join");
const tpl = document.getElementById("peer-tpl");
const settingsBtn = document.getElementById("settings");
const tokenEl = document.getElementById("token");
const tokenHint = document.getElementById("token-hint");

const saveTokenBtn = document.getElementById("save-token");
saveTokenBtn?.addEventListener("click", () => {
  const val = (tokenEl?.value || "").trim();
  if (val) localStorage.setItem("ROOM_TOKEN", val);
  else localStorage.removeItem("ROOM_TOKEN");
  if (tokenHint) tokenHint.textContent = "Токен: " + maskToken(val || "");
  toast(val ? "Токен сохранён" : "Токен очищен");
  initWS(); // переподключение
});

const pcs = new Map();    // id -> RTCPeerConnection
const audios = new Map(); // id -> <audio>
const pendingIce = new Map(); // id -> Array<candidate>

function queueIce(id, c) {
  if (!pendingIce.has(id)) pendingIce.set(id, []);
  pendingIce.get(id).push(c);
}
async function flushQueuedIce(id) {
  const pc = pcs.get(id);
  if (!pc || !pc.remoteDescription) return;
  const list = pendingIce.get(id) || [];
  for (const c of list) {
    try { await pc.addIceCandidate(c); }
    catch (e) { console.warn("[ICE] late add failed", e); }
  }
  pendingIce.delete(id);
}

const audioOutSel = document.getElementById("audio-output");
let selectedAudioOutput = "";

if (audioOutSel && typeof HTMLMediaElement.prototype.setSinkId !== "function") {
  audioOutSel.closest("label")?.setAttribute("hidden", "true");
}

async function setAudioOutput(audio) {
  if (!audio || typeof audio.setSinkId !== "function" || !selectedAudioOutput) return;
  try {
    await audio.setSinkId(selectedAudioOutput);
  } catch (err) {
    console.warn("[AUDIO] setSinkId", err);
  }
}

async function refreshAudioOutputs() {
  if (!audioOutSel || !navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    audioOutSel.innerHTML = "";
    for (const d of devices) {
      if (d.kind === "audiooutput") {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || (d.deviceId === "default" ? "По умолчанию" : d.deviceId);
        audioOutSel.appendChild(opt);
      }
    }
    if (audioOutSel.options.length > 0) {
      if (!selectedAudioOutput) {
        selectedAudioOutput = audioOutSel.options[0].value;
      }
      audioOutSel.value = selectedAudioOutput;
      audios.forEach((a) => setAudioOutput(a));
    }
  } catch (err) {
    console.warn("[AUDIO] enumerateDevices", err);
  }
}

audioOutSel?.addEventListener("change", () => {
  selectedAudioOutput = audioOutSel.value;
  audios.forEach((a) => setAudioOutput(a));
});

let myId = null;
let joined = false;
let micStream = null;
let ws = null;

function setState(text, status = "idle") {
  const el = document.getElementById("state");
  if (!el) return;
  el.textContent = text;
  el.setAttribute("data-status", status);
}

function maskToken(t) {
  if (!t) return "(не задан)";
  if (t.length <= 6) return t;
  return t.slice(0, 3) + "…" + t.slice(-3);
}

function currentToken() {
  return localStorage.getItem("ROOM_TOKEN") || "";
}

let reconnectTimer = null;

function scheduleReconnect() {
  if (!joined) return;                 // не лезем, если пользователь вышел
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWS();                          // пересоздаём ws
    waitWsOpen(6000).catch(() => {});  // не шумим тостами тут
  }, 800); // лёгкий бэкофф
}

function initWS() {
  try {
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close(4000, "reconnect");
    }
  } catch {}
  closeAllPeers();

  const token = currentToken();
  if (!token) { setState("Требуется токен", "warn"); ws = null; return; }

  // Если страница по https — используем wss, иначе ws
  const scheme = (location.protocol === "https:") ? "wss://" : "ws://";
  // Дублируем токен и в query, и в subprotocol — чтобы пройти и через хитрые прокси
  const url = scheme + location.host + "/ws?t=" + encodeURIComponent(token);

  // Передаём вариант subprotocol: "token.<…>"
  ws = new WebSocket(url, ["token." + currentToken()]);

  ws.onopen = () => { setState("Соединение установлено", "ok"); };
  ws.onclose = (e) => {
    console.warn("[WS close]", e.code, e.reason);
    setState("Соединение закрыто", "warn");
    scheduleReconnect();
  };
  ws.onerror = (e) => {
    console.error("[WS error]", e);
    setState("Ошибка соединения", "error");
  };
  ws.onmessage = onWSMessage;
}

function addPeerUI(id, name) {
  if (!peersEl || !tpl) return;
  if (document.getElementById("peer-" + id)) return;
  const node = tpl.content.cloneNode(true);
  const root = $(".peer", node);
  if (!root) return;
  root.id = "peer-" + id;
  const nameLabel = $(".peer__name", node);
  if (nameLabel) nameLabel.textContent = name || id.slice(0, 6);
  const audio = $("audio", node);
  const muteBtn = $(".mute", node);
  const vol = $(".vol", node);
  if (muteBtn && audio) {
    muteBtn.onclick = () => {
      audio.muted = !audio.muted;
      muteBtn.textContent = audio.muted ? "Unmute" : "Mute";
      muteBtn.classList.toggle("is-on", audio.muted);
      muteBtn.setAttribute("aria-pressed", audio.muted ? "true" : "false");
    };
  }
  if (vol && audio) {
    vol.oninput = () => {
      audio.volume = +vol.value / 100;
    };
  }
  peersEl.appendChild(node);
  audios.set(id, audio);
  setAudioOutput(audio);
}

function removePeerUI(id) {
  const el = document.getElementById("peer-" + id);
  if (el) {
    el.classList.add("bye");
    setTimeout(() => el.remove(), 300);
  }
  audios.delete(id);
}

function closeAllPeers() {
  for (const [, pc] of pcs) {
    try {
      pc.getSenders().forEach((s) => s.track && s.track.stop());
    } catch {}
    try {
      pc.close();
    } catch {}
  }
  pcs.clear();
  if (peersEl) peersEl.innerHTML = "";
  audios.clear();
}

function makePC(remoteId) {
  const stun = localStorage.getItem("STUN") || "stun:stun.l.google.com:19302";
  const iceServers = [{ urls: [stun] }];
  // TURN fallback for restrictive NATs
  iceServers.push({
    urls: "turn:turn.anyfirewall.com:443?transport=tcp",
    username: "webrtc",
    credential: "webrtc",
  });
  const pc = new RTCPeerConnection({ iceServers });
  pcs.set(remoteId, pc);

  if (micStream) micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));

  pc.ontrack = (ev) => {
    const [stream] = ev.streams;
    const displayName = rosterById.get(remoteId) || "";
    addPeerUI(remoteId, displayName);

    const audio = audios.get(remoteId);
    if (!audio) return;
    audio.srcObject = stream;
    audio.muted = false;
    audio.autoplay = true;
    audio.playsInline = true;
    setAudioOutput(audio);

    // Плавный fade-in
    audio.volume = 0;
    const target = 1;
    let v = 0;
    const tick = () => {
      v = Math.min(target, v + 0.05);
      audio.volume = v;
      if (v < target) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  pc.onicecandidate = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "ice",
          to: remoteId,
          candidate: e.candidate
            ? {
                candidate: e.candidate.candidate,
                sdpMid: e.candidate.sdpMid,
                sdpMLineIndex: e.candidate.sdpMLineIndex,
              }
            : null,
        })
      );
    }
  };

  return pc;
}

async function maybeCall(remoteId) {
  if (!joined) return;
  if (myId < remoteId) {
    const pc = pcs.get(remoteId) || makePC(remoteId);
    const off = await pc.createOffer();
    await pc.setLocalDescription(off);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: "offer",
          to: remoteId,
          sdp: pc.localDescription.sdp,
          sdpType: pc.localDescription.type,
        })
      );
    }
  }
}

function callAllKnownPeers() {
  for (const peerId of rosterById.keys()) {
    if (peerId === myId) continue;
    if (!pcs.has(peerId)) maybeCall(peerId);
  }
}

async function onWSMessage(ev) {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }

  if (m.type === "hello") {
    updateRoster(m.roster || []);
    myId = m.id;
    setState("В комнате", "ok");
    if (joined) callAllKnownPeers();
    return;
  }

  if (m.type === "roster") {
    updateRoster(m.roster || []);
    return;
  }

  if (m.type === "peer-joined") {
    if (m.id !== myId) {
      if (joined) maybeCall(m.id);
      toast("Кто-то подключился");
    }
    return;
  }

  if (m.type === "chat") {
    appendChat(m);
    return;
  }

  if (m.type === "peer-left") {
    removePeerUI(m.id);
    toast("Кто-то вышел", "warn");
    return;
  }

  // === Perfect Negotiation (glare-handling) ===
  if (m.type === "offer") {
    const from = m.from;
    const pc = pcs.get(from) || makePC(from);

    // Роль «вежливый/невежливый» — для устойчивого разруливания двусторонних офферов
    const polite = myId > from; // у кого id больше — тот «polite»

    try {
      if (pc.signalingState === "have-local-offer") {
        // Коллизия офферов (glare)
        if (!polite) {
          console.warn("[SIG] glare: impolite side ignores incoming offer");
          return; // невежливый сохраняет свой локальный оффер
        }
        // Вежливый откатывает свой локальный оффер и принимает удалённый
        await pc.setLocalDescription({ type: "rollback" });
      }

      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });

      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "answer",
            to: from,
            sdp: pc.localDescription.sdp,
            sdpType: pc.localDescription.type,
          })
        );
      }

      // Применить отложенные ICE после установки удалённого оффера
      flushQueuedIce(from);

    } catch (e) {
      console.warn("[SIG] offer handling failed:", e, "state=", pc.signalingState);
    }
    return;
  }

  if (m.type === "answer") {
    const pc = pcs.get(m.from);
    if (!pc) return;

    // Принимать answer только когда ожидаем его после локального оффера
    if (pc.signalingState !== "have-local-offer") {
      console.warn("[SIG] late/duplicate answer ignored, state=", pc.signalingState);
      return;
    }
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
    } catch (e) {
      console.warn("[SIG] setRemoteDescription(answer) failed:", e, "state=", pc.signalingState);
    }
    return;
  }

  if (m.type === "ice") {
    const pc = pcs.get(m.from);
    if (!pc) return;
    const c = m.candidate;

    if (c === null) {
      try { await pc.addIceCandidate(null); } catch {}
      return;
    }
    if (!c.candidate || c.candidate.includes(".local")) return;

    // Если ещё нет remoteDescription — копим кандидаты
    if (!pc.remoteDescription) {
      queueIce(m.from, c);
      return;
    }
    try { await pc.addIceCandidate(c); } catch (e) { console.warn("[ICE] add failed", e); }
    return;
  }

  if (m.type === "full") {
    const cap = typeof m.capacity === "number" ? m.capacity : undefined;
    const title = "Комната заполнена";
    const text = cap
      ? `Достигнут лимит участников: ${cap}. Попробуйте позже.`
      : "Комната заполнена. Попробуйте позже.";
    showModal(title, text);
    try {
      ws?.close(4001, "room full");
    } catch {}
    setState("Комната заполнена", "warn");
    return;
  }

  if (m.type === "browser-only") {
    showModal(
      "Требуется браузер",
      "Подключение возможно только из браузера. Откройте ссылку в Chrome/Firefox/Safari/Edge."
    );
    try {
      ws?.close(4002, "browser only");
    } catch {}
    setState("Только браузер", "error");
    return;
  }
}

function switchJoinButton(toState) {
  if (!joinBtn) return;
  const label = joinBtn.querySelector(".btn__label");
  if (toState === "leave") {
    joinBtn.dataset.mode = "leave";
    joinBtn.classList.remove("primary", "glow");
    joinBtn.classList.add("danger", "is-on");
    joinBtn.setAttribute("aria-pressed", "true");
    if (label) label.textContent = "Выйти";
  } else {
    joinBtn.dataset.mode = "join";
    joinBtn.classList.remove("danger", "is-on");
    joinBtn.classList.add("primary", "glow");
    joinBtn.setAttribute("aria-pressed", "false");
    if (label) label.textContent = "Войти";
  }
}

async function waitWsOpen(timeoutMs = 6000) {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  // если сокета нет или он закрыт/закрывается — пересоздаём
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    initWS();                       // <— создать новый WS
  }

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error("ws-timeout")); }, timeoutMs);

    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("ws-error")); };

    function cleanup() {
      try {
        ws && ws.removeEventListener("open", onOpen);
        ws && ws.removeEventListener("error", onError);
        clearTimeout(t);
      } catch {}
    }

    // тут ws уже точно «живой» после initWS()
    ws?.addEventListener("open", onOpen);
    ws?.addEventListener("error", onError);
  });
}

async function startCall() {
  if (!currentToken()) {
    toast("Не задан токен комнаты", "warn");
    setState("Требуется токен", "warn");
    return;
  }

  try {
    setState("Запрашиваем микрофон…", "idle");
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }
    await refreshAudioOutputs();
  } catch {
    toast("Доступ к микрофону запрещён", "error");
    setState("Нет доступа к микрофону", "error");
    switchJoinButton("join");
    return;
  }

  // Обновим текущие PC (на случай реконнекта)
  for (const [, pc] of pcs) {
    try {
      micStream.getTracks().forEach((t) => pc.addTrack(t, micStream));
    } catch {}
  }

  try {
    await waitWsOpen(6000);
  } catch {
    toast("Нет соединения с сервером", "warn");
    setState("Нет соединения", "warn");
    initWS();
    try {
      await waitWsOpen(6000);
    } catch {
      switchJoinButton("join");
      return;
    }
  }

  ws?.send(
    JSON.stringify({
      type: "name",
      name: (nameEl?.value || "User").slice(0, 32),
    })
  );

  joined = true;
  callAllKnownPeers();

  // Если в DOM уже есть карточки из прежней сессии — дозвонимся
  $$(".peer").forEach((el) => {
    const id = el.id.replace("peer-", "");
    if (id && !pcs.has(id)) maybeCall(id);
  });

  toast("Микрофон включен");
  setState("Вы в эфире", "ok");
  switchJoinButton("leave");
}

async function leaveCall() {
  try {
    joined = false;

    if (micStream) {
      for (const t of micStream.getTracks()) {
        try { t.stop(); } catch {}
      }
      micStream = null;
    }

    closeAllPeers();

    // корректно закрываем WS и ОБЯЗАТЕЛЬНО зануляем ссылку
    if (ws) {
      try { ws.close(4005, "user left"); } catch {}
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws = null;                    // <— ВАЖНО
    }

    setState("Вы вышли из разговора", "warn");
    toast("Вы вышли из разговора", "warn");
  } finally {
    switchJoinButton("join");
  }
}

/* =========================================================================
   Инициализация и единые обработчики
   ========================================================================= */
document.addEventListener("DOMContentLoaded", () => {
  // Инициал — состояние кнопки
  switchJoinButton("join");

  // Токен из localStorage
  const savedToken = localStorage.getItem("ROOM_TOKEN") || "";
  if (tokenEl) tokenEl.value = savedToken;
  if (tokenHint) tokenHint.textContent = "Токен: " + maskToken(savedToken);

  // Кнопка настроек — единый toggle + sync состояния
  settingsBtn?.addEventListener("click", () => {
    const pop = $("#net-popover");
    if (!pop) return;
    const willOpen = pop.classList.contains("hidden");
    if (willOpen) showNet();
    else hideNet();
    settingsBtn.classList.toggle("is-on", willOpen);
    settingsBtn.setAttribute("aria-pressed", willOpen ? "true" : "false");
  });

  // Автоконнект WS (без старта разговора)
  initWS();

  // ЕДИНСТВЕННЫЙ обработчик кнопки «Войти/Выйти»
  joinBtn && (joinBtn.onclick = async () => {
    if (joinBtn.dataset.mode === "join" && !joined) {
      const name = nameEl?.value.trim();
      const token = tokenEl?.value.trim();
      if (!name) {
        toast("Введите имя!", "error");
        return;
      }
      if (!token) {
        toast("Введите токен комнаты!", "error");
        return;
      }
      localStorage.setItem("ROOM_TOKEN", token);
      if (tokenHint) tokenHint.textContent = "Токен: " + maskToken(token);

      initWS();
      await startCall();
    } else if (joinBtn.dataset.mode === "leave") {
      await leaveCall();
    }
  });
});

// Безопасные логи
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection:", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("Unhandled error:", e.error || e.message);
});
