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
A tiny **Python (aiohttp + aiortc)** backend serves static files and **WebSocket** signaling. No third‑party storage, you control the server and the keys.

---

## 🚀 Features (Functional Overview)

### Calls
- **1×1** and **Group calls** (capacity is configurable before hosting).
- **Join / Leave** single button with clear visual states.
- **Roster** is updated live when peers join/leave.
- **Per‑peer audio controls**: _Mute_ button and _Volume_ slider (local only).

### Chat
- **In‑room text chat** with timestamps.
- **Mentions** using `@name` or short peer id (autocomplete popup).
- **Emoji picker** (grid) with close button, outside‑click & `Esc` to dismiss.

### UI / UX
- Futuristic frontend: **glassmorphism**, **particles**, **animated gradients**.
- **Toast** notifications for key events and errors.
- **Status bar** with connection state.
- **“Room is full / Browser‑only” modal** when joining is not possible.
- **Settings (⚙︎)** popover to customize **STUN** server at runtime (saved to `localStorage`).

### Hosting / Server
- **Single Python process**: serves HTML/CSS/JS and a **WebSocket** on `/ws`.
- **Capacity limit** (e.g., 2 for 1×1, or up to N for group) picked in the desktop GUI.
- Optional **public URL** via `localhost.run` SSH tunnel (auto‑parsed, clickable in GUI).

---

## 🧰 Tech Stack

```text
Backend:   Python 3.11+, aiohttp (HTTP + WebSocket), aiortc (WebRTC), cryptography
Frontend:  HTML/CSS/JS (vanilla)
Audio:     WebRTC getUserMedia in browser; sounddevice/av used only locally when needed
Tunnel:    OpenSSH -> localhost.run (optional)
GUI:       Tkinter desktop app to start the server & set capacity
```

**Project layout**
```
Secret-Call/
├─ main.py                # App entry-point (GUI + runner)
├─ gui.py                 # Tkinter GUI: mode/capacity, start hosting, tunnel link
├─ core.py                # HTTP server, WebSocket signaling, logging helpers
├─ async_runner.py        # Background task runner for async coroutines
├─ tunnel.py              # localhost.run SSH tunnel integration
├─ index.html             # Frontend (UI, WebRTC, chat, mentions, emoji)
├─ style.css              # Glassmorphism + particles + responsive layout
└─ icon.svg               # App icon
```

---

## ⚙️ How it works (Protocol sketch)

1. **Serve UI**: `aiohttp` serves `index.html`, `style.css`, `icon.svg` and opens a **WebSocket** `/ws`.
2. **Hello / roster**: When the page connects, server sends `hello {id, roster}`. The client renders peers.
3. **Join**: User clicks **Join** → browser asks for mic → client sends `name` to server.
4. **Offer/Answer**: Peers exchange SDP via server messages `offer` / `answer` and ICE candidates `ice`. Media flows **P2P**.
5. **Capacity / browser checks**: If room is full → server emits `full {capacity}`. If non‑browser agent → `browser-only`.
6. **Chat**: Text messages go over the signaling WS as `{type:"chat", text, [mentions]}` and are displayed by all peers.
7. **Leave**: Tracks are stopped, RTCPeerConnections closed, UI cleared.

> The signaling server **never forwards audio**; it only moves small JSON envelopes (hello/roster/offer/answer/ice/chat).

---

## 📦 Installation

> **Prereqs**: Python **3.11+**, OpenSSH client in PATH (for optional public tunnel).

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

Create `requirements.txt` if you don’t have one yet:
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

## ▶️ Run

```bash
python main.py
```
Open in the browser:
```
https://localhost:8790
```

- Enter your **name** and press **Join**.
- The **Join** button toggles to **Leave**; the status changes to **Live**.

### Public URL (optional)
Expose your server to the internet (useful for NAT traversal tests):

**Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

**localhost.run**
```bash
ssh -tt -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:8790 nokey@localhost.run
```

---

## 🎛 Frontend Controls

- **Join / Leave** — start/stop microphone and WebRTC sessions.
- **Per‑peer Mute** — mute a specific remote audio (local only).
- **Per‑peer Volume** — adjust remote audio loudness (local only).
- **Chat input** — press **Enter** to send.
- **Emoji button** — toggle emoji grid; click to insert.
- **Mentions** — type `@` to open suggestions; `↑/↓/Enter` to choose.
- **Settings (⚙︎)** — set **STUN** URL; saved to browser `localStorage`.
- **Esc** — close emoji and mentions popovers.
- **Toasts** — short notifications (joined, left, errors).

---

## 🛡️ Security (Deep dive) & Comparison

### Media security
- **DTLS‑SRTP** on the media path = encryption and integrity for voice packets.
- **Ephemeral keys** negotiated per session; no static keys stored server‑side.
- **Peer‑to‑peer** media when possible; otherwise you may add TURN (not included by default).

### Signaling channel
- WebSocket signaling carries **only metadata** (SDP, ICE, simple chat text).
- No audio content traverses the server.
- You control logging policies and retention on your own host.

### Hardening checklist
- Run behind a reverse proxy (Nginx/Caddy) with TLS.
- Restrict allowed origins for the WebSocket.
- Provide your **own TURN** for symmetric‑NAT scenarios (e.g., coturn).
- Keep dependencies up‑to‑date; rotate certificates; monitor logs.

### How safe is it vs popular apps?
| Aspect | Secret‑Call (self‑hosted) | WhatsApp / Telegram (calls) | Zoom / Google Meet |
|---|---|---|---|
| Media crypto | DTLS‑SRTP (WebRTC standard) | DTLS‑SRTP (or equivalent) | DTLS‑SRTP |
| Hosting | **Your server** | Vendor cloud | Vendor cloud |
| TURN infra | Optional, you provide | Global vendor infra | Global vendor infra |
| Code transparency | Open Python & JS | Closed‑source (parts) | Closed‑source |
| Metadata control | **You** decide | Vendor policies | Vendor policies |

> **Bottom line:** When deployed correctly, Secret‑Call uses the **same cryptographic standards** for the audio path as major apps, with the advantage that **you** own the server and logs. Overall security still depends on your device hygiene, server hardening and network setup.

---



## 🗺 Roadmap (suggested)
- Built‑in TURN templates & provisioning.
- Push‑to‑talk, echo cancellation controls.
- File transfer over data channels.
- Invite links with room secrets.
- Recordings (local, opt‑in).

---

## 📜 License
**MIT** — free to use & modify with attribution.


---

# Русский

### Что это?
**Secret‑Call** — это приложение для **голосовых звонков** через **WebRTC** (DTLS‑SRTP) с **самостоятельным хостингом**.  
Небольшой бэкенд на **Python (aiohttp + aiortc)** отдает фронтенд и выполняет **сигналинг по WebSocket**. Медиа‑трафик не хранится на сервере и не проксируется через него.

---

## 🚀 Функционал (подробно)

### Звонки
- Режимы **1×1** и **Групповой** (вместимость задаётся перед запуском комнаты).
- **Войти / Выйти** одной кнопкой с чёткой индикацией.
- **Живой список участников** с обновлением при входе/выходе.
- **Управление звуком по участнику**: _Mute_ и _Громкость_ (влияет только на ваш клиент).

### Чат
- **Текстовый чат** с временем отправки.
- **Упоминания** `@имя` или короткий id (всплывающая подсказка, навигация стрелками).
- **Панель эмодзи** (сетка) с кнопкой закрытия, закрывается кликом вне и клавишей `Esc`.

### Интерфейс
- Современный дизайн: **стекло**, **частицы**, **градиенты**.
- **Тосты** (уведомления) о ключевых событиях.
- **Строка статуса** подключения.
- **Модальные окна**: «Комната переполнена», «Только из браузера».
- **Настройки (⚙︎)**: указание **STUN**‑сервера; сохраняется в `localStorage`.

### Хостинг / Сервер
- Один процесс Python: **HTTP** + **WebSocket** на `/ws`.
- **Лимит участников** (2 для 1×1 или до N для группы) задаётся в десктоп‑GUI.
- Опционально **публичный URL** через `localhost.run` (линк парсится и выводится в GUI).

---

## 🧰 Технологии

```text
Бэкенд:    Python 3.11+, aiohttp (HTTP + WebSocket), aiortc (WebRTC), cryptography
Фронтенд:  HTML/CSS/JS (vanilla)
Аудио:     WebRTC getUserMedia в браузере; sounddevice/av — при необходимости локально
Туннель:   OpenSSH -> localhost.run (по желанию)
GUI:       Tkinter-приложение для запуска сервера и выбора вместимости
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
├─ style.css
└─ icon.svg
```

---

## ⚙️ Как это работает (схема)

1. **Выдача UI**: `aiohttp` отдаёт файлы и открывает **WebSocket** `/ws`.
2. **Приветствие / список**: при подключении клиент получает `hello {id, roster}`.
3. **Вход**: нажимаете **Войти** → браузер запрашивает микрофон → клиент отправляет `name`.
4. **Обмен SDP**: сообщения `offer` / `answer` и ICE‑кандидаты `ice` идут через сервер; медиа — **P2P**.
5. **Проверки**: при переполнении — `full {capacity}`; если не браузер — `browser-only`.
6. **Чат**: сообщения — `{type:"chat", text, [mentions]}`; все их отображают.
7. **Выход**: локальные треки останавливаются, соединения закрываются, UI очищается.

> Сервер сигналинга **не передаёт аудио** — только служебные JSON‑пакеты.

---

## 📦 Установка

> **Требования**: Python **3.11+**, OpenSSH в `PATH` (для публичного туннеля — по желанию).

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
https://localhost:8790
```

- Введите **имя** и нажмите **Войти**.
- Кнопка станет **Выйти**, статус — **В эфире**.

### Публичный доступ (опционально)
Откройте сервер наружу (удобно для теста NAT):

**Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

**localhost.run**
```bash
ssh -tt -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:8790 nokey@localhost.run
```

---

## 🎛 Элементы управления

- **Войти / Выйти** — включить/выключить микрофон и WebRTC‑сессии.
- **Mute по участнику** — заглушить конкретного человека (локально).
- **Громкость по участнику** — регулировка громкости удалённого аудио (локально).
- **Поле чата** — отправка по **Enter**.
- **Кнопка эмодзи** — открыть/закрыть сетку; клик вставляет символ.
- **Упоминания** — `@` открывает подсказки; выбор `↑/↓/Enter`.
- **Настройки (⚙︎)** — указание **STUN**‑сервера; сохраняется в `localStorage`.
- **Esc** — закрыть панели эмодзи и упоминаний.
- **Тосты** — краткие уведомления (присоединился, вышел, ошибка).

---

## 🛡️ Безопасность и сравнение

### Защита медиа
- **DTLS‑SRTP** на медиаканале (шифрование и контроль целостности).
- **Эфемерные ключи** для каждой сессии; сервер не хранит ключи.
- Медиа стремится к **P2P**; при «жёстком» NAT — добавьте собственный **TURN** (не входит по умолчанию).

### Сигналинг
- WebSocket переносит **только метаданные** (SDP, ICE, текст чата).
- Сервер не проксирует аудио; вы контролируете логи и политику хранения.

### Чеклист усиления
- Запускайте за реверс‑прокси с TLS (Nginx/Caddy).
- Ограничьте допустимые **Origin** для WebSocket.
- Разверните свой **TURN** (например, coturn) для сложных NAT.
- Обновляйте зависимости, ротуйте сертификаты, мониторьте логи.

### Насколько безопасно в сравнении?
| Критерий | Secret‑Call (self‑hosted) | WhatsApp / Telegram (calls) | Zoom / Google Meet |
|---|---|---|---|
| Шифрование медиа | DTLS‑SRTP (WebRTC) | DTLS‑SRTP (или экв.) | DTLS‑SRTP |
| Хостинг | **Ваш сервер** | Облако вендора | Облако вендора |
| TURN‑инфра | Опционально, на вашей стороне | Глобальная вендора | Глобальная вендора |
| Прозрачность | Открытый Python/JS | Частично закрытые | Закрытые |
| Метаданные | **Вы** решаете | Политики вендора | Политики вендора |

> **Итог:** При корректном развёртывании Secret‑Call применяет те же крипто‑стандарты для аудио, что и крупные приложения, а контроль за сервером/логами остаётся у вас.

---



## 🗺 Дорожная карта (предложение)
- Готовые шаблоны и скрипты для TURN.
- Push‑to‑talk, дополнительные аудио‑настройки.
- Передача файлов через data‑channel.
- Пригласительные ссылки с секретами комнаты.
- Локальная запись (по согласию).

---

## 📜 Лицензия
**MIT** — свободное использование и модификация с указанием авторства.
