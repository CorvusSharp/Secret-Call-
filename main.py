"""Entry point for the Secure Call application."""

import threading
import tkinter as tk
from pathlib import Path

from async_runner import AsyncRunner
from core import log  # логгер берём из актуального модуля
from gui import App

def main() -> None:
    runner = AsyncRunner()
    runner.start()

    # ВНИМАНИЕ: сервер НЕ стартуем здесь.
    # Он стартует в GUI после выбора режима и лимита и нажатия "Start hosting".
    log.info("[BOOT] GUI ready — waiting for user to choose mode and capacity")

    root = tk.Tk()
    try:
        icon_path = Path(__file__).resolve().parent / "static" / "icon.svg"
        root.iconphoto(True, tk.PhotoImage(file=icon_path))
    except Exception:
        pass

    app = App(root, runner)
    root.protocol("WM_DELETE_WINDOW", app.stop)
    root.mainloop()

if __name__ == "__main__":
    main()
