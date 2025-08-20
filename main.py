"""Entry point for the Secure Call application."""

import threading
import tkinter as tk
from pathlib import Path

from async_runner import AsyncRunner
from core import HTTP_PORT, log, start_http_server, start_udp_responder
from gui import App
from tunnel import start_localhost_run_tunnel


def main() -> None:
    runner = AsyncRunner()
    runner.start()
    runner.submit(start_http_server())
    start_udp_responder()
    log.info("[BOOT] HTTP server scheduled, UDP responder started")

    root = tk.Tk()
    try:
        icon_path = Path(__file__).resolve().parent / "static" / "icon.svg"
        root.iconphoto(True, tk.PhotoImage(file=icon_path))
    except Exception:
        pass
    app = App(root, runner)

    threading.Thread(
        target=start_localhost_run_tunnel,
        name="TunnelStarter",
        kwargs={"local_port": HTTP_PORT, "on_url": app.set_tunnel_url},
        daemon=True,
    ).start()

    root.protocol("WM_DELETE_WINDOW", app.stop)
    root.mainloop()


if __name__ == "__main__":
    main()

