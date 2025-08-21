"use strict";

/* =========================================================================
   Партиклы (фон)
   ========================================================================= */
(function () {
  const canvas = document.getElementById("bg-particles");
  if (!canvas) return;

  const ctx = canvas.getContext("2d", { alpha: true });
  const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  let W = 0,
    H = 0,
    particles = [];

  function resize() {
    W = canvas.width = Math.floor(window.innerWidth * DPR);
    H = canvas.height = Math.floor(window.innerHeight * DPR);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    spawn();
  }

  function spawn() {
    const count = Math.floor((W * H) / (130 * 130) * 0.75);
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      rCss: 0.6 + Math.random() * 1.2, // радиус в CSS-пикселях
      a: 0.15 + Math.random() * 0.45,
      vx: (Math.random() - 0.5) * 0.25 * DPR,
      vy: (Math.random() - 0.5) * 0.25 * DPR,
    }));
  }

  function step() {
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < -5 * DPR) p.x = W + 5 * DPR;
      if (p.x > W + 5 * DPR) p.x = -5 * DPR;
      if (p.y < -5 * DPR) p.y = H + 5 * DPR;
      if (p.y > H + 5 * DPR) p.y = -5 * DPR;

      const hue = (p.x / W) * 360;
      ctx.beginPath();
      ctx.fillStyle = `hsla(${hue}, 90%, 60%, ${p.a})`;

      ctx.arc(p.x, p.y, p.rCss * DPR, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(step);
  }

  window.addEventListener("resize", resize, { passive: true });
  resize();
  step();
})();

/* =========================================================================
   Утилиты UI
   ========================================================================= */
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const lastToastAt = new Map();
const TOAST_COOLDOWN_MS = 1500;

export function toast(text, type = "info") {
  const key = `${type}::${text}`;
  const now = Date.now();
  const prev = lastToastAt.get(key) || 0;
  if (now - prev < TOAST_COOLDOWN_MS) return;
  lastToastAt.set(key, now);

  const box = document.createElement("div");
  box.className = `toast ${type}`;
  box.textContent = text;
  $("#toasts")?.appendChild(box);
  requestAnimationFrame(() => box.classList.add("show"));
  setTimeout(() => {
    box.classList.remove("show");
    setTimeout(() => box.remove(), 400);
  }, 3500);
}

// Ripple на кнопках (один набор обработчиков)
document.addEventListener(
  "pointerdown",
  (e) => {
    const btn = e.target.closest?.(".btn");
    if (!btn) return;
    btn.classList.add("is-pressed");
    const rect = btn.getBoundingClientRect();
    const r = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const wave = document.createElement("span");
    wave.className = "ripple";
    wave.style.left = x - r / 2 + "px";
    wave.style.top = y - r / 2 + "px";
    wave.style.width = wave.style.height = r + "px";
    btn.appendChild(wave);
    setTimeout(() => wave.remove(), 600);
  },
  { passive: true }
);
["pointerup", "pointerleave", "blur"].forEach((ev) => {
  document.addEventListener(
    ev,
    (e) => {
      const btn = e.target.closest?.(".btn");
      if (!btn) return;
      btn.classList.remove("is-pressed");
    },
    true
  );
});

// Модалка для системных сообщений
export function showModal(title, text) {
  $("#join-modal-title") && ($("#join-modal-title").textContent = title || "Невозможно подключиться");
  $("#join-modal-text") && ($("#join-modal-text").textContent = text || "Попробуйте позже.");
  $("#join-modal")?.classList.remove("hidden");
  setTimeout(() => $("#join-modal-ok")?.focus(), 0);
}
export function hideModal() {
  $("#join-modal")?.classList.add("hidden");
}
$("#join-modal-ok")?.addEventListener("click", hideModal);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideModal();
    hideNet();
    const emojiPop = document.getElementById("emoji-pop");
    const mentionBox = document.getElementById("mentions-suggest");
    if (emojiPop) emojiPop.hidden = true;
    if (mentionBox) mentionBox.hidden = true;
  }
});

// Поповер сети/настроек (единый обработчик)
export function showNet() {
  const pop = $("#net-popover");
  if (!pop) return;
  pop.classList.remove("hidden");
  const stunEl = $("#stun-input");
  if (stunEl) stunEl.value = localStorage.getItem("STUN") || "";
}
export function hideNet() {
  $("#net-popover")?.classList.add("hidden");
}
$("#stun-save")?.addEventListener("click", () => {
  const v = $("#stun-input")?.value?.trim() || "";
  if (v) localStorage.setItem("STUN", v);
  else localStorage.removeItem("STUN");
  toast(v ? "STUN сохранён" : "STUN сброшен");
  hideNet();
});
$("#stun-reset")?.addEventListener("click", () => {
  localStorage.removeItem("STUN");
  const el = $("#stun-input");
  if (el) el.value = "";
  toast("STUN сброшен");
});

