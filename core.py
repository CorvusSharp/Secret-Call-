# core.py
# ────────────────────────────────────────────────────────────────────
# WebRTC сигналинг-сервер (групповые звонки mesh до 10 пиров)
# • HTTP: (/, /style.css, /icon.svg, /js/*) + WS сигналинг на /ws
# • UDP discovery для локальной сети (хост/гость)
# • Безопасность: whitelist Origin, токен через WS subprotocol, антифлуд,
#   чистые логи (без SDP/ICE/токенов/чат-текста), строгие security headers.
# Запуск: импортируйте start_http_server() из main.py
# ────────────────────────────────────────────────────────────────────

import asyncio
import json
import logging
import os
import re
import socket
import time
import uuid
from pathlib import Path
from typing import Dict, Optional

import time
from collections import defaultdict, deque
from aiohttp import web

from aiohttp import web

# ─── Константы ──────────────────────────────────────────────────────
HTTP_PORT = 8790

DISCOVERY_PORT = 37020
DISCOVERY_MSG = b"SECURECALL_WEBRTC_DISCOVER_V2"

LOG_FILE = "securecall_webrtc.log"

# Лимиты / безопасность
MAX_MSG_SIZE = 64 * 1024  # 64 KB для WS
MAX_MSGS_PER_SEC = 20     # антифлуд per-peer
MAX_CHAT_LEN = 500
MAX_NAME_LEN = 64
MAX_PEERS: int = 10        # лимит участников комнаты

REJECT_NON_BROWSER: bool = True  # пускать только браузеры

TS_SKEW_SEC = 20           # <= 20 секунд допускаем
# Глубина памяти по ts для защиты от повторной доставки
REPLAY_WINDOW = 64         # сколько последних ts держим на отправителя

RL_MAX_REQ = int(os.environ.get("RL_MAX_REQ", "30"))          # запросов
RL_WINDOW_SEC = int(os.environ.get("RL_WINDOW_SEC", "60"))    # в секундах
_http_rl = defaultdict(lambda: deque())  # ip -> deque[timestamps]

# replay_guard[room_token][sender_id] = {"last": int, "recent": deque([...])}
replay_guard = defaultdict(lambda: defaultdict(lambda: {"last": 0, "recent": deque(maxlen=REPLAY_WINDOW)}))


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# Разрешённые Origin'ы (CSV в env: "https://site1,https://site2")
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
# Токен комнаты; пусто => режим без проверки токена
ROOM_TOKEN = os.environ.get("ROOM_TOKEN", "")

# ─── Логгер ─────────────────────────────────────────────────────────
log = logging.getLogger("SecureCallWebRTC")
if not log.handlers:
    # В проде по умолчанию WARNING, включите DEBUG=1 для подробных логов
    log.setLevel(logging.INFO if os.environ.get("DEBUG") == "1" else logging.WARNING)
    fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    log.addHandler(fh)
    sh = logging.StreamHandler()
    sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    log.addHandler(sh)

# ─── Утилиты ────────────────────────────────────────────────────────
def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        try: s.close()
        except Exception: pass

async def wait_port(host: str, port: int, timeout: float = 2.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
            w.close()
            try: await w.wait_closed()
            except Exception: pass
            return True
        except OSError:
            await asyncio.sleep(0.1)
    return False


def validate_ts(room: str, sender_id: str, ts: int) -> bool:
    """
    Возвращает True, если метка времени валидна:
      - присутствует и является int/float
      - не выходит за допуск по сдвигу часов
      - монотонно возрастает для данного sender_id внутри комнаты
      - не повторяется в недавнем окне (anti-replay)
    """
    try:
        t_client = float(ts) / (1000.0 if ts > 10_000_000_000 else 1.0)  # поддержим ms и sec
    except Exception:
        return False

    now = time.time()
    if abs(now - t_client) > TS_SKEW_SEC:
        return False

    st = replay_guard[room][sender_id]
    # жёсткая монотония: новый ts должен быть > последнего
    if t_client <= st["last"]:
        return False

    # защита от повторов: точное совпадение ts в окне
    if st["recent"] and any(abs(t_client - x) < 1e-6 for x in st["recent"]):
        return False

    st["last"] = t_client
    st["recent"].append(t_client)
    return True


# ─── UDP discovery ─────────────────────────────────────────────────
async def udp_discover(timeout=1.0, attempts=3):
    for _ in range(attempts):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        s.settimeout(timeout)
        try:
            s.sendto(DISCOVERY_MSG, ("255.255.255.255", DISCOVERY_PORT))
            data, addr = s.recvfrom(4096)
            try:
                info = json.loads(data.decode("utf-8"))
            except Exception:
                info = None
            if isinstance(info, dict) and info.get("role") == "host":
                info["host"] = addr[0]
                return info
        except Exception:
            pass
        finally:
            try: s.close()
            except Exception: pass
    return None

def start_udp_responder():
    import threading
    def run():
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("0.0.0.0", DISCOVERY_PORT))
        except Exception as e:
            log.warning("[UDP] bind failed: %s", e)
            return
        log.info("[UDP] discovery responder on %s", DISCOVERY_PORT)
        while True:
            try:
                data, addr = s.recvfrom(4096)
                if data == DISCOVERY_MSG:
                    resp = json.dumps({"role": "host", "port": HTTP_PORT}).encode("utf-8")
                    s.sendto(resp, addr)
            except Exception:
                pass
    t = threading.Thread(target=run, name="UDPResponder", daemon=True)
    t.start()

# ─── HTTP и статик ─────────────────────────────────────────────────
async def http_index(request):
    return web.FileResponse(STATIC_DIR / "index.html")

async def http_style(request):
    return web.FileResponse(STATIC_DIR / "style.css")

async def http_icon(request):
    return web.FileResponse(STATIC_DIR / "icon.svg")

async def http_app(request):
    # опциональный общий бандл; основные файлы лежат в /static/js/*
    return web.FileResponse(STATIC_DIR / "app.js")

async def http_healthz(request):
    return web.Response(text="ok")

async def http_status(request):
    # простой статус-эндпоинт, можно защитить заголовком
    if os.environ.get("ADMIN_STATUS") == "1":
        secret = os.environ.get("STATUS_SECRET", "")
        if secret and request.headers.get("X-Status-Secret") == secret:
            return web.json_response({"peers": len(ROOM["peers"]), "capacity": MAX_PEERS, "ok": True})
    return web.json_response({"ok": True})

@web.middleware
async def security_headers_mw(request, handler):
    resp = await handler(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Strict-Transport-Security", "max-age=15552000")
    resp.headers.setdefault("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()")
    csp = (
        "default-src 'self'; "
        "script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "connect-src 'self' ws: wss:; "
        "base-uri 'none'; frame-ancestors 'none'"
    )
    if "Content-Security-Policy" in resp.headers:
        resp.headers["Content-Security-Policy"] = resp.headers["Content-Security-Policy"] + "; " + csp
    else:
        resp.headers["Content-Security-Policy"] = csp
    return resp

@web.middleware
async def rate_limit_mw(request, handler):
    path = request.path
    # Ограничиваем только статусные эндпоинты
    if path not in ("/status", "/healthz"):
        return await handler(request)

    ip = request.headers.get("X-Forwarded-For", request.remote or "unknown").split(",")[0].strip()
    now = time.time()
    dq = _http_rl[ip]

    # выкидываем устаревшие метки
    while dq and now - dq[0] > RL_WINDOW_SEC:
        dq.popleft()

    if len(dq) >= RL_MAX_REQ:
        return web.Response(status=429, text="Too Many Requests")

    dq.append(now)
    return await handler(request)



# ─── Комната и адресный WS-сигналинг ───────────────────────────────
ROOM: Dict[str, Dict] = {"peers": {}, "names": {}}

async def _broadcast(payload: dict, exclude: Optional[str] = None):
    dead = []
    for pid, ws in list(ROOM["peers"].items()):
        if exclude and pid == exclude:
            continue
        try:
            await ws.send_json(payload)
        except Exception:
            dead.append(pid)
    for pid in dead:
        try:
            await ROOM["peers"][pid].close()
        except Exception:
            pass
        ROOM["peers"].pop(pid, None)
        ROOM["names"].pop(pid, None)

def _is_browser(request) -> bool:
    """
    Допускаем только браузеры, если включено REJECT_NON_BROWSER.
    """
    if not REJECT_NON_BROWSER:
        return True
    ua = (request.headers.get("User-Agent") or "").lower()
    markers = ("mozilla", "chrome", "safari", "firefox", "edg", "opr", "mobile")
    return any(m in ua for m in markers)

async def http_ws(request):
    # ── Origin whitelist ─────────────────────────────────────────────
    origin = request.headers.get("Origin")
    if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
        log.warning("[WS] forbidden Origin: %s", origin)
        return web.Response(status=403, text="Forbidden")

    # ── Token из subprotocol (основной способ) или query (?t=) для совместимости
    expected = ROOM_TOKEN  # может быть пустым
    offered = (request.headers.get("Sec-WebSocket-Protocol") or "")
    offered_items = [x.strip() for x in offered.split(",") if x.strip()]

    proto_token = None
    matched_item = None
    for item in offered_items:
        if expected:
            if item == expected or (item.startswith("token.") and item.split("token.", 1)[1] == expected):
                proto_token = expected
                matched_item = item
                break
        else:
            if item and item != "null":
                proto_token = item
                matched_item = item
                break

    qtok = request.query.get("t", "")

    authed = (proto_token == expected or qtok == expected) if expected else True
    if not authed:
        log.warning("[WS] unauthorized token from %s", request.remote)
        return web.Response(status=401, text="Unauthorized")

    # ── Только браузеры ──────────────────────────────────────────────
    if not _is_browser(request):
        ws_tmp = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG_SIZE)
        await ws_tmp.prepare(request)
        await ws_tmp.send_json({"type": "browser-only", "reason": "Please join from a web browser"})
        await ws_tmp.close()
        return ws_tmp

    # ── Лимит вместимости ────────────────────────────────────────────
    if len(ROOM["peers"]) >= MAX_PEERS:
        ws_tmp = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG_SIZE)
        await ws_tmp.prepare(request)
        await ws_tmp.send_json({"type": "full", "capacity": MAX_PEERS})
        await ws_tmp.close()
        return ws_tmp

    # ── Эхо выбора субпротокола (важно для Chrome) ───────────────────
    if matched_item:
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG_SIZE, protocols=[matched_item])
    elif offered_items:
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG_SIZE, protocols=[offered_items[0]])
    else:
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_MSG_SIZE)

    await ws.prepare(request)

    # 2.1: привязка «room» к WS-сессии + заготовка peer id
    ws._room_token = matched_item or request.query.get("t", "") or ROOM_TOKEN or "default"
    ws._peer_id = None

    # ── Регистрация пира ─────────────────────────────────────────────
    pid = uuid.uuid4().hex
    ws._peer_id = pid  # для anti-replay/очистки
    ROOM["peers"][pid] = ws
    roster = [{"id": p, "name": ROOM["names"].get(p, "")} for p in ROOM["peers"].keys()]
    await ws.send_json({"type": "hello", "id": pid, "roster": roster})
    await _broadcast({"type": "peer-joined", "id": pid}, exclude=pid)
    log.info("[WS] peer joined: %s (total=%d)", pid[:6], len(ROOM["peers"]))

    # ── Антифлуд ─────────────────────────────────────────────────────
    last_ts = 0
    msg_count = 0

    try:
        async for msg in ws:
            now_sec = int(time.time())
            if now_sec != last_ts:
                last_ts = now_sec
                msg_count = 0
            if msg_count >= MAX_MSGS_PER_SEC:
                if msg_count == MAX_MSGS_PER_SEC:
                    log.warning("[WS] rate limit exceeded for %s", pid[:6])
                continue
            msg_count += 1

            if msg.type != web.WSMsgType.TEXT:
                if msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                    break
                continue

            # Безопасный парсинг
            try:
                data = json.loads(msg.data)
            except Exception:
                continue

            typ = data.get("type")
            # Разрешённые типы
            if typ not in {"name", "chat", "offer", "answer", "ice", "key", "chat-e2e", "safety-ok"}:
                continue

            if typ == "name":
                ROOM["names"][pid] = (data.get("name") or "")[:MAX_NAME_LEN]
                await _broadcast({
                    "type": "roster",
                    "roster": [{"id": p, "name": ROOM["names"].get(p, "")} for p in ROOM["peers"].keys()],
                })
                continue

            if typ == "chat":
                text = (data.get("text") or "").strip()[:MAX_CHAT_LEN]
                if not text:
                    continue
                payload = {
                    "type": "chat",
                    "from": pid,
                    "name": ROOM["names"].get(pid, ""),
                    "text": text,
                    "ts": int(time.time() * 1000),
                }
                await _broadcast(payload)
                continue

            # Адресные сообщения
            to_id = data.get("to")
            if not to_id or to_id not in ROOM["peers"]:
                continue

            # 2.2: server-side anti-replay ts check для адресных сообщений
            room = getattr(ws, "_room_token", "default")
            sender_id = getattr(ws, "_peer_id", "")
            ts_val = data.get("ts", 0)
            if not validate_ts(room, sender_id, ts_val):
                # log.debug("[anti-replay] drop %s from %s: bad ts=%r", typ, sender_id[:6], ts_val)
                continue

            if typ == "ice":
                cand = data.get("candidate", None)
                if cand is not None and not isinstance(cand, dict):
                    continue
                # candidate/sdp не логируем

            payload = dict(data)
            payload["from"] = pid
            try:
                await ROOM["peers"][to_id].send_json(payload)
                log.info("[WS→%s] %s (from=%s)", to_id[:6], typ, pid[:6])
            except Exception as e:
                log.warning("[WS] forward %s to %s failed: %s", typ, to_id[:6], e)

    finally:
        try:
            await ws.close()
        except Exception:
            pass
        ROOM["peers"].pop(pid, None)
        ROOM["names"].pop(pid, None)
        await _broadcast({"type": "peer-left", "id": pid})
        log.info("[WS] peer left: %s (total=%d)", pid[:6], len(ROOM["peers"]))

        # 2.3: очистка состояния anti-replay для этого пользователя
        try:
            room = getattr(ws, "_room_token", "default")
            _ = replay_guard.get(room, None)
            if _ is not None:
                replay_guard[room].pop(pid, None)
                if not replay_guard[room]:
                    replay_guard.pop(room, None)
        except Exception:
            pass

    return ws


# ─── HTTP сервер ───────────────────────────────────────────────────
async def start_http_server(max_peers: int = 2):
    """
    Старт HTTP/WS сервера. Лимит участников задаётся параметром, по умолчанию 2.
    """
    global MAX_PEERS
    MAX_PEERS = max(1, min(10, int(max_peers)))

    app = web.Application(middlewares=[security_headers_mw, rate_limit_mw])
    app.add_routes([
        web.get("/", http_index),
        web.get("/ws", http_ws),
        web.get("/healthz", http_healthz),
        web.get("/status", http_status),
        web.get("/app.js", http_app),           # опционально
        web.get("/style.css", http_style),
        web.get("/icon.svg", http_icon),
    ])
    app.router.add_static("/js/", path=str(STATIC_DIR / "js"), show_index=False)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    log.info("[HTTP] http://0.0.0.0:%d (/, /style.css, /app.js, /icon.svg, /ws, /healthz, /status) — capacity=%d",
             HTTP_PORT, MAX_PEERS)


# ─── Экспорт ────────────────────────────────────────────────────────
__all__ = [
    "HTTP_PORT",
    "get_local_ip",
    "udp_discover",
    "wait_port",
    "start_http_server",
    "start_udp_responder",
    "log",
]
