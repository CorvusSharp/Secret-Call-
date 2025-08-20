
"""Utilities for managing the localhost.run SSH tunnel."""

import os
import pathlib
import re
import signal
import subprocess
import threading
import time
from typing import Callable, Optional

from core import HTTP_PORT, log


_TUNNEL_PROC = None
_TUNNEL_URL: Optional[str] = None
_TUNNEL_LOCK = threading.Lock()
_TUNNEL_URL_EVENT = threading.Event()


def _which(cmd: str) -> bool:
    from shutil import which

    return which(cmd) is not None


def ensure_ssh_key() -> pathlib.Path:
    """Create an ed25519 key in ~/.ssh/localhost_run if absent."""

    home = pathlib.Path.home()
    ssh_dir = home / ".ssh"
    key_path = ssh_dir / "localhost_run"
    if not ssh_dir.exists():
        ssh_dir.mkdir(parents=True, exist_ok=True)
    if not key_path.exists():
        log.info("[TUNNEL] Generating SSH key at %s", key_path)
        result = subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-f", str(key_path), "-N", ""],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ssh-keygen failed:\n{result.stdout}")
    return key_path


def _extract_lhr_https(text: str) -> Optional[str]:
    """Extract the first https://<sub>.lhr.life link from text."""

    m = re.search(r"https://([a-z0-9\-]+\.lhr\.life)(?:[^\s]*)?", text.strip())
    return f"https://{m.group(1)}" if m else None


def _tunnel_reader(proc: subprocess.Popen, on_url: Callable[[str], None] | None = None) -> None:
    """Read tunnel process output and extract the public URL."""

    global _TUNNEL_URL

    buf = ""
    while True:
        chunk = proc.stdout.read(1) if proc.stdout else None
        if not chunk:
            break

        buf += chunk

        if chunk == "\n":
            line = buf.strip()
            if line:
                log.info("[TUNNEL] %s", line)

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


def start_localhost_run_tunnel(local_port: int = HTTP_PORT, on_url: Callable[[str], None] | None = None) -> None:
    """Start localhost.run tunnel and capture its public URL."""

    global _TUNNEL_PROC, _TUNNEL_URL

    def _safe_call_cb(url: str) -> None:
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
            log.warning(
                "[TUNNEL] OpenSSH 'ssh' not found in PATH=%s — tunnel will not be started",
                os.getenv("PATH"),
            )
            return

        host = os.environ.get("LOCALHOST_RUN_HOST", "nokey@localhost.run")
        cmd = [
            "ssh",
            "-tt",
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "ServerAliveInterval=30",
            "-o",
            "ExitOnForwardFailure=yes",
            "-R",
            f"80:127.0.0.1:{local_port}",
            host,
        ]

        creationflags = 0
        env = os.environ.copy()
        env.setdefault("TERM", "xterm")

        log.info("[TUNNEL] Starting localhost.run tunnel (this may take a few seconds)…")
        _TUNNEL_PROC = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=creationflags,
            bufsize=1,
            env=env,
        )

        def reader() -> None:
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

                if (not nudged) and (_TUNNEL_URL is None) and (time.time() - t0 > 3.0):
                    try:
                        if _TUNNEL_PROC.stdin:
                            _TUNNEL_PROC.stdin.write("\n")
                            _TUNNEL_PROC.stdin.flush()
                            nudged = True
                            log.info("[TUNNEL] timed nudge sent")
                    except Exception as e:
                        log.info("[TUNNEL] timed nudge failed: %s", e)

                if _TUNNEL_URL is None:
                    url_inline = _extract_lhr_https(buf)
                    if url_inline:
                        _TUNNEL_URL = url_inline
                        log.info("[TUNNEL] URL: %s (open this on both devices)", _TUNNEL_URL)
                        _safe_call_cb(_TUNNEL_URL)

            log.info("[TUNNEL] process ended")

        threading.Thread(target=reader, name="TunnelReader", daemon=True).start()


def stop_localhost_run_tunnel() -> None:
    """Stop the SSH tunnel if it is running."""

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


def wait_for_tunnel_url(timeout: float = 30.0) -> Optional[str]:
    """Wait for the tunnel URL to appear."""

    if _TUNNEL_URL_EVENT.wait(timeout):
        return _TUNNEL_URL
    return None

