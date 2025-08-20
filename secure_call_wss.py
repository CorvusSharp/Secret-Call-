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
import subprocess
import pathlib
import signal
from dataclasses import dataclass
from fractions import Fraction
import webbrowser
import tkinter as tk

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

# ─── Константы ──────────────────────────────────────────────────────
HTTP_PORT = 8790
DISCOVERY_PORT = 37020
DISCOVERY_MSG = b"SECURECALL_WEBRTC_DISCOVER_V1"

SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2  # int16
FRAME_SAMPLES = 960  # 20 ms @ 48k

LOG_FILE = "securecall_webrtc.log"

# ─── Логирование ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(threadName)s %(name)s: %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("SecureCallWebRTC")
logging.getLogger("aioice").setLevel(logging.WARNING)

# ─── Авто-туннель (localhost.run) ───────────────────────────────────
_TUNNEL_PROC = None
_TUNNEL_URL = None
_TUNNEL_LOCK = threading.Lock()
_TUNNEL_URL_EVENT = threading.Event()


def _which(cmd: str) -> bool:
    from shutil import which
    return which(cmd) is not None

def ensure_ssh_key() -> pathlib.Path:
    """
    Создаёт ed25519-ключ в ~/.ssh/localhost_run, если его ещё нет.
    Возвращает путь к приватному ключу.
    """
    home = pathlib.Path.home()
    ssh_dir = home / ".ssh"
    key_path = ssh_dir / "localhost_run"
    if not ssh_dir.exists():
        ssh_dir.mkdir(parents=True, exist_ok=True)
    if not key_path.exists():
        log.info("[TUNNEL] Generating SSH key at %s", key_path)
        # ssh-keygen -t ed25519 -f <path> -N ""
        result = subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-f", str(key_path), "-N", ""],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
        )
        if result.returncode != 0:
            raise RuntimeError(f"ssh-keygen failed:\n{result.stdout}")
    return key_path

def _extract_lhr_https(text: str) -> str | None:
    """Извлекает первую https-ссылку вида https://<sub>.lhr.life из текста."""
    m = re.search(r"https://([a-z0-9\-]+\.lhr\.life)(?:[^\s]*)?", text.strip())
    return f"https://{m.group(1)}" if m else None

def _tunnel_reader(proc: subprocess.Popen, on_url: callable = None):
    """Читает вывод процесса туннеля и извлекает URL."""
    global _TUNNEL_URL
    
    buf = ""
    while True:
        chunk = proc.stdout.read(1) if proc.stdout else None
        if not chunk:  # Процесс завершился
            break
            
        buf += chunk
        
        # Логируем полные строки
        if chunk == "\n":
            line = buf.strip()
            if line:
                log.info("[TUNNEL] %s", line)
                
                # Пытаемся извлечь URL
                url = _extract_lhr_https(line)
                if url and not _TUNNEL_URL:
                    with _TUNNEL_LOCK:
                        _TUNNEL_URL = url
                        _TUNNEL_URL_EVENT.set()
                    log.info("[TUNNEL] URL found: %s", url)
                    if callable(on_url):
                        try:
                            on_url(url)
                        except Exception as e:
                            log.warning("[TUNNEL] on_url callback error: %s", e)
            buf = ""
        
        # Параллельно проверяем буфер на наличие URL
        if not _TUNNEL_URL:
            url = _extract_lhr_https(buf)
            if url:
                with _TUNNEL_LOCK:
                    _TUNNEL_URL = url
                    _TUNNEL_URL_EVENT.set()
                log.info("[TUNNEL] URL found (inline): %s", url)
                if callable(on_url):
                    try:
                        on_url(url)
                    except Exception as e:
                        log.warning("[TUNNEL] on_url callback error: %s", e)

def start_localhost_run_tunnel(local_port: int = HTTP_PORT, on_url=None) -> None:
    """
    Запускает: ssh -tt -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:127.0.0.1:<local_port> nokey@localhost.run
    Без -N, без ключей. Читает баннер побайтно и вытаскивает https://<sub>.lhr.life.
    """
    import subprocess, os, threading, time
    global _TUNNEL_PROC, _TUNNEL_URL

    def _safe_call_cb(url: str):
        if callable(on_url):
            try:
                on_url(url)
            except Exception as e:
                log.warning("[TUNNEL] on_url callback error: %s", e)

    with _TUNNEL_LOCK:
        if _TUNNEL_PROC is not None and _TUNNEL_PROC.poll() is None:
            log.info("[TUNNEL] already running at %s", _TUNNEL_URL or "<pending>")
            if _TUNNEL_URL:
                _safe_call_cb(_TUNNEL_URL)
            return

        if not _which("ssh"):
            log.warning("[TUNNEL] OpenSSH 'ssh' not found in PATH=%s — tunnel will not be started", os.getenv("PATH"))
            return

        host = os.environ.get("LOCALHOST_RUN_HOST", "nokey@localhost.run")
        cmd = [
            "ssh",
            "-tt",                                  # принудительный TTY
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
            "-R", f"80:127.0.0.1:{local_port}",
            host,
            # без -N → интерактивная сессия, баннер полностью приходит
        ]

        # Важно: не скрываем окно и даём stdin — иначе хвост может не прийти
        creationflags = 0  # на Windows не используем CREATE_NO_WINDOW
        env = os.environ.copy()
        env.setdefault("TERM", "xterm")  # на всякий случай

        log.info("[TUNNEL] Starting localhost.run tunnel (this may take a few seconds)…")
        _TUNNEL_PROC = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=creationflags,
            bufsize=1,  # строковое буферизование
            env=env,
        )

        def reader():
            """Логируем баннер побайтно; после 'connection id' отправляем '\\n'; парсим https://<sub>.lhr.life."""
            global _TUNNEL_URL
            assert _TUNNEL_PROC.stdout is not None
            buf = ""
            nudged = False
            t0 = time.time()
            log.info("[TUNNEL] reader started, waiting for https://<sub>.lhr.life …")

            while True:
                ch = _TUNNEL_PROC.stdout.read(1)
                if ch == "" or ch is None:
                    break
                buf += ch

                if ch == "\n":
                    line = buf.strip("\r\n")
                    if line:
                        log.info("[TUNNEL] %s", line)

                        # «пинок» сразу после connection id
                        if (not nudged) and ("your connection id is" in line.lower()):
                            try:
                                if _TUNNEL_PROC.stdin:
                                    _TUNNEL_PROC.stdin.write("\n")
                                    _TUNNEL_PROC.stdin.flush()
                                    nudged = True
                                    log.info("[TUNNEL] nudged stdin with newline")
                            except Exception as e:
                                log.info("[TUNNEL] nudge failed: %s", e)

                        url = _extract_lhr_https(line)
                        if url and _TUNNEL_URL is None:
                            _TUNNEL_URL = url
                            log.info("[TUNNEL] URL: %s (open this on both devices)", _TUNNEL_URL)
                            _safe_call_cb(_TUNNEL_URL)
                    buf = ""

                # Фолбэк: если спустя 3 сек URL нет — ещё один «пинок»
                if (not nudged) and (_TUNNEL_URL is None) and (time.time() - t0 > 3.0):
                    try:
                        if _TUNNEL_PROC.stdin:
                            _TUNNEL_PROC.stdin.write("\n")
                            _TUNNEL_PROC.stdin.flush()
                            nudged = True
                            log.info("[TUNNEL] timed nudge sent")
                    except Exception as e:
                        log.info("[TUNNEL] timed nudge failed: %s", e)

                # Ищем URL прямо в буфере (на случай печати без \n)
                if _TUNNEL_URL is None:
                    url_inline = _extract_lhr_https(buf)
                    if url_inline:
                        _TUNNEL_URL = url_inline
                        log.info("[TUNNEL] URL: %s (open this on both devices)", _TUNNEL_URL)
                        _safe_call_cb(_TUNNEL_URL)

            log.info("[TUNNEL] process ended")

        threading.Thread(target=reader, name="TunnelReader", daemon=True).start()

def stop_localhost_run_tunnel() -> None:
    """Останавливает SSH-туннель."""
    global _TUNNEL_PROC, _TUNNEL_URL
    
    with _TUNNEL_LOCK:
        if _TUNNEL_PROC and _TUNNEL_PROC.poll() is None:
            log.info("[TUNNEL] Stopping tunnel...")
            try:
                if os.name == "nt":
                    _TUNNEL_PROC.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    _TUNNEL_PROC.terminate()
                
                _TUNNEL_PROC.wait(timeout=3)
            except Exception as e:
                log.warning("[TUNNEL] Error stopping tunnel: %s", e)
                try:
                    _TUNNEL_PROC.kill()
                except Exception:
                    pass
        
        _TUNNEL_PROC = None
        _TUNNEL_URL = None
        _TUNNEL_URL_EVENT.clear()

def wait_for_tunnel_url(timeout: float = 30.0) -> str | None:
    """Ожидает появления URL туннеля."""
    if _TUNNEL_URL_EVENT.wait(timeout):
        return _TUNNEL_URL
    return None

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
            self.q.put_nowait(bytes(indata))
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
    if len(ROOM["peers"]) >= 2:
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

# ─── HTTP сайт ─────────────────────────────────────────────────────
INDEX_HTML = """\
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Secure Call — WebRTC (Browser)</title>
<style>
 body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
 .card { max-width: 720px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 12px; }
 h1 { margin-top: 0; font-size: 20px; }
 button { padding: 10px 16px; border-radius: 10px; border: 1px solid #ccc; background:#fff; cursor:pointer; }
 button:disabled { opacity: .6; cursor: default; }
 .row { margin: 10px 0; }
 .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
 .ok { color: #0a7; } .warn { color: #a70; } .err { color: #c00; }
 .help { margin-top:12px; font-size:13px; color:#555; }
 code { background: #f5f5f5; padding: 1px 4px; border-radius: 4px; }
</style>
</head>
<body>
<div class="card">
  <h1>Secure Call — WebRTC (Browser)</h1>
  <p>Нажмите «Подключиться» и разрешите доступ к микрофону. Связь идёт по <b>HTTPS/WSS</b>, если вы зашли по публичной ссылке.</p>
  <div class="row">
    <button id="btn">Подключиться</button>
    <span id="st" class="mono"></span>
  </div>
  <div class="row">
    <label><input type="checkbox" id="ec" checked> Echo Cancellation</label>
    <label style="margin-left:12px;"><input type="checkbox" id="ns" checked> Noise Suppression</label>
    <label style="margin-left:12px;"><input type="checkbox" id="agc" checked> Auto Gain</label>
  </div>
  <audio id="remote" autoplay playsinline></audio>
  <div id="log" class="row mono" style="white-space:pre-wrap;"></div>
  <div class="help">
    Открывайте эту страницу через публичный HTTPS-домен туннеля — сигналинг будет WSS, а медиа пойдёт напрямую (или через TURN).
  </div>
</div>
<script>
(() => {
  const logEl = document.getElementById('log');
  const statusEl = document.getElementById('st');
  const btn = document.getElementById('btn');
  const audioEl = document.getElementById('remote');

  const opts = () => ({
    audio: {
      channelCount: 1,
      noiseSuppression: document.getElementById('ns').checked,
      echoCancellation: document.getElementById('ec').checked,
      autoGainControl: document.getElementById('agc').checked,
      sampleRate: 48000
    },
    video: false
  });

  const say = (m, cls='') => { if (cls) statusEl.className = cls; statusEl.textContent = m; logEl.textContent += m + "\\n"; };

  function filterCandidateStr(cand) {
    if (cand.includes(' 127.') || cand.includes(' 169.254.') || cand.includes(' 192.168.56.')) return false;
    return true;
  }

  const wsScheme = (location.protocol === 'https:') ? 'wss://' : 'ws://';
  const wsURL = wsScheme + location.host + '/ws';

  function parseIceFromEnv() {
    try { return JSON.parse(window.ICE_URLS || "[]"); } catch { return []; }
  }
  const defaultIce = [{urls: 'stun:stun.l.google.com:19302'}];
  const iceServers = (parseIceFromEnv().length ? parseIceFromEnv() : defaultIce);

  async function connect() {
    btn.disabled = true;
    say('Инициализация…', 'mono');

    const pc = new RTCPeerConnection({iceServers});
    const ws = new WebSocket(wsURL);

    pc.onicecandidate = ev => {
      if (!ev.candidate) {
        (ws.readyState === 1) && ws.send(JSON.stringify({type:'ice', candidate: null}));
        return;
      }
      const cand = ev.candidate.candidate || '';
      if (!filterCandidateStr(cand)) { say('[ICE] drop ' + cand); return; }
      (ws.readyState === 1) && ws.send(JSON.stringify({
        type: 'ice',
        candidate: {
          candidate: cand,
          sdpMid: ev.candidate.sdpMid,
          sdpMLineIndex: ev.candidate.sdpMLineIndex
        }
      }));
    };

    pc.ontrack = ev => {
      say('[PC] ontrack audio', 'ok');
      audioEl.srcObject = ev.streams[0] || new MediaStream([ev.track]);
      audioEl.play().catch(()=>{});
    };
    pc.onconnectionstatechange   = () => say('[PC] state=' + pc.connectionState);
    pc.oniceconnectionstatechange= () => say('[ICE] state=' + pc.iceConnectionState);

    try {
      const ms = await navigator.mediaDevices.getUserMedia(opts());
      ms.getAudioTracks().forEach(t => pc.addTrack(t, ms));
      say('[MEDIA] mic ok');
    } catch (err) {
      say('Микрофон не доступен: ' + err.name + ' — добавляю recvonly', 'warn');
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }

    ws.onopen = () => say('[WS] open', 'ok');
    ws.onerror = () => say('[WS] error', 'err');
    ws.onclose = () => say('[WS] closed', 'warn');

    ws.onmessage = async (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'joined') {
        const peers = data.peers || 1;
        const isCaller = (peers >= 2);
        say(`[WS] joined, peers=${peers}`);
        if (isCaller) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          ws.send(JSON.stringify({type:'offer', sdp: offer.sdp, sdpType: offer.type}));
          say('[PC] offer sent');
        } else {
          say('[PC] waiting for offer…');
        }
      } else if (data.type === 'offer') {
        say('[WS] got offer');
        await pc.setRemoteDescription({type:'offer', sdp: data.sdp});
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({type:'answer', sdp: answer.sdp, sdpType: answer.type}));
        say('[PC] answer sent');
      } else if (data.type === 'answer') {
        say('[WS] got answer');
        await pc.setRemoteDescription({type:'answer', sdp: data.sdp});
      } else if (data.type === 'ice') {
        const c = data.candidate;
        if (c && c.candidate && filterCandidateStr(c.candidate)) {
          try { await pc.addIceCandidate(c); } catch {}
        } else if (c === null) {
          try { await pc.addIceCandidate(null); } catch {}
        }
      } else if (data.type === 'full') {
        say('[WS] room full', 'err');
      }
    };
  }

  document.getElementById('btn').addEventListener('click', async () => {
    try { await connect(); }
    catch (e) { say('Ошибка: ' + e, 'err'); document.getElementById('btn').disabled = false; }
  });
})();
</script>
</body>
</html>
"""

async def http_index(request):
    return web.Response(text=INDEX_HTML, content_type="text/html", charset="utf-8")

async def http_healthz(request):
    return web.Response(text="ok")

async def http_status(request):
    return web.json_response({"peers": len(ROOM["peers"])})

FAVICON = b""

async def http_favicon(request):
    return web.Response(body=FAVICON, content_type="image/x-icon")

async def start_http_server():
    app = web.Application()
    app.add_routes([
        web.get("/", http_index),
        web.get("/ws", http_ws),
        web.get("/healthz", http_healthz),
        web.get("/status", http_status),
        web.get("/favicon.ico", http_favicon),
    ])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", HTTP_PORT)
    await site.start()
    log.info("[HTTP] http://0.0.0.0:%d (/, /ws, /healthz, /status)", HTTP_PORT)

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

# ─── Асинхронный раннер ────────────────────────────────────────────
class AsyncRunner:
    def __init__(self):
        self.loop = None
        self.thread = None
        self.ready = threading.Event()
    def start(self):
        def target():
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            self.ready.set()
            self.loop.run_forever()
        self.thread = threading.Thread(target=target, name="AsyncLoop", daemon=True)
        self.thread.start()
        self.ready.wait()
    def submit(self, coro):
        self.ready.wait()
        return asyncio.run_coroutine_threadsafe(coro, self.loop)
    def stop(self):
        if self.loop:
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread:
            self.thread.join(timeout=1)

# ─── GUI «одна кнопка» ─────────────────────────────────────────────
class App:
    def __init__(self, root: tk.Tk, runner: AsyncRunner):
        self.root = root
        self.runner = runner

        self.root.title("Secure Call — WebRTC (1 кнопка)")
        wrap = tk.Frame(root)
        wrap.pack(padx=10, pady=10)

        tk.Label(
            wrap,
            text=(
                "HTTP сервер запущен.\n"
                "Публичный URL появится ниже, как кликабельная ссылка.\n"
                f"Локально:  http://{get_local_ip()}:{HTTP_PORT}\n"
                "(Браузер спросит доступ к микрофону.)"
            ),
            justify="left",
        ).pack()

        # Кликабельная ссылка HTTPS туннеля
        self.url_label = tk.Label(wrap, text="", fg="blue", cursor="hand2")
        self.url_label.pack(pady=(6, 10))

        # Кнопки
        self.start_btn = tk.Button(wrap, text="Подключиться (auto host/join)", command=self.start_call)
        self.start_btn.pack(pady=10)

        self.stop_btn = tk.Button(wrap, text="Выход", command=self.stop)
        self.stop_btn.pack()

        self.status = tk.Label(wrap, text="Сервер запущен, туннель стартует…", fg="green")
        self.status.pack(pady=(8, 0))

    # Показывает ссылку и делает её кликабельной
    def set_tunnel_url(self, url: str):
        def _apply():
            def open_url(_evt):
                webbrowser.open(url)
            self.url_label.config(text=url)
            self.url_label.bind("<Button-1>", open_url)
            self.set_status("Публичная ссылка готова", "green")
        self.root.after(0, _apply)

    def start_call(self):
        self.set_status("Поиск хоста в LAN…", "blue")
        self.start_btn.config(state="disabled")
        self.runner.submit(self.auto_host_or_join())

    async def auto_host_or_join(self):
        info = await udp_discover(timeout=1.0, attempts=3)
        if info and "host" in info and await wait_port(info["host"], HTTP_PORT, timeout=3.0):
            host = info["host"]
            self.set_status(f"Подключаюсь к хосту {host}…", "blue")
            await run_peer(PeerContext(ws_url=f"ws://{host}:{HTTP_PORT}/ws", is_initiator=True))
            self.set_status("Звонок завершён", "green")
            self.start_btn.config(state="normal")
            return

        self.set_status("Я — ХОСТ. Жду участника…", "green")
        await run_peer(PeerContext(ws_url=f"ws://127.0.0.1:{HTTP_PORT}/ws", is_initiator=False))
        self.set_status("Звонок завершён", "green")
        self.start_btn.config(state="normal")

    def stop(self):
        self.set_status("Завершение…", "orange")
        try:
            stop_localhost_run_tunnel()
        except Exception:
            pass
        time.sleep(0.2)
        os._exit(0)

    def set_status(self, text: str, color: str = "green"):
        try:
            self.root.after(0, lambda: self.status.config(text=text, fg=color))
        except Exception:
            self.status.config(text=text, fg=color)

# ─── Точка входа ───────────────────────────────────────────────────
if __name__ == "__main__":
    runner = AsyncRunner(); runner.start()
    runner.submit(start_http_server())
    start_udp_responder()
    log.info("[BOOT] HTTP server scheduled, UDP responder started")

    root = tk.Tk()
    app = App(root, runner)

    # Стартуем туннель и пробрасываем колбэк показа ссылки
    threading.Thread(
        target=start_localhost_run_tunnel,
        name="TunnelStarter",
        kwargs={"local_port": HTTP_PORT, "on_url": app.set_tunnel_url},
        daemon=True
    ).start()

    root.protocol("WM_DELETE_WINDOW", app.stop)
    root.mainloop()
