# 🔮 Secret-Call  

<div align="center">

✨ **End-to-End Encrypted WebRTC Calls** ✨  
_Built with Python • Powered by the Browser_

[🇬🇧 English](#english) | [🇷🇺 Русский](#русский)

![Static Badge](https://img.shields.io/badge/WebRTC-secure-blue?logo=webrtc)  
![Static Badge](https://img.shields.io/badge/Python-3.11+-yellow?logo=python)  
![Static Badge](https://img.shields.io/badge/license-MIT-green?logo=open-source-initiative)

</div>

---

## English

### 🚀 Features
- 🔒 **Secure** — DTLS-SRTP, no third-party storage  
- 🌍 **Group & 1-to-1 calls** right in your browser  
- 🎨 **Futuristic UI** with particles & gradients  
- ⚡ **Self-hosted** — you stay in control  
- 🛠 **Python Backend**: aiohttp + aiortc  

---

### 🧰 Tech Stack
```text
Python 3.11+
├─ aiohttp       → async web server + WebSocket signaling
├─ aiortc        → WebRTC (SDP, ICE, SRTP)
├─ sounddevice   → optional local audio
├─ av            → media handling
└─ cryptography  → security layer
```

Frontend:
- HTML5 / CSS3 (glassmorphism + particles)
- Vanilla JS (WebRTC, chat, emoji, mentions)

---

### ⚡ Quickstart

1. Clone
```bash
git clone https://github.com/yourname/Secret-Call.git
cd Secret-Call
```

2. Setup venv
```bash
# Linux / macOS
python -m venv .venv
source .venv/bin/activate

# Windows (PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1
```

3. Install deps
```bash
pip install -U pip setuptools wheel
pip install -r requirements.txt
```



4. Run
```bash
python main.py
```
👉 Open: **https://localhost:8790**

---

### 🌍 Public Access
Expose to the world:

**Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

**localhost.run**
```bash
ssh -R 80:127.0.0.1:8790 nokey@localhost.run
```

---

### 🛡️ Security & Comparison

- **WebRTC Security**: Uses DTLS-SRTP (Datagram Transport Layer Security + Secure RTP). This is the **same standard** used by Google Meet, Zoom, WhatsApp and Telegram.  
- **Signaling server**: Only coordinates peers. Media streams (audio) never pass through the server, they go **peer-to-peer** (if NAT allows).  
- **E2E encryption**: Packets are encrypted with ephemeral keys negotiated via DTLS, making interception nearly impossible without device compromise.  
- **Compared to WhatsApp / Telegram**:  
  - ✅ Our app does not rely on central servers — you host it yourself.  
  - ✅ Transparency: open Python code, you see exactly what happens.  
  - ⚠️ Unlike WhatsApp, no global TURN infrastructure is provided out of the box. If peers are behind strict NAT, you may need your own TURN server.  

**Verdict:** As secure as commercial messengers, but you hold the keys because it’s **self-hosted**.

---

### 📜 License
MIT — free to use, hack & remix  

---

# Русский

### 🚀 Возможности
- 🔒 **Безопасно** — DTLS-SRTP, без сторонних серверов  
- 🌍 **Групповые и 1-на-1 звонки** прямо в браузере  
- 🎨 **Футуристичный интерфейс** (градиенты, партиклы, эмодзи)  
- ⚡ **Самостоятельный хостинг** — полный контроль у вас  
- 🛠 **Python Backend**: aiohttp + aiortc  

---

### 🧰 Технологический стек
```text
Python 3.11+
├─ aiohttp       → асинхронный сервер и WebSocket-сигналинг
├─ aiortc        → WebRTC (SDP, ICE, SRTP)
├─ sounddevice   → локальное аудио
├─ av            → медиа-обработка
└─ cryptography  → шифрование
```

Фронтенд:
- HTML5 / CSS3 (glassmorphism, частицы)
- Vanilla JS (WebRTC, чат, эмодзи, упоминания)

---

### ⚡ Быстрый старт

1. Клонировать репозиторий
```bash
git clone https://github.com/yourname/Secret-Call.git
cd Secret-Call
```

2. Создать окружение
```bash
# Linux / macOS
python -m venv .venv
source .venv/bin/activate

# Windows (PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1
```

3. Установить зависимости
```bash
pip install -U pip setuptools wheel
pip install -r requirements.txt
```



4. Запустить
```bash
python main.py
```
👉 Открыть в браузере: **https://localhost:8790**

---

### 🌍 Публичный доступ

**Cloudflare Tunnel**
```bash
cloudflared tunnel --url http://127.0.0.1:8790
```

**localhost.run**
```bash
ssh -R 80:127.0.0.1:8790 nokey@localhost.run
```

---

### 🛡️ Безопасность и сравнение

- **WebRTC Security**: Используется DTLS-SRTP — тот же протокол, что и в WhatsApp, Zoom, Google Meet.  
- **Сервер сигналинга**: только координирует соединение. Аудиопотоки идут напрямую **peer-to-peer**.  
- **E2E-шифрование**: ключи генерируются динамически через DTLS. Подслушивание невозможно без доступа к устройству.  
- **По сравнению с WhatsApp / Telegram**:  
  - ✅ Нет централизации — вы сами хостите систему.  
  - ✅ Прозрачность кода.  
  - ⚠️ Для обхода NAT может понадобиться собственный TURN-сервер.  

**Итог:** Уровень безопасности сопоставим с крупными мессенджерами, но контроль полностью у вас.

---

### 📜 Лицензия
MIT — свободное использование и модификация.
