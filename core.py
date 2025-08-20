# secure_call_wss.py
# ────────────────────────────────────────────────────────────────────
# WebRTC-аудиозвонок «в одну кнопку» + авто-туннель localhost.run (универсально)
# • Локально: HTTP сайт (http://<host>:8790) + WS сигналинг на /ws
# • Публично: автоматический SSH-туннель (localhost.run) с TLS-терминацией
# • Аудио: 48 kHz mono int16, мини-джиттер-буфер
# • Авто-хост/гость (UDP discovery в LAN)
# • Фильтр ICE-кандидатов отбрасывает link-local, VBox host-only и пр.
#
# pip install aiortc av sounddevice aiohttp websockets
# Запуск: python secure_call_wss.py
# ────────────────────────────────────────────────────────────────────

import asyncio
import json
import logging
import queue
import socket
import threading
import time
import collections
import re
import sys
import os
from dataclasses import dataclass
from fractions import Fraction

import numpy as np
import sounddevice as sd
import websockets
from aiortc import (
    RTCPeerConnection,
    RTCSessionDescription,
    RTCIceCandidate,
    RTCConfiguration,
    RTCIceServer,
    MediaStreamTrack,
)
from aiortc.sdp import candidate_from_sdp
import av
from av.audio.resampler import AudioResampler
from aiohttp import web
from pathlib import Path

# ─── Константы ──────────────────────────────────────────────────────
HTTP_PORT = 8790
DISCOVERY_PORT = 37020
DISCOVERY_MSG = b"SECURECALL_WEBRTC_DISCOVER_V1"

SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16
FRAME_SAMPLES = 960  # 20 ms @ 48k

LOG_FILE = "securecall_webrtc.log"

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

# ─── Глобальные настройки аудио (громкость/мьют) ────────────────────


@dataclass
class AudioSettings:
    """Runtime-configurable audio parameters."""

    mic_volume: float = 1.0
    mic_muted: bool = False
    remote_volume: float = 1.0
    remote_muted: bool = False


AUDIO_SETTINGS = AudioSettings()

# ─── Логирование ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(threadName)s %(name)s: %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("SecureCallWebRTC")
logging.getLogger("aioice").setLevel(logging.WARNING)

# ─── Утилиты ────────────────────────────────────────────────────────
def get_local_ip() -> str:
    ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    return ip

LOCAL_IP = get_local_ip()

async def wait_port(host: str, port: int, timeout=5.0) -> bool:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.3):
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
        s.bind(("", DISCOVERY_PORT))
        log.info("[DISCOVERY] UDP responder on %d", DISCOVERY_PORT)
        try:
            while True:
                data, addr = s.recvfrom(4096)
                if data == DISCOVERY_MSG:
                    resp = json.dumps({"role": "host", "http_port": HTTP_PORT}).encode("utf-8")
                    s.sendto(resp, addr)
        except Exception as e:
            log.info("[DISCOVERY] responder stopped: %s", e)
        finally:
            s.close()
    threading.Thread(target=run, name="UDPResponder", daemon=True).start()

# ─── Аудио слои ────────────────────────────────────────────────────
class MicTrack(MediaStreamTrack):
    kind = "audio"
    def __init__(self):
        super().__init__()
        self.q: "queue.Queue[bytes]" = queue.Queue(maxsize=120)
        self._pts = 0
        self._time_base = Fraction(1, SAMPLE_RATE)
        self.stream = sd.RawInputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            callback=self._callback,
        )
        self.stream.start()
        log.info("[AUDIO] Input started")
    def _callback(self, indata, frames, time_info, status):
        try:
            arr = np.frombuffer(indata, dtype=np.int16)
            if AUDIO_SETTINGS.mic_muted:
                arr[:] = 0
            else:
                arr = (arr * AUDIO_SETTINGS.mic_volume).astype(np.int16)
            self.q.put_nowait(arr.tobytes())
        except queue.Full:
            pass
    async def recv(self):
        loop = asyncio.get_event_loop()
        pcm = await loop.run_in_executor(None, self.q.get)
        n = len(pcm) // SAMPLE_WIDTH
        frame = av.AudioFrame(format="s16", layout="mono", samples=n)
        frame.sample_rate = SAMPLE_RATE
        frame.pts = self._pts
        frame.time_base = self._time_base
        frame.planes[0].update(pcm)
        self._pts += n
        return frame
    async def stop(self):
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
        log.info("[AUDIO] Input stopped")
        await super().stop()

class AudioPlayer:
    def __init__(self):
        self.q: "queue.Queue[bytes]" = queue.Queue(maxsize=240)
        self.stream = sd.RawOutputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="int16",
            blocksize=FRAME_SAMPLES,
            callback=self._callback,
        )
        self.stream.start()
        log.info("[AUDIO] Output started")
    def _callback(self, outdata, frames, time_info, status):
        need = frames * SAMPLE_WIDTH
        try:
            data = self.q.get_nowait()
        except queue.Empty:
            outdata[:] = b"\x00" * need
            return
        if len(data) < need:
            data = data + b"\x00" * (need - len(data))
        outdata[:] = data
    def put(self, pcm: bytes):
        try:
            arr = np.frombuffer(pcm, dtype=np.int16)
            if AUDIO_SETTINGS.remote_muted:
                arr[:] = 0
            else:
                arr = (arr * AUDIO_SETTINGS.remote_volume).astype(np.int16)
            self.q.put_nowait(arr.tobytes())
        except queue.Full:
            pass
    def close(self):
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
        log.info("[AUDIO] Output stopped")

class JitterBuffer:
    def __init__(self, target_packets=4, max_packets=200):
        self.buf = collections.deque()
        self.target = target_packets
        self.max = max_packets
    def push(self, pcm: bytes):
        if len(self.buf) >= self.max:
            self.buf.popleft()
        self.buf.append(pcm)
    def pop(self):
        if len(self.buf) >= self.target:
            return self.buf.popleft()
        return None

# ─── Комната и WS-сигналинг ────────────────────────────────────────
ROOM: dict[str, list] = {"peers": []}

async def http_ws(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    if len(ROOM["peers"]) >= 10:
        await ws.send_json({"type": "full"})
        await ws.close()
        return ws
    ROOM["peers"].append(ws)
    try:
        await ws.send_json({"type": "joined", "peers": len(ROOM["peers"])})
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                for other in list(ROOM["peers"]):
                    if other is not ws and not other.closed:
                        try:
                            await other.send_str(msg.data)
                        except Exception:
                            pass
            elif msg.type in (web.WSMsgType.ERROR, web.WSMsgType.CLOSE):
                break
    finally:
        try:
            ROOM["peers"].remove(ws)
        except ValueError:
            pass
    return ws


async def http_index(request):
    return web.FileResponse(STATIC_DIR / "index.html")

async def http_style(request):
    return web.FileResponse(STATIC_DIR / "style.css")

async def http_icon(request):
    return web.FileResponse(STATIC_DIR / "icon.svg")

async def http_healthz(request):
    return web.Response(text="ok")

async def http_status(request):
    return web.json_response({"peers": len(ROOM["peers"])})

async def start_http_server():
    app = web.Application()
    app.add_routes([
        web.get("/", http_index),
        web.get("/style.css", http_style),
        web.get("/icon.svg", http_icon),
        web.get("/favicon.ico", http_icon),
        web.get("/ws", http_ws),
        web.get("/healthz", http_healthz),
        web.get("/status", http_status),
    ])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    log.info("[HTTP] http://0.0.0.0:%d (/, /style.css, /icon.svg, /ws, /healthz, /status)", HTTP_PORT)

# ─── Вспомогалки ICE ───────────────────────────────────────────────
def _extract_ip_from_candidate(candidate_sdp: str) -> str | None:
    m = re.search(r"\scandidate:.*\s(\d+\.\d+\.\d+\.\d+)\s\d+\s", " " + candidate_sdp + " ")
    return m.group(1) if m else None

def _same_subnet(ip1: str, ip2: str, bits=24) -> bool:
    try:
        a = list(map(int, ip1.split(".")))
        b = list(map(int, ip2.split(".")))
        mask = (0xFFFFFFFF << (32 - bits)) & 0xFFFFFFFF
        ai = (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]
        bi = (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
        return (ai & mask) == (bi & mask)
    except Exception:
        return False

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
        tcpType=parsed.get("tcpType"),
        relAddr=parsed.get("relAddr"),
        relPort=parsed.get("relPort"),
        sdpMid=sdp_mid,
        sdpMLineIndex=sdp_mline_index,
    )

def _ice_servers_from_env():
    raw = os.getenv("ICE_URLS", "")
    if not raw:
        return [RTCIceServer("stun:stun.l.google.com:19302")]
    try:
        arr = json.loads(raw)
        servers = []
        for s in arr:
            servers.append(
                RTCIceServer(
                    urls=s["urls"],
                    username=s.get("username"),
                    credential=s.get("credential")
                )
            )
        return servers
    except Exception:
        return [RTCIceServer("stun:stun.l.google.com:19302")]

# ─── WebRTC peer (Python сторона) ───────────────────────────────────
@dataclass
class PeerContext:
    ws_url: str   # ws://host:8790/ws
    is_initiator: bool
    name: str = ""

async def run_peer(ctx: PeerContext):
    cfg = RTCConfiguration(iceServers=_ice_servers_from_env())
    pc = RTCPeerConnection(cfg)

    mic = MicTrack()
    player = AudioPlayer()
    jb = JitterBuffer(target_packets=4, max_packets=200)
    audio_sender = None

    @pc.on("track")
    async def on_track(track):
        log.info("[PC] on_track: %s", track.kind)
        if track.kind != "audio":
            return
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
                    jb.push(pcm)
                    ready = jb.pop()
                    if ready is not None:
                        player.put(ready)
        asyncio.create_task(pump())

    def has_remote_audio_transceiver() -> bool:
        for t in pc.getTransceivers():
            if t.kind == "audio":
                return True
        return False

    async def attach_mic_if_allowed():
        nonlocal audio_sender
        if audio_sender is None:
            audio_sender = pc.addTrack(mic)
            log.info("[AUDIO] Mic track attached")

    async def send_ws(ws, payload):
        await ws.send(json.dumps(payload))

    async with websockets.connect(ctx.ws_url) as ws:
        msg = json.loads(await ws.recv())
        if msg.get("type") != "joined":
            raise RuntimeError("Signal: unexpected first message")
        peers = msg.get("peers", 1)
        is_caller = ctx.is_initiator or (peers >= 2)

        if ctx.name:
            try:
                await ws.send(json.dumps({"type": "name", "name": ctx.name}))
            except Exception:
                pass
            log.info("[USER] name sent: %s", ctx.name)

        @pc.on("icecandidate")
        async def on_ice(candidate):
            if not candidate:
                await send_ws(ws, {"type": "ice", "candidate": None})
                return
            cand_sdp = candidate.to_sdp()
            ip = _extract_ip_from_candidate(cand_sdp) or ""
            bad = (
                ip.startswith("127.")
                or ip.startswith("169.254.")
                or ip.startswith("192.168.56.")
                or ip == ""
                or ".local" in cand_sdp
            )
            prefer_subnet = _same_subnet(ip, LOCAL_IP, bits=24)
            if bad or (ip and not prefer_subnet and ip.startswith("192.168.")):
                log.info("[ICE] drop candidate %s", cand_sdp.strip())
                return
            log.info("[ICE] keep candidate %s", cand_sdp.strip())
            await send_ws(
                ws,
                {
                    "type": "ice",
                    "candidate": {
                        "candidate": cand_sdp,
                        "sdpMid": candidate.sdpMid,
                        "sdpMLineIndex": candidate.sdpMLineIndex,
                    },
                },
            )

        if is_caller:
            await attach_mic_if_allowed()
            offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            await send_ws(ws, {"type": "offer", "sdp": pc.localDescription.sdp, "sdpType": pc.localDescription.type})
            log.info("[PC] Offer sent")
        else:
            log.info("[PC] Waiting for offer...")

        async for raw in ws:
            data = json.loads(raw)
            typ = data.get("type")

            if typ == "offer":
                offer = RTCSessionDescription(sdp=data["sdp"], type="offer")
                await pc.setRemoteDescription(offer)
                if has_remote_audio_transceiver():
                    await attach_mic_if_allowed()
                else:
                    log.warning("[SDP] Remote offer без audio m-line; отвечаем без локального аудио")
                answer = await pc.createAnswer()
                await pc.setLocalDescription(answer)
                await send_ws(ws, {"type": "answer", "sdp": pc.localDescription.sdp, "sdpType": pc.localDescription.type})
                log.info("[PC] Answer sent")

            elif typ == "answer":
                answer = RTCSessionDescription(sdp=data["sdp"], type="answer")
                await pc.setRemoteDescription(answer)
                log.info("[PC] Answer applied")

            elif typ == "ice":
                c = data.get("candidate")
                if c is None:
                    try:
                        await pc.addIceCandidate(None)
                    except Exception:
                        pass
                    continue
                cand_sdp = (c.get("candidate") or "").strip()
                if not cand_sdp:
                    continue
                if ".local" in cand_sdp:
                    log.info("[ICE] skip .local candidate: %s", cand_sdp)
                    continue
                try:
                    candidate_obj = parse_candidate_compat(
                        cand_sdp=cand_sdp,
                        sdp_mid=c.get("sdpMid"),
                        sdp_mline_index=c.get("sdpMLineIndex"),
                    )
                    await pc.addIceCandidate(candidate_obj)
                except Exception as e:
                    log.info("[ICE] addIceCandidate error: %s (cand=%s)", e, c)

        await mic.stop()
        player.close()
        await pc.close()
        log.info("[PC] Closed")
