"""Tkinter GUI for the Secure Call application (neon dark)."""

import os
import time
import tkinter as tk
import tkinter.ttk as ttk
import webbrowser
import threading

from async_runner import AsyncRunner
# ИМПОРТ ИЗ secure_call_wss: сохраняем стиль и имена, просто берём из актуального модуля
from core import (
    HTTP_PORT,
    PeerContext,
    get_local_ip,
    run_peer,
    log,
    start_http_server,
    start_udp_responder,
)
from tunnel import start_localhost_run_tunnel, stop_localhost_run_tunnel


class App:
    def __init__(self, root: tk.Tk, runner: AsyncRunner) -> None:
        self.root = root
        self.runner = runner

        self.root.title("Secure Call — WebRTC")
        try:
            self.root.wm_attributes("-alpha", 0.98)
        except Exception:
            pass
        self._init_theme()

        self.call_mode = None  # "1x1" or "group"
        self.server_started = False
        self.max_peers_var = tk.IntVar(value=2)

        # Main card
        self.card = ttk.Frame(self.root, style="Card.TFrame")
        self.card.pack(padx=14, pady=14, ipadx=12, ipady=12, fill="x")

        self.title = ttk.Label(self.card, text="Secure Call", style="Title.TLabel")
        self.title.pack(pady=(0, 8))

        self.subtitle = ttk.Label(
            self.card,
            text="Choose call mode and capacity, then start hosting. Others will join via the public link.",
            style="Body.TLabel",
            justify="left",
        )
        self.subtitle.pack(pady=(0, 10))

        # Inline mode selector
        self.mode_row = ttk.Frame(self.card, style="Card.TFrame")
        self.mode_row.pack(pady=(2, 8))

        self.btn_1x1 = ttk.Button(self.mode_row, text="1×1 call", command=lambda: self._choose_mode("1x1"))
        self.btn_group = ttk.Button(self.mode_row, text="Group call (up to 10)", command=lambda: self._choose_mode("group"))
        self.btn_1x1.grid(row=0, column=0, padx=6)
        self.btn_group.grid(row=0, column=1, padx=6)

        # Capacity slider (двигающаяся полоска)
        self.cap_row = ttk.Frame(self.card, style="Card.TFrame")
        self.cap_row.pack(pady=(6, 8), fill="x")
        ttk.Label(self.cap_row, text="Max participants:", style="Body.TLabel").grid(row=0, column=0, padx=(0, 8))
        self.cap_scale = ttk.Scale(self.cap_row, from_=1, to=10, orient="horizontal",
                                   command=lambda v: self.max_peers_var.set(int(float(v))))
        self.cap_scale.set(self.max_peers_var.get())
        self.cap_scale.grid(row=0, column=1, sticky="ew")
        self.cap_row.columnconfigure(1, weight=1)
        self.cap_value = ttk.Label(self.cap_row, textvariable=self.max_peers_var, style="Body.TLabel")
        self.cap_value.grid(row=0, column=2, padx=(8, 0))

        # Start hosting button
        self.start_btn = ttk.Button(self.card, text="Start hosting", command=self._start_hosting)
        self.start_btn.pack(pady=(6, 10))

        self.info = ttk.Label(
            self.card,
            text=(
                "HTTP server will run here.\n"
                f"Local:  http://{get_local_ip()}:{HTTP_PORT}\n"
                "(Open in a browser; it will request microphone permission.)"
            ),
            style="Body.TLabel",
            justify="left",
        )
        self.info.pack()

        self.url_label = ttk.Label(self.card, text="", style="Body.TLabel", cursor="hand2", foreground="#63E6FF")
        self.url_label.pack(pady=(8, 12))

        self.status = ttk.Label(self.card, text="Awaiting mode selection and capacity…", style="Body.TLabel")
        self.status.pack(pady=(6, 0))

    def _init_theme(self) -> None:
        style = ttk.Style(self.root)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        self.root.configure(bg="#0B0F14")
        style.configure("TButton", padding=10, relief="flat", foreground="#EAF2FF", background="#182132")
        style.map("TButton", background=[("active", "#203047")])
        style.configure("Title.TLabel", font=("Segoe UI", 14, "bold"), foreground="#EAF2FF", background="#0B0F14")
        style.configure("Body.TLabel", font=("Segoe UI", 10), foreground="#BBD0FF", background="#0B0F14")
        style.configure("Card.TFrame", background="#132033", borderwidth=1, relief="solid")

    def _choose_mode(self, mode: str) -> None:
        self.call_mode = mode
        # Disable buttons after selection
        self.btn_1x1.state(["disabled"])
        self.btn_group.state(["disabled"])
        # не подключаемся из приложения! только браузерные клиенты
        self.set_status(f"Selected mode: {mode}. Set capacity and press Start hosting.")

    def _start_hosting(self) -> None:
        if self.server_started:
            return
        cap = int(self.max_peers_var.get())
        if self.call_mode == "1x1":
            cap = 2  # фиксируем для 1×1
        # блокируем элементы управления
        self.server_started = True
        self.cap_scale.state(["disabled"])
        self.start_btn.state(["disabled"])
        self.set_status(f"Starting HTTP server (capacity={cap})…", "blue")

        # стартуем HTTP/WS с выбранной вместимостью
        self.runner.submit(start_http_server(max_peers=cap))
        start_udp_responder()

        # поднимаем публичный туннель
        def _on_url(url: str) -> None:
            def _apply() -> None:
                def open_url(_evt) -> None:
                    webbrowser.open(url)
                self.url_label.config(text=url)
                self.url_label.bind("<Button-1>", open_url)
                self.set_status("Public link is ready", "green")
            self.root.after(0, _apply)

        threading.Thread(
            target=start_localhost_run_tunnel,
            name="TunnelStarter",
            kwargs={"local_port": HTTP_PORT, "on_url": _on_url},
            daemon=True,
        ).start()

        self.set_status("Hosting room (others join via link)…", "green")

    def set_tunnel_url(self, url: str) -> None:
        """Старый метод обратной совместимости — оставляем (вдруг кто-то вызывает)."""
        def _apply() -> None:
            def open_url(_evt) -> None:
                webbrowser.open(url)
            self.url_label.config(text=url)
            self.url_label.bind("<Button-1>", open_url)
            self.set_status("Public link is ready", "green")
        self.root.after(0, _apply)

    async def auto_host(self) -> None:
        """Сохраняем функцию для совместимости, но НЕ используем подключение из приложения."""
        self.set_status("Hosting room (browser clients only)…", "blue")
        # Раньше здесь было подключение run_peer(...). Больше не подключаемся из приложения.
        # Оставляем «заглушку» чтобы не ломать старые вызовы, если они где-то есть.
        await asyncio.sleep(0)

    def stop(self) -> None:
        self.set_status("Shutting down…", "orange")
        try:
            stop_localhost_run_tunnel()
        except Exception:
            pass
        time.sleep(0.2)
        os._exit(0)

    def set_status(self, text: str, color: str = "green") -> None:
        def _apply():
            try:
                self.status.configure(text=text, foreground=color)
            except Exception:
                self.status.config(text=text)
        try:
            self.root.after(0, _apply)
        except Exception:
            _apply()
