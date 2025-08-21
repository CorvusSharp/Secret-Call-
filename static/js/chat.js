// /js/chat.js
"use strict";

import { $, $$, toast } from "./ui.js";

/* =========================================================================
   DOM
   ========================================================================= */
const emojiBtn   = document.getElementById("emoji-btn");
const emojiPop   = document.getElementById("emoji-pop");
const mentionBox = document.getElementById("mentions-suggest");
const chatLog    = document.getElementById("chat-log");
const chatInput  = document.getElementById("chat-input");
const chatSend   = document.getElementById("chat-send");

/* =========================================================================
   Конфиг эмодзи
   ========================================================================= */
const EMOJIS = "👍,👎,🙂,😉,😊,😂,🤣,😮,😢,😡,❤,🔥,✨,🎉,✅,❌,⭐,🚀,🎧,🎵,☎,💡,🧠,💬,🍀,☕,🍕,🍎".split(",");

/* =========================================================================
   Внутреннее состояние чата
   ========================================================================= */
let rosterById = new Map();      // id -> name
let myId = null;                 // выставляет rtc.js через setMyId()
let sendChatFn = null;           // выставляет rtc.js через setSendChat(fn)

/* =========================================================================
   Экспортируемые API для rtc.js
   ========================================================================= */
export function setMyId(id) {
  myId = id || null;
}


export function getRosterIds() {
  return Array.from(rosterById.keys());
}


export function updateRoster(roster) {
  rosterById = new Map((roster || []).map((p) => [p.id, (p.name || "").trim()]));
  // сразу подсветим имена на карточках пиров
  for (const [id, name] of rosterById.entries()) {
    const root = document.getElementById("peer-" + id);
    if (!root) continue;
    const label = root.querySelector(".peer__name");
    if (label) label.textContent = name || id.slice(0, 6);
  }
}

export function appendChat({ from: fromId, name, text, ts }) {
  if (!chatLog) return;
  const mine = myId && fromId === myId;

  const row = document.createElement("div");
  row.className = "chat__msg" + (mine ? " mine" : "");

  const meta = document.createElement("span");
  meta.className = "meta";
  const who = name ? name : fromId ? fromId.slice(0, 6) : "anon";
  meta.textContent = `${who} · ${fmtTime(ts)}`;

  const body = document.createElement("span");
  body.className = "body";
  body.textContent = " " + (text || "");

  row.appendChild(meta);
  row.appendChild(body);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
}

/** rtc.js должен вызвать это и передать функцию-отправитель */
export function setSendChat(fn) {
  sendChatFn = typeof fn === "function" ? fn : null;
}

/* =========================================================================
   Внутренняя логика чата (упоминания, эмодзи)
   ========================================================================= */
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
  const end   = input.selectionEnd ?? input.value.length;
  const val   = input.value;
  input.value = val.slice(0, start) + text + val.slice(end);
  const pos = start + text.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event("input"));
}

function currentWordAtCaret(input) {
  const pos  = input.selectionStart ?? input.value.length;
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

/* =========================================================================
   Обработчики UI
   ========================================================================= */
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

function doSendChat() {
  const text = (chatInput?.value || "").slice(0, 500).trim();
  if (!text || !sendChatFn) return;
  const mentions = extractMentions(text);
  sendChatFn({ text, mentions });   // отдаём во внешний мир (rtc.js)
  if (chatInput) chatInput.value = "";
}
chatSend?.addEventListener("click", doSendChat);
chatInput?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    doSendChat();
  }
});

// safety logs
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled promise rejection (chat):", e.reason);
});
window.addEventListener("error", (e) => {
  console.error("Unhandled error (chat):", e.error || e.message);
});
