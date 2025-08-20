# 🔒 Secret-Call — Secure WebRTC Calls

[🇬🇧 English](#english) | [🇷🇺 Русский](#русский)

---

## English

### 🚀 About the Project
**Secret-Call** is a secure, peer-to-peer voice calling application built on **WebRTC** and **Python (aiohttp, aiortc)**.  
It allows you to make **end-to-end encrypted calls** directly in the browser, without third-party servers storing your data.

The main goal:  
- Provide a **simple**, **secure**, and **self-hosted** alternative to popular messengers like Telegram or WhatsApp.  
- Fully **open-source** and **self-controlled**.  

---

### 🛠️ Technologies
- **Python 3.11+**
- **aiohttp** — async web server
- **aiortc** — WebRTC implementation for Python
- **sounddevice** — audio input/output
- **WebSockets** — signaling channel
- **HTML + CSS + JS** (frontend)
- **Cloudflare Tunnel / localhost.run** (optional public access)

---

### 🔧 Installation

Clone the repo:
```bash
git clone https://github.com/yourname/Secret-Call.git
cd Secret-Call
```

Create venv:
```bash
python -m venv venv
source venv/bin/activate   # Linux / Mac
venv\Scripts\activate      # Windows
```

Install requirements:
```bash
pip install -r requirements.txt
```

---

### ▶️ Usage

Start server:
```bash
python main.py
```

Then open in your browser:
```
https://localhost:8790
```

You can choose how many participants are allowed (1x1 or group) **before launching the server**.  
If the limit is reached, new users will see a styled popup in the browser:  
❌ *"The room is full, please try again later."*

---

### 🌍 Public Access

If you want to allow external users:
```bash
cloudflared tunnel --url http://127.0.0.1:8790
```
or
```bash
ssh -R 80:127.0.0.1:8790 nokey@localhost.run
```

---

### 🔐 Security
- All calls are encrypted with **DTLS-SRTP**  
- No call metadata stored on server  
- Self-hosted → you are in full control  

---

### 📂 Project Structure
```
Secret-Call/
├── main.py                # Entry point
├── core.py                # Core logic (WebRTC sessions)
├── gui.py                 # GUI control (slider for participants)
├── tunnel.py              # Tunnel integrations
├── async_runner.py        # Async helper
├── static/                # Frontend files
│   ├── index.html
│   ├── style.css
│   └── icon.svg
└── README.md
```

---

### 📜 License
MIT License — free to use and modify.

---

## Русский

### 🚀 О проекте
**Secret-Call** — это безопасное приложение для голосовых звонков, построенное на **WebRTC** и **Python (aiohttp, aiortc)**.  
Оно позволяет совершать **сквозное зашифрованное соединение** прямо в браузере, без участия сторонних серверов.

Главная цель:  
- Дать простую и **надёжную альтернативу** мессенджерам вроде Telegram и WhatsApp.  
- Полный **open-source** и **контроль у владельца сервера**.  

---

### 🛠️ Технологии
- **Python 3.11+**
- **aiohttp** — асинхронный веб-сервер
- **aiortc** — реализация WebRTC на Python
- **sounddevice** — ввод/вывод аудио
- **WebSockets** — канал сигналинга
- **HTML + CSS + JS** — фронтенд часть
- **Cloudflare Tunnel / localhost.run** — для публичного доступа

---

### 🔧 Установка

Клонировать проект:
```bash
git clone https://github.com/yourname/Secret-Call.git
cd Secret-Call
```

Создать виртуальное окружение:
```bash
python -m venv venv
source venv/bin/activate   # Linux / Mac
venv\Scripts\activate      # Windows
```

Установить зависимости:
```bash
pip install -r requirements.txt
```

---

### ▶️ Запуск

Запустить сервер:
```bash
python main.py
```

Открыть в браузере:
```
https://localhost:8790
```

Перед запуском можно выбрать, **сколько максимум участников** будет в звонке (1х1 или групповая).  
Если лимит превышен, пользователь увидит в браузере красивое окно:  
❌ *"Комната переполнена, попробуйте позже."*

---

### 🌍 Публичный доступ

Для подключения извне можно использовать туннель:
```bash
cloudflared tunnel --url http://127.0.0.1:8790
```
или
```bash
ssh -R 80:127.0.0.1:8790 nokey@localhost.run
```

---

### 🔐 Безопасность
- Все звонки зашифрованы протоколом **DTLS-SRTP**  
- Сервер не хранит метаданные  
- Самостоятельный хостинг = полный контроль у вас  

---

### 📂 Структура проекта
```
Secret-Call/
├── main.py                # Точка входа
├── core.py                # Логика WebRTC
├── gui.py                 # Интерфейс (слайдер для участников)
├── tunnel.py              # Интеграция туннелей
├── async_runner.py        # Хелпер для асинхронного запуска
├── static/                # Файлы фронтенда
│   ├── index.html
│   ├── style.css
│   └── icon.svg
└── README.md
```
