"""Asyncio event loop runner executed in a background thread.

Provides a small utility to run an asyncio event loop in its own thread and
schedule coroutines or callbacks onto it from arbitrary threads.

Usage:

    runner = AsyncRunner()
    runner.start()

    # schedule a coroutine (returns concurrent.futures.Future)
    fut = runner.submit(some_coro(arg=1))

    # wait for result
    result = fut.result()

    runner.stop()

Also supports context manager:

    with AsyncRunner() as runner:
        result = runner.run_coroutine(some_coro(), timeout=5)

"""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
import traceback
from typing import Any, Callable, Optional


class AsyncRunner:
    """Run an asyncio loop in a dedicated thread."""

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._ready_evt = threading.Event()
        self._stopped_evt = threading.Event()
        self._exc_in_thread: BaseException | None = None
        self._lock = threading.RLock()

    # --------------------------- lifecycle ---------------------------

    def start(self) -> None:
        """Start the event loop thread if not already started."""
        with self._lock:
            if self._thread and self._thread.is_alive():
                return

            self._ready_evt.clear()
            self._stopped_evt.clear()
            self._exc_in_thread = None

            def target() -> None:
                try:
                    loop = asyncio.new_event_loop()
                    self._loop = loop
                    asyncio.set_event_loop(loop)
                    self._ready_evt.set()
                    # Run forever until stop() posts loop.stop()
                    loop.run_forever()
                    # After loop.stop(), attempt graceful cleanup
                    try:
                        self._cancel_pending(loop)
                    finally:
                        loop.close()
                except BaseException as e:  # capture any fatal error in the thread
                    self._exc_in_thread = e
                    traceback.print_exc()
                finally:
                    self._stopped_evt.set()

            self._thread = threading.Thread(target=target, name="AsyncLoop", daemon=True)
            self._thread.start()

        # wait until the loop is created and installed in the thread
        self._ready_evt.wait()
        # if thread failed during startup, surface the exception now
        if self._exc_in_thread:
            raise RuntimeError("AsyncRunner failed to start") from self._exc_in_thread

    def stop(self, join_timeout: float = 5.0) -> None:
        """Stop the loop and join the thread.

        Args:
            join_timeout: maximum time (seconds) to wait for the thread to join.
        """
        with self._lock:
            loop = self._loop
            thread = self._thread

        if loop and loop.is_running():
            try:
                loop.call_soon_threadsafe(loop.stop)
            except RuntimeError:
                # loop may already be closed
                pass

        # Wait for the loop thread to finish cleanup
        self._stopped_evt.wait(timeout=join_timeout)

        with self._lock:
            if thread and thread.is_alive():
                # give it a bit more time; if still alive, we detach (daemon)
                thread.join(timeout=join_timeout)
            self._thread = None
            self._loop = None

    # ------------------------ scheduling API -------------------------

    def submit(self, coro: "asyncio.coroutines.Coroutine[Any, Any, Any]") -> concurrent.futures.Future:
        """Schedule a coroutine for execution (thread-safe).

        Returns a concurrent.futures.Future (not an asyncio.Future).
        """
        loop = self._ensure_running_loop()
        return asyncio.run_coroutine_threadsafe(coro, loop)

    def call_soon(self, callback: Callable[..., Any], *args: Any) -> None:
        """Thread-safe call to schedule a callback on the loop ASAP."""
        loop = self._ensure_running_loop()
        loop.call_soon_threadsafe(callback, *args)

    def run_sync(self, func: Callable[..., Any], *args: Any, **kwargs: Any) -> concurrent.futures.Future:
        """Run a blocking function in the loop's default executor.

        Returns a concurrent.futures.Future (use .result() to wait).
        """
        loop = self._ensure_running_loop()
        return asyncio.run_coroutine_threadsafe(loop.run_in_executor(None, lambda: func(*args, **kwargs)), loop)

    def run_coroutine(self, coro: "asyncio.coroutines.Coroutine[Any, Any, Any]", timeout: Optional[float] = None) -> Any:
        """Submit a coroutine and (optionally) wait for its result with a timeout."""
        fut = self.submit(coro)
        return fut.result(timeout=timeout)

    # ---------------------------- helpers ----------------------------

    def is_running(self) -> bool:
        """Return True if the event loop thread is running."""
        loop = self._loop
        return bool(loop and loop.is_running())

    def get_loop(self) -> asyncio.AbstractEventLoop:
        """Get the underlying event loop (raises if not started)."""
        return self._ensure_running_loop()

    def _ensure_running_loop(self) -> asyncio.AbstractEventLoop:
        """Internal: ensure loop is up and running, else raise."""
        # Fast path
        if self._loop and self._loop.is_running():
            return self._loop

        # If not ready yet, wait shortly
        if not self._ready_evt.is_set():
            self._ready_evt.wait(timeout=1.0)

        if self._exc_in_thread:
            raise RuntimeError("AsyncRunner thread crashed") from self._exc_in_thread

        if not (self._loop and self._loop.is_running()):
            raise RuntimeError("AsyncRunner is not running. Call start() first.")
        return self._loop

    @staticmethod
    def _cancel_pending(loop: asyncio.AbstractEventLoop) -> None:
        """Cancel all pending tasks on the loop and run one iteration to let them finalize."""
        try:
            pending = [t for t in asyncio.all_tasks(loop=loop) if not t.done()]
            for t in pending:
                t.cancel()
            if pending:
                # Run a brief loop iteration to allow cancellations to propagate
                loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        except Exception:
            # We don't re-raise during shutdown
            traceback.print_exc()

    # ---------------------- context manager API ----------------------

    def __enter__(self) -> "AsyncRunner":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()


# Backwards compatible alias if someone imported AsyncLoopRunner, etc.
__all__ = ["AsyncRunner"]
