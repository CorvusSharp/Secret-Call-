# 🔮 Secret-Call  

<div align="center">

✨ **End-to-End Encrypted WebRTC Calls** ✨  
_Built with Python • Powered by the Browser_

![Static Badge](https://img.shields.io/badge/WebRTC-secure-blue?logo=webrtc)  
![Static Badge](https://img.shields.io/badge/Python-3.11+-yellow?logo=python)  
![Static Badge](https://img.shields.io/badge/license-MIT-green?logo=open-source-initiative)

</div>

---

## 🚀 Features
- 🔒 **Secure** — DTLS-SRTP, no third-party storage  
- 🌍 **Group & 1-to-1 calls** right in your browser  
- 🎨 **Futuristic UI** with particles & gradients  
- ⚡ **Self-hosted** — you stay in control  
- 🛠 **Python Backend**: aiohttp + aiortc  

---

## 🧰 Tech Stack
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

## ⚡ Quickstart

### 1. Clone
```bash
git clone https://github.com/yourname/Secret-Call.git
cd Secret-Call
```

### 2. Setup venv
```bash
# Linux / macOS
python -m venv .venv
source .venv/bin/activate

# Windows (PowerShell)
python -m venv .venv
.venv\Scripts\Activate.ps1
```

### 3. Install deps
```bash
pip install -U pip setuptools wheel
pip install -r requirements.txt
```

<details>
<summary>📦 If you don’t have <code>requirements.txt</code> yet</summary>

```txt
aiohttp>=3.9
aiortc>=1.7
websockets>=12
sounddevice>=0.4
av>=12
cryptography>=42
```
</details>

### 4. Run
```bash
python main.py
```

Then open:  
👉 **https://localhost:8790**

---

## 🌍 Public Access
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

## 🗂 Project Structure
```
Secret-Call/
├─ main.py
├─ core.py
├─ gui.py
├─ tunnel.py
├─ async_runner.py
├─ index.html
├─ style.css
└─ icon.svg
```

---

## 🧪 Checklist
- ✅ Mic permission allowed  
- ✅ Join button toggles → Leave  
- ✅ Status shows **Live**  
- ✅ Emoji panel works  
- ✅ Mentions work  
- ✅ WSS connected to `/ws`  

---

## 🆘 Troubleshooting
- **Join does nothing** → check mic permissions & HTTPS  
- **No peers** → try another STUN, or public tunnel  
- **Windows build issues** → keep `pip`, `setuptools`, `wheel` fresh  

---

## 📜 License
MIT — free to use, hack & remix  
