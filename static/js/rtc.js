// /js/rtc.js
"use strict";






import { $, $$, toast, showModal, showNet, hideNet } from "./ui.js";
import { updateRoster, appendChat, setMyId, setSendChat, getRosterIds } from "./chat.js";

/* =========================================================================
   DOM
   ========================================================================= */
const peersEl = document.getElementById("peers");
const nameEl = document.getElementById("name");
const joinBtn = document.getElementById("join");
const tpl = document.getElementById("peer-tpl");
const settingsBtn = document.getElementById("settings");
const tokenEl = document.getElementById("token");
const tokenHint = document.getElementById("token-hint");
const audioOutSel = document.getElementById("audio-output");
const selfMuteBtn = document.getElementById("self-mute");
const selfMuteRow = document.getElementById("self-mute-row");

/* =========================================================================
   Состояние
   ========================================================================= */
const pcs = new Map(); // id -> RTCPeerConnection
const audios = new Map(); // id -> <audio>
const pendingIce = new Map(); // id -> Array<candidate>
const senders = new Map();
const negotiating = new Map(); // id -> boolean (идёт ли сейчас оффер)
const needRenego = new Map(); // id -> boolean (отложенная перенегоциация)
const analysers = new Map(); // id -> AnalyserNode
const speakingDetectionIntervals = new Map(); // id -> interval ID
const trackClones = new Map();   

let myId = null;
let joined = false;
let micStream = null;
let ws = null;
let selfMuted = false;
let audioContext = null;

let selectedAudioOutput = "";

/* =========================================================================
   Утилиты UI/состояния
   ========================================================================= */
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

/* =========================================================================
   Аудио выход
   ========================================================================= */
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
      if (!selectedAudioOutput) selectedAudioOutput = audioOutSel.options[0].value;
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

// negotiating: Map<peerId, boolean>
// needRenego:  Map<peerId, boolean>

async function renegotiate(remoteId, pc, opts = {}) {
  if (!pc || pc.connectionState === "closed") return;

  // ставим флаг "надо", один цикл обслужит пачку запросов
  needRenego.set(remoteId, true);
  if (negotiating.get(remoteId)) return;

  negotiating.set(remoteId, true);
  try {
    while (needRenego.get(remoteId)) {
      needRenego.set(remoteId, false);

      // не зовём оффер вне stable
      try {
        if (pc.signalingState !== "stable") {
          await waitForSignalingState(pc, "stable", 2500);
          if (pc.signalingState !== "stable") {
            needRenego.set(remoteId, true);
            break;
          }
        }
      } catch {
        break; // pc закрыт/таймаут
      }

      if (pc.connectionState === "closed") break;

      // создаём оффер строго из stable
      let offer;
      try {
        offer = await pc.createOffer({ ...opts });
        if (pc.signalingState !== "stable") { // во время createOffer прилетела удалённая offer
          needRenego.set(remoteId, true);
          continue;
        }
        await pc.setLocalDescription(offer);
      } catch (e) {
        if (pc.signalingState === "have-remote-offer") {
          needRenego.set(remoteId, true); // произошёл glare — подождём пока обработаем REMOTE offer
          continue;
        }
        console.warn("[NEG] renegotiate create/setLocal failed:", e, "state=", pc.signalingState);
        needRenego.set(remoteId, true);
        break;
      }

      // отправляем оффер
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "offer",
            to: remoteId,
            sdp: pc.localDescription.sdp,
            sdpType: pc.localDescription.type,
          }));
        }
      } catch (e) {
        console.warn("[NEG] send offer failed:", e);
        needRenego.set(remoteId, true);
        break;
      }
      // ждём answer — обработчик ответит и подфлашит ICE
    }
  } finally {
    negotiating.set(remoteId, false);
    if (pc.connectionState === "closed") {
      negotiating.delete(remoteId);
      needRenego.delete(remoteId);
      return;
    }
    if (needRenego.get(remoteId) && pc.signalingState === "stable") {
      queueMicrotask(() => renegotiate(remoteId, pc, opts));
    }
  }
}

function requestRenegotiate(remoteId, opts = {}) {
  const pc = pcs.get(remoteId);
  if (!pc || pc.connectionState === "closed") return;
  const idsNow = (getRosterIds?.() || []);
  if (!idsNow.includes(remoteId)) return; // не звоним «призракам»
  needRenego.set(remoteId, true);
  if (!negotiating.get(remoteId)) {
    renegotiate(remoteId, pc, opts);
  }
}


// Помощник: ждём нужный signalingState с таймаутом
function waitForSignalingState(pc, desired = "stable", timeoutMs = 2500) {
  if (!pc || pc.signalingState === desired) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let t;
    const onState = () => {
      if (pc.signalingState === desired) {
        cleanup(); resolve();
      }
    };
    const onClose = () => { cleanup(); reject(new Error("pc-closed")); };
    const cleanup = () => {
      try {
        pc.removeEventListener("signalingstatechange", onState);
        pc.removeEventListener("connectionstatechange", onClose);
        clearTimeout(t);
      } catch {}
    };
    pc.addEventListener("signalingstatechange", onState);
    pc.addEventListener("connectionstatechange", onClose);
    t = setTimeout(() => { cleanup(); reject(new Error("wait-state-timeout")); }, timeoutMs);
  });
}

/* =========================================================================
   Мутация себя
   ========================================================================= */
function toggleSelfMute() {
  selfMuted = !selfMuted;
  
  if (micStream) {
    const audioTracks = micStream.getAudioTracks();
    audioTracks.forEach(track => {
      track.enabled = !selfMuted;
    });
  }

  // Обновляем UI
  if (selfMuteBtn) {
    selfMuteBtn.setAttribute("aria-pressed", selfMuted);
    selfMuteBtn.textContent = selfMuted ? "🔊 Включить микрофон" : "🔇 Вы заглушены";
    selfMuteBtn.classList.toggle("danger", !selfMuted);
    selfMuteBtn.classList.toggle("primary", selfMuted);
  }

  // Обновляем все sender'ы
  updateAllSenders();

  toast(selfMuted ? "Микрофон отключен" : "Микрофон включен");
}

function updateAllSenders() {
  for (const [rid, sender] of senders) {
    if (sender.track) {
      sender.track.enabled = !selfMuted;
    }
  }
}

/* =========================================================================
   Детекция речи
   ========================================================================= */
function setupSpeakingDetection(peerId, audioElement) {
  if (!audioContext) {
    audioContext = new AudioContext();
  }

  const source = audioContext.createMediaStreamSource(audioElement.srcObject);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);

  analysers.set(peerId, analyser);

  // Запускаем интервал для проверки уровня звука
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  
  const intervalId = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
    
    const peerElement = document.getElementById(`peer-${peerId}`);
    if (peerElement) {
      const vuMeter = peerElement.querySelector('.vumeter-bar');
      if (vuMeter) {
        // Обновляем VU-meter
        const width = Math.min(100, average * 2);
        vuMeter.style.width = `${width}%`;
        
        // Определяем, говорит ли пользователь
        const isSpeaking = average > 20; // Пороговое значение
        peerElement.classList.toggle('speaking', isSpeaking);
      }
    }
  }, 100);

  speakingDetectionIntervals.set(peerId, intervalId);
}

function stopSpeakingDetection(peerId) {
  const intervalId = speakingDetectionIntervals.get(peerId);
  if (intervalId) {
    clearInterval(intervalId);
    speakingDetectionIntervals.delete(peerId);
  }
  analysers.delete(peerId);
}

/* =========================================================================
   ICE/PC утилиты
   ========================================================================= */
function queueIce(id, c) {
  if (!pendingIce.has(id)) pendingIce.set(id, []);
  pendingIce.get(id).push(c);
}

async function flushQueuedIce(id) {
  const pc = pcs.get(id);
  if (!pc || !pc.remoteDescription) return;
  const list = pendingIce.get(id) || [];
  for (const c of list) {
    try {
      await pc.addIceCandidate(c);
    } catch (e) {
      console.warn("[ICE] late add failed", e);
    }
  }
  pendingIce.delete(id);
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
  senders.clear();
  if (peersEl) peersEl.innerHTML = "";
  audios.clear();
}

/* =========================================================================
   WebSocket (иниц./реконнект)
   ========================================================================= */
let reconnectTimer = null;

function scheduleReconnect() {
  if (!joined) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    initWS();
    waitWsOpen(6000).catch(() => {});
  }, 800);
}

function initWS() {
  try {
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws.close(4000, "reconnect");
    }
  } catch {}

  const token = currentToken();
  if (!token) {
    setState("Требуется токен", "warn");
    ws = null;
    return;
  }

  const scheme = (location.protocol === "https:") ? "wss://" : "ws://";
  const url = scheme + location.host + "/ws?t=" + encodeURIComponent(token);
  ws = new WebSocket(url, ["token." + token]);

  ws.onopen = () => setState("Соединение установлено", "ok");
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

  // ⬇️ E2E-chat: теперь отправка идёт через шифратор
  setSendChat(async ({ text /*, mentions*/ }) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    await E2E.send(text);
  });
}

async function waitWsOpen(timeoutMs = 6000) {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    initWS();
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("ws-timeout"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("ws-error"));
    };

    function cleanup() {
      try {
        ws && ws.removeEventListener("open", onOpen);
        ws && ws.removeEventListener("error", onError);
        clearTimeout(t);
      } catch {}
    }
    ws?.addEventListener("open", onOpen);
    ws?.addEventListener("error", onError);
  });
}

/* =========================================================================
   WebRTC
   ========================================================================= */
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

  // ── место для отпечатка ключа
  const fp = document.createElement("div");
  fp.className = "peer__fp";
  fp.style.cssText = "font:12px/1.2 ui-monospace,monospace;color:#6b7280;margin-top:4px;";
  fp.textContent = "🔒 ожидаем ключ…";
  root.appendChild(fp);

  peersEl.appendChild(node);
  audios.set(id, audio);
  setAudioOutput(audio);

  // Запускаем детекцию речи для этого пира
  setTimeout(() => {
    if (audio.srcObject) {
      setupSpeakingDetection(id, audio);
    }
  }, 1000);
}

function setPeerFingerprint(peerId, fpHex) {
  const root = document.getElementById("peer-" + peerId);
  if (!root) return;
  let el = root.querySelector(".peer__fp");
  if (!el) {
    el = document.createElement("div");
    el.className = "peer__fp";
    el.style.cssText = "font:12px/1.2 ui-monospace,monospace;color:#6b7280;margin-top:4px;";
    root.appendChild(el);
  }
  el.textContent = "🔒 " + fpHex;
  el.title = "Код безопасности (SHA-256(pub) · первые 8 байт)";
}

function showMyFingerprint(fpHex) {
  const el = document.getElementById("my-fp");
  if (el) {
    el.textContent = "Мой код безопасности: " + fpHex;
  } else {
    console.log("[E2E] my fingerprint:", fpHex);
  }
}

function removePeerUI(id) {
  const el = document.getElementById("peer-" + id);
  if (el) {
    el.classList.add("bye");
    setTimeout(() => el.remove(), 300);
  }
  audios.delete(id);
  stopSpeakingDetection(id);
}

// 3. Функция makePC - улучшенная обработка аудиотреков
function makePC(remoteId) {
  const iceServers = [
    { urls: ["stun:stun.l.google.com:19302"] },
  ];

  const pc = new RTCPeerConnection({ iceServers });
  pcs.set(remoteId, pc);

  // ── локальный поток и аудиосенд
  const localStream = new MediaStream();

  if (micStream && micStream.getAudioTracks().length > 0) {
    const srcTrack = micStream.getAudioTracks()[0];
    if (srcTrack) {
      // ВАЖНО: клон для каждого пира
      const clone = srcTrack.clone();
      trackClones.set(remoteId, clone);
      localStream.addTrack(clone);
      const sender = pc.addTrack(clone, localStream);
      senders.set(remoteId, sender);
      clone.enabled = !selfMuted;
      console.log("[AUDIO] Audio track added for peer:", remoteId);
    } else {
      console.warn("[AUDIO] No audio track available for peer:", remoteId);
      const tr = pc.addTransceiver("audio", { direction: "sendrecv", streams: [localStream] });
      senders.set(remoteId, tr.sender);
    }
  } else {
    console.warn("[AUDIO] No mic stream available for peer:", remoteId);
    const tr = pc.addTransceiver("audio", { direction: "sendrecv", streams: [localStream] });
    senders.set(remoteId, tr.sender);
  }

  // ── входящие дорожки
  pc.ontrack = (ev) => {
    console.debug("[TRACK]", remoteId, ev.track?.kind, ev.streams?.[0]?.id);
    const [stream] = ev.streams;
    addPeerUI(remoteId, null);

    const audio = audios.get(remoteId);
    if (!audio) return;

    audio.srcObject = stream;
    audio.muted = false;
    audio.autoplay = true;
    audio.playsInline = true;
    setAudioOutput(audio);

    // fade-in
    audio.volume = 0;
    const target = 1;
    let v = 0;
    const tick = () => {
      v = Math.min(target, v + 0.05);
      audio.volume = v;
      if (v < target) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    ensurePlayback(audio);
    setupSpeakingDetection(remoteId, audio);
  };

  // ── исходящие ICE
  pc.onicecandidate = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN && e.candidate) {
      if (e.candidate.candidate.includes(".local")) {
        console.log("[ICE] Skipping local candidate:", e.candidate.candidate);
        return;
      }
      ws.send(JSON.stringify({
        type: "ice",
        to: remoteId,
        candidate: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        },
      }));
    }
  };

  // ── диагностика/автовосстановление
  pc.onconnectionstatechange = () => {
    console.debug("[PC]", remoteId, "connection state:", pc.connectionState);
    if (pc.connectionState === "failed") {
      requestRenegotiate(remoteId, { iceRestart: true });
    }
  };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    console.debug("[ICE]", remoteId, "ICE state:", st);
    if (st === "failed" || st === "disconnected") {
      requestRenegotiate(remoteId, { iceRestart: true });
    }
  };
  pc.onsignalingstatechange = () => {
    console.debug("[SIG]", remoteId, "signaling state:", pc.signalingState);
    if (pc.signalingState === "stable" && needRenego.get(remoteId)) {
      needRenego.set(remoteId, false);
      requestRenegotiate(remoteId);
    }
  };

  // ── НЕ инициируем оффер, если пира уже нет в ростере
  pc.onnegotiationneeded = () => {
    if (!joined) return;
    const idsNow = (getRosterIds?.() || []);
    if (!idsNow.includes(remoteId)) return;
    // микротаск, чтобы выйти из текущего sync-контекста
    queueMicrotask(() => requestRenegotiate(remoteId));
  };

  return pc;
}


async function maybeCall(remoteId) {
  if (!joined) return;
  const idsNow = (getRosterIds?.() || []);
  if (!idsNow.includes(remoteId)) {
    console.debug("[CALL] skip, not in roster:", remoteId);
    return;
  }
  const pc = pcs.get(remoteId) || makePC(remoteId);
  requestRenegotiate(remoteId);
}

let callAllTimer = null;

function callAllKnownPeersDebounced(delay = 120) {
  if (callAllTimer) clearTimeout(callAllTimer);
  callAllTimer = setTimeout(() => {
    callAllTimer = null;
    callAllKnownPeers();
  }, delay);
}

async function ensureMicForExistingPeers() {
  if (!micStream) return;
  const src = micStream.getAudioTracks()[0] || null;
  if (!src) return;

  for (const [rid, pc] of pcs) {
    if (!pc || pc.connectionState === "closed") continue;
    const idsNow = (getRosterIds?.() || []);
    if (!idsNow.includes(rid)) continue;

    const sender = senders.get(rid);
    if (!sender) continue;

    const needNew =
      !sender.track ||
      sender.track.readyState === "ended" ||
      !trackClones.get(rid) ||
      trackClones.get(rid).readyState === "ended";

    if (!needNew) continue;

    try {
      const oldClone = trackClones.get(rid) || null;
      const newClone = src.clone();
      newClone.enabled = !selfMuted;

      await sender.replaceTrack(newClone);
      trackClones.set(rid, newClone);

      if (oldClone && oldClone !== newClone) {
        try { oldClone.stop(); } catch {}
      }

      requestRenegotiate(rid);
      console.debug("[AUDIO] ensureMic: clone reattached for", rid);
    } catch (e) {
      console.warn("[AUDIO] ensureMic failed for", rid, e);
    }
  }
}


// 5. Улучшенная функция callAllKnownPeers
function callAllKnownPeers() {
  const ids = getRosterIds();
  console.log("[CALL] Calling all known peers:", ids);
  for (const peerId of ids) {
    if (!peerId || peerId === myId) continue;
    if (!pcs.has(peerId)) {
      console.log("[CALL] Initiating call to:", peerId);
      maybeCall(peerId);
    } else {
      const pc = pcs.get(peerId);
      if (pc.connectionState !== 'connected') {
        console.log("[CALL] Reconnecting to:", peerId);
        requestRenegotiate(peerId, { iceRestart: true });
      }
    }
  }
}

function logPeerConnections() {
  console.log("=== PEER CONNECTIONS STATUS ===");
  console.log("My ID:", myId);
  console.log("Joined:", joined);
  console.log("Total PCs:", pcs.size);
  
  for (const [id, pc] of pcs) {
    console.log(`Peer ${id}:`);
    console.log(`  - Connection state: ${pc.connectionState}`);
    console.log(`  - ICE state: ${pc.iceConnectionState}`);
    console.log(`  - Signaling state: ${pc.signalingState}`);
    console.log(`  - Senders: ${pc.getSenders().length}`);
    console.log(`  - Receivers: ${pc.getReceivers().length}`);
  }
  console.log("===============================");
}


/* =========================================================================
   Обработка сигналинга
   ========================================================================= */
async function onWSMessage(ev) {
  let m;
  try {
    m = JSON.parse(ev.data);
  } catch {
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // HELLO: мой id, ростер, плейсхолдеры и старт E2E
  if (m.type === "hello") {
    updateRoster(m.roster || []);
    myId = m.id;
    setMyId(myId);

    for (const pid of getRosterIds()) {
      if (pid !== myId && !document.getElementById("peer-" + pid)) {
        addPeerUI(pid, null);
      }
    }

    // подключаем E2E к текущей WS-сессии
    await E2E.attach({
      ws,
      myId,
      getRosterIds: () => getRosterIds(),
      appendChat: (payload) => appendChat(payload), // {from,text,ts}
      onPeerFingerprint: (peerId, fpHex) => setPeerFingerprint(peerId, fpHex),
      onMyFingerprint: (fpHex) => showMyFingerprint(fpHex),
    });

    setState("В комнате", "ok");
    if (joined) callAllKnownPeers();
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Полный ростер
  if (m.type === "roster") {
    updateRoster(m.roster || []);
    for (const pid of getRosterIds()) {
      if (pid !== myId && !document.getElementById("peer-" + pid)) {
        addPeerUI(pid, null);
      }
    }
    // сообщим E2E: могли появиться новые участники — разослать pub
    E2E.onRosterUpdate();
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Совместимость (старый незашифрованный чат). Новые клиенты его НЕ шлют.
  if (m.type === "chat") {
    appendChat(m);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // E2E-обмен ключами и шифрованный чат
  if (m.type === "key") {
    await E2E.onKey(m);
    return;
  }
  if (m.type === "chat-e2e") {
    await E2E.onCipher(m);
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Peer присоединился — дорисуем карточку и инициируем звонок при необходимости
  if (m.type === "peer-joined") {
    if (m.id !== myId) {
      if (!document.getElementById("peer-" + m.id)) addPeerUI(m.id, null);
      if (joined) maybeCall(m.id);
      // при появлении нового пира повторим E2E-анонс
      E2E.onRosterUpdate();
      toast("Кто-то подключился");
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Perfect Negotiation — входящий OFFER
  if (m.type === "offer") {
    const from = m.from;
    const pc = pcs.get(from) || makePC(from);
    if (!document.getElementById("peer-" + from)) addPeerUI(from, null);

    const polite = (typeof myId === "string" && myId) ? (myId > from) : true;

    try {
      if (pc.signalingState === "have-local-offer") {
        if (!polite) {
          console.warn("[SIG] glare: impolite ignores incoming offer");
          return;
        }
        await pc.setLocalDescription({ type: "rollback" });
      }

      await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });

      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: "answer",
          to: from,
          sdp: pc.localDescription.sdp,
          sdpType: pc.localDescription.type,
        }));
      }

      await flushQueuedIce(from);
    } catch (e) {
      console.warn("[SIG] offer handling failed:", e, "state=", pc.signalingState);
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Входящий ANSWER
  if (m.type === "answer") {
    const pc = pcs.get(m.from);
    if (!pc) return;

    if (pc.signalingState !== "have-local-offer") {
      console.warn("[SIG] late/dup answer ignored, state=", pc.signalingState);
      return;
    }
    try {
      await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
      await flushQueuedIce(m.from);
    } catch (e) {
      console.warn("[SIG] setRemoteDescription(answer) failed:", e, "state=", pc.signalingState);
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Входящий ICE-кандидат
  if (m.type === "ice") {
    const c = m.candidate;
    const from = m.from;

    const pc = pcs.get(from);
    if (!pc) {
      if (c) queueIce(from, c);
      return;
    }

    if (c === null) {
      try { await pc.addIceCandidate(null); } catch {}
      return;
    }
    if (!c.candidate || c.candidate.includes(".local")) return;

    if (!pc.remoteDescription) {
      queueIce(from, c);
      return;
    }
    try {
      await pc.addIceCandidate(c);
    } catch (e) {
      console.warn("[ICE] add failed", e);
    }
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Peer вышел — подчистка
  if (m.type === "peer-left") {
    const id = m.id;
    removePeerUI(id);
    try {
      // 1) Остановить клон трека
      const clone = trackClones.get(id);
      if (clone) {
        try { clone.stop(); } catch {}
        trackClones.delete(id);
      }

      // 2) Закрыть PC
      const pc = pcs.get(id);
      if (pc) {
        try { pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
        try { pc.close(); } catch {}
        pcs.delete(id);
      }

      // 3) Снять все внутренние флаги/очереди/датчики
      pendingIce.delete(id);
      senders.delete(id);
      negotiating.delete(id);
      needRenego.delete(id);
      if (speakingDetectionIntervals.has(id)) stopSpeakingDetection(id);
      analysers.delete(id);
    } catch {}

    // Актуализировать дозвон (если кто-то ещё появился/вернулся)
    queueMicrotask(() => callAllKnownPeersDebounced());

    toast("Кто-то вышел", "warn");
    return;
  }

  // ─────────────────────────────────────────────────────────────────
  // Комната заполнена / браузер не поддерживается
  if (m.type === "full") {
    const cap = typeof m.capacity === "number" ? m.capacity : undefined;
    const title = "Комната заполнена";
    const text = cap ? `Достигнут лимит участников: ${cap}. Попробуйте позже.` : "Комната заполнена. Попробуйте позже.";
    showModal(title, text);
    try { ws?.close(4001, "room full"); } catch {}
    setState("Комната заполнена", "warn");
    return;
  }

  if (m.type === "browser-only") {
    showModal("Требуется браузер", "Подключение возможно только из браузера. Откройте ссылку в Chrome/Firefox/Safari/Edge.");
    try { ws?.close(4002, "browser only"); } catch {}
    setState("Только браузер", "error");
    return;
  }
}

/* =========================================================================
   E2E модуль для чата: ECDH(P-256) → AES-GCM(256) + Fingerprint (SHA-256(pub))
   ========================================================================= */
const E2E = (() => {
  let wsRef = null;
  let myIdRef = null;
  let getIds = () => [];
  let appendFn = ({ from, text, ts }) => console.log(from, text, ts);
  let onPeerFp = null;
  let onMyFp = null;

  let myPriv = null;        // CryptoKey (ECDH private)
  let myPubRaw = null;      // ArrayBuffer (65 bytes, uncompressed P-256)
  let myFpHex = null;       // "aa:bb:..."
  const peerFp = new Map(); // id -> "aa:bb:..."
  const aesForPeer = new Map(); // peerId -> CryptoKey (AES-GCM)

  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64 = (buf) => {
    const b = Array.from(new Uint8Array(buf)).map((x) => String.fromCharCode(x)).join("");
    return btoa(b);
  };
  const b64u = (s) => s.replace(/-/g, "+").replace(/_/g, "/");
  const unb64 = (str) => {
    const s = atob(b64u(str));
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
    return buf.buffer;
  };

  function hex(bytes) {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(":");
  }

  async function fpFromRaw(rawBuf) {
    const h = await crypto.subtle.digest("SHA-256", rawBuf);
    return hex(new Uint8Array(h).slice(0, 8)); // первые 8 байт
  }

  async function ensureECDH() {
    if (myPriv) return;
    const kp = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveKey", "deriveBits"]
    );
    myPriv = kp.privateKey;
    myPubRaw = await crypto.subtle.exportKey("raw", kp.publicKey);
    myFpHex = await fpFromRaw(myPubRaw);
  }

  async function deriveAES(peerPubRawBuf) {
    const peerPub = await crypto.subtle.importKey("raw", peerPubRawBuf, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return await crypto.subtle.deriveKey(
      { name: "ECDH", public: peerPub },
      myPriv,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  function wsSend(obj) {
    if (wsRef && wsRef.readyState === WebSocket.OPEN) {
      wsRef.send(JSON.stringify(obj));
    }
  }

  async function attach({ ws, myId, getRosterIds, appendChat, onPeerFingerprint, onMyFingerprint }) {
    wsRef = ws;
    myIdRef = myId;
    getIds = getRosterIds || getIds;
    appendFn = appendChat || appendFn;
    onPeerFp = onPeerFingerprint || null;
    onMyFp = onMyFingerprint || null;

    await ensureECDH();

    // показать свой fp
    if (typeof onMyFp === "function") onMyFp(myFpHex);

    // разослать свой паблик всем
    announceToAll();
  }

  function onRosterUpdate() {
    announceToAll();
  }

  function announceToAll() {
    const ids = (getIds() || []).filter((id) => id && id !== myIdRef);
    for (const pid of ids) {
      wsSend({ type: "key", to: pid, pub: b64(myPubRaw) });
    }
  }

  async function onKey(msg) {
    if (!myPriv) await ensureECDH();
    const from = msg.from;
    if (!from || from === myIdRef) return;
    try {
      const raw = unb64(msg.pub);
      const key = await deriveAES(raw);
      aesForPeer.set(from, key);

      // вычислим и сообщим UI отпечаток пира
      const fp = await fpFromRaw(raw);
      peerFp.set(from, fp);
      if (typeof onPeerFp === "function") onPeerFp(from, fp);

      // симметрично ответим своим pub, если вдруг не дошёл
      wsSend({ type: "key", to: from, pub: b64(myPubRaw) });
    } catch (e) {
      console.warn("[E2E] derive failed from", from, e);
    }
  }

  async function send(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    const ids = (getIds() || []).filter((id) => id && id !== myIdRef);
    const now = Date.now();

    for (const pid of ids) {
      try {
        const key = aesForPeer.get(pid);
        if (!key) {
          // нет ключа — дёрнем анонс и пропустим этого пира
          wsSend({ type: "key", to: pid, pub: b64(myPubRaw) });
          continue;
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ctBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(msg));
        wsSend({ type: "chat-e2e", to: pid, iv: b64(iv), ct: b64(ctBuf), ts: now });
      } catch (e) {
        console.warn("[E2E] encrypt/send failed for", pid, e);
      }
    }
    // локально рисуем сразу
    appendFn({ from: myIdRef, text: msg, ts: now });
  }

  async function onCipher(msg) {
    const { from, to, iv, ct, ts } = msg;
    if (!to || to !== myIdRef) return;
    const key = aesForPeer.get(from);
    if (!key) {
      // попросим ключ
      announceToAll();
      return;
    }
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(unb64(iv)) }, key, unb64(ct));
      const text = dec.decode(pt);
      appendFn({ from, text, ts: ts || Date.now() });
    } catch (e) {
      console.warn("[E2E] decrypt failed from", from, e);
    }
  }

  // опциональные геттеры — если понадобится где-то ещё
  function getMyFingerprint() { return myFpHex; }
  function getPeerFingerprint(id) { return peerFp.get(id) || null; }

  return { attach, onRosterUpdate, onKey, onCipher, send, getMyFingerprint, getPeerFingerprint };
})();

/* =========================================================================
   Кнопка «Войти/Выйти» и старт/выход
   ========================================================================= */
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

// автозапуск аудио с ретраем на жест пользователя
async function ensurePlayback(audio) {
  try {
    await audio.play();
  } catch (e) {
    console.warn("[AUDIO] play() blocked, waiting for user gesture", e);
    toast("Нажмите любую кнопку интерфейса, чтобы включить звук", "warn");
    const once = () => {
      audio.play().catch(() => {});
      document.removeEventListener("click", once, true);
    };
    document.addEventListener("click", once, true);
  }
}


// 4. Улучшенная функция startCall с проверкой микрофона
async function startCall() {
  if (!currentToken()) {
    toast("Не задан токен комнаты", "warn");
    setState("Требуется токен", "warn");
    return;
  }

  try {
    setState("Запрашиваем микрофон…", "idle");
    if (!micStream) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: true,
          noiseSuppression: true
        }
      });

      const audioTracks = micStream.getAudioTracks();
      if (audioTracks.length === 0) {
        toast("Микрофон не доступен", "error");
        setState("Нет доступа к микрофону", "error");
        switchJoinButton("join");
        return;
      }

      console.log("[AUDIO] Microphone acquired, tracks:", audioTracks.length);
    }
    await refreshAudioOutputs();
  } catch (err) {
    console.error("Microphone access error:", err);
    toast("Доступ к микрофону запрещён", "error");
    setState("Нет доступа к микрофону", "error");
    switchJoinButton("join");
    return;
  }

  if (selfMuteRow) selfMuteRow.style.display = "flex";

  // Раздать клоны всем существующим PC (если они были созданы до GUM)
  await ensureMicForExistingPeers();

  // Гарантируем открытый WS
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

  // Имя
  ws?.send(JSON.stringify({
    type: "name",
    name: (nameEl?.value || "User").slice(0, 32),
  }));

  joined = true;

  // Дозвон всем известным пирам (с дебаунсом)
  callAllKnownPeersDebounced();

  toast("Микрофон включен");
  setState("Вы в эфире", "ok");
  switchJoinButton("leave");
  updateAudioStatus();
}

async function leaveCall() {
  try {
    joined = false;

    if (selfMuteRow) {
      selfMuteRow.style.display = 'none';
    }

    // Останавливаем все детекторы речи
    for (const id of speakingDetectionIntervals.keys()) {
      stopSpeakingDetection(id);
    }

    // 1) Отключаем исходящую дорожку у всех sender'ов
    if (senders && senders.size) {
      for (const [rid, sender] of senders) {
        try { await sender.replaceTrack(null); } catch {}
      }
    }

    // 2) Останавливаем все клоны микрофона
    for (const [, clone] of trackClones) {
      try { clone.stop(); } catch {}
    }
    trackClones.clear();

    // 3) Гасим локальный микрофон
    if (micStream) {
      try { for (const t of micStream.getTracks()) { try { t.stop(); } catch {} } }
      finally { micStream = null; }
    }

    // 4) Чистим UI и аудио-элементы
    try {
      audios.forEach((audio) => {
        try {
          if (audio) { audio.srcObject = null; audio.load?.(); }
        } catch {}
      });
    } catch {}
    audios.clear();

    // 5) Закрываем все RTCPeerConnection и чистим очереди ICE/флаги
    for (const [id, pc] of pcs) {
      try { pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
      try { pc.close(); } catch {}
    }
    pcs.clear();
    pendingIce.clear();
    senders.clear();
    negotiating.clear();
    needRenego.clear();

    // 6) Отменяем отложенный реконнект WS
    if (reconnectTimer) {
      try { clearTimeout(reconnectTimer); } catch {}
      reconnectTimer = null;
    }

    // 7) Закрываем WS
    if (ws) {
      try { ws.close(4005, "user left"); } catch {}
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws = null;
    }

    // 8) Чистим карточки пиров
    if (peersEl) peersEl.innerHTML = "";

    setState("Вы вышли из разговора", "warn");
    toast("Вы вышли из разговора", "warn");
  } finally {
    switchJoinButton("join");
  }
}



function updateAudioStatus() {
    const statusEl = document.getElementById('audio-status');
    if (!statusEl) return;
    
    let status = 'Микрофон: ';
    if (!micStream) {
        status += 'не доступен';
        statusEl.style.color = 'red';
    } else {
        const tracks = micStream.getAudioTracks();
        if (tracks.length > 0 && tracks[0].readyState === 'live') {
            status += selfMuted ? 'выключен' : 'включен';
            statusEl.style.color = selfMuted ? 'orange' : 'green';
            
            // Показываем уровень громкости
            if (!selfMuted) {
                const audioContext = new AudioContext();
                const analyser = audioContext.createAnalyser();
                const source = audioContext.createMediaStreamSource(micStream);
                source.connect(analyser);
                
                const dataArray = new Uint8Array(analyser.frequencyBinCount);
                analyser.getByteFrequencyData(dataArray);
                const average = dataArray.reduce((a, b) => a + b) / dataArray.length;
                
                status += ` (уровень: ${Math.round(average)}%)`;
            }
        } else {
            status += 'ошибка';
            statusEl.style.color = 'red';
        }
    }
    
    // Статус подключений
    status += ' | Подключения: ';
    let activeConnections = 0;
    pcs.forEach((pc, id) => {
        if (pc.connectionState === 'connected') {
            activeConnections++;
        }
    });
    status += `${activeConnections}/${pcs.size}`;
    
    statusEl.textContent = status;
}

// Добавьте этот элемент в ваш HTML или создайте динамически
function createAudioStatusElement() {
    const statusEl = document.createElement('div');
    statusEl.id = 'audio-status';
    statusEl.style.cssText = 'position: fixed; bottom: 10px; left: 10px; background: rgba(0,0,0,0.7); color: white; padding: 5px 10px; border-radius: 5px; font-size: 12px; z-index: 1000;';
    document.body.appendChild(statusEl);
    return statusEl;
}

// Вызывайте при запуске
document.addEventListener('DOMContentLoaded', () => {
    createAudioStatusElement();
    setInterval(updateAudioStatus, 2000); // Обновлять каждые 2 секунды
});

/* =========================================================================
   Инициализация
   ========================================================================= */
document.addEventListener("DOMContentLoaded", () => {
  // начальное состояние
  switchJoinButton("join");

  // токен из localStorage -> поле и «пилюля»
  const savedToken = localStorage.getItem("ROOM_TOKEN") || "";
  if (tokenEl) tokenEl.value = savedToken;
  if (tokenHint) tokenHint.textContent = "Токен: " + maskToken(savedToken);

  // настройки сети (STUN) — toggle поповера
  settingsBtn?.addEventListener("click", () => {
    const pop = $("#net-popover");
    if (!pop) return;
    const willOpen = pop.classList.contains("hidden");
    if (willOpen) showNet();
    else hideNet();
    settingsBtn.classList.toggle("is-on", willOpen);
    settingsBtn.setAttribute("aria-pressed", willOpen ? "true" : "false");
  });

  // кнопка мута себя
  selfMuteBtn?.addEventListener("click", toggleSelfMute);

  // автоподключение WS (без старта звонка)
  initWS();

  // обработчик кнопки Войти/Выйти
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

// safety logs
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection (rtc):", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("Unhandled error (rtc):", e.error || e.message);
});
