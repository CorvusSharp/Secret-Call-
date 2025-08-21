# secure_call_wss.py
# ────────────────────────────────────────────────────────────────────
# WebRTC аудиозвонок с групповым режимом (mesh до 10 пиров) и адресным сигналингом
# • HTTP сайт (/, /style.css, /icon.svg) + WS сигналинг на /ws
# • Публично: автоматический SSH-туннель (localhost.run) с TLS-терминацией
# • Аудио: 48 kHz mono int16, мини-джиттер-буферы и софт-микшер для N удалённых дорожек
# • Авто-хост/гость (UDP discovery в LAN)
# • Фильтр ICE-кандидатов отбрасывает link-local, VBox host-only и т.п.
#
# pip install aiortc av sounddevice aiohttp websockets numpy
# Запуск: python main.py
# ────────────────────────────────────────────────────────────────────

import asyncio
import json
import logging
import os
import queue
import random
import re
import socket
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Optional

import numpy as np
import sounddevice as sd
import websockets
from aiohttp import web
from av.audio.resampler import AudioResampler
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCConfiguration,
    RTCIceCandidate,
    RTCIceServer,
)
from aiortc.rtcrtpsender import RTCRtpSender
from aiortc.sdp import candidate_from_sdp

# ─── Константы ──────────────────────────────────────────────────────
HTTP_PORT = 8790
DISCOVERY_PORT = 37020
DISCOVERY_MSG = b"SECURECALL_WEBRTC_DISCOVER_V2"

SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16
FRAME_SAMPLES = 960  # 20 ms @ 48k

LOG_FILE = "securecall_webrtc.log"

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# ─── Логгер ─────────────────────────────────────────────────────────
log = logging.getLogger("SecureCallWebRTC")
if not log.handlers:
    log.setLevel(logging.INFO)
    fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    log.addHandler(fh)
    sh = logging.StreamHandler()
    sh.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s"))
    log.addHandler(sh)

# ─── Аудио настройки: локальные, по-умолчанию ──────────────────────
@dataclass
class AudioSettings:
    mic_volume: float = 1.0
    mic_muted: bool = False

# Глобальные локальные настройки для клиента Python
AUDIO_SETTINGS = AudioSettings()

# ─── Глобальные параметры сигналинга ────────────────────────────────
# Устанавливаются на старте сервера (из GUI). По умолчанию — 2 (1×1).
MAX_PEERS: int = 2
# Разрешать только браузерные подключения к /ws
REJECT_NON_BROWSER: bool = True

# Разрешённые Origin'ы (CSV в env)
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
# Токен комнаты
ROOM_TOKEN = os.environ.get("ROOM_TOKEN", "")

# ─── Утилиты ────────────────────────────────────────────────────────
def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()

async def wait_port(host: str, port: int, timeout: float = 2.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            r, w = await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)
            w.close()
            try:
                await w.wait_closed()
            except Exception:
                pass
            return True
        except OSError:
            await asyncio.sleep(0.1)
    return False

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
            s.close()
    return None

def start_udp_responder():
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
    import threading
    t = threading.Thread(target=run, name="UDPResponder", daemon=True)
    t.start()

# ─── Аудио: микрофон → WebRTC track ─────────────────────────────────
class MicTrack:
    kind = "audio"
    def __init__(self):
        self.stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
        )
        self.stream.start()
        log.info("[AUDIO] Input started")
    async def recv(self):
        data = self.stream.read(FRAME_SAMPLES)[0].tobytes()
        if AUDIO_SETTINGS.mic_muted:
            return b"\x00" * len(data)
        if AUDIO_SETTINGS.mic_volume != 1.0:
            arr = np.frombuffer(data, dtype=np.int16)
            arr = np.clip(arr * AUDIO_SETTINGS.mic_volume, -32768, 32767).astype(np.int16)
            data = arr.tobytes()
        return data
    async def stop(self):
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
        log.info("[AUDIO] Input stopped")

# ─── Аудио: проигрыватель ──────────────────────────────────────────
class AudioPlayer:
    def __init__(self):
        self.q: "queue.Queue[bytes]" = queue.Queue(maxsize=50)
        self.stream = sd.OutputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            callback=self._callback,
        )
        self.stream.start()
        log.info("[AUDIO] Output started")

    def _callback(self, outdata, frames, time_info, status):
        # Expect int16 mono frames; pull bytes from queue, convert to ndarray, pad/trim
        need_samples = frames * CHANNELS
        try:
            data = self.q.get_nowait()
        except Exception:
            outdata[:] = 0
            return
        arr = np.frombuffer(data, dtype=np.int16)
        if arr.size < need_samples:
            arr = np.pad(arr, (0, need_samples - arr.size), mode='constant')
        else:
            arr = arr[:need_samples]
        outdata[:] = arr.reshape(frames, CHANNELS)

    def put(self, pcm: bytes):
        try:
            self.q.put_nowait(pcm)
        except queue.Full:
            pass

    def close(self):
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
        log.info("[AUDIO] Output stopped")

# ─── Джиттер-буфер ─────────────────────────────────────────────────
from collections import deque
class JitterBuffer:
    def __init__(self, target_packets=4, max_packets=200):
        self.buf = deque()
        self.target = target_packets
        self.max_packets = max_packets
    def push(self, pcm: bytes):
        self.buf.append(pcm)
        while len(self.buf) > self.max_packets:
            self.buf.popleft()
    def pop(self) -> Optional[bytes]:
        if len(self.buf) >= self.target:
            return self.buf.popleft()
        return None

# ─── Софт-микшер для нескольких удалённых источников ───────────────
class AudioMixer:
    def __init__(self, player: AudioPlayer):
        self.player = player
        self.jbs: Dict[str, JitterBuffer] = {}
        self.vol: Dict[str, float] = {}
        self.muted: Dict[str, bool] = {}
        self._running = True
        self._task: Optional[asyncio.Task] = None
    def register_peer(self, peer_id: str):
        self.jbs.setdefault(peer_id, JitterBuffer(target_packets=4, max_packets=200))
        self.vol.setdefault(peer_id, 1.0)
        self.muted.setdefault(peer_id, False)
    def remove_peer(self, peer_id: str):
        self.jbs.pop(peer_id, None)
        self.vol.pop(peer_id, None)
        self.muted.pop(peer_id, None)
    def push(self, peer_id: str, pcm: bytes):
        jb = self.jbs.get(peer_id)
        if jb:
            jb.push(pcm)
    def set_volume(self, peer_id: str, v: float):
        self.vol[peer_id] = max(0.0, min(2.0, v))
    def set_muted(self, peer_id: str, m: bool):
        self.muted[peer_id] = bool(m)
    async def _loop(self):
        silence = (np.zeros(FRAME_SAMPLES, dtype=np.int16)).tobytes()
        while self._running:
            arrays = []
            for pid, jb in list(self.jbs.items()):
                chunk = jb.pop() or silence
                arr = np.frombuffer(chunk, dtype=np.int16).astype(np.int32)
                if self.muted.get(pid, False):
                    arr[:] = 0
                else:
                    arr = (arr * self.vol.get(pid, 1.0)).astype(np.int32)
                arrays.append(arr)
            if arrays:
                mix = np.sum(arrays, axis=0)
                mix = np.clip(mix, -32768, 32767).astype(np.int16)
                self.player.put(mix.tobytes())
            else:
                self.player.put(silence)
            await asyncio.sleep(FRAME_SAMPLES / SAMPLE_RATE)
    def start(self):
        if not self._task:
            self._task = asyncio.create_task(self._loop())
    async def stop(self):
        self._running = False
        if self._task:
            await self._task

# ─── HTTP и статик ─────────────────────────────────────────────────
async def http_index(request):
    return web.FileResponse(STATIC_DIR / "index.html")

async def http_style(request):
    return web.FileResponse(STATIC_DIR / "style.css")

async def http_icon(request):
    return web.FileResponse(STATIC_DIR / "icon.svg")

async def http_app(request):
    return web.FileResponse(STATIC_DIR / "app.js")

async def http_healthz(request):
    return web.Response(text="ok")

async def http_status(request):
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
    resp.headers.setdefault("Permissions-Policy", "microphone=()")
    csp = "default-src 'self'; img-src 'self' data:; style-src 'self'; connect-src 'self' wss:;"
    if "Content-Security-Policy" in resp.headers:
        resp.headers["Content-Security-Policy"] = resp.headers["Content-Security-Policy"] + "; " + csp
    else:
        resp.headers["Content-Security-Policy"] = csp
    return resp

# ─── Комната и адресный WS-сигналинг ───────────────────────────────
# ROOM: peers -> id: ws, names -> id: display name
ROOM = {"peers": {}, "names": {}}

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
    """Простейшая эвристика: пропускаем только браузерные UA."""
    if not REJECT_NON_BROWSER:
        return True
    ua = (request.headers.get("User-Agent") or "").lower()
    browser_markers = ("mozilla", "chrome", "safari", "firefox", "edg", "opr", "mobile")
    return any(m in ua for m in browser_markers)


async def http_ws(request):
    origin = request.headers.get("Origin")
    if ALLOWED_ORIGINS and origin not in ALLOWED_ORIGINS:
        log.warning("[WS] forbidden Origin: %s", origin)
        return web.Response(status=403, text="Forbidden")

    token = request.query.get("t")
    if not token or token != ROOM_TOKEN:
        log.warning("[WS] unauthorized token from %s", request.remote)
        return web.Response(status=401, text="Unauthorized")

    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=65536)
    await ws.prepare(request)

    if not _is_browser(request):
        await ws.send_json({"type": "browser-only", "reason": "Please join from a web browser"})
        await ws.close()
        return ws

    if len(ROOM["peers"]) >= MAX_PEERS:
        await ws.send_json({"type": "full", "capacity": MAX_PEERS})
        await ws.close()
        return ws

    pid = uuid.uuid4().hex
    ROOM["peers"][pid] = ws
    roster = [{"id": p, "name": ROOM["names"].get(p, "")} for p in ROOM["peers"].keys()]
    await ws.send_json({"type": "hello", "id": pid, "roster": roster})
    await _broadcast({"type": "peer-joined", "id": pid}, exclude=pid)
    log.info("[WS] peer joined: %s (total=%d)", pid, len(ROOM["peers"]))

    last_ts = 0
    msg_count = 0

    try:
        async for msg in ws:
            now = int(time.time())
            if now != last_ts:
                last_ts = now
                msg_count = 0
            if msg_count >= 20:
                if msg_count == 20:
                    log.warning("[WS] rate limit exceeded for %s", pid)
                continue
            msg_count += 1

            if msg.type == web.WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except Exception:
                    continue
                typ = data.get("type")
                if typ not in {"name", "chat", "offer", "answer", "ice"}:
                    continue

                if typ == "name":
                    ROOM["names"][pid] = data.get("name", "")[:64]
                    await _broadcast({
                        "type": "roster",
                        "roster": [
                            {"id": p, "name": ROOM["names"].get(p, "")}
                            for p in ROOM["peers"].keys()
                        ],
                    })

                elif typ == "chat":
                    text = (data.get("text") or "").strip()[:500]
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

                elif typ in {"offer", "answer"}:
                    to = data.get("to")
                    if to and to in ROOM["peers"]:
                        payload = {
                            "type": typ,
                            "from": pid,
                            "to": to,
                            "sdp": data.get("sdp"),
                            "sdpType": data.get("sdpType"),
                        }
                        try:
                            await ROOM["peers"][to].send_json(payload)
                        except Exception:
                            pass

                elif typ == "ice":
                    to = data.get("to")
                    if to and to in ROOM["peers"]:
                        payload = {
                            "type": "ice",
                            "from": pid,
                            "to": to,
                            "candidate": data.get("candidate"),
                            "sdpMid": data.get("sdpMid"),
                            "sdpMLineIndex": data.get("sdpMLineIndex"),
                        }
                        try:
                            await ROOM["peers"][to].send_json(payload)
                        except Exception:
                            pass

            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break
    finally:
        try:
            await ws.close()
        except Exception:
            pass
        ROOM["peers"].pop(pid, None)
        ROOM["names"].pop(pid, None)
        await _broadcast({"type": "peer-left", "id": pid})
        log.info("[WS] peer left: %s (total=%d)", pid, len(ROOM["peers"]))

    return ws


async def start_http_server(max_peers: int = 2):
    """Старт HTTP/WS сервера. Лимит участников задаётся параметром, по умолчанию 2."""
    global MAX_PEERS
    MAX_PEERS = max(1, min(10, int(max_peers)))
    app = web.Application(middlewares=[security_headers_mw])
    app.add_routes([
        web.get("/", http_index),
        web.get("/style.css", http_style),
        web.get("/icon.svg", http_icon),
        web.get("/app.js", http_app),
        web.get("/favicon.ico", http_icon),
        web.get("/ws", http_ws),
        web.get("/healthz", http_healthz),
        web.get("/status", http_status),
    ])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    log.info("[HTTP] http://0.0.0.0:%d (/, /style.css, /app.js, /icon.svg, /ws, /healthz, /status) — capacity=%d",
             HTTP_PORT, MAX_PEERS)

# ─── ICE утилиты ───────────────────────────────────────────────────
def _extract_ip_from_candidate(candidate_sdp: str) -> str | None:
    m = re.search(r"\scandidate:.*\s(\d+\.\d+\.\d+\.\d+)\s\d+\s", " " + candidate_sdp + " ")
    return m.group(1) if m else None

def parse_candidate_compat(cand_sdp: str, sdp_mid, sdp_mline_index):
    parsed = candidate_from_sdp(cand_sdp)
    if isinstance(parsed, RTCIceCandidate):
        parsed.sdpMid = parsed.sdpMid if getattr(parsed, "sdpMid", None) is not None else sdp_mid
        parsed.sdpMLineIndex = (
            parsed.sdpMLineIndex if getattr(parsed, "sdpMLineIndex", None) is not None else sdp_mline_index
        )
        return parsed
    return RTCIceCandidate(
        foundation=parsed["foundation"],
        component=parsed["component"],
        protocol=parsed["protocol"],
        priority=parsed["priority"],
        ip=parsed["ip"],
        port=parsed["port"],
        type=parsed["type"],
        sdpMid=sdp_mid,
        sdpMLineIndex=sdp_mline_index,
        sdp=cand_sdp,
    )

# Нормализатор ICE (исправляет 'dict' object has no attribute "urls")
def _ice_servers_from_env():
    """
    Возвращает список RTCIceServer.
    Поддерживает:
      - STUN из переменной окружения STUN="stun:host:port"
      - ICE_SERVERS как JSON:
        ICE_SERVERS='[{"urls":["stun:stun1.l.google.com:19302"]},
                      {"urls":["turn:turn.example.com"], "username":"u", "credential":"p"}]'
    """
    val = os.environ.get("ICE_SERVERS")
    servers: list[RTCIceServer] = []

    if val:
        try:
            raw = json.loads(val)
            if isinstance(raw, dict):
                raw = [raw]
            for s in raw or []:
                if isinstance(s, RTCIceServer):
                    servers.append(s)
                elif isinstance(s, dict):
                    urls = s.get("urls") or s.get("url")
                    username = s.get("username")
                    credential = s.get("credential")
                    if urls:
                        servers.append(RTCIceServer(urls=urls, username=username, credential=credential))
        except Exception as e:
            log.warning("[ICE] Failed to parse ICE_SERVERS JSON: %s", e)

    if not servers:
        stun = os.environ.get("STUN", "stun:stun.l.google.com:19302")
        servers = [RTCIceServer(urls=[stun])]

    return servers

# ─── WebRTC peer (Python сторона) — групповая mesh-схема ────────────
@dataclass
class PeerContext:
    ws_url: str   # ws://host:8790/ws
    is_initiator: bool  # сохраняем для обратной совместимости; в mesh решаем по id
    name: str = ""

async def run_peer(ctx: PeerContext):
    cfg = RTCConfiguration(iceServers=_ice_servers_from_env())
    mic = MicTrack()
    player = AudioPlayer()
    mixer = AudioMixer(player)
    mixer.start()

    # Словари по удалённым пирам
    pcs: Dict[str, RTCPeerConnection] = {}
    pumps: Dict[str, asyncio.Task] = {}

    async def close_peer(pid: str):
        pc = pcs.pop(pid, None)
        if pc:
            try:
                await pc.close()
            except Exception:
                pass
        mixer.remove_peer(pid)
        t = pumps.pop(pid, None)
        if t:
            t.cancel()

    async def make_pc(remote_id: str) -> RTCPeerConnection:
        pc = RTCPeerConnection(cfg)

        # Локальный микрофон во все pc
        sender: Optional[RTCRtpSender] = None
        if sender is None:
            sender = pc.addTrack(mic)

        # Приходящие ICE → адресно
        @pc.on("icecandidate")
        async def on_ice(candidate):
            if candidate is None:
                await ws.send(json.dumps({"type": "ice", "to": remote_id, "candidate": None}))
                return
            cand_sdp = candidate.to_sdp()
            ip = _extract_ip_from_candidate(cand_sdp) or ""
            # фильтруем мусорные
            bad = (ip.startswith("127.") or ip.startswith("169.254.") or ip.startswith("192.168.56.") or (".local" in cand_sdp))
            if bad:
                log.info("[ICE] skip %s", cand_sdp)
                return
            await ws.send(json.dumps({
                "type": "ice",
                "to": remote_id,
                "candidate": {
                    "candidate": cand_sdp,
                    "sdpMid": getattr(candidate, "sdpMid", "0"),
                    "sdpMLineIndex": getattr(candidate, "sdpMLineIndex", 0),
                },
            }))

        # Получение аудио-дорожки
        @pc.on("track")
        async def on_track(track):
            if track.kind != "audio":
                return
            mixer.register_peer(remote_id)
            resampler = AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
            async def pump():
                while True:
                    frame = await track.recv()
                    frames = resampler.resample(frame)
                    if not frames:
                        continue
                    for f in frames:
                        try:
                            pcm = f.to_ndarray().tobytes()
                        except Exception:
                            pcm = bytes(f.planes[0])
                        mixer.push(remote_id, pcm)
            pumps[remote_id] = asyncio.create_task(pump())

        pcs[remote_id] = pc
        return pc

    async with websockets.connect(ctx.ws_url) as ws:
        hello = json.loads(await ws.recv())
        if hello.get("type") != "hello":
            raise RuntimeError("Signal: unexpected first message")
        my_id = hello["id"]
        roster = [p["id"] for p in hello.get("roster", []) if p["id"] != my_id]

        # Отправляем своё имя (если задано)
        if ctx.name:
            try:
                await ws.send(json.dumps({"type": "name", "name": ctx.name}))
            except Exception:
                pass
            log.info("[USER] name sent: %s", ctx.name)

        # Правило чтобы избежать glare: инициатор — у кого меньший id
        async def maybe_call(remote_id: str):
            if my_id < remote_id:
                pc = pcs.get(remote_id) or await make_pc(remote_id)
                offer = await pc.createOffer()
                await pc.setLocalDescription(offer)
                await ws.send(json.dumps({"type": "offer", "to": remote_id,
                                          "sdp": pc.localDescription.sdp, "sdpType": pc.localDescription.type}))
                log.info("[PC] Offer → %s", remote_id)

        # Звоним всем уже в комнате по правилу
        for pid in roster:
            await maybe_call(pid)

        # Основной цикл сигналинга
        async for raw in ws:
            data = json.loads(raw)
            typ = data.get("type")

            if typ == "peer-joined":
                rid = data["id"]
                if rid != my_id:
                    await maybe_call(rid)

            elif typ == "peer-left":
                rid = data["id"]
                await close_peer(rid)

            elif typ == "offer":
                rid = data.get("from")
                if not rid:
                    continue
                pc = pcs.get(rid) or await make_pc(rid)
                offer = RTCSessionDescription(sdp=data["sdp"], type="offer")
                await pc.setRemoteDescription(offer)
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                await ws.send(json.dumps({"type": "answer", "to": rid,
                                          "sdp": pc.localDescription.sdp, "sdpType": pc.localDescription.type}))
                log.info("[PC] Answer → %s", rid)

            elif typ == "answer":
                rid = data.get("from")
                if not rid:
                    continue
                pc = pcs.get(rid)
                if not pc:
                    continue
                answer = RTCSessionDescription(sdp=data["sdp"], type="answer")
                await pc.setRemoteDescription(answer)
                log.info("[PC] Answer applied from %s", rid)

            elif typ == "ice":
                rid = data.get("from")
                if not rid:
                    continue
                pc = pcs.get(rid)
                if not pc:
                    continue
                c = data.get("candidate")
                if c is None:
                    try:
                        await pc.addIceCandidate(None)
                    except Exception:
                        pass
                    continue
                cand_sdp = (c.get("candidate") or "").strip()
                if not cand_sdp or ".local" in cand_sdp:
                    continue
                try:
                    candidate_obj = RTCIceCandidate(sdpMid=c.get('sdpMid'), sdpMLineIndex=c.get('sdpMLineIndex'), candidate=cand_sdp)
                    await pc.addIceCandidate(candidate_obj)
                except Exception as e:
                    log.info("[ICE] addIceCandidate error: %s (cand=%s)", e, c)

        # WS закрыт
        for pid in list(pcs.keys()):
            await close_peer(pid)
        await mic.stop()
        await mixer.stop()
        player.close()
        log.info("[PC] Closed all")

# ─── Экспортируем то, что использует GUI ───────────────────────────
__all__ = [
    "HTTP_PORT",
    "PeerContext",
    "get_local_ip",
    "run_peer",
    "udp_discover",
    "wait_port",
    "start_http_server",
    "start_udp_responder",
    "log",
]
