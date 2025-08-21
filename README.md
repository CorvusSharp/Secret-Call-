# 🔮 Secret‑Call

<div align="center">

✨ **End‑to‑End Encrypted WebRTC Calls** ✨  
_Built with Python • Powered by the Browser_

[🇬🇧 English](#english) ｜ [🇷🇺 Русский](#русский)

![Static Badge](https://img.shields.io/badge/WebRTC-secure-blue?logo=webrtc)
![Static Badge](https://img.shields.io/badge/Python-3.11+-yellow?logo=python)
![Static Badge](https://img.shields.io/badge/license-MIT-green?logo=open-source-initiative)

</div>

---

## English

### What is it?
**Secret‑Call** is a self‑hosted voice calling app that uses **WebRTC** (DTLS‑SRTP) end‑to‑end on the media path.  
A tiny **Python (aiohttp + aiortc)** backend serves static files and **WebSocket** signaling. No third‑party storage, you control the server and logs.

---

## 🚀 Features (Functional Overview)

### Calls
- **1×1** and **Group** calls (capacity is selected in the desktop GUI before hosting).
- **Join / Leave** single toggle with clear visual states.
- Live **roster** updates as peers join/leave.
- **Per‑peer audio controls**: _Mute_ and _Volume_ (local‑only, does not affect others).
- Basic **NAT hygiene** on candidates (filters link‑local/host‑only types client‑side).

### Chat
- **In‑room text chat** with timestamps.
- **Mentions** via `@name` or short peer id (suggestions popup with arrow navigation).
- **Emoji picker** (grid) with close button, closes on outside‑click and **Esc**.

### UI / UX
- Futuristic frontend: **glassmorphism**, **particles**, **animated gradients**.
- **Toasts** for key events and errors.
- **Status bar** with connection state and hints.
- **Modals**: “Room is full”, “Browser‑only”.  
- **Settings (⚙︎)** popover: set **STUN** URL at runtime (persisted in `localStorage`).

### Hosting / Server
- Single Python process: **HTTP** for static files and **WebSocket** on `/ws` for signaling.
- **Capacity limit**: 2 for 1×1, up to N for group (picked in GUI).
- Optional **public URL** via `localhost.run` SSH tunnel (auto‑parsed and clickable in GUI).
- **Security headers**: CSP, HSTS, X‑Frame‑Options, Referrer‑Policy, Permissions‑Policy (microphone/camera).

### Desktop GUI
- Minimal **Tkinter** application to start hosting, set capacity, and view/click public link.
- **Room token** field with default value **`123`** (for demos). If the `ROOM_TOKEN` env var is set, it overrides the default.

> ⚠️ **Change the token** for real use. The default `123` is only to simplify first‑run demos.

---

## 🧰 Tech Stack

```text
Backend:   Python 3.11+, aiohttp (HTTP + WebSocket), aiortc (WebRTC)
Frontend:  HTML / CSS / JS (vanilla)
Audio:     Browser getUserMedia (WebRTC). Local libs used only where required
Tunnel:    OpenSSH -> localhost.run (optional)
GUI:       Tkinter app to select mode/capacity and start hosting
```

**Project layout**
```
Secret-Call/
├─ main.py                # App entry-point (GUI + async runner)
├─ gui.py                 # Tkinter GUI: capacity, start hosting, tunnel link
├─ core.py                # HTTP server, WebSocket signaling, security headers, logging
├─ async_runner.py        # Asyncio loop runner in background thread
├─ tunnel.py              # localhost.run SSH tunnel integration (parse clickable URL)
├─ index.html             # Frontend UI (WebRTC, chat, mentions, emoji)
├─ app.js                 # Frontend logic
├─ style.css              # Glassmorphism + particles + responsive layout
└─ icon.svg               # App icon (optional)
```

---

## ⚙️ How it works (Protocol sketch)

1. **Serve UI** — `aiohttp` serves `index.html`, `style.css`, `app.js`, `icon.svg` and opens a **WebSocket** at `/ws`.
2. **Hello / roster** — on connect, server sends `hello {id, roster}`. Client renders the roster.
3. **Join** — user presses **Join**, browser asks for microphone, client sends `name`.
4. **Offer/Answer** — peers exchange SDP via server messages `offer`/`answer` and ICE candidates `ice`. Media flows **P2P**.
5. **Capacity / browser checks** — if room is full → server emits `full {capacity}`; if non‑browser agent → `browser-only` modal.
6. **Chat** — text goes over signaling WS as `{type:"chat", text, [mentions]}` and renders for all.
7. **Leave** — local tracks stop, RTCPeerConnections close, UI resets.

> The signaling server **never forwards audio**; it only forwards small JSON envelopes (hello/roster/offer/answer/ice/chat).

---

## 🔧 Configuration

### Environment variables
| Variable | Purpose | Default |
|---|---|---|
| `ROOM_TOKEN` | Room secret required via WebSocket subprotocol | GUI default: **`123`** |
| `ALLOWED_ORIGINS` | Comma‑separated list of allowed `Origin` values for `/ws` | _(empty = allow all)_ |
| `ICE_SERVERS` | JSON list of STUN/TURN servers for the browser | browser default STUN or none |
| `ADMIN_STATUS` | Enable `/status` endpoint (non‑sensitive counters) | `0` |
| `STATUS_SECRET` | Header secret to read `/status` when `ADMIN_STATUS=1` | _(unset)_ |

> Tip: put env vars in a `.env` and `set -a; source .env; set +a` (Linux/macOS) before `python main.py`. On Windows PowerShell: `$env:ROOM_TOKEN='...'`.

### Ports & URLs
- Local server: `http://127.0.0.1:8790` (browsers treat `localhost` as a secure context for getUserMedia).  
- Public: optional via SSH tunnel (see below).

### TURN/STUN examples
```json
ICE_SERVERS='[
  {"urls":["stun:stun.l.google.com:19302"]},
  {"urls":["turns:turn.example.com:5349"],"username":"user","credential":"pass"}
]'
```

---

## ▶️ Run

```bash
python main.py
```
Open in the browser:
```
http://localhost:8790
```

- Enter your **name** and press **Join**.  
- The **Join** button toggles to **Leave**; the status changes to **Live**.

### Optional public URL
Useful for NAT tests and inviting remote peers. Two options:

**Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://127.0.0.1:8790 --edge-ip-version 4
```

**localhost.run (SSH)**
```bash
ssh -tt \
  -o StrictHostKeyChecking=accept-new \
  -o ServerAliveInterval=30 \
  -R 80:127.0.0.1:8790 \
  nokey@localhost.run
```

> You can enable fingerprint pinning in `tunnel.py` to avoid TOFU risks on first connect.

---

## 🎛 Frontend Controls (Cheat‑sheet)

- **Join / Leave** — start/stop microphone and WebRTC sessions.  
- **Per‑peer Mute** — mute a specific remote audio (local only).  
- **Per‑peer Volume** — adjust remote audio loudness (local only).  
- **Chat input** — **Enter** to send.  
- **Emoji button** — toggle emoji grid; click to insert; **Esc** or outside‑click to close.  
- **Mentions** — type `@` to open suggestions; use `↑/↓/Enter` to choose.  
- **Settings (⚙︎)** — set **STUN** URL; saved to `localStorage`.  
- **Toasts** — notifications on join/leave/errors.

---

## 🛡️ Security (Deep dive)

### Media
- **DTLS‑SRTP** on the media path = encryption + integrity.  
- Ephemeral session keys negotiated by the browsers.  
- Media is **peer‑to‑peer** whenever possible; use your own **TURN** for symmetric‑NATs.

### Signaling
- WebSocket carries **only metadata** (SDP/ICE/chat).  
- Server applies **security headers** (CSP, HSTS, X‑Frame‑Options, Referrer‑Policy, Permissions‑Policy).  
- **Origin allow‑list** can be enforced via `ALLOWED_ORIGINS`.  
- **Token** is required via WebSocket subprotocol (`Sec-WebSocket-Protocol`).

### Hardening checklist (recommended for Internet exposure)
1. Run behind **Nginx/Caddy** with TLS and HSTS.  
2. Set `ALLOWED_ORIGINS=https://your.domain` (exact origin).  
3. Provide **TURN** (`turns:`) with TLS; keep STUN as fallback.  
4. Log rotation & masking of sensitive values; rate‑limit `/ws` at proxy level.  
5. Change the default `ROOM_TOKEN` from `123` to a random secret.

---

## 🧪 Troubleshooting

- **Mic prompt never appears** — ensure you open via `http://localhost` or HTTPS (secure context), and grant mic permissions.  
- **“Room is full”** — capacity limit reached (set before hosting in GUI).  
- **“Browser‑only”** — non‑browser UA detected; open from Chrome/Firefox/Safari/Edge.  
- **Cannot connect from corporate/Wi‑Fi** — add your **TURN** server with TLS.  
- **No public URL from tunnel** — check your SSH/Cloudflare client and firewall; try localhost first.  
- **WS closes immediately in Chrome** — ensure token is present and matches the WebSocket subprotocol; check `ALLOWED_ORIGINS`.

---

## 🗺 Roadmap (suggested)
- Built‑in TURN templates & provisioning scripts.  
- Push‑to‑talk, echo cancellation controls.  
- File transfer over data channels.  
- Invite links with expiring secrets.  
- Local recordings (opt‑in).

---

## 📜 License
**MIT** — free to use & modify with attribution.

---

# Русский

### Что это?
**Secret‑Call** — самохостинговое приложение для **голосовых звонков** через **WebRTC** (DTLS‑SRTP).  
Небольшой бэкенд на **Python (aiohttp + aiortc)** отдаёт фронтенд и выполняет **сигналинг по WebSocket**. Медиа‑трафик не проксируется сервером и не хранится.

---

## 🚀 Функционал (подробно)

### Звонки
- Режимы **1×1** и **Групповой** (вместимость выбирается в десктоп‑GUI перед запуском).  
- **Войти / Выйти** одной кнопкой с чёткой индикацией.  
- Живой **список участников** — обновляется при входе/выходе.  
- **Звук по участнику**: _Mute_ и _Громкость_ (локально, не влияет на других).  
- **Гигиена ICE**: отбрасываются link‑local/host‑only кандидаты на клиенте.

### Чат
- **Текстовый чат** с отметкой времени.  
- **Упоминания** `@имя` или короткий id (всплывающая подсказка, стрелки для выбора).  
- **Панель эмодзи** (сетка) — закрывается по кнопке, клику вне и клавишей **Esc**.

### Интерфейс
- Современный дизайн: **стекло**, **частицы**, **анимированные градиенты**.  
- **Тосты** для ключевых событий и ошибок.  
- **Строка статуса** подключения.  
- **Модальные окна**: «Комната переполнена», «Только из браузера».  
- **Настройки (⚙︎)**: указание **STUN**‑сервера; сохраняется в `localStorage`.

### Хостинг / Сервер
- Один процесс Python: **HTTP** для выдачи статических файлов и **WebSocket** `/ws` для сигналинга.  
- **Лимит участников**: 2 для 1×1 и до N — для группы (выбирается в GUI).  
- Опционально **публичный URL** через `localhost.run` (парсится автоматически и доступен кликом в GUI).  
- **Заголовки безопасности**: CSP, HSTS, X‑Frame‑Options, Referrer‑Policy, Permissions‑Policy (микрофон/камера).

### Десктоп‑GUI
- Небольшое приложение на **Tkinter**: запуск сервера, выбор вместимости, отображение публичной ссылки.  
- Поле **Room token** имеет дефолт **`123`** (для демо). Если задан `ROOM_TOKEN` в окружении — он приоритетнее.

> ⚠️ **Поменяйте токен** для реального использования. Значение `123` — только для первых тестов.

---

## 🧰 Технологии

```text
Бэкенд:   Python 3.11+, aiohttp (HTTP + WebSocket), aiortc (WebRTC)
Фронтенд: HTML / CSS / JS (vanilla)
Аудио:    WebRTC getUserMedia в браузере
Туннель:  OpenSSH -> localhost.run (по желанию)
GUI:      Tkinter (выбор режима/вместимости, старт сервера)
```

**Структура проекта**
```
Secret-Call/
├─ main.py
├─ gui.py
├─ core.py
├─ async_runner.py
├─ tunnel.py
├─ index.html
├─ app.js
├─ style.css
└─ icon.svg
```

---

## ⚙️ Как это работает (схема)

1. **Выдача UI** — `aiohttp` отдаёт `index.html`, `style.css`, `app.js`, `icon.svg` и открывает **WebSocket** на `/ws`.  
2. **Приветствие / список** — при подключении сервер шлёт `hello {id, roster}`. Клиент рисует список.  
3. **Вход** — нажимаете **Войти**, браузер запрашивает микрофон, клиент отправляет `name`.  
4. **SDP/ICE** — `offer` / `answer` и кандидаты `ice` ходят через сервер; медиа — **P2P**.  
5. **Проверки** — переполнение → `full {capacity}`; не‑браузер → `browser-only`.  
6. **Чат** — `{type:"chat", text, [mentions]}` показывается всем.  
7. **Выход** — останавливаются треки, закрываются соединения, UI очищается.

> Сервер сигналинга **не передаёт аудио** — только служебные JSON‑сообщения.

---

## 📦 Установка

> **Требования**: Python **3.11+**, OpenSSH в `PATH` (для публичного туннеля — опционально).

```bash
git clone https://github.com/yourname/Secret-Call.git
cd Secret-Call

python -m venv .venv
# macOS / Linux
source .venv/bin/activate
# Windows (PowerShell)
# .venv\Scripts\Activate.ps1

pip install -U pip setuptools wheel
pip install -r requirements.txt
```

Создайте `requirements.txt`, если его нет:
```txt
aiohttp>=3.9
websockets>=12
aiortc>=1.9
av>=10
sounddevice>=0.4.6
cryptography>=42
numpy>=1.26
pillow>=10
```

---

## ▶️ Запуск

```bash
python main.py
```
Откройте в браузере:
```
http://localhost:8790
```

- Введите **имя** и нажмите **Войти**.  
- Кнопка станет **Выйти**, статус — **В эфире**.

### Публичный доступ (опционально)

**Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://127.0.0.1:8790 --edge-ip-version 4
```

**localhost.run (SSH)**
```bash
ssh -tt \
  -o StrictHostKeyChecking=accept-new \
  -o ServerAliveInterval=30 \
  -R 80:127.0.0.1:8790 \
  nokey@localhost.run
```

> В `tunnel.py` можно включить **пиннинг отпечатка** сервера, чтобы избежать рисков TOFU при первом подключении.

---

## 🎛 Элементы управления

- **Войти / Выйти** — включение микрофона и запуск/остановка WebRTC‑сессий.  
- **Mute по участнику** — заглушить конкретный удалённый звук (локально).  
- **Громкость по участнику** — регулировка громкости удалённого участника (локально).  
- **Поле чата** — отправка по **Enter**.  
- **Эмодзи** — открыть/закрыть сетку; клик вставляет; закрытие по **Esc** или клику вне.  
- **Упоминания** — `@` открывает подсказки; выбор `↑/↓/Enter`.  
- **Настройки (⚙︎)** — STUN‑URL; сохраняется в `localStorage`.  
- **Тосты** — уведомления о присоединении/выходе/ошибках.

---

## 🛡️ Безопасность

### Медиа
- **DTLS‑SRTP** на медиаканале (шифрование и целостность).  
- Эфемерные ключи на каждую сессию.  
- Медиа **P2P**, для сложных NAT добавьте свой **TURN**.

### Сигналинг
- WebSocket переносит **только метаданные** (SDP/ICE/чат).  
- Сервер ставит **заголовки безопасности** (CSP, HSTS, X‑Frame‑Options, Referrer‑Policy, Permissions‑Policy).  
- Можно ограничить **Origin** через `ALLOWED_ORIGINS`.  
- Требуется **токен комнаты** через WebSocket‑сабпротокол.

### Чек‑лист усиления
1. Реверс‑прокси (Nginx/Caddy) с TLS и HSTS.  
2. `ALLOWED_ORIGINS=https://ваш.домен` (точное совпадение).  
3. Собственный **TURN** (`turns:`) c TLS; STUN оставить как fallback.  
4. Ротация логов, маскирование секретов; rate‑limit `/ws` на прокси.  
5. Поменять дефолтный токен `123` на случайный секрет.

---

## 🧪 Неполадки и их причины

- **Нет запроса микрофона** — открывайте через `http://localhost` или HTTPS (нужен безопасный контекст), дайте разрешение.  
- **«Комната переполнена»** — достигнут лимит (меняется в GUI перед стартом).  
- **«Только из браузера»** — откройте из Chrome/Firefox/Safari/Edge.  
- **Проблемы через корпоративную сеть/Wi‑Fi** — добавьте свой **TURN** с TLS.  
- **Нет публичного URL от туннеля** — проверьте клиента SSH/Cloudflare и фаервол; сначала убедитесь, что всё работает на `localhost`.  
- **WS сразу закрывается в Chrome** — проверьте токен и `ALLOWED_ORIGINS` (должен совпадать `Origin`).

---

## 🗺 Дорожная карта
- Шаблоны и скрипты для развёртывания TURN.  
- Push‑to‑talk, дополнительные аудио‑настройки.  
- Передача файлов через data‑channel.  
- Пригласительные ссылки с истекающими секретами.  
- Локальная запись (по согласию).

---

## 📜 Лицензия
**MIT** — свободное использование и модификация с указанием авторства.
