"""Tkinter GUI for the Secure Call application."""

import os
import time
import tkinter as tk
import webbrowser

from async_runner import AsyncRunner
from core import (
    HTTP_PORT,
    PeerContext,
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

        self.call_mode = "1x1"
        self.username = ""
        self._choose_mode()

    def _choose_mode(self) -> None:
        win = tk.Toplevel(self.root)
        win.title("Выбор режима")
        tk.Label(win, text="Выберите режим").pack(padx=20, pady=10)

        def set_mode(mode: str) -> None:
            self.call_mode = mode
            win.destroy()

        tk.Button(win, text="1x1 call", width=15, command=lambda: set_mode("1x1")).pack(pady=5)
        tk.Button(win, text="Group call", width=15, command=lambda: set_mode("group")).pack(pady=5)

        win.grab_set()
        self.root.wait_window(win)

        wrap = tk.Frame(self.root)
        wrap.pack(padx=10, pady=10)

        tk.Label(wrap, text=f"Режим: {self.call_mode}").pack(pady=(0, 6))

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

