// /js/rtc.js
"use strict";

import { $, $$, toast, showModal, showNet, hideNet } from "./ui.js";
import { updateRoster, appendChat, setMyId, setSendChat, getRosterIds } from "./chat.js";



let _lastTs = 0;
function nextTs() {
  const t = Date.now();
  _lastTs = t <= _lastTs ? _lastTs + 1 : t; // строго возрастающий
  return _lastTs;
}

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
const pcs = new Map();           // id -> RTCPeerConnection
const audios = new Map();        // id -> <audio>
const pendingIce = new Map();    // id -> Array<candidate>
const senders = new Map();       // id -> RTCRtpSender
const negotiating = new Map();   // id -> boolean
const needRenego = new Map();    // id -> boolean
const analysers = new Map();     // id -> AnalyserNode
const speakingDetectionIntervals = new Map(); // id -> interval
const trackClones = new Map();   // id -> MediaStreamTrack (clone per peer)

let myId = null;
let joined = false;
let micStream = null;
let ws = null;
let selfMuted = false;
let userMuted = false;
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
  // безопаснее: сначала sessionStorage, потом localStorage
  return sessionStorage.getItem("ROOM_TOKEN") || localStorage.getItem("ROOM_TOKEN") || "";
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

/* =========================================================================
   Ренегоциация / perfect negotiation helpers
   ========================================================================= */
async function renegotiate(remoteId, pc, opts = {}) {
  if (!pc || pc.connectionState === "closed") return;

  needRenego.set(remoteId, true);
  if (negotiating.get(remoteId)) return;

  negotiating.set(remoteId, true);
  try {
    while (needRenego.get(remoteId)) {
      needRenego.set(remoteId, false);

      try {
        if (pc.signalingState !== "stable") {
          await waitForSignalingState(pc, "stable", 2500);
          if (pc.signalingState !== "stable") {
            needRenego.set(remoteId, true);
            break;
          }
        }
      } catch {
        break;
      }

      if (pc.connectionState === "closed") break;

      let offer;
      try {
        offer = await pc.createOffer({ ...opts });
        if (pc.signalingState !== "stable") {
          needRenego.set(remoteId, true);
          continue;
        }
        await pc.setLocalDescription(offer);
      } catch (e) {
        if (pc.signalingState === "have-remote-offer") {
          needRenego.set(remoteId, true);
          continue;
        }
        console.warn("[NEG] renegotiate create/setLocal failed:", e, "state=", pc.signalingState);
        needRenego.set(remoteId, true);
        break;
      }

      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: "offer",
            to: remoteId,
            sdp: pc.localDescription.sdp,
            sdpType: pc.localDescription.type,
            ts: nextTs(),
          }));
        }
      } catch (e) {
        console.warn("[NEG] send offer failed:", e);
        needRenego.set(remoteId, true);
        break;
      }
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
  if (!idsNow.includes(remoteId)) return;
  needRenego.set(remoteId, true);
  if (!negotiating.get(remoteId)) {
    renegotiate(remoteId, pc, opts);
  }
}

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
  function setSelfMuted(nextMuted, reason = "", source = "user") {
    if (selfMuted === nextMuted && source !== "safety") return;

    if (source === "user") {
      userMuted = nextMuted; // запоминаем волю пользователя
    }
    selfMuted = nextMuted;

    if (micStream) {
      const audioTracks = micStream.getAudioTracks();
      audioTracks.forEach(track => { track.enabled = !selfMuted; });
    }

    if (selfMuteBtn) {
      selfMuteBtn.setAttribute("aria-pressed", selfMuted);
      selfMuteBtn.textContent = selfMuted
        ? "🔊 Включить микрофон"
        : "🔇 Вас Слышно, нажмите чтобы заглушить";
      selfMuteBtn.classList.toggle("danger", !selfMuted);
      selfMuteBtn.classList.toggle("primary", selfMuted);
    }

    updateAllSenders();
    toast(selfMuted ? (reason || "Микрофон отключен") : "Микрофон включен");
  }



  function toggleSelfMute() {
    setSelfMuted(!selfMuted, "", "user"); // ← помечаем как ручное действие
  }

  function updateAllSenders() {
    for (const [, sender] of senders) {
      if (sender.track) sender.track.enabled = !selfMuted;
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

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  const intervalId = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length;

    const peerElement = document.getElementById(`peer-${peerId}`);
    if (peerElement) {
      const vuMeter = peerElement.querySelector('.vumeter-bar');
      if (vuMeter) {
        const width = Math.min(100, average * 2);
        vuMeter.style.width = `${width}%`;
        const isSpeaking = average > 20;
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
    try { pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
    try { pc.close(); } catch {}
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

  // Определяем PROD-режим (через window.PROD или <meta name="env" content="prod">)
  const PROD = (window.PROD === true) || (document.querySelector('meta[name="env"]')?.content === "prod");

  // В проде запрещаем незащищённые схемы (стр. должна быть по HTTPS → WS только WSS)
  if (PROD) {
    if (location.protocol !== "https:") {
      setState("Требуется HTTPS (prod)", "error");
      toast("В продакшене страница должна открываться по HTTPS", "error");
      ws = null;
      return;
    }
  }

  const scheme = (location.protocol === "https:") ? "wss://" : "ws://";
  const url = scheme + location.host + "/ws"; // без ?t= — токен только как subprotocol
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

  // шифрованная отправка чата
  setSendChat(async ({ text }) => {
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
    const onOpen = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("ws-error")); };

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

  const fp = document.createElement("div");
  fp.className = "peer__fp";
  fp.style.cssText = "font:12px/1.2 ui-monospace,monospace;color:#6b7280;margin-top:4px;";
  fp.textContent = "🔒 ожидаем ключ…";
  root.appendChild(fp);

  peersEl.appendChild(node);
  audios.set(id, audio);
  setAudioOutput(audio);

  setTimeout(() => {
    if (audio.srcObject) {
      setupSpeakingDetection(id, audio);
    }
  }, 1000);
}

// Проксируем в Safety-модуль, чтобы не дублировать UI-логику
function setPeerFingerprint(peerId, fpHex) { Safety.setPeerFingerprint(peerId, fpHex); }
function showMyFingerprint(fpHex) { Safety.setMyFingerprint(fpHex); }

function removePeerUI(id) {
  const el = document.getElementById("peer-" + id);
  if (el) {
    el.classList.add("bye");
    setTimeout(() => el.remove(), 300);
  }
  audios.delete(id);
  stopSpeakingDetection(id);
}

/* ---- RTCPeerConnection c relay-only TURN (fallback на STUN для отладки) ---- */
function makePC(remoteId) {
  const turnUrl  = document.querySelector('meta[name="turns-url"]')?.content || window.TURNS_URL || "";
  const turnUser = document.querySelector('meta[name="turns-user"]')?.content || window.TURNS_USER || "";
  const turnPass = document.querySelector('meta[name="turns-pass"]')?.content || window.TURNS_PASS || "";

  let pc;

  // В проде требуем TURN
  const PROD = (window.PROD === true) || (document.querySelector('meta[name="env"]')?.content === "prod");
  if (PROD && !turnUrl) {
    toast("TURN не настроен — соединение запрещено в продакшене", "error");
    throw new Error("TURN required in PROD");
  }

  if (turnUrl) {
    const iceServers = [{ urls: [turnUrl], username: turnUser, credential: turnPass }];
    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: "relay",
      bundlePolicy: "max-bundle",
    });
  } else {
    console.warn("[RTC] TURN не задан — используем STUN для тестов (IP будут видны).");
    toast("Dev-режим: STUN. Ваш IP виден участникам.", "warn");
    const iceServers = [{ urls: ["stun:stun.l.google.com:19302"] }];
    pc = new RTCPeerConnection({
      iceServers,
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
    });
  }

  pcs.set(remoteId, pc);

  // Локальная отправка: клонируем микрофон под каждого пира (или держим transceiver)
  const localStream = new MediaStream();
  if (micStream && micStream.getAudioTracks().length > 0) {
    const srcTrack = micStream.getAudioTracks()[0];
    if (srcTrack) {
      const clone = srcTrack.clone();
      trackClones.set(remoteId, clone);
      localStream.addTrack(clone);
      const sender = pc.addTrack(clone, localStream);
      senders.set(remoteId, sender);
      clone.enabled = !selfMuted;
    } else {
      const tr = pc.addTransceiver("audio", { direction: "sendrecv" });
      senders.set(remoteId, tr.sender);
    }
  } else {
    const tr = pc.addTransceiver("audio", { direction: "sendrecv" });
    senders.set(remoteId, tr.sender);
  }

  // --- ВХОДЯЩЕЕ АУДИО (надёжный ontrack) ---
  pc.ontrack = (ev) => {
    // Убедимся, что у нас есть поток
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    
    addPeerUI(remoteId, null);
    const audio = audios.get(remoteId);
    if (!audio) return;

    // Установим поток и убедимся, что аудио воспроизводится
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    audio.muted = false;
    
    // Принудительно запустим воспроизведение
    const playPromise = audio.play();
    if (playPromise !== undefined) {
      playPromise.catch(error => {
        console.warn("Автовоспроизведение заблокировано:", error);
        // Добавим обработчик клика для разблокировки аудио
        document.addEventListener('click', () => audio.play(), { once: true });
      });
    }

    setupSpeakingDetection(remoteId, audio);
  };


  // Исходящие ICE — отправляем кандидаты и ОБЯЗАТЕЛЬНО завершающий null
  pc.onicecandidate = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (e.candidate && e.candidate.candidate?.includes(".local")) {
      console.log("[ICE] Skipping local candidate:", e.candidate.candidate);
      return;
    }

    if (e.candidate) {
      ws.send(JSON.stringify({
        type: "ice",
        to: remoteId,
        candidate: {
          candidate: e.candidate.candidate,
          sdpMid: e.candidate.sdpMid,
          sdpMLineIndex: e.candidate.sdpMLineIndex,
        },
        ts: nextTs(),
      }));
    } else {
      // end-of-candidates → помогает третьим участникам/сложным NAT
      ws.send(JSON.stringify({
        type: "ice",
        to: remoteId,
        candidate: null,
        ts: nextTs(),
      }));
    }
  };

  pc.onicecandidateerror = (e) => {
    console.warn("[ICE] candidate error:", e.errorCode, e.errorText);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") {
      requestRenegotiate(remoteId, { iceRestart: true });
    }
  };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === "failed" || st === "disconnected") {
      requestRenegotiate(remoteId, { iceRestart: true });
    }
  };
  pc.onsignalingstatechange = () => {
    if (pc.signalingState === "stable" && needRenego.get(remoteId)) {
      needRenego.set(remoteId, false);
      requestRenegotiate(remoteId);
    }
  };
  pc.onnegotiationneeded = () => {
    if (!joined) return;
    const idsNow = (getRosterIds?.() || []);
    if (!idsNow.includes(remoteId)) return;
    queueMicrotask(() => requestRenegotiate(remoteId));
  };

  return pc;
}


function forceReconnect() {
  if (!joined) return;
  
  // Закроем все существующие соединения
  closeAllPeers();
  
  // Переподключимся к WebSocket
  if (ws) {
    ws.close();
    initWS();
  }
  
  // Вызовем повторное соединение после небольшой задержки
  setTimeout(() => {
    if (joined) {
      callAllKnownPeers();
    }
  }, 1000);
}


async function maybeCall(remoteId) {
  if (!joined) return;
  const idsNow = (getRosterIds?.() || []);
  if (!idsNow.includes(remoteId)) return;
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

function callAllKnownPeers() {
  const ids = getRosterIds();
  for (const peerId of ids) {
    if (!peerId || peerId === myId) continue;
    
    const pc = pcs.get(peerId);
    if (!pc) {
      // Создаем новое соединение
      maybeCall(peerId);
    } else if (pc.connectionState !== 'connected' && 
               pc.connectionState !== 'connecting') {
      // Принудительно пересоздаем соединение для неработающих пиров
      pcs.delete(peerId);
      setTimeout(() => maybeCall(peerId), 100);
    }
  }
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

  // hello: мой id, старт E2E, первичная отрисовка
  if (m.type === "hello") {
    updateRoster(m.roster || []);
    myId = m.id;
    setMyId(myId);

    // новая сессия
    Safety.resetAllForNewSession?.();

    for (const pid of getRosterIds()) {
      if (pid !== myId && !document.getElementById("peer-" + pid)) {
        addPeerUI(pid, null);
      }
    }

    await E2E.attach({
      ws,
      myId,
      getRosterIds: () => getRosterIds(),
      appendChat: (payload) => appendChat(payload),
      onPeerFingerprint: (peerId, fpHex) => setPeerFingerprint(peerId, fpHex),
      onMyFingerprint: (fpHex) => showMyFingerprint(fpHex),
    });

    setState("В комнате", "ok");
    if (joined) callAllKnownPeers();
    return;
  }

  if (m.type === "roster") {
    updateRoster(m.roster || []);
    for (const pid of getRosterIds()) {
      if (pid !== myId && !document.getElementById("peer-" + pid)) {
        addPeerUI(pid, null);
      }
    }
    callAllKnownPeersDebounced(150);
    Safety.onRosterChanged?.();
    E2E.onRosterUpdate?.();
    Safety.enforceMuteIfUnverified?.();
    return;
  }

  if (m.type === "chat") {
    appendChat(m);
    return;
  }

  if (m.type === "key") {
    await E2E.onKey(m);
    return;
  }
  if (m.type === "chat-e2e") {
    await E2E.onCipher(m);
    return;
  }

  // подтверждения безопасности больше не используются — игнорируем
  if (m.type === "safety-ok") {
    return;
  }

    if (m.type === "reconnect") {
      forceReconnect();
      return;
    }

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
          ts: nextTs(),
        }));
      }

      await flushQueuedIce(from);
    } catch (e) {
      console.warn("[SIG] offer handling failed:", e, "state=", pc.signalingState);
    }
    return;
  }

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

  if (m.type === "peer-left") {
    const id = m.id;
    removePeerUI(id);
    try {
      const clone = trackClones.get(id);
      if (clone) { try { clone.stop(); } catch {} trackClones.delete(id); }

      const pc = pcs.get(id);
      if (pc) {
        try { pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
        try { pc.close(); } catch {}
        pcs.delete(id);
      }

      pendingIce.delete(id);
      senders.delete(id);
      negotiating.delete(id);
      needRenego.delete(id);
      if (speakingDetectionIntervals.has(id)) stopSpeakingDetection(id);
      analysers.delete(id);
    } catch {}

    queueMicrotask(() => callAllKnownPeersDebounced());
    toast("Кто-то вышел", "warn");
    Safety.onRosterChanged?.();
    Safety.enforceMuteIfUnverified?.();
    return;
  }

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
   setTimeout(() => {
    if (joined) {
      callAllKnownPeers();
      
      // Дополнительная проверка через 3 секунды
      setTimeout(() => {
        let hasProblems = false;
        for (const [id, pc] of pcs) {
          if (pc.connectionState !== 'connected') {
            hasProblems = true;
            break;
          }
        }
        
        if (hasProblems) {
          forceReconnect();
        }
      }, 3000);
    }
  }, 500);
  
  return;
}




/* =========================================================================
   Safety Codes (минимальный UX)
   ========================================================================= */
/* =========================================================================
   Safety Codes (подтверждения безопасности) с криптоподписью
   ========================================================================= */
/* =========================================================================
   Safety (упрощённый): только отображение fingerprint'ов.
   Никаких подтверждений, блокировок и автозаглушений.
   ========================================================================= */
const Safety = (() => {
  const peers = new Map(); // id -> { fpHex }
  let myFp = null;

  function setMyFingerprint(fpHex) {
    myFp = fpHex;
    const el = document.getElementById("my-fp");
    if (el) el.textContent = "Мой код безопасности: " + (fpHex || "(ожидается)");
  }

  function ensurePeerUIBits(id) {
    const root = document.getElementById("peer-" + id);
    if (!root) return null;

    let fpEl = root.querySelector(".peer__fp");
    if (!fpEl) {
      fpEl = document.createElement("div");
      fpEl.className = "peer__fp";
      fpEl.style.cssText =
        "font:12px/1.2 ui-monospace,monospace;color:#6b7280;margin-top:4px;";
      root.appendChild(fpEl);
    }

    // если в разметке остались кнопки подтверждения — убираем
    root.querySelector(".peer__confirm")?.remove();
    root.querySelector(".peer__who-confirmed")?.remove();

    return { root, fpEl };
  }

  function setPeerFingerprint(id, fpHex) {
    const s = peers.get(id) || {};
    s.fpHex = fpHex;
    peers.set(id, s);

    const bits = ensurePeerUIBits(id);
    if (bits && bits.fpEl) {
      bits.fpEl.textContent = "🔒 " + (fpHex || "(ожидается)");
      bits.fpEl.title = "Код безопасности (первые 8 байт SHA-256(pub))";
    }
  }

  // Заглушки для совместимости со старым кодом:
  function onRosterChanged() {}
  function enforceMuteIfUnverified() {}
  function updateConfirmButton() {}
  function isEveryoneConfirmed() { return true; }
  function resetPeer() {}
  function resetAllForNewSession() {}
  async function onMacReady() {}

  return {
    setMyFingerprint,
    setPeerFingerprint,
    onRosterChanged,
    enforceMuteIfUnverified,
    updateConfirmButton,
    isEveryoneConfirmed,
    resetPeer,
    resetAllForNewSession,
    onMacReady,
  };
})();


/* =========================================================================
   E2E модуль (ECDH P-256 → AES-GCM) + Fingerprint (SHA-256(pub))
   ========================================================================= */
const E2E = (() => {
  let wsRef = null;
  let myIdRef = null;
  let getIds = () => [];
  let appendFn = ({ from, text, ts }) => console.log(from, text, ts);
  let onPeerFp = null;
  let onMyFp = null;

  let myPriv = null;        // CryptoKey (ECDH private)
  let myPubRaw = null;      // ArrayBuffer (raw P-256 public)
  let myFpHex = null;       // "aa:bb:..."

  const peerFp = new Map();     // id -> fp
  const aesForPeer = new Map(); // id -> CryptoKey (AES-GCM)
  const macForPeer = new Map(); // id -> CryptoKey (HMAC-SHA256)

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

  // HKDF: из общего секрета → AES и HMAC
  async function derivePair(peerId, peerPubRawBuf) {
    const peerPub = await crypto.subtle.importKey("raw", peerPubRawBuf, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const sharedBits = await crypto.subtle.deriveBits({ name: "ECDH", public: peerPub }, myPriv, 256);
    const sharedKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);

    const [a, b] = [myIdRef, peerId].sort();
    const salt    = enc.encode("sc-v1-hkdf-salt");
    const infoAES = enc.encode(`sc-v1|aes|${a}|${b}`);
    const infoMAC = enc.encode(`sc-v1|mac|${a}|${b}`);

    const aesKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: infoAES },
      sharedKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    const macKey = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: infoMAC },
      sharedKey,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"]
    );

    aesForPeer.set(peerId, aesKey);
    macForPeer.set(peerId, macKey);
  }

  function wsSend(obj) {
    if (wsRef && wsRef.readyState === WebSocket.OPEN) {
      wsRef.send(JSON.stringify(obj));
    }
  }

  async function attach({ ws, myId, getRosterIds, appendChat, onPeerFingerprint, onMyFingerprint }) {
    wsRef = ws;
    myIdRef = myId;
    getIds  = getRosterIds || getIds;
    appendFn = appendChat || appendFn;
    onPeerFp = onPeerFingerprint || null;
    onMyFp   = onMyFingerprint   || null;

    await ensureECDH();
    if (typeof onMyFp === "function") onMyFp(myFpHex);
    announceToAll();
  }

  function onRosterUpdate() {
    announceToAll();
  }

  function announceToAll() {
    const ids = (getIds() || []).filter((id) => id && id !== myIdRef);
    for (const pid of ids) {
      wsSend({ type: "key", to: pid, pub: b64(myPubRaw), ts: nextTs() });
    }
  }

  async function onKey(msg) {
    if (!myPriv) await ensureECDH();
    const from = msg.from;
    if (!from || from === myIdRef) return;
    try {
      const raw = unb64(msg.pub);

      await derivePair(from, raw);

      const fp = await fpFromRaw(raw);
      peerFp.set(from, fp);
      if (typeof onPeerFp === "function") onPeerFp(from, fp);

      // ответим своим пабликом (на случай, если у него нас нет)
      wsSend({ type: "key", to: from, pub: b64(myPubRaw), ts: nextTs() });

      // ключ MAC готов → попросим Safety досвести отложенные подтверждения
      if (typeof Safety?.onMacReady === "function") {
        Safety.onMacReady(from);
      }
    } catch (e) {
      console.warn("[E2E] derive failed from", from, e);
    }
  }

  async function send(text) {
    const msg = (text || "").trim();
    if (!msg) return;
    const ids = (getIds() || []).filter((id) => id && id !== myIdRef);
    const now = nextTs();

    for (const pid of ids) {
      try {
        const key = aesForPeer.get(pid);
        if (!key) {
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
    appendFn({ from: myIdRef, text: msg, ts: now });
  }

  async function onCipher(msg) {
    const { from, to, iv, ct, ts } = msg;
    if (!to || to !== myIdRef) return;
    const key = aesForPeer.get(from);
    if (!key) {
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

  function getMyFingerprint()   { return myFpHex; }
  function getPeerFingerprint(id) { return peerFp.get(id) || null; }
  function hasMacKey(peerId)    { return macForPeer.has(peerId); }

  // Подпись «safety-ok»: HMAC-SHA256 по строке payload
  async function signSafety(payload, peerIdForMac) {
    const macKey = macForPeer.get(peerIdForMac);
    if (!macKey) {
      wsSend({ type: "key", to: peerIdForMac, pub: b64(myPubRaw), ts: nextTs() });
      throw new Error("no MAC key yet for peer " + peerIdForMac);
    }
    const sig = await crypto.subtle.sign("HMAC", macKey, enc.encode(payload));
    return b64(sig);
  }

  // Проверка подписи для входящего safety-ok (используем ключ пары fromPeerId↔me)
  async function verifySafety(payload, b64sig, fromPeerId) {
    const macKey = macForPeer.get(fromPeerId);
    if (!macKey) return false;
    const sig = unb64(b64sig);
    return await crypto.subtle.verify("HMAC", macKey, sig, enc.encode(payload));
  }

  return {
    attach, onRosterUpdate, onKey, onCipher, send,
    getMyFingerprint, getPeerFingerprint,
    signSafety, verifySafety,
    hasMacKey
  };
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

async function ensurePlayback(audio) {
  const tryPlay = (el) => el && typeof el.play === "function" && el.play().catch(()=>{});
  try {
    await audio.play();
  } catch (e) {
    // покажем подсказку один раз и подпишемся на клик
    console.warn("[AUDIO] play() blocked, waiting for user gesture", e);
    toast("Нажмите любую кнопку интерфейса, чтобы включить звук", "warn");
    const once = () => {
      // дожимаем ВСЕ активные аудио, не только текущее
      audios.forEach((a) => tryPlay(a));
      document.removeEventListener("click", once, true);
    };
    document.addEventListener("click", once, true);
  }
}

// Если поток "застрял": трек остаётся muted / нет данных — пробуем оживить
function armMediaWatchdog(remoteId, audioEl, inTrack, pc) {
  let fired = false;
  const bump = () => {
    if (fired) return;
    fired = true;
    console.warn("[WATCHDOG] revive audio for", remoteId);
    // 1) перепривязка srcObject, если трек ожил
    if (inTrack && !inTrack.muted) {
      try {
        const ms = new MediaStream([inTrack]);
        audioEl.srcObject = ms;
      } catch {}
    }
    // 2) дожать воспроизведение
    ensurePlayback(audioEl);
    // 3) если соединение не "connected" — запросить ICE restart
    if (pc && (pc.connectionState === "failed" || pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected")) {
      requestRenegotiate(remoteId, { iceRestart: true });
    }
  };

  // Срабатывания, указывающие на «ожил/застрял»
  if (inTrack) {
    inTrack.onunmute = () => { ensurePlayback(audioEl); };
    // если долго muted — толкнём
    const muteTimer = setTimeout(() => { if (inTrack.muted) bump(); }, 2500);
    // очистка при воспроизведении
    audioEl.addEventListener("playing", () => clearTimeout(muteTimer), { once: true });
  }

  // Если аудио так и не начало играть — попробуем «пнуть»
  const stallTimer = setTimeout(() => {
    if (audioEl.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) bump();
  }, 3000);

  audioEl.addEventListener("playing", () => clearTimeout(stallTimer), { once: true });
  audioEl.addEventListener("stalled", bump);
  audioEl.addEventListener("suspend", bump);
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

  await ensureMicForExistingPeers();

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

  ws?.send(JSON.stringify({
    type: "name",
    name: (nameEl?.value || "User").slice(0, 32),
  }));

  joined = true;

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

    for (const id of speakingDetectionIntervals.keys()) {
      stopSpeakingDetection(id);
    }

    if (senders && senders.size) {
      for (const [, sender] of senders) {
        try { await sender.replaceTrack(null); } catch {}
      }
    }

    for (const [, clone] of trackClones) {
      try { clone.stop(); } catch {}
    }
    trackClones.clear();

    if (micStream) {
      try { for (const t of micStream.getTracks()) { try { t.stop(); } catch {} } }
      finally { micStream = null; }
    }

    try {
      audios.forEach((audio) => {
        try { if (audio) { audio.srcObject = null; audio.load?.(); } } catch {}
      });
    } catch {}
    audios.clear();

    for (const [, pc] of pcs) {
      try { pc.getSenders().forEach((s) => s.track && s.track.stop()); } catch {}
      try { pc.close(); } catch {}
    }
    pcs.clear();
    pendingIce.clear();
    senders.clear();
    negotiating.clear();
    needRenego.clear();

    if (reconnectTimer) {
      try { clearTimeout(reconnectTimer); } catch {}
      reconnectTimer = null;
    }

    if (ws) {
      try { ws.close(4005, "user left"); } catch {}
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      ws = null;
    }

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

  status += ' | Подключения: ';
  let activeConnections = 0;
  pcs.forEach((pc) => {
    if (pc.connectionState === 'connected') activeConnections++;
  });
  status += `${activeConnections}/${pcs.size}`;

  statusEl.textContent = status;
}

function createAudioStatusElement() {
  const statusEl = document.createElement('div');
  statusEl.id = 'audio-status';
  statusEl.style.cssText = 'position: fixed; bottom: 10px; left: 10px; background: rgba(0,0,0,0.7); color: white; padding: 5px 10px; border-radius: 5px; font-size: 12px; z-index: 1000;';
  document.body.appendChild(statusEl);
  return statusEl;
}



function unlockAllAudiosOnce() {
  const tryPlay = (el) => el && typeof el.play === "function" && el.play().catch(()=>{});
  document.addEventListener("click", () => {
    audios.forEach((a) => tryPlay(a));
  }, { once: true, capture: true });
}

document.addEventListener("DOMContentLoaded", () => {
  unlockAllAudiosOnce();
});

/* =========================================================================
   Инициализация
   ========================================================================= */
document.addEventListener('DOMContentLoaded', () => {
  createAudioStatusElement();
  setInterval(updateAudioStatus, 2000);
});

document.addEventListener("DOMContentLoaded", () => {
  switchJoinButton("join");

  const savedToken = currentToken();
  if (tokenEl) tokenEl.value = savedToken;
  if (tokenHint) tokenHint.textContent = "Токен: " + maskToken(savedToken);

  settingsBtn?.addEventListener("click", () => {
    const pop = $("#net-popover");
    if (!pop) return;
    const willOpen = pop.classList.contains("hidden");
    if (willOpen) showNet();
    else hideNet();
    settingsBtn.classList.toggle("is-on", willOpen);
    settingsBtn.setAttribute("aria-pressed", willOpen ? "true" : "false");
  });

  selfMuteBtn?.addEventListener("click", toggleSelfMute);

  // автоподключение WS (без старта звонка)
  initWS();

  joinBtn && (joinBtn.onclick = async () => {
    if (joinBtn.dataset.mode === "join" && !joined) {
      const name = nameEl?.value.trim();
      const token = tokenEl?.value.trim();
      if (!name) { toast("Введите имя!", "error"); return; }
      if (!token) { toast("Введите токен комнаты!", "error"); return; }
      // храним в sessionStorage (короче живёт), дублируем в localStorage для совместимости
      sessionStorage.setItem("ROOM_TOKEN", token);
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
