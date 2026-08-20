"""
File watcher service for real-time file system monitoring.
Uses watchdog to detect file changes and broadcast via asyncio.Queue (SSE transport).
"""

import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, Optional, Set

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from app.services.project import ProjectService

logger = logging.getLogger(__name__)


class FileWatcherEvent:
    """Represents a file system event to be sent to clients."""

    def __init__(self, event_type: str, path: str, new_path: Optional[str] = None):
        self.event_type = event_type  # 'created', 'modified', 'deleted', 'moved'
        self.path = path
        self.new_path = new_path
        self.timestamp = datetime.now()

    def to_dict(self) -> dict:
        """Convert to JSON-serializable dict."""
        result = {
            "type": self.event_type,
            "path": self.path,
            "timestamp": self.timestamp.isoformat(),
        }
        if self.new_path:
            result["new_path"] = self.new_path
        return result


class ProjectFileHandler(FileSystemEventHandler):
    """Handles file system events for a specific project."""

    # Directories to ignore
    IGNORE_DIRS = {
        ".git",
        "__pycache__",
        ".pytest_cache",
        "node_modules",
        ".venv",
        "venv",
        "dbt_packages",
        "target",
        "logs",
        ".DS_Store",
    }

    # File extensions to ignore
    IGNORE_EXTENSIONS = {".pyc", ".pyo", ".swp", ".swo", ".swn", ".tmp", ".lock"}

    def __init__(
        self, project_id: str, project_path: Path, manager: "FileWatcherManager"
    ):
        super().__init__()
        self.project_id = project_id
        self.project_path = project_path
        self.manager = manager

        # Debouncing: track recent events to avoid spam
        self.recent_events: Dict[str, datetime] = {}
        self.debounce_seconds = 0.1  # 100ms debounce

    def _should_ignore(self, path: str) -> bool:
        """Check if path should be ignored."""
        path_obj = Path(path)

        # Ignore specific directories
        for part in path_obj.parts:
            if part in self.IGNORE_DIRS:
                return True

        # Ignore specific extensions
        if path_obj.suffix in self.IGNORE_EXTENSIONS:
            return True

        # Ignore hidden files (except .gitignore, .env, etc.)
        if path_obj.name.startswith(".") and path_obj.suffix not in {
            ".gitignore",
            ".env",
            ".editorconfig",
        }:
            return True

        return False

    def _is_debounced(self, event_key: str) -> bool:
        """Check if event should be debounced."""
        now = datetime.now()
        if event_key in self.recent_events:
            last_time = self.recent_events[event_key]
            if (now - last_time).total_seconds() < self.debounce_seconds:
                return True

        self.recent_events[event_key] = now

        # Clean old entries (older than 1 second)
        cutoff = now - timedelta(seconds=1)
        self.recent_events = {k: v for k, v in self.recent_events.items() if v > cutoff}

        return False

    def _get_relative_path(self, absolute_path: str) -> str:
        """Convert absolute path to relative path from project root."""
        try:
            return str(Path(absolute_path).relative_to(self.project_path))
        except ValueError:
            return absolute_path

    def _broadcast_event(self, event: FileWatcherEvent):
        """Broadcast event to all connected clients (thread-safe)."""
        # Get the event loop from the manager and schedule the coroutine
        try:
            loop = self.manager.get_event_loop()
            if loop and loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    self.manager.broadcast_event(self.project_id, event), loop
                )
        except Exception as e:
            logger.error(f"Failed to broadcast event: {e}")

    def on_created(self, event: FileSystemEvent):
        """Called when a file or directory is created."""
        src_path = (
            str(event.src_path) if isinstance(event.src_path, bytes) else event.src_path
        )
        if event.is_directory or self._should_ignore(src_path):
            return

        event_key = f"created:{src_path}"
        if self._is_debounced(event_key):
            return

        relative_path = self._get_relative_path(src_path)
        logger.info(f"File created: {relative_path}")

        watcher_event = FileWatcherEvent("created", relative_path)
        self._broadcast_event(watcher_event)

    def on_modified(self, event: FileSystemEvent):
        """Called when a file or directory is modified."""
        src_path = (
            str(event.src_path) if isinstance(event.src_path, bytes) else event.src_path
        )
        if event.is_directory or self._should_ignore(src_path):
            return

        event_key = f"modified:{src_path}"
        if self._is_debounced(event_key):
            return

        relative_path = self._get_relative_path(src_path)
        logger.debug(f"File modified: {relative_path}")

        watcher_event = FileWatcherEvent("modified", relative_path)
        self._broadcast_event(watcher_event)

    def on_deleted(self, event: FileSystemEvent):
        """Called when a file or directory is deleted."""
        src_path = (
            str(event.src_path) if isinstance(event.src_path, bytes) else event.src_path
        )
        if event.is_directory or self._should_ignore(src_path):
            return

        event_key = f"deleted:{src_path}"
        if self._is_debounced(event_key):
            return

        relative_path = self._get_relative_path(src_path)
        logger.info(f"File deleted: {relative_path}")

        watcher_event = FileWatcherEvent("deleted", relative_path)
        self._broadcast_event(watcher_event)

    def on_moved(self, event: FileSystemEvent):
        """Called when a file or directory is moved or renamed."""
        src_path = (
            str(event.src_path) if isinstance(event.src_path, bytes) else event.src_path
        )
        dest_path = (
            str(event.dest_path)
            if hasattr(event, "dest_path") and isinstance(event.dest_path, bytes)
            else getattr(event, "dest_path", "")
        )
        if event.is_directory or self._should_ignore(src_path):
            return

        event_key = f"moved:{src_path}:{dest_path}"
        if self._is_debounced(event_key):
            return

        src_relative = self._get_relative_path(src_path)
        dest_relative = self._get_relative_path(dest_path)
        logger.info(f"File moved: {src_relative} -> {dest_relative}")

        watcher_event = FileWatcherEvent("moved", src_relative, dest_relative)
        self._broadcast_event(watcher_event)


class ProjectWatcher:
    """Manages file watching for a single project."""

    def __init__(
        self, project_id: str, project_path: Path, manager: "FileWatcherManager"
    ):
        self.project_id = project_id
        self.project_path = project_path
        self.manager = manager

        # SSE client queues for this project. Each connected SSE endpoint
        # pushes a queue here; broadcast() puts events onto every queue.
        self.queues: Set[asyncio.Queue] = set()

        # Watchdog observer
        self.observer = Observer()
        self.event_handler = ProjectFileHandler(project_id, project_path, manager)

        # Start watching
        self.observer.schedule(self.event_handler, str(project_path), recursive=True)
        self.observer.start()
        logger.info(f"Started file watcher for project: {project_id}")

    async def add_queue(self, queue: asyncio.Queue) -> None:
        """Register an SSE client queue."""
        self.queues.add(queue)
        logger.debug(
            f"SSE client connected to file watcher: {self.project_id} (total: {len(self.queues)})"
        )

    async def remove_queue(self, queue: asyncio.Queue) -> None:
        """Unregister an SSE client queue."""
        self.queues.discard(queue)
        logger.debug(
            f"SSE client disconnected from file watcher: {self.project_id} (remaining: {len(self.queues)})"
        )

    async def broadcast(self, event: FileWatcherEvent) -> None:
        """Broadcast event to all connected SSE clients."""
        if not self.queues:
            return

        event_data = event.to_dict()
        for queue in self.queues:
            try:
                queue.put_nowait(event_data)
            except asyncio.QueueFull:
                # Slow consumer: log and drop this event. Do NOT remove the queue —
                # backpressure is expected for slow clients; killing the connection
                # would cause spurious disconnects on transient lag.
                logger.warning(
                    f"Queue full for project {self.project_id}, dropping event "
                    f"(queue size: {queue.qsize()}/{queue.maxsize})"
                )

    def stop(self):
        """Stop watching and clean up."""
        self.observer.stop()
        self.observer.join(timeout=1)
        logger.info(f"Stopped file watcher for project: {self.project_id}")


class FileWatcherManager:
    """Singleton manager for all project file watchers."""

    _instance: Optional["FileWatcherManager"] = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self.watchers: Dict[str, ProjectWatcher] = {}
        self.project_service = ProjectService()
        self._event_loop: Optional[asyncio.AbstractEventLoop] = None
        self._initialized = True
        logger.info("FileWatcherManager initialized")

    def get_event_loop(self) -> Optional[asyncio.AbstractEventLoop]:
        """Get the stored event loop for thread-safe scheduling."""
        return self._event_loop

    def set_event_loop(self, loop: asyncio.AbstractEventLoop):
        """Store the event loop for thread-safe scheduling."""
        self._event_loop = loop

    async def start_watching(self, project_id: str, queue: asyncio.Queue) -> bool:
        """
        Start watching a project and register an SSE client queue.

        Returns:
            True if successfully started/registered, False otherwise
        """
        try:
            # Get project path - use get_path instead of get_path_or_raise for empty projects
            project_path = self.project_service.get_path(project_id)

            # Check if project has files - if empty, still allow watching for new files
            if not project_path.exists():
                logger.warning(
                    f"Project {project_id} path doesn't exist yet, creating..."
                )
                project_path.mkdir(parents=True, exist_ok=True)

            # Check if project has dbt_project.yml - if not, it might be syncing
            has_dbt_project = (project_path / "dbt_project.yml").exists()
            if not has_dbt_project:
                logger.info(
                    f"Project {project_id} appears empty (no dbt_project.yml), watcher will monitor for new files"
                )

            # Create watcher if not exists
            if project_id not in self.watchers:
                self.watchers[project_id] = ProjectWatcher(
                    project_id, project_path, self
                )

            # Register queue
            await self.watchers[project_id].add_queue(queue)
            return True

        except Exception as e:
            logger.error(f"Failed to start watching project {project_id}: {e}")
            return False

    async def stop_watching(self, project_id: str, queue: asyncio.Queue) -> None:
        """Unregister an SSE client queue and stop watcher if no clients remain."""
        if project_id not in self.watchers:
            return

        watcher = self.watchers[project_id]
        await watcher.remove_queue(queue)

        # Stop watcher if no clients left
        if not watcher.queues:
            watcher.stop()
            del self.watchers[project_id]
            logger.info(f"No more clients, stopped watcher for: {project_id}")

    async def broadcast_event(self, project_id: str, event: FileWatcherEvent):
        """Broadcast event to all clients watching a project."""
        if project_id in self.watchers:
            await self.watchers[project_id].broadcast(event)

    def cleanup_all(self):
        """Stop all watchers (called on shutdown)."""
        for project_id, watcher in list(self.watchers.items()):
            watcher.stop()
        self.watchers.clear()
        logger.info("All file watchers stopped")


# Singleton instance
file_watcher_manager = FileWatcherManager()
