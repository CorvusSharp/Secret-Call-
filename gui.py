"""Neon/Glass GUI for Secure Call — refined to match index.html aesthetics."""

import os
import tkinter as tk
import tkinter.ttk as ttk
import tkinter.font as tkfont
import webbrowser
import threading

from async_runner import AsyncRunner
from core import HTTP_PORT, get_local_ip, log, start_http_server, start_udp_responder
from tunnel import start_localhost_run_tunnel, stop_localhost_run_tunnel

# ─────────────────────────────────────────────────────────────────────
# Palette (aligned with index.html)
# ─────────────────────────────────────────────────────────────────────
BG        = "#0B0F14"
FG        = "#EAF2FF"
MUTED     = "#BBD0FF"
CARD      = "#132033"
CARD_BD   = "#24324B"
ACC1      = "#6CE2FF"
ACC2      = "#9B7DFF"
OK        = "#3BE0A7"
WARN      = "#FFD56C"
DANGER    = "#A50000"


def apply_theme(root: tk.Tk) -> ttk.Style:
    root.configure(bg=BG)
    style = ttk.Style(root)
    try:
        style.theme_use("clam")
    except Exception:
        pass

    # Safe global fonts (no Tcl errors on names with spaces)
    try:
        tkfont.nametofont("TkDefaultFont").configure(family="Segoe UI", size=10)
        tkfont.nametofont("TkTextFont").configure(family="Segoe UI", size=10)
        tkfont.nametofont("TkHeadingFont").configure(family="Segoe UI", size=11, weight="bold")
    except Exception:
        pass

    # App bar (subtle top band)
    style.configure("AppBar.TFrame", background=BG)

    # Card (soft border; glass-like tone)
    style.configure("Card.TFrame", background=CARD, borderwidth=1, relief="solid")

    # Labels
    style.configure("Title.TLabel", font=("Segoe UI", 18, "bold"), foreground=FG, background=BG)
    style.configure("Sub.TLabel",   font=("Segoe UI", 10), foreground=MUTED, background=BG)
    style.configure("Body.TLabel",  font=("Segoe UI", 10), foreground=MUTED, background=CARD)
    style.configure("Status.TLabel", font=("Segoe UI", 10, "semibold"), foreground=MUTED, background=CARD)
    style.configure("Link.TLabel",  font=("Segoe UI", 10, "bold"), foreground=ACC1, background=CARD)

    # Inputs (glass-ish)
    style.configure(
        "Glass.TEntry",
        fieldbackground=BG,
        background=BG,
        foreground=FG,
        bordercolor=CARD_BD,
        lightcolor=ACC1,
        darkcolor=CARD_BD,
        borderwidth=1,
        padding=6,
    )
    style.map("Glass.TEntry", bordercolor=[("focus", ACC1)], lightcolor=[("focus", ACC1)])

    # Buttons (pill-like via padding; ttk has no real radius)
    style.configure("Primary.TButton", foreground="#0A1320", background=ACC1, borderwidth=0, padding=(14, 10))
    style.map("Primary.TButton", background=[("active", ACC2)])

    style.configure("Ghost.TButton", foreground=FG, background="#1A2436", borderwidth=0, padding=(14, 10))
    style.map("Ghost.TButton", background=[("active", "#222F49")])

    style.configure("Danger.TButton", foreground="#1B0B10", background=DANGER, borderwidth=0, padding=(14, 10))
    style.map("Danger.TButton", background=[("active", "#ff5b7c")])

    # Thin separators
    style.configure("Line.TSeparator", background=CARD_BD)

    return style


# ─────────────────────────────────────────────────────────────────────
# App
# ─────────────────────────────────────────────────────────────────────
class App:
    def __init__(self, root: tk.Tk, runner: AsyncRunner) -> None:
        self.root = root
        self.runner = runner
        self.server_started = False
        self.public_url: str | None = None

        self.root.title("Secure Call — WebRTC")
        try:
            self.root.wm_attributes("-alpha", 0.98)
        except Exception:
            pass

        apply_theme(self.root)

        # Top app bar (subtle, not distracting)
        appbar = ttk.Frame(self.root, style="AppBar.TFrame")
        appbar.pack(fill="x")

        # Title + subtitle
        ttk.Label(self.root, text="Secure Call", style="Title.TLabel").pack(pady=(8, 2))
        ttk.Label(
            self.root,
            text="Choose mode and enter a room token. Hosting starts instantly.",
            style="Sub.TLabel",
        ).pack(pady=(0, 12))

        # Card container
        card = ttk.Frame(self.root, style="Card.TFrame")
        card.pack(padx=16, pady=10, ipadx=14, ipady=14, fill="x")
        self.card = card

        # Token row
        row1 = ttk.Frame(card, style="Card.TFrame")
        row1.pack(fill="x")
        ttk.Label(row1, text="Room token", style="Body.TLabel").grid(row=0, column=0, padx=(2, 10), pady=(2, 8))
        self.token_var = tk.StringVar(value=os.environ.get("ROOM_TOKEN", ""))
        self.token = ttk.Entry(row1, textvariable=self.token_var, style="Glass.TEntry")
        self.token.grid(row=0, column=1, sticky="ew", pady=(2, 8))
        row1.columnconfigure(1, weight=1)

        ttk.Separator(card, orient="horizontal", style="Line.TSeparator").pack(fill="x", pady=6)

        # Mode buttons (instant start)
        row2 = ttk.Frame(card, style="Card.TFrame")
        row2.pack(fill="x")

        self.btn_1x1 = ttk.Button(row2, text="1×1 call", style="Primary.TButton", command=lambda: self._start(mode="1x1"))
        self.btn_grp = ttk.Button(
            row2, text="Group call (up to 10)", style="Ghost.TButton", command=lambda: self._start(mode="group")
        )
        self.btn_stop = ttk.Button(row2, text="Stop hosting", style="Danger.TButton", command=self._stop, state="disabled")

        self.btn_1x1.grid(row=0, column=0, padx=(0, 8), pady=(2, 2))
        self.btn_grp.grid(row=0, column=1, padx=(0, 8), pady=(2, 2))
        self.btn_stop.grid(row=0, column=2, pady=(2, 2))
        row2.columnconfigure(1, weight=1)

        # Info block
        ttk.Separator(card, orient="horizontal", style="Line.TSeparator").pack(fill="x", pady=8)
        info = ttk.Label(
            card,
            text=(
                f"HTTP server will run here.\n"
                f"Local:  http://{get_local_ip()}:{HTTP_PORT}\n"
                "(Open in a browser; it will request microphone permission.)"
            ),
            style="Body.TLabel",
            justify="left",
        )
        info.pack(pady=(0, 6))

        # Public URL (clickable)
        self.url_label = ttk.Label(card, text="", style="Link.TLabel", cursor="hand2")
        self.url_label.pack(pady=(2, 6))

        # Status line
        self.status = ttk.Label(card, text="Ready.", style="Status.TLabel")
        self.status.pack(pady=(2, 0))

    # ── Actions ──────────────────────────────────────────────────────
    def _start(self, mode: str) -> None:
        if self.server_started:
            self.set_status("Already hosting. Stop first to change mode.", "warn")
            return

        tok = (self.token_var.get() or "").strip()
        if not tok:
            self.set_status("Please set a Room token.", "error")
            self.token.focus_set()
            return

        os.environ["ROOM_TOKEN"] = tok
        cap = 2 if mode == "1x1" else 10

        # Lock UI while starting
        self.btn_1x1.state(["disabled"])
        self.btn_grp.state(["disabled"])
        self.set_status(f"Starting hosting · mode={mode}, capacity={cap}…", "info")
        self.server_started = True

        # Start HTTP/WS
        self.runner.submit(start_http_server(max_peers=cap))
        start_udp_responder()

        # Start public tunnel in background
        def on_url(url: str) -> None:
            def apply():
                self.public_url = url
                self.url_label.config(text=url)
                self.url_label.bind("<Button-1>", lambda _e: webbrowser.open(url))
                self.set_status("Public link is ready", "ok")
                self.btn_stop.state(["!disabled"])
            self.root.after(0, apply)

        threading.Thread(
            target=start_localhost_run_tunnel,
            name="TunnelStarter",
            kwargs={"local_port": HTTP_PORT, "on_url": on_url},
            daemon=True,
        ).start()

    def _stop(self) -> None:
        # Soft stop: close tunnel and unlock UI. (HTTP shutdown would need extra plumbing.)
        try:
            stop_localhost_run_tunnel()
        except Exception:
            pass

        self.btn_stop.state(["disabled"])
        self.btn_1x1.state(["!disabled"])
        self.btn_grp.state(["!disabled"])
        self.set_status("Hosting stopped. You can start again.", "info")
        self.url_label.config(text="")
        self.public_url = None
        self.server_started = False

    def stop(self) -> None:
        self._stop()
        self.root.destroy()

    # ── UI helpers ───────────────────────────────────────────────────
    def set_status(self, text: str, level: str = "info") -> None:
        colors = {"ok": OK, "info": MUTED, "warn": WARN, "error": DANGER}
        self.status.config(text=text, foreground=colors.get(level, MUTED))
