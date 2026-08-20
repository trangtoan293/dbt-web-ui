"""
File operations service.
Handles all file CRUD operations.
"""

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.exceptions import FileNotFoundException, InvalidPathException
from app.models.file import FileCreateRequest, FileSaveRequest
from app.services.project import ProjectService

logger = logging.getLogger(__name__)


class FileService:
    """Service for file operations."""

    # Whitelist of readable text file extensions
    READABLE_EXTENSIONS = {
        # SQL & dbt
        ".sql",
        ".yml",
        ".yaml",
        # Documentation
        ".md",
        ".txt",
        ".rst",
        ".csv",
        ".tsv",
        # Code
        ".py",
        ".js",
        ".ts",
        ".jsx",
        ".tsx",
        ".json",
        # Config
        ".toml",
        ".ini",
        ".cfg",
        ".conf",
        ".env",
        ".properties",
        ".gitignore",
        ".dockerignore",
        ".editorconfig",
        ".log",
        ".logs",
        # Data formats
        ".xml",
    }

    # Files without extension that are readable
    READABLE_FILENAMES = {
        "Dockerfile",
        "Makefile",
        "LICENSE",
        "README",
        ".gitignore",
        ".dbtignore",
        ".dockerignore",
        ".env",
        ".env.example",
    }

    def __init__(self, project_service: Optional[ProjectService] = None):
        self.project = project_service or ProjectService()

    async def list_files(self, project_id: str, path: str = "") -> Dict[str, Any]:
        """
        List files in a project directory.

        Args:
            project_id: Project identifier
            path: Relative path within project (empty for root)

        Returns:
            Dict with path and items list
        """
        project_path = self.project.get_path_or_raise(project_id)
        target_path = project_path / path if path else project_path

        if not target_path.exists():
            raise FileNotFoundException(path)

        # Directories to always skip
        skip_dirs = {
            ".git",
            "__pycache__",
            ".pytest_cache",
            "node_modules",
            ".venv",
            "venv",
        }

        items = []
        try:
            for item in target_path.iterdir():
                # Skip certain system directories
                if item.is_dir() and item.name in skip_dirs:
                    continue

                try:
                    items.append(
                        {
                            "name": item.name,
                            "path": str(item.relative_to(project_path)),
                            "type": "folder" if item.is_dir() else "file",
                            "size": item.stat().st_size if item.is_file() else None,
                        }
                    )
                except PermissionError:
                    logger.warning(f"Permission denied accessing item: {item}")
                    continue
                except OSError as e:
                    logger.warning(f"OS error accessing item {item}: {e}")
                    continue
        except PermissionError:
            logger.error(f"Permission denied accessing directory: {target_path}")
            raise InvalidPathException(f"Permission denied: {path}")

        # Sort: folders first, then by name
        items = sorted(items, key=lambda x: (x["type"] != "folder", x["name"]))

        return {"path": path, "items": items}

    async def search_files(self, project_id: str, query: str) -> Dict[str, Any]:
        """
        Search for files matching a query in the entire project.

        Args:
            project_id: Project identifier
            query: Search query string

        Returns:
            Dict with query and matching files list
        """
        project_path = self.project.get_path_or_raise(project_id)

        # Directories to always skip
        skip_dirs = {
            ".git",
            "__pycache__",
            ".pytest_cache",
            "node_modules",
            ".venv",
            "venv",
            "target",
            "logs",
            "dbt_packages",
        }

        query_lower = query.lower()
        results = []

        def search_directory(dir_path: Path):
            try:
                for item in dir_path.iterdir():
                    # Skip certain system directories
                    if item.is_dir() and item.name in skip_dirs:
                        continue

                    rel_path = str(item.relative_to(project_path))

                    # Check if name matches query
                    if query_lower in item.name.lower():
                        results.append(
                            {
                                "name": item.name,
                                "path": rel_path,
                                "type": "folder" if item.is_dir() else "file",
                            }
                        )

                    # Recursively search directories
                    if item.is_dir():
                        search_directory(item)
            except PermissionError:
                pass

        search_directory(project_path)

        # Sort: folders first, then by name
        results = sorted(results, key=lambda x: (x["type"] != "folder", x["name"]))

        return {"query": query, "results": results}

    async def read_file(self, project_id: str, path: str) -> Dict[str, Any]:
        """
        Read file content.

        Args:
            project_id: Project identifier
            path: Relative path to file

        Returns:
            Dict with path and content
        """
        project_path = self.project.get_path_or_raise(project_id)
        file_path = project_path / path

        if not file_path.exists():
            raise FileNotFoundException(path)

        if not file_path.is_file():
            raise InvalidPathException(f"Path is not a file: {path}")

        # Check if file is readable (whitelist approach)
        file_ext = file_path.suffix.lower()
        file_name = file_path.name

        is_readable = (
            file_ext in self.READABLE_EXTENSIONS or file_name in self.READABLE_FILENAMES
        )

        if not is_readable:
            raise InvalidPathException(
                f"Cannot read file '{path}': unsupported file type '{file_ext or 'no extension'}'. "
                f"Only text files are supported."
            )

        try:
            content = file_path.read_text()
            return {"path": path, "content": content}
        except PermissionError:
            logger.error(f"Permission denied reading file: {path}")
            raise InvalidPathException(f"Permission denied: {path}")
        except UnicodeDecodeError as e:
            logger.error(f"Cannot decode file as text: {path} - {e}")
            raise InvalidPathException(
                f"Cannot read file '{path}': file is not a valid text file or contains binary data"
            )
        except OSError as e:
            logger.error(f"OS error reading file {path}: {e}")
            raise InvalidPathException(f"Cannot read file '{path}': {e}")

    async def write_file(
        self, project_id: str, path: str, content: str
    ) -> Dict[str, Any]:
        """
        Write file content.

        Args:
            project_id: Project identifier
            path: Relative path to file
            content: File content to write

        Returns:
            Dict with success and path
        """
        project_path = self.project.get_path_or_raise(project_id)
        file_path = project_path / path

        # Validate path is within project
        self.project.validate_subpath(project_path, path)

        # Create parent directories if needed
        if not file_path.parent.exists():
            file_path.parent.mkdir(parents=True)

        try:
            file_path.write_text(content)
            return {"success": True, "path": path}
        except PermissionError:
            logger.error(f"Permission denied writing file: {path}")
            raise InvalidPathException(f"Permission denied: {path}")
        except OSError as e:
            logger.error(f"OS error writing file {path}: {e}")
            raise InvalidPathException(f"Cannot write file '{path}': {e}")

    async def create(
        self, project_id: str, request: FileCreateRequest
    ) -> Dict[str, Any]:
        """
        Create a new file or directory.

        Args:
            project_id: Project identifier
            request: FileCreateRequest with path, content, file_type

        Returns:
            Dict with success, message, path
        """
        # Use ensure_exists instead of get_path_or_raise to auto-create project folder
        project_path = self.project.ensure_exists(project_id)
        target_path = project_path / request.path

        # Validate path
        self.project.validate_subpath(project_path, request.path)

        try:
            if request.file_type == "directory":
                target_path.mkdir(parents=True, exist_ok=True)
                return {
                    "success": True,
                    "message": f"Directory created: {request.path}",
                    "path": str(target_path),
                }
            else:
                # Create parent directories if needed
                target_path.parent.mkdir(parents=True, exist_ok=True)

                # Determine default content based on file extension
                content = request.content
                if not content:
                    content = self._get_default_content(target_path)

                target_path.write_text(content or "")
                return {
                    "success": True,
                    "message": f"File created: {request.path}",
                    "path": str(target_path),
                }
        except PermissionError:
            logger.error(f"Permission denied creating: {request.path}")
            raise InvalidPathException(f"Permission denied: {request.path}")
        except OSError as e:
            logger.error(f"OS error creating {request.path}: {e}")
            raise InvalidPathException(f"Cannot create '{request.path}': {e}")

    def _get_default_content(self, target_path: Path) -> str:
        """Get default content based on file extension."""
        ext = target_path.suffix.lower()
        templates = {
            ".sql": f"-- {target_path.name}\n\nSELECT\n    *\nFROM {{ ref('source') }}\n",
            ".yml": f"# {target_path.name}\nversion: 2\n\nmodels:\n  - name: example\n",
            ".yaml": f"# {target_path.name}\nversion: 2\n\nmodels:\n  - name: example\n",
            ".md": f"# {target_path.stem}\n\nDescription here\n",
            ".csv": "id,name\n1,example\n",
            ".py": f"# {target_path.name}\n\ndef model(dbt, session):\n    pass\n",
        }
        return templates.get(ext, "")

    async def save_content(
        self, project_id: str, request: FileSaveRequest
    ) -> Dict[str, Any]:
        """
        Save content to an existing file.

        Args:
            project_id: Project identifier
            request: FileSaveRequest with path and content

        Returns:
            Dict with success and message
        """
        project_path = self.project.get_path_or_raise(project_id)
        target_path = project_path / request.path

        # Validate path
        self.project.validate_subpath(project_path, request.path)

        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            target_path.write_text(request.content)

            return {"success": True, "message": f"File saved: {request.path}"}
        except PermissionError:
            logger.error(f"Permission denied saving: {request.path}")
            raise InvalidPathException(f"Permission denied: {request.path}")
        except OSError as e:
            logger.error(f"OS error saving {request.path}: {e}")
            raise InvalidPathException(f"Cannot save '{request.path}': {e}")

    async def delete(self, project_id: str, path: str) -> Dict[str, Any]:
        """
        Delete a file or directory.

        Args:
            project_id: Project identifier
            path: Relative path to delete

        Returns:
            Dict with success and message
        """
        import shutil

        project_path = self.project.get_path_or_raise(project_id)
        target_path = project_path / path

        if not target_path.exists():
            raise FileNotFoundException(path)

        # Validate path is within project
        self.project.validate_subpath(project_path, path)

        try:
            if target_path.is_dir():
                shutil.rmtree(target_path)
            else:
                target_path.unlink()

            return {"success": True, "message": f"Deleted: {path}"}
        except PermissionError:
            logger.error(f"Permission denied deleting: {path}")
            raise InvalidPathException(f"Permission denied: {path}")
        except OSError as e:
            logger.error(f"OS error deleting {path}: {e}")
            raise InvalidPathException(f"Cannot delete '{path}': {e}")

    async def rename(
        self, project_id: str, old_path: str, new_path: str
    ) -> Dict[str, Any]:
        """
        Rename a file or directory.

        Args:
            project_id: Project identifier
            old_path: Current relative path
            new_path: New relative path

        Returns:
            Dict with success, message, old_path, new_path
        """
        import shutil

        project_path = self.project.get_path_or_raise(project_id)
        old_target = project_path / old_path
        new_target = project_path / new_path

        if not old_target.exists():
            raise FileNotFoundException(old_path)

        if new_target.exists():
            raise InvalidPathException(f"Path already exists: {new_path}")

        # Validate both paths are within project
        self.project.validate_subpath(project_path, old_path)
        self.project.validate_subpath(project_path, new_path)

        try:
            # Create parent directories if needed
            new_target.parent.mkdir(parents=True, exist_ok=True)
            # Rename using shutil.move
            shutil.move(str(old_target), str(new_target))

            return {
                "success": True,
                "message": f"Renamed: {old_path} -> {new_path}",
                "old_path": old_path,
                "new_path": new_path,
            }
        except PermissionError:
            logger.error(f"Permission denied renaming: {old_path} to {new_path}")
            raise InvalidPathException(f"Permission denied: {old_path}")
        except OSError as e:
            logger.error(f"OS error renaming {old_path} to {new_path}: {e}")
            raise InvalidPathException(f"Cannot rename '{old_path}': {e}")

    async def move(
        self, project_id: str, source_path: str, dest_path: str
    ) -> Dict[str, Any]:
        """
        Move a file or directory to a new location.
        Uses the same logic as rename internally.

        Args:
            project_id: Project identifier
            source_path: Current relative path
            dest_path: Destination relative path (can be a directory)

        Returns:
            Dict with success, message, source_path, dest_path
        """
        import shutil

        project_path = self.project.get_path_or_raise(project_id)
        source_target = project_path / source_path

        # Handle empty dest_path (move to root)
        if not dest_path or dest_path.strip() == "":
            # Moving to root: extract filename from source
            filename = Path(source_path).name
            dest_target = project_path / filename
        else:
            dest_target = project_path / dest_path

        # Validate paths
        try:
            source_target = self.project.validate_subpath(project_path, source_path)
        except Exception:
            raise FileNotFoundException(source_path)

        if not source_target.exists():
            raise FileNotFoundException(source_path)

        # Determine final destination
        if dest_target.exists() and dest_target.is_dir():
            # If destination is an existing directory, move into it
            final_dest = dest_target / source_target.name
        else:
            # Otherwise, use as-is (rename)
            final_dest = dest_target

        project_root = project_path.resolve()
        final_dest_resolved = final_dest.resolve()
        try:
            final_dest_relative = final_dest_resolved.relative_to(project_root)
        except ValueError:
            raise InvalidPathException(f"Invalid destination path: {dest_path}")

        # Prevent moving into itself or child
        try:
            final_dest_resolved.relative_to(source_target.resolve())
            raise InvalidPathException(
                f"Cannot move '{source_path}' into itself or a subdirectory"
            )
        except ValueError:
            # Not a subdirectory, safe to proceed
            pass

        if final_dest_resolved.exists():
            raise InvalidPathException(
                f"Destination already exists: {final_dest_relative}"
            )

        # Ensure parent exists
        final_dest.parent.mkdir(parents=True, exist_ok=True)

        # Perform move
        try:
            shutil.move(str(source_target), str(final_dest))
            logger.info(
                f"Moved: {source_path} -> {final_dest_relative}"
            )

            return {
                "success": True,
                "message": f"Moved to {final_dest_relative}",
                "source_path": source_path,
                "dest_path": str(final_dest_relative),
            }
        except PermissionError:
            logger.error(f"Permission denied moving: {source_path} to {dest_path}")
            raise InvalidPathException(f"Permission denied moving '{source_path}'")
        except OSError as e:
            logger.error(f"OS error moving {source_path} to {dest_path}: {e}")
            raise InvalidPathException(
                f"Failed to move '{source_path}' to '{dest_path}': {str(e)}"
            )

    async def copy(
        self, project_id: str, source_path: str, dest_path: str
    ) -> Dict[str, Any]:
        """
        Copy a file or directory to a new location.

        Args:
            project_id: Project identifier
            source_path: Source relative path
            dest_path: Destination relative path

        Returns:
            Dict with success, message, source_path, dest_path
        """
        import shutil

        project_path = self.project.get_path_or_raise(project_id)
        source_target = project_path / source_path
        dest_target = project_path / dest_path

        if not source_target.exists():
            raise FileNotFoundException(source_path)

        # Validate both paths are within project
        self.project.validate_subpath(project_path, source_path)
        self.project.validate_subpath(project_path, dest_path)

        # If destination is a directory, copy the source into it
        if dest_target.exists() and dest_target.is_dir():
            dest_target = dest_target / source_target.name

        if dest_target.exists():
            raise InvalidPathException(f"Path already exists: {dest_path}")

        try:
            # Create parent directories if needed
            dest_target.parent.mkdir(parents=True, exist_ok=True)

            if source_target.is_dir():
                shutil.copytree(str(source_target), str(dest_target))
            else:
                shutil.copy2(str(source_target), str(dest_target))

            final_dest_path = str(dest_target.relative_to(project_path))
            return {
                "success": True,
                "message": f"Copied: {source_path} -> {final_dest_path}",
                "source_path": source_path,
                "dest_path": final_dest_path,
            }
        except PermissionError:
            logger.error(f"Permission denied copying: {source_path} to {dest_path}")
            raise InvalidPathException(f"Permission denied: {source_path}")
        except OSError as e:
            logger.error(f"OS error copying {source_path} to {dest_path}: {e}")
            raise InvalidPathException(f"Cannot copy '{source_path}': {e}")

    async def duplicate(self, project_id: str, path: str) -> Dict[str, Any]:
        """
        Duplicate a file or directory in the same location with _copy suffix.

        Args:
            project_id: Project identifier
            path: Relative path to duplicate

        Returns:
            Dict with success, message, original_path, new_path
        """
        import shutil

        project_path = self.project.get_path_or_raise(project_id)
        source_target = project_path / path

        if not source_target.exists():
            raise FileNotFoundException(path)

        # Validate path is within project
        self.project.validate_subpath(project_path, path)

        # Generate new name with _copy suffix
        stem = source_target.stem
        suffix = source_target.suffix
        parent = source_target.parent

        # Find a unique name
        copy_count = 1
        if source_target.is_dir():
            new_name = f"{source_target.name}_copy"
            new_target = parent / new_name
            while new_target.exists():
                copy_count += 1
                new_name = f"{source_target.name}_copy{copy_count}"
                new_target = parent / new_name
        else:
            new_name = f"{stem}_copy{suffix}"
            new_target = parent / new_name
            while new_target.exists():
                copy_count += 1
                new_name = f"{stem}_copy{copy_count}{suffix}"
                new_target = parent / new_name

        try:
            if source_target.is_dir():
                shutil.copytree(str(source_target), str(new_target))
            else:
                shutil.copy2(str(source_target), str(new_target))

            new_path = str(new_target.relative_to(project_path))
            return {
                "success": True,
                "message": f"Duplicated: {path} -> {new_path}",
                "original_path": path,
                "new_path": new_path,
            }
        except PermissionError:
            logger.error(f"Permission denied duplicating: {path}")
            raise InvalidPathException(f"Permission denied: {path}")
        except OSError as e:
            logger.error(f"OS error duplicating {path}: {e}")
            raise InvalidPathException(f"Cannot duplicate '{path}': {e}")
