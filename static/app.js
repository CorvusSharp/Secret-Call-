"use strict";
// ---------- Партиклы (фон) ----------
(function () {
    const canvas = document.getElementById('bg-particles');
    const ctx = canvas.getContext('2d', { alpha: true });
    const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let W = 0, H = 0, particles = [];
    function resize() {
      W = canvas.width = Math.floor(window.innerWidth * DPR);
      H = canvas.height = Math.floor(window.innerHeight * DPR);
      canvas.style.width = window.innerWidth + 'px';
      canvas.style.height = window.innerHeight + 'px';
      spawn();
    }
    function spawn() {
      const count = Math.floor((W * H) / (130 * 130) * 0.75);
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * W,
        y: Math.random() * H,
        r: 0.8 + Math.random() * 1.8,
        a: 0.15 + Math.random() * 0.5,
        vx: (Math.random() - 0.5) * 0.25 * DPR,
        vy: (Math.random() - 0.5) * 0.25 * DPR,
      }));
    }
    function step() {
      ctx.clearRect(0, 0, W, H);
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy;
        if (p.x < -5) p.x = W + 5; if (p.x > W + 5) p.x = -5;
        if (p.y < -5) p.y = H + 5; if (p.y > H + 5) p.y = -5;
        const hue = (p.x / W) * 360;
        ctx.beginPath();
        ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${p.a})`;
        ctx.arc(p.x, p.y, p.r * DPR, 0, Math.PI * 2);
        ctx.fill();
      }
      requestAnimationFrame(step);
    }
    window.addEventListener('resize', resize, { passive: true });
    resize(); step();
  })();

  // ---------- Утилиты UI ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  function toast(text, type = 'info') {
    const box = document.createElement('div');
    box.className = `toast ${type}`;
    box.textContent = text;
    $('#toasts').appendChild(box);
    setTimeout(() => box.classList.add('show'), 10);
    setTimeout(() => { box.classList.remove('show'); setTimeout(()=>box.remove(), 400); }, 3500);
  }

  // Ripple эффект на всех кнопках (визуальный отклик)
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.btn'); if (!btn) return;
    btn.classList.add('is-pressed');
    const rect = btn.getBoundingClientRect();
    const r = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const wave = document.createElement('span');
    wave.className = 'ripple';
    wave.style.left = (x - r/2) + 'px';
    wave.style.top  = (y - r/2) + 'px';
    wave.style.width = wave.style.height = r + 'px';
    btn.appendChild(wave);
    setTimeout(()=> wave.remove(), 600);
  }, { passive: true });
  ['pointerup','pointerleave','blur'].forEach(ev => {
    document.addEventListener(ev, (e)=>{
      const btn = e.target.closest?.('.btn'); if (!btn) return;
      btn.classList.remove('is-pressed');
    }, true);
  });

  function showModal(title, text) {
    $('#join-modal-title').textContent = title || 'Невозможно подключиться';
    $('#join-modal-text').textContent = text || 'Попробуйте позже.';
    $('#join-modal').classList.remove('hidden');
    setTimeout(() => $('#join-modal-ok')?.focus(), 0);
  }
  function hideModal() { $('#join-modal')?.classList.add('hidden'); }
  $('#join-modal-ok')?.addEventListener('click', hideModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideModal(); hideNet();
      // закрыть поповеры эмодзи/упоминаний
      const emojiPop = document.getElementById('emoji-pop');
      const mentionBox = document.getElementById('mentions-suggest');
      if (emojiPop) emojiPop.hidden = true;
      if (mentionBox) mentionBox.hidden = true;
    }
  });

  function showNet() { $('#net-popover').classList.remove('hidden'); $('#stun-input').value = localStorage.getItem('STUN') || ''; }
  function hideNet() { $('#net-popover').classList.add('hidden'); }
  $('#settings').addEventListener('click', showNet);
  $('#stun-save').addEventListener('click', () => { 
    const v = $('#stun-input').value.trim();
    if (v) localStorage.setItem('STUN', v); else localStorage.removeItem('STUN');
    toast('STUN сохранён'); hideNet();
  });
  $('#stun-reset').addEventListener('click', () => { localStorage.removeItem('STUN'); $('#stun-input').value = ''; toast('STUN сброшен'); });

  // ---------- Emoji & Mentions ----------
  const emojiBtn = document.getElementById('emoji-btn');
  const emojiPop = document.getElementById('emoji-pop');
  const mentionBox = document.getElementById('mentions-suggest');
  const chatLog = document.getElementById('chat-log');
  const chatInput = document.getElementById('chat-input');
  const chatSend = document.getElementById('chat-send');

  // Common emoji set
  const EMOJIS = '👍,👎,🙂,😉,😊,😂,🤣,😮,😢,😡,❤,🔥,✨,🎉,✅,❌,⭐,🚀,🎧,🎵,☎,💡,🧠,💬,🍀,☕,🍕,🍎'.split(',');
  function buildEmojiPop() {
    emojiPop.innerHTML = '';
    // Header
    const hdr = document.createElement('div');
    hdr.className = 'emoji-pop__hdr';
    const title = document.createElement('div');
    title.className = 'emoji-pop__title';
    title.textContent = 'Эмодзи';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'emoji-pop__close';
    close.textContent = '×';
    close.title = 'Закрыть';
    close.addEventListener('click', () => { emojiPop.hidden = true; chatInput.focus(); });
    hdr.appendChild(title); hdr.appendChild(close);
    emojiPop.appendChild(hdr);
    const hr = document.createElement('hr'); emojiPop.appendChild(hr);
    // Grid of emoji
    EMOJIS.forEach(e => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = e;
      b.addEventListener('click', () => {
        insertAtCursor(chatInput, e);
        emojiPop.hidden = true;
        chatInput.focus();
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
    input.dispatchEvent(new Event('input'));
  }
  emojiBtn?.addEventListener('click', () => {
    if (emojiPop.hidden) { buildEmojiPop(); }
    emojiPop.hidden = !emojiPop.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!emojiPop.hidden && !emojiPop.contains(e.target) && e.target !== emojiBtn) emojiPop.hidden = true;
    if (!mentionBox.hidden && !mentionBox.contains(e.target)) mentionBox.hidden = true;
  });

  // Roster для @упоминаний
  let rosterById = new Map();
  function updateRoster(roster) {
    rosterById = new Map(roster.map(p => [p.id, p.name || ""]));
  }

  function currentWordAtCaret(input) {
    const pos = input.selectionStart ?? input.value.length;
    const left = input.value.slice(0, pos);
    const m = left.match(/(^|\s)(@[\w\-]{0,32})$/);
    if (!m) return null;
    return {start: pos - m[2].length, end: pos, token: m[2]};
  }
  function showMentionSuggest(prefix) {
    const q = prefix.slice(1).toLowerCase();
    const opts = [];
    for (const [id, name] of rosterById.entries()) {
      const shortId = id.slice(0,6);
      const label = name || shortId;
      if (!q || label.toLowerCase().includes(q) || shortId.startsWith(q)) {
        opts.push({id, name, label});
      }
    }
    if (!opts.length) { mentionBox.hidden = true; return; }
    mentionBox.innerHTML = "";
    opts.slice(0, 20).forEach((o, idx) => {
      const div = document.createElement('div');
      div.className = 'opt' + (idx===0?' active':'');

      div.textContent = '@' + (o.name || o.id.slice(0,6));
      div.dataset.id = o.id;
      div.addEventListener('click', () => applyMentionFromBox(o.id, o.name));
      mentionBox.appendChild(div);
    });
    mentionBox.hidden = false;
  }
  function applyMentionFromBox(id, name) {
    const cur = currentWordAtCaret(chatInput);
    if (!cur) return;
    const label = '@' + (name || id.slice(0,6));
    const val = chatInput.value;
    chatInput.value = val.slice(0, cur.start) + label + val.slice(cur.end);
    chatInput.focus();
    mentionBox.hidden = true;
  }
  chatInput?.addEventListener('input', () => {
    const cur = currentWordAtCaret(chatInput);
    if (cur) showMentionSuggest(cur.token); else mentionBox.hidden = true;
  });
  chatInput?.addEventListener('keydown', (e) => {
    if (!mentionBox.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
      e.preventDefault();
      const items = Array.from(mentionBox.querySelectorAll('.opt'));
      let idx = items.findIndex(x => x.classList.contains('active'));
      if (e.key === 'ArrowDown') idx = Math.min(idx+1, items.length-1);
      if (e.key === 'ArrowUp') idx = Math.max(idx-1, 0);
      items.forEach((x,i)=>x.classList.toggle('active', i===idx));
      if (e.key === 'Enter' && idx>=0) {
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
        const shortId = id.slice(0,6).toLowerCase();
        if ((name && name.toLowerCase() === label) || shortId === label) {
          ids.push(id); break;
        }
      }
    }
    return Array.from(new Set(ids));
  }

  function fmtTime(ts) {
    try { const d = new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
    catch { return ''; }
  }
  function appendChat({from: fromId, name, text, ts, mentions}) {
    const mine = (fromId === myId);
    const row = document.createElement('div');
    row.className = 'chat__msg' + (mine ? ' mine' : '');
    const meta = document.createElement('span');
    meta.className = 'meta';
    const who = name ? name : (fromId ? fromId.slice(0,6) : 'anon');
    meta.textContent = `${who} · ${fmtTime(ts)}`;
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = ' ' + text;
    row.appendChild(meta); row.appendChild(body);
    chatLog.appendChild(row);
    chatLog.scrollTop = chatLog.scrollHeight;
  }
  function sendChat(){
    const text = (chatInput.value || "").slice(0,500).trim();
    if(!text || ws.readyState !== WebSocket.OPEN) return;
    const mentions = extractMentions(text);
    ws.send(JSON.stringify({type:"chat", text, mentions}));
    chatInput.value = "";
  }
  chatSend?.addEventListener('click', sendChat);
  chatInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });

  // ---------- WebSocket + WebRTC ----------
  const peersEl = document.getElementById('peers');
  const nameEl = document.getElementById('name');
  const joinBtn = document.getElementById('join');
  const tpl = document.getElementById('peer-tpl');

  const pcs = new Map();    // id -> RTCPeerConnection
  const audios = new Map(); // id -> <audio>
  let myId = null;
  let joined = false;
  let micStream = null;

  function setState(text, status='idle') {
    const el = document.getElementById('state');
    el.textContent = text;
    el.setAttribute('data-status', status);
  }

  // создаём WS
  const token = localStorage.getItem('ROOM_TOKEN') || '';
  let ws;
  if (token) {
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?t=' + encodeURIComponent(token));
  } else {
    setState('Требуется токен', 'warn');
    toast('Не задан токен комнаты', 'warn');
    ws = {send() {}, addEventListener() {}, close() {}, readyState: WebSocket.CLOSED};
  }
  ws.addEventListener('open', () => setState('Соединение установлено', 'ok'));
  ws.addEventListener('close', (e) => {
    if (e.code === 1006 && token) {
      setState('401 Unauthorized', 'error');
      toast('401 Unauthorized', 'error');
    } else {
      setState('Соединение закрыто', 'warn');
    }
  });
  ws.addEventListener('error', () => {
    if (ws.readyState === WebSocket.CLOSED && token) {
      setState('401 Unauthorized', 'error');
    } else {
      setState('Ошибка соединения', 'error');
    }
  });

  function addPeerUI(id, name) {
    if (document.getElementById('peer-' + id)) return;
    const node = tpl.content.cloneNode(true);
    const root = $('.peer', node); root.id = 'peer-' + id;
    $('.peer__name', node).textContent = name || id.slice(0,6);
    const audio = $('audio', node);
    const muteBtn = $('.mute', node);
    const vol = $('.vol', node);
    muteBtn.onclick = () => {
      audio.muted = !audio.muted;
      muteBtn.textContent = audio.muted ? 'Unmute' : 'Mute';
      muteBtn.classList.toggle('is-on', audio.muted);
      muteBtn.setAttribute('aria-pressed', audio.muted ? 'true' : 'false');
    };
    vol.oninput = () => { audio.volume = (+vol.value)/100; };
    peersEl.appendChild(node);
    audios.set(id, audio);
  }
  function removePeerUI(id) {
    const el = document.getElementById('peer-' + id);
    if (el) {
      el.classList.add('bye');
      setTimeout(()=>el.remove(), 300);
    }
    audios.delete(id);
  }

  function closeAllPeers() {
    for (const [id, pc] of pcs) {
      try { pc.getSenders().forEach(s=>s.track && s.track.stop()); } catch {}
      try { pc.close(); } catch {}
    }
    pcs.clear();
    peersEl.innerHTML = '';
    audios.clear();
  }

  function makePC(remoteId) {
    const stun = localStorage.getItem('STUN') || 'stun:stun.l.google.com:19302';
    const pc = new RTCPeerConnection({ iceServers: [{ urls: [stun] }] });
    pcs.set(remoteId, pc);
    if (micStream) micStream.getTracks().forEach(t => pc.addTrack(t, micStream));

    pc.ontrack = (ev) => {
      const [stream] = ev.streams;
      addPeerUI(remoteId);
      const audio = audios.get(remoteId);
      audio.srcObject = stream;
      // плавный fade-in
      audio.volume = 0; const target = 1; let v = 0;
      const tick = () => { v = Math.min(target, v + 0.05); audio.volume = v; if (v < target) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    };

    pc.onicecandidate = (e) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'ice', to:remoteId, candidate: e.candidate ? {
        candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex
      } : null }));
    };
    return pc;
  }

  async function maybeCall(remoteId) {
    if (myId < remoteId && joined) {
      const pc = pcs.get(remoteId) || makePC(remoteId);
      const off = await pc.createOffer();
      await pc.setLocalDescription(off);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'offer', to:remoteId, sdp:pc.localDescription.sdp, sdpType:pc.localDescription.type }));
    }
  }

  ws.addEventListener('message', async (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }

    if (m.type === 'hello') {
      updateRoster(m.roster || []);
      myId = m.id;
      setState('В комнате', 'ok');
      (m.roster||[]).filter(p => p.id !== myId).forEach(p => addPeerUI(p.id, p.name));
      return;
    }
    if (m.type === 'roster') {
      updateRoster(m.roster || []);
      peersEl.innerHTML = '';
      (m.roster||[]).filter(p => p.id !== myId).forEach(p => addPeerUI(p.id, p.name));
      return;
    }
    if (m.type === 'peer-joined') {
      if (m.id !== myId) { addPeerUI(m.id); if (joined) maybeCall(m.id); toast('Кто-то подключился'); }
      return;
    }
    if (m.type === 'chat') { appendChat(m); return; }
    if (m.type === 'peer-left') {
      removePeerUI(m.id); toast('Кто-то вышел', 'warn');
      return;
    }
    if (m.type === 'offer') {
      const from = m.from; const pc = pcs.get(from) || makePC(from);
      await pc.setRemoteDescription({ type:'offer', sdp:m.sdp });
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type:'answer', to:from, sdp:pc.localDescription.sdp, sdpType:pc.localDescription.type }));
      return;
    }
    if (m.type === 'answer') {
      const pc = pcs.get(m.from); if (!pc) return;
      await pc.setRemoteDescription({ type:'answer', sdp:m.sdp });
      return;
    }
    if (m.type === 'ice') {
      const pc = pcs.get(m.from); if (!pc) return;
      const c = m.candidate;
      if (c === null) { try { await pc.addIceCandidate(null); } catch {} ; return; }
      if (!c.candidate || c.candidate.includes('.local')) return;
      try { await pc.addIceCandidate(c); } catch {}
      return;
    }
    if (m.type === 'full') {
      const cap = typeof m.capacity === 'number' ? m.capacity : undefined;
      const title = 'Комната заполнена';
      const text = cap
        ? `Достигнут лимит участников: ${cap}. Попробуйте позже.`
        : 'Комната заполнена. Попробуйте позже.';
      showModal(title, text);
      try { ws.close(4001, 'room full'); } catch {}
      setState('Комната заполнена', 'warn');
      return;
    }
    if (m.type === 'browser-only') {
      showModal('Требуется браузер', 'Подключение возможно только из браузера. Откройте ссылку в Chrome/Firefox/Safari/Edge.');
      try { ws.close(4002, 'browser only'); } catch {}
      setState('Только браузер', 'error');
      return;
    }
  });

  // ====== Кнопка Войти ⇄ Выйти с красивыми состояниями ======
  function switchJoinButton(toState) {
    const label = joinBtn.querySelector('.btn__label');
    if (toState === 'leave') {
      joinBtn.dataset.mode = 'leave';
      joinBtn.classList.remove('primary','glow');
      joinBtn.classList.add('danger','is-on');
      joinBtn.setAttribute('aria-pressed','true');
      label.textContent = 'Выйти';
    } else {
      joinBtn.dataset.mode = 'join';
      joinBtn.classList.remove('danger','is-on');
      joinBtn.classList.add('primary','glow');
      joinBtn.setAttribute('aria-pressed','false');
      label.textContent = 'Войти';
    }
  }

  async function startCall() {
    try {
      setState('Запрашиваем микрофон…', 'idle');
      micStream = await navigator.mediaDevices.getUserMedia({ audio:true });
      if (ws.readyState !== WebSocket.OPEN) {
        toast('Нет соединения', 'error');
        setState('Нет соединения', 'error');
        return;
      }
      ws.send(JSON.stringify({ type:'name', name: (nameEl.value || 'User').slice(0, 32) }));
      joined = true;
      // Позвонить всем уже видимым
      $$('.peer').forEach(el => {
        const id = el.id.replace('peer-',''); maybeCall(id);
      });
      toast('Микрофон включен');
      setState('Вы в эфире', 'ok');
      switchJoinButton('leave');
    } catch (e) {
      toast('Доступ к микрофону запрещён', 'error');
      setState('Нет доступа к микрофону', 'error');
      switchJoinButton('join');
    }
  }

  async function leaveCall() {
    try {
      joined = false;
      // остановить локальные треки
      if (micStream) {
        for (const t of micStream.getTracks()) { try { t.stop(); } catch {} }
        micStream = null;
      }
      // закрыть все pc и очистить UI пиров
      closeAllPeers();
      setState('Вы вышли из разговора', 'warn');
      toast('Вы вышли из разговора', 'warn');
    } finally {
      switchJoinButton('join');
    }
  }

  joinBtn.onclick = async () => {
    if (joinBtn.dataset.mode === 'join' && !joined) {
      await startCall();
    } else if (joinBtn.dataset.mode === 'leave') {
      await leaveCall();
    }
  };

  // Кнопка настроек получает toggle-состояние для наглядности
  const settingsBtn = document.getElementById('settings');
  settingsBtn.addEventListener('click', () => {
    const opened = !document.getElementById('net-popover').classList.contains('hidden');
    settingsBtn.classList.toggle('is-on', !opened);
    settingsBtn.setAttribute('aria-pressed', !opened ? 'true' : 'false');
  });
