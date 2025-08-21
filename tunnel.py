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

# Hide sensitive data (public URL) in logs if PROD=1
PROD = os.environ.get("PROD") == "1"

# Allow overriding ssh target like "nokey@localhost.run"
LOCALHOST_RUN_HOST = os.environ.get("LOCALHOST_RUN_HOST", "nokey@localhost.run")

# Optional host key pinning (e.g., "SHA256:xxxxxxxx..."); when set, we enforce StrictHostKeyChecking=yes
PINNED_FINGERPRINT = os.environ.get("PINNED_FINGERPRINT") or ""

# Internal state
_TUNNEL_PROC: Optional[subprocess.Popen] = None
_TUNNEL_URL: Optional[str] = None
_TUNNEL_LOCK = threading.Lock()
_TUNNEL_URL_EVENT = threading.Event()


def _which(cmd: str) -> bool:
    """Return True if command is available in PATH."""
    from shutil import which
    return which(cmd) is not None


def ensure_ssh_key() -> pathlib.Path:
    """
    Create an ed25519 key in ~/.ssh/localhost_run if absent.

    NOTE: localhost.run supports 'nokey@' user flow and does not require a key.
    We keep this helper if you decide to switch to key-based auth or another host.
    """
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
    m = re.search(r"https://([a-z0-9\-]+\.lhr\.life)(?:[^\s]*)?", (text or "").strip(), re.I)
    return f"https://{m.group(1)}" if m else None


def _check_pinned_fingerprint(host: str, expected: str) -> Optional[pathlib.Path]:
    """
    Verify SSH host public key fingerprint and return a path to a known_hosts file
    that contains this host key, or None on mismatch/failure.
    """
    try:
        scan = subprocess.run(
            ["ssh-keyscan", host],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
        if scan.returncode != 0 or not scan.stdout:
            log.error("[TUNNEL] ssh-keyscan failed for %s: %s", host, scan.stderr.strip())
            return None

        fp = subprocess.run(
            ["ssh-keygen", "-lf", "-"],
            input=scan.stdout,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if fp.returncode != 0:
            log.error("[TUNNEL] ssh-keygen failed: %s", fp.stderr.strip())
            return None

        if expected not in fp.stdout:
            log.error(
                "[TUNNEL] host key fingerprint mismatch for %s: expected %s got %s",
                host,
                expected,
                fp.stdout.strip(),
            )
            return None

        kh = pathlib.Path.home() / ".ssh" / "localhost_run_known_hosts"
        kh.parent.mkdir(parents=True, exist_ok=True)
        kh.write_text(scan.stdout)
        return kh
    except Exception as e:
        log.error("[TUNNEL] fingerprint check failed: %s", e)
        return None


def _tunnel_reader(proc: subprocess.Popen, on_url: Callable[[str], None] | None = None) -> None:
    """
    Read tunnel process output and extract the public URL.
    Runs in a background thread.
    """
    global _TUNNEL_URL

    buf = ""
    # For some banners, we may need to send a newline to continue.
    nudged = False
    t0 = time.time()

    log.info("[TUNNEL] reader started, waiting for https://<sub>.lhr.life …")
    while True:
        ch = proc.stdout.read(1) if proc.stdout else None
        if not ch:
            break

        buf += ch

        if ch == "\n":
            line = buf.strip()
            if line and not PROD:
                log.info("[TUNNEL] %s", line)

            # Some variants print "your connection id is ..." and wait; nudge stdin
            if (not nudged) and ("your connection id is" in line.lower()):
                try:
                    if proc.stdin:
                        proc.stdin.write("\n")
                        proc.stdin.flush()
                        nudged = True
                        log.info("[TUNNEL] nudged stdin with newline")
                except Exception as e:
                    log.info("[TUNNEL] nudge failed: %s", e)

            url = _extract_lhr_https(line)
            if url:
                with _TUNNEL_LOCK:
                    if _TUNNEL_URL is None:
                        _TUNNEL_URL = url
                        _TUNNEL_URL_EVENT.set()
                        log.info("[TUNNEL] URL found: %s", url if not PROD else "<hidden>")
                        if callable(on_url):
                            try:
                                on_url(url)
                            except Exception as e:
                                log.warning("[TUNNEL] on_url callback error: %s", e)
            buf = ""

        # Timed nudge in case the banner is waiting silently
        if (not nudged) and (time.time() - t0 > 3.0):
            try:
                if proc.stdin:
                    proc.stdin.write("\n")
                    proc.stdin.flush()
                    nudged = True
                    log.info("[TUNNEL] timed nudge sent")
            except Exception as e:
                log.info("[TUNNEL] timed nudge failed: %s", e)

        # Inline extraction (URL printed without newline yet)
        if _TUNNEL_URL is None:
            url_inline = _extract_lhr_https(buf)
            if url_inline:
                with _TUNNEL_LOCK:
                    if _TUNNEL_URL is None:
                        _TUNNEL_URL = url_inline
                        _TUNNEL_URL_EVENT.set()
                        log.info("[TUNNEL] URL found (inline): %s", url_inline if not PROD else "<hidden>")
                        if callable(on_url):
                            try:
                                on_url(url_inline)
                            except Exception as e:
                                log.warning("[TUNNEL] on_url callback error: %s", e)

    log.info("[TUNNEL] process output ended")


def start_localhost_run_tunnel(local_port: int = HTTP_PORT, on_url: Callable[[str], None] | None = None) -> None:
    """
    Start localhost.run tunnel and capture its public URL.

    Args:
        local_port: local HTTP port to expose (default: core.HTTP_PORT)
        on_url: optional callback called once with the public https URL
    """
    global _TUNNEL_PROC, _TUNNEL_URL

    def _safe_call_cb(url: str) -> None:
        if callable(on_url):
            try:
                on_url(url)
            except Exception as e:
                log.warning("[TUNNEL] on_url callback error: %s", e)

    with _TUNNEL_LOCK:
        # Already running
        if _TUNNEL_PROC is not None and _TUNNEL_PROC.poll() is None:
            log.info("[TUNNEL] already running at %s", _TUNNEL_URL or "<pending>")
            if _TUNNEL_URL:
                _safe_call_cb(_TUNNEL_URL)
            return

        # Check ssh binary
        if not _which("ssh"):
            log.warning(
                "[TUNNEL] OpenSSH 'ssh' not found in PATH=%s — tunnel will not be started",
                os.getenv("PATH"),
            )
            return

        # Prepare StrictHostKeyChecking mode and known_hosts (if pinning requested)
        host = LOCALHOST_RUN_HOST
        strict = "StrictHostKeyChecking=accept-new"
        known_hosts_file = None

        if PINNED_FINGERPRINT:
            host_only = host.split("@")[-1]
            kh = _check_pinned_fingerprint(host_only, PINNED_FINGERPRINT)
            if not kh:
                log.error("[TUNNEL] fingerprint verification failed, aborting tunnel start")
                return
            strict = "StrictHostKeyChecking=yes"
            known_hosts_file = str(kh)

        # Build command
        cmd = [
            "ssh",
            "-tt",
            "-o", strict,
            "-o", "ServerAliveInterval=30",
            "-o", "ExitOnForwardFailure=yes",
        ]
        if known_hosts_file:
            cmd += ["-o", f"UserKnownHostsFile={known_hosts_file}"]
        # Reverse forward 80 -> 127.0.0.1:local_port
        cmd += ["-R", f"80:127.0.0.1:{local_port}", host]

        # On Windows, no special flags required here; keep text I/O to parse banners
        env = os.environ.copy()
        env.setdefault("TERM", "xterm")

        # Reset state
        _TUNNEL_URL = None
        _TUNNEL_URL_EVENT.clear()

        log.info("[TUNNEL] Starting localhost.run tunnel (this may take a few seconds)…")
        _TUNNEL_PROC = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env=env,
        )

        # Background reader
        t = threading.Thread(
            target=_tunnel_reader, args=(_TUNNEL_PROC, on_url), name="TunnelReader", daemon=True
        )
        t.start()


def stop_localhost_run_tunnel() -> None:
    """Stop the SSH tunnel if it is running."""
    global _TUNNEL_PROC, _TUNNEL_URL

    with _TUNNEL_LOCK:
        if _TUNNEL_PROC and _TUNNEL_PROC.poll() is None:
            log.info("[TUNNEL] Stopping tunnel...")
            try:
                if os.name == "nt":
                    # CTRL_BREAK_EVENT works only for processes in the same console group.
                    # We try; if it fails, fall back to terminate/kill.
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
    """
    Wait for the tunnel URL to appear.
    Returns the URL string on success, or None on timeout.
    """
    if _TUNNEL_URL_EVENT.wait(timeout):
        return _TUNNEL_URL
    return None


def get_tunnel_url() -> Optional[str]:
    """Thread-safe getter for the current tunnel URL (if already detected)."""
    with _TUNNEL_LOCK:
        return _TUNNEL_URL
