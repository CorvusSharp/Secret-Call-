"""Tkinter GUI for the Secure Call application."""

import os
import time
import tkinter as tk
from tkinter import simpledialog
import webbrowser

from async_runner import AsyncRunner
from core import (
    HTTP_PORT,
    PeerContext,
    AUDIO_SETTINGS,
    get_local_ip,
    run_peer,
    udp_discover,
    wait_port,
)
from tunnel import stop_localhost_run_tunnel


class App:
    """Simple one-button GUI that starts and manages calls."""

    def __init__(self, root: tk.Tk, runner: AsyncRunner):
        self.root = root
        self.runner = runner

        self.root.title("Secure Call — WebRTC")

        # Ask for name and mode at startup
        self.call_mode = simpledialog.askstring(
            "Режим",
            "Введите режим: 1x1 или group",
            parent=root,
        ) or "1x1"
        self.username = simpledialog.askstring(
            "Ваше имя",
            "Введите своё имя",
            parent=root,
        ) or "Anonymous"

        wrap = tk.Frame(root)
        wrap.pack(padx=10, pady=10)

        tk.Label(wrap, text=f"Пользователь: {self.username} | режим: {self.call_mode}").pack(pady=(0, 6))

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

        self.url_label = tk.Label(wrap, text="", fg="blue", cursor="hand2")
        self.url_label.pack(pady=(6, 10))

        self.start_btn = tk.Button(wrap, text="Подключиться (auto host/join)", command=self.start_call)
        self.start_btn.pack(pady=10)

        self.stop_btn = tk.Button(wrap, text="Выход", command=self.stop)
        self.stop_btn.pack()

        self.status = tk.Label(wrap, text="Сервер запущен, туннель стартует…", fg="green")
        self.status.pack(pady=(8, 0))

        # audio controls
        ctl = tk.LabelFrame(wrap, text="Звук")
        ctl.pack(pady=(10, 0), fill="x")

        self.mic_var = tk.DoubleVar(value=100)
        self.mic_mute = tk.IntVar()
        tk.Label(ctl, text="Микрофон").grid(row=0, column=0, sticky="w")
        tk.Scale(ctl, from_=0, to=100, orient="horizontal", variable=self.mic_var, command=self._upd_mic).grid(row=0, column=1)
        tk.Checkbutton(ctl, text="Mute", variable=self.mic_mute, command=self._upd_mic).grid(row=0, column=2)

        self.remote_var = tk.DoubleVar(value=100)
        self.remote_mute = tk.IntVar()
        tk.Label(ctl, text="Собеседник").grid(row=1, column=0, sticky="w")
        tk.Scale(ctl, from_=0, to=100, orient="horizontal", variable=self.remote_var, command=self._upd_remote).grid(row=1, column=1)
        tk.Checkbutton(ctl, text="Mute", variable=self.remote_mute, command=self._upd_remote).grid(row=1, column=2)

    def set_tunnel_url(self, url: str) -> None:
        """Display the public tunnel URL as a clickable link."""

        def _apply() -> None:
            def open_url(_evt) -> None:
                webbrowser.open(url)

            self.url_label.config(text=url)
            self.url_label.bind("<Button-1>", open_url)
            self.set_status("Публичная ссылка готова", "green")

        self.root.after(0, _apply)

    def start_call(self) -> None:
        self.set_status("Поиск хоста в LAN…", "blue")
        self.start_btn.config(state="disabled")
        self.runner.submit(self.auto_host_or_join())

    async def auto_host_or_join(self) -> None:
        info = await udp_discover(timeout=1.0, attempts=3)
        if info and "host" in info and await wait_port(info["host"], HTTP_PORT, timeout=3.0):
            host = info["host"]
            self.set_status(f"Подключаюсь к хосту {host}…", "blue")
            await run_peer(PeerContext(ws_url=f"ws://{host}:{HTTP_PORT}/ws", is_initiator=True, name=self.username))
            self.set_status("Звонок завершён", "green")
            self.start_btn.config(state="normal")
            return

        self.set_status("Я — ХОСТ. Жду участника…", "green")
        await run_peer(PeerContext(ws_url=f"ws://127.0.0.1:{HTTP_PORT}/ws", is_initiator=False, name=self.username))
        self.set_status("Звонок завершён", "green")
        self.start_btn.config(state="normal")

    def stop(self) -> None:
        self.set_status("Завершение…", "orange")
        try:
            stop_localhost_run_tunnel()
        except Exception:
            pass
        time.sleep(0.2)
        os._exit(0)

    def set_status(self, text: str, color: str = "green") -> None:
        try:
            self.root.after(0, lambda: self.status.config(text=text, fg=color))
        except Exception:
            self.status.config(text=text, fg=color)

    # --- audio controls -------------------------------------------------

    def _upd_mic(self, _evt=None) -> None:
        AUDIO_SETTINGS.mic_volume = self.mic_var.get() / 100.0
        AUDIO_SETTINGS.mic_muted = bool(self.mic_mute.get())

    def _upd_remote(self, _evt=None) -> None:
        AUDIO_SETTINGS.remote_volume = self.remote_var.get() / 100.0
        AUDIO_SETTINGS.remote_muted = bool(self.remote_mute.get())

