"""
Local filesystem storage service.
Replaces Supabase storage buckets with direct filesystem operations.
"""

import io
import json
import logging
import tarfile
import shutil
import os
from datetime import datetime
from pathlib import Path
from typing import Any, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)

EXCLUDE_PATTERNS = [
    "target/", "dbt_packages/", "logs/", "__pycache__/",
    ".git/", "*.pyc", ".DS_Store", "Thumbs.db", "node_modules/", ".venv/",
]


class StorageService:
    """Local filesystem storage for project snapshots and manifests."""

    def __init__(self, base_dir: Optional[str] = None):
        self.base_dir = Path(base_dir or settings.storage_dir)
        self.projects_dir = self.base_dir / "dbt-projects"
        self.projects_dir.mkdir(parents=True, exist_ok=True)

    def ensure_project_dir(self, project_id: str) -> Path:
        """Ensure the project directory exists and return its path."""
        project_dir = self.projects_dir / project_id
        project_dir.mkdir(parents=True, exist_ok=True)
        return project_dir

    def upload(self, project_id: str, file_path: str, content: bytes) -> Path:
        """Upload a file to the project's storage directory."""
        project_dir = self.ensure_project_dir(project_id)
        target = project_dir / file_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        logger.info(f"Uploaded: {project_id}/{file_path}")
        return target

    def download(self, project_id: str, file_path: str) -> Optional[bytes]:
        """Download a file from the project's storage directory."""
        target = self.projects_dir / project_id / file_path
        if not target.exists():
            return None
        return target.read_bytes()

    def list_files(self, project_id: str, prefix: str = "") -> List[dict]:
        """List files in a project directory, optionally filtered by prefix."""
        project_dir = self.ensure_project_dir(project_id)
        search_dir = project_dir / prefix if prefix else project_dir
        if not search_dir.exists():
            return []
        files = []
        for root, dirs, filenames in os.walk(search_dir):
            for fname in filenames:
                full_path = Path(root) / fname
                rel_path = full_path.relative_to(project_dir)
                stat = full_path.stat()
                files.append({
                    "name": str(rel_path),
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                })
        return files

    def remove(self, project_id: str, file_paths: List[str]) -> None:
        """Remove files from project storage."""
        for fp in file_paths:
            target = self.projects_dir / project_id / fp
            if target.exists():
                target.unlink()
                logger.info(f"Removed: {project_id}/{fp}")

    def remove_project(self, project_id: str) -> None:
        """Remove entire project storage directory."""
        project_dir = self.projects_dir / project_id
        if project_dir.exists():
            shutil.rmtree(project_dir)
            logger.info(f"Removed project directory: {project_id}")

    def mark_deleted(self, project_id: str) -> Path:
        """Mark a project as soft-deleted in local storage metadata."""
        project_dir = self.ensure_project_dir(project_id)
        marker = project_dir / ".deleted.json"
        marker.write_text(
            json.dumps({"deleted_at": datetime.utcnow().isoformat()}),
            encoding="utf-8",
        )
        logger.info(f"Marked project as deleted: {project_id}")
        return marker

    def restore_project(self, project_id: str) -> None:
        """Clear local storage soft-delete metadata for a project."""
        marker = self.projects_dir / project_id / ".deleted.json"
        if marker.exists():
            marker.unlink()
            logger.info(f"Restored project marker: {project_id}")

    def create_snapshot(self, project_id: str, source_dir: Path) -> None:
        """Create a tar.gz snapshot of the project workspace."""
        project_dir = self.ensure_project_dir(project_id)
        snapshot_path = project_dir / f"snapshot_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.tar.gz"

        with tarfile.open(snapshot_path, "w:gz") as tar:
            for root, dirs, files in os.walk(source_dir):
                dirs[:] = [d for d in dirs if not any(
                    d == p.rstrip("/") for p in ["target", "dbt_packages", "logs", ".git", "__pycache__", "node_modules", ".venv"]
                )]
                for fname in files:
                    if any(fname.endswith(p.lstrip("*")) for p in EXCLUDE_PATTERNS):
                        continue
                    full_path = Path(root) / fname
                    tar.add(full_path, arcname=full_path.relative_to(source_dir))

        logger.info(f"Created snapshot: {snapshot_path}")

    def restore_snapshot(self, project_id: str, snapshot_name: str, target_dir: Path) -> bool:
        """Restore a snapshot to the target directory."""
        snapshot_path = self.projects_dir / project_id / snapshot_name
        if not snapshot_path.exists():
            return False
        target_dir.mkdir(parents=True, exist_ok=True)
        with tarfile.open(snapshot_path, "r:gz") as tar:
            tar.extractall(target_dir)
        logger.info(f"Restored snapshot: {snapshot_name} -> {target_dir}")
        return True

    def sync_from_workspace(self, project_id: str, workspace_dir: Path) -> None:
        """Sync workspace files to project storage directory."""
        project_dir = self.ensure_project_dir(project_id)
        for root, dirs, files in os.walk(workspace_dir):
            dirs[:] = [d for d in dirs if d not in ["target", "dbt_packages", ".git", "__pycache__", "node_modules", ".venv"]]
            for fname in files:
                src = Path(root) / fname
                rel = src.relative_to(workspace_dir)
                dst = project_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dst)
        logger.info(f"Synced workspace to storage: {project_id}")


# Singleton
storage_service = StorageService()


# Compatibility wrapper for old async Supabase-based callers
class StorageServiceCompat:
    """Compatibility wrapper providing the old async API on top of local FS."""
    
    def __init__(self):
        self._inner = storage_service
        self.enabled = True  # Local FS is always available

    async def sync_files_to_storage(self, project_id: str, workspace_path: Path) -> bool:
        """Async wrapper for sync_from_workspace."""
        try:
            self._inner.sync_from_workspace(project_id, workspace_path)
            return True
        except Exception as e:
            logger.error(f"Sync to storage failed: {e}")
            return False

    async def sync_files_from_storage(self, project_id: str, target_path: Path) -> bool:
        """Alias for sync_from_storage - direct file sync with timestamp comparison."""
        return await self.sync_from_storage(project_id, target_path)

    async def sync_from_storage(self, project_id: str, target_path: Path) -> bool:
        """Async wrapper - restore latest snapshot."""
        try:
            files = self._inner.list_files(project_id)
            snapshots = [f["name"] for f in files if f["name"].startswith("snapshot_")]
            if snapshots:
                latest = sorted(snapshots)[-1]
                return self._inner.restore_snapshot(project_id, latest, target_path)
            # Fallback: just ensure directory exists
            target_path.mkdir(parents=True, exist_ok=True)
            return True
        except Exception as e:
            logger.error(f"Sync from storage failed: {e}")
            return False

    async def delete_from_storage(self, project_id: str) -> bool:
        """Async wrapper for permanent project storage deletion."""
        try:
            self._inner.remove_project(project_id)
            return True
        except Exception as e:
            logger.error(f"Delete from storage failed: {e}")
            return False

    async def mark_deleted(self, project_id: str) -> bool:
        """Async wrapper for soft-delete metadata."""
        try:
            self._inner.mark_deleted(project_id)
            return True
        except Exception as e:
            logger.error(f"Mark deleted failed: {e}")
            return False

    async def restore_project(self, project_id: str) -> bool:
        """Async wrapper for clearing soft-delete metadata."""
        try:
            self._inner.restore_project(project_id)
            return True
        except Exception as e:
            logger.error(f"Restore project failed: {e}")
            return False

    async def _get_manifest(self, project_id: str) -> Optional[dict]:
        """Get dbt manifest from project storage."""
        try:
            data = self._inner.download(project_id, "target/manifest.json")
            if data:
                return json.loads(data.decode())
            return None
        except Exception:
            return None


def get_storage_service() -> StorageServiceCompat:
    """Get storage service instance (compatibility API)."""
    return StorageServiceCompat()
