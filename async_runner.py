"""Asyncio event loop runner executed in a background thread."""

import asyncio
import threading


class AsyncRunner:
    """Run an asyncio loop in a dedicated thread."""

    def __init__(self) -> None:
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.ready = threading.Event()

    def start(self) -> None:
        """Start the event loop thread."""

        def target() -> None:
            self.loop = asyncio.new_event_loop()
            asyncio.set_event_loop(self.loop)
            self.ready.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=target, name="AsyncLoop", daemon=True)
        self.thread.start()
        self.ready.wait()

    def submit(self, coro):
        """Schedule a coroutine for execution."""

        self.ready.wait()
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    def stop(self) -> None:
        """Stop the loop and join the thread."""

        if self.loop:
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread:
            self.thread.join(timeout=1)

