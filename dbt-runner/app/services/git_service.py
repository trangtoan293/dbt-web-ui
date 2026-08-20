"""
Git operations service.
Handles all git command executions.
"""

import base64
import logging
import shutil
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import text

from app.core.crypto import EncryptionError, decrypt_secret, encrypt_secret
from app.exceptions import GitOperationError
from app.models.git import (
    GitAddRemoteRequest,
    GitCheckoutRequest,
    GitCloneRequest,
    GitCommitRequest,
    GitConfigRequest,
    GitInitRequest,
    GitPullRequest,
    GitPushRequest,
)
from app.services.command import CommandService
from app.services.project import ProjectService
from app.services.storage_service import StorageService

logger = logging.getLogger(__name__)


def _looks_like_auth_failure(stderr: str) -> bool:
    text = (stderr or "").lower()
    return any(
        marker in text
        for marker in (
            "authentication failed",
            "could not read username",
            "permission denied",
            "403",
            "401",
        )
    )


class GitService:
    """Service for git operations."""

    def __init__(
        self,
        command_service: Optional[CommandService] = None,
        project_service: Optional[ProjectService] = None,
    ):
        self.command = command_service or CommandService()
        self.project = project_service or ProjectService()

    async def clone(
        self,
        request: GitCloneRequest,
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Clone a Git repository."""
        from datetime import datetime

        from app.config import settings

        project_path = self.project.get_path(request.project_id)
        backup_path = None

        # Backup existing project instead of deleting (safety measure)
        if project_path.exists():
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = (
                project_path.parent / f"{request.project_id}_backup_{timestamp}"
            )
            try:
                shutil.move(str(project_path), str(backup_path))
                logger.warning(f"Backed up existing project to: {backup_path}")
            except Exception as e:
                logger.error(f"Failed to backup project, attempting rmtree: {e}")
                # Fallback to rmtree if move fails
                shutil.rmtree(project_path)
                backup_path = None

        git_url = request.git_url
        username, token = await self._resolve_credentials(
            request.project_id,
            [git_url],
            request.username,
            request.token,
            session=session,
            user_id=user_id,
        )
        auth_env = self._get_http_auth_env(git_url, username, token)

        # Clone repository
        cmd = ["git", "clone", "--branch", request.branch]
        if getattr(settings, "git_clone_depth", 0) and settings.git_clone_depth > 0:
            cmd += ["--depth", str(settings.git_clone_depth)]
        cmd += [git_url, str(project_path)]
        returncode, stdout, stderr = await self.command.run(
            cmd, Path(settings.workspace_dir), env=auth_env
        )

        if returncode != 0:
            if _looks_like_auth_failure(stderr):
                await self._delete_git_credentials(
                    request.project_id, [git_url], session=session, user_id=user_id
                )
            raise GitOperationError("clone", stderr)

        await self._save_git_credentials(
            request.project_id,
            git_url,
            username,
            token,
            session=session,
            user_id=user_id,
        )

        upstream_url = request.git_url
        upstream_check_code, _, _ = await self.command.run(
            ["git", "remote", "get-url", "upstream"], project_path
        )
        if upstream_check_code != 0:
            await self.command.run(
                ["git", "remote", "add", "upstream", upstream_url], project_path
            )

        # Check for dbt_project.yml
        dbt_path = self.project.find_dbt_project(project_path)
        if not dbt_path:
            raise GitOperationError("clone", "No dbt_project.yml found in repository")

        # Sync cloned files to Supabase storage (individual files)
        # This ensures files are available when frontend loads the project
        logger.info(f"Syncing cloned project to storage: {request.project_id}")
        storage_service = StorageService()
        try:
            sync_success = await storage_service.sync_files_to_storage(
                request.project_id, project_path
            )
            if not sync_success:
                logger.warning(
                    f"Failed to sync cloned project to storage: {request.project_id}"
                )
                # Continue anyway - local files exist
        except Exception as e:
            logger.error(f"Error syncing to storage after clone: {e}")
            # Continue anyway - local files exist

        # Build response message with backup info
        message = "Repository cloned successfully"
        if backup_path and backup_path.exists():
            message += f". Previous project backed up to: {backup_path.name}"

        return {
            "success": True,
            "project_path": str(dbt_path),
            "message": message,
            "backup_path": str(backup_path) if backup_path else None,
        }

    async def pull(
        self,
        request: GitPullRequest,
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Pull latest changes for a project."""
        project_path = self.project.get_path_or_raise(request.project_id)

        remote_url = await self._get_remote_url(project_path, "origin")
        username, token = await self._resolve_credentials(
            request.project_id,
            [remote_url] if remote_url else [],
            request.username,
            request.token,
            session=session,
            user_id=user_id,
        )
        auth_env = self._get_http_auth_env(
            remote_url, username, token
        )
        cmd = ["git", "pull", "--rebase", "origin", request.branch or "main"]
        returncode, stdout, stderr = await self.command.run(
            cmd, project_path, env=auth_env
        )

        if returncode != 0:
            if _looks_like_auth_failure(stderr):
                await self._delete_git_credentials(
                    request.project_id, [remote_url], session=session, user_id=user_id
                )
            raise GitOperationError("pull", stderr)

        await self._save_git_credentials(
            request.project_id,
            remote_url,
            username,
            token,
            session=session,
            user_id=user_id,
        )

        return {"success": True, "output": stdout or stderr}

    async def commit(
        self, request: GitCommitRequest, user_name: str, user_email: str
    ) -> Dict[str, Any]:
        """Commit staged changes (does NOT auto-stage all).

        VSCode-style behavior:
        - Only commits files that are already staged
        - If stage_all=True is passed, will stage all before commit
        - Returns appropriate message if nothing is staged
        """
        project_path = self.project.get_path_or_raise(request.project_id)

        # Only stage all if explicitly requested
        if getattr(request, "stage_all", False):
            await self.command.run(["git", "add", "-A"], project_path)

        # Check if there are staged changes
        returncode, staged_output, _ = await self.command.run(
            ["git", "diff", "--cached", "--name-only"], project_path
        )

        has_staged = bool(staged_output.strip()) if returncode == 0 else False

        if not has_staged:
            return {
                "success": False,
                "message": "No changes staged for commit. Use 'git add' to stage files first.",
                "nothing_staged": True,
                "stdout": "",
                "stderr": "",
            }

        # Apply the authenticated user's identity for this commit only. Do not
        # mutate repository or runner-level config shared by later requests.
        returncode, stdout, stderr = await self.command.run(
            [
                "git",
                "-c",
                f"user.name={user_name}",
                "-c",
                f"user.email={user_email}",
                "commit",
                "-m",
                request.message,
            ],
            project_path,
        )

        success = returncode == 0
        return {
            "success": success,
            "message": "Changes committed successfully" if success else "Commit failed",
            "stdout": stdout,
            "stderr": stderr,
            "nothing_staged": False,
        }

    async def push(
        self,
        request: GitPushRequest,
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Push commits to remote repository."""
        project_path = self.project.get_path_or_raise(request.project_id)

        # Get current branch if not specified
        branch = request.branch
        if not branch:
            returncode, stdout, _ = await self.command.run(
                ["git", "rev-parse", "--abbrev-ref", "HEAD"], project_path
            )
            branch = stdout.strip() if returncode == 0 else "main"

        remote_url = await self._get_remote_url(project_path, request.remote)
        username, token = await self._resolve_credentials(
            request.project_id,
            [remote_url] if remote_url else [],
            request.username,
            request.token,
            session=session,
            user_id=user_id,
        )
        auth_env = self._get_http_auth_env(
            remote_url, username, token
        )
        await self._ensure_full_history(project_path, request.remote, auth_env)

        # Push to remote with optional force flag
        cmd = ["git", "push", "-u", request.remote, branch]
        if request.force:
            cmd.insert(2, "--force")

        returncode, stdout, stderr = await self.command.run(
            cmd, project_path, env=auth_env
        )

        success = returncode == 0
        if success:
            await self._save_git_credentials(
                request.project_id,
                remote_url,
                username,
                token,
                session=session,
                user_id=user_id,
            )
        elif _looks_like_auth_failure(stderr):
            await self._delete_git_credentials(
                request.project_id, [remote_url], session=session, user_id=user_id
            )
        return {
            "success": success,
            "message": (
                f"Pushed to {request.remote}/{branch}" if success else "Push failed"
            ),
            "stdout": stdout,
            "stderr": stderr,
            "branch": branch,
            "force": request.force,
        }

    async def _ensure_full_history(
        self, project_path: Path, remote: str, auth_env: Optional[Dict[str, str]] = None
    ) -> None:
        returncode, stdout, _ = await self.command.run(
            ["git", "rev-parse", "--is-shallow-repository"], project_path
        )
        is_shallow = returncode == 0 and stdout.strip().lower() == "true"
        if not is_shallow:
            return

        returncode, remotes_stdout, remotes_stderr = await self.command.run(
            ["git", "remote"], project_path
        )
        if returncode != 0:
            raise GitOperationError("remote", remotes_stderr)

        all_remotes = [r.strip() for r in remotes_stdout.splitlines() if r.strip()]
        remotes_to_try = [remote] + [r for r in all_remotes if r != remote]

        last_stderr = ""
        for remote_name in remotes_to_try:
            returncode, _, stderr = await self.command.run(
                ["git", "fetch", remote_name, "--unshallow", "--tags"],
                project_path,
                env=auth_env,
            )
            if returncode == 0:
                return
            last_stderr = stderr

            returncode, _, stderr = await self.command.run(
                ["git", "fetch", remote_name, "--depth=2147483647", "--tags"],
                project_path,
                env=auth_env,
            )
            if returncode == 0:
                return
            last_stderr = stderr

        raise GitOperationError("fetch", last_stderr)

    async def _get_remote_url(self, project_path, remote_name: str) -> Optional[str]:
        """Get the URL for a git remote."""
        returncode, url, _ = await self.command.run(
            ["git", "remote", "get-url", remote_name], project_path
        )
        return url.strip() if returncode == 0 else None

    @staticmethod
    def _get_http_auth_env(
        git_url: Optional[str], username: Optional[str], token: Optional[str]
    ) -> Optional[Dict[str, str]]:
        """Build subprocess-only HTTPS credentials without persisting the token."""
        if (
            not git_url
            or not git_url.startswith("https://")
            or not username
            or not token
        ):
            return None

        credentials = base64.b64encode(f"{username}:{token}".encode()).decode()
        return {
            "GIT_CONFIG_COUNT": "1",
            "GIT_CONFIG_KEY_0": f"http.{git_url}.extraHeader",
            "GIT_CONFIG_VALUE_0": f"Authorization: Basic {credentials}",
        }

    @staticmethod
    def _get_http_auth_env_for_urls(
        git_urls: List[str], username: Optional[str], token: Optional[str]
    ) -> Optional[Dict[str, str]]:
        """Build subprocess-only HTTPS credentials for multiple remote URLs."""
        if not username or not token:
            return None

        https_urls = []
        for git_url in git_urls:
            if git_url.startswith("https://") and git_url not in https_urls:
                https_urls.append(git_url)

        if not https_urls:
            return None

        credentials = base64.b64encode(f"{username}:{token}".encode()).decode()
        env = {"GIT_CONFIG_COUNT": str(len(https_urls))}
        for index, git_url in enumerate(https_urls):
            env[f"GIT_CONFIG_KEY_{index}"] = f"http.{git_url}.extraHeader"
            env[f"GIT_CONFIG_VALUE_{index}"] = f"Authorization: Basic {credentials}"
        return env

    async def exec_command(self, project_id: str, command: str) -> Dict[str, Any]:
        """Execute a git command in the project directory."""
        import shlex

        project_path = self.project.get_path_or_raise(project_id)

        try:
            cmd_parts = shlex.split(command)
            if self._has_external_config_scope(cmd_parts):
                return {
                    "success": False,
                    "command": f"git {command}",
                    "stdout": "",
                    "stderr": "Git config outside the project scope is not allowed",
                    "returncode": 1,
                }
            cmd = ["git"] + cmd_parts

            returncode, stdout, stderr = await self.command.run(cmd, project_path)

            return {
                "success": returncode == 0,
                "command": f"git {command}",
                "stdout": stdout,
                "stderr": stderr,
                "returncode": returncode,
            }
        except Exception as e:
            return {
                "success": False,
                "command": f"git {command}",
                "stdout": "",
                "stderr": str(e),
                "returncode": 1,
            }

    @staticmethod
    def _has_external_config_scope(cmd_parts: List[str]) -> bool:
        """Reject config writes or reads that escape the current repository."""
        if not cmd_parts or cmd_parts[0] != "config":
            return False

        external_scope_options = {"--global", "--system", "--file", "-f"}
        return any(
            part in external_scope_options or part.startswith("--file=")
            for part in cmd_parts[1:]
        )

    async def get_status(self, project_id: str) -> Dict[str, Any]:
        """Get git status of the project."""
        project_path = self.project.get_path_or_raise(project_id)

        returncode, stdout, stderr = await self.command.run(
            ["git", "status", "--porcelain"], project_path
        )

        if returncode != 0:
            no_repo = "not a git repository" in stderr.lower()
            return {"success": False, "clean": True, "changes": [], "error": stderr, "no_repo": no_repo}

        # Parse status output
        # Git porcelain format: XY PATH (XY is always 2 chars, then 1 space, then path)
        # X = staged status, Y = unstaged status
        # Space means no change in that area
        # Examples: "M  file.txt" = staged modified, " M file.txt" = unstaged modified
        changes = []
        # Split by newline first, then process each line
        # Don't strip stdout before split - leading spaces are meaningful!
        lines = stdout.split("\n")
        for line in lines:
            # Remove only trailing whitespace, preserve leading spaces
            line = line.rstrip()
            if line and len(line) >= 4:  # Minimum: XY + space + at least 1 char path
                # Status is always first 2 characters
                status_code = line[:2]
                # Path starts after position 3 (XY + space)
                file_path = line[3:]
                if file_path:
                    changes.append({"status": status_code, "path": file_path})

        return {"success": True, "clean": len(changes) == 0, "changes": changes}

    async def get_log(self, project_id: str, limit: int = 50) -> Dict[str, Any]:
        """Get commit history for the project."""
        project_path = self.project.get_path_or_raise(project_id)

        cmd = [
            "git",
            "log",
            f"--max-count={limit}",
            "--pretty=format:%H|%an|%ae|%ad|%s",
            "--date=iso",
        ]
        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        if returncode != 0:
            return {"success": False, "commits": [], "error": stderr}

        commits = []
        for line in stdout.strip().split("\n"):
            if line:
                parts = line.split("|", 4)
                if len(parts) >= 5:
                    commits.append(
                        {
                            "hash": parts[0],
                            "author": parts[1],
                            "email": parts[2],
                            "date": parts[3],
                            "message": parts[4],
                        }
                    )

        return {"success": True, "commits": commits}

    async def get_branches(self, project_id: str) -> Dict[str, Any]:
        """Get list of branches for the project."""
        project_path = self.project.get_path_or_raise(project_id)

        # Get current branch
        returncode, current_branch, _ = await self.command.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"], project_path
        )
        current_branch = current_branch.strip() if returncode == 0 else "main"

        # Get all branches
        cmd = [
            "git",
            "branch",
            "-a",
            "--format=%(refname:short)|%(objectname:short)|%(committerdate:iso)",
        ]
        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        if returncode != 0:
            return {
                "success": False,
                "branches": [],
                "current": current_branch,
                "error": stderr,
            }

        branches = []
        for line in stdout.strip().split("\n"):
            if line:
                parts = line.split("|")
                name = parts[0] if len(parts) > 0 else ""
                if name and not name.startswith("origin/HEAD"):
                    branches.append(
                        {
                            "name": name,
                            "hash": parts[1] if len(parts) > 1 else "",
                            "date": parts[2] if len(parts) > 2 else "",
                            "is_remote": name.startswith("origin/"),
                            "is_current": name == current_branch,
                        }
                    )

        return {"success": True, "branches": branches, "current": current_branch}

    async def init(self, request: GitInitRequest) -> Dict[str, Any]:
        """Initialize a new git repository for a project."""
        project_path = self.project.ensure_exists(request.project_id)

        # Check if already a git repo
        git_dir = project_path / ".git"
        if git_dir.exists():
            return {
                "success": True,
                "message": "Repository already initialized",
                "already_exists": True,
            }

        # Initialize git
        returncode, stdout, stderr = await self.command.run(
            ["git", "init", "-b", request.branch], project_path
        )

        if returncode != 0:
            raise GitOperationError("init", stderr)

        # Add remote if provided
        if request.remote_url:
            await self.command.run(
                ["git", "remote", "add", "origin", request.remote_url], project_path
            )

        return {
            "success": True,
            "message": "Repository initialized successfully",
            "path": str(project_path),
            "branch": request.branch,
            "remote": request.remote_url,
        }

    async def add_remote(self, request: GitAddRemoteRequest) -> Dict[str, Any]:
        """Add a remote to the git repository."""
        project_path = self.project.get_path_or_raise(request.project_id)

        # Check if remote already exists
        returncode, existing_url, _ = await self.command.run(
            ["git", "remote", "get-url", request.remote_name], project_path
        )

        if returncode == 0:
            cmd = ["git", "remote", "set-url", request.remote_name, request.remote_url]
            action = "updated"
        else:
            cmd = ["git", "remote", "add", request.remote_name, request.remote_url]
            action = "added"

        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        if returncode != 0:
            raise GitOperationError(f"remote {action}", stderr)

        return {
            "success": True,
            "message": f"Remote '{request.remote_name}' {action} successfully",
            "remote_name": request.remote_name,
            "remote_url": request.remote_url,
        }

    async def get_remotes(self, project_id: str) -> Dict[str, Any]:
        """Get list of remotes for the project."""
        project_path = self.project.get_path_or_raise(project_id)

        returncode, stdout, stderr = await self.command.run(
            ["git", "remote", "-v"], project_path
        )

        if returncode != 0:
            return {"success": False, "remotes": [], "error": stderr}

        remotes = {}
        for line in stdout.strip().split("\n"):
            if line:
                parts = line.split()
                if len(parts) >= 2:
                    name = parts[0]
                    url = parts[1]
                    remote_type = parts[2].strip("()") if len(parts) > 2 else "fetch"
                    if name not in remotes:
                        remotes[name] = {"name": name, "fetch_url": "", "push_url": ""}
                    if remote_type == "fetch":
                        remotes[name]["fetch_url"] = url
                    else:
                        remotes[name]["push_url"] = url

        return {"success": True, "remotes": list(remotes.values())}

    async def get_config(self, project_id: str) -> Dict[str, Any]:
        """Get git user config for the project."""
        project_path = self.project.get_path_or_raise(project_id)

        returncode, user_name, _ = await self.command.run(
            ["git", "config", "user.name"], project_path
        )
        user_name = user_name.strip() if returncode == 0 else ""

        returncode, user_email, _ = await self.command.run(
            ["git", "config", "user.email"], project_path
        )
        user_email = user_email.strip() if returncode == 0 else ""

        return {"success": True, "user_name": user_name, "user_email": user_email}

    async def set_config(self, request: GitConfigRequest) -> Dict[str, Any]:
        """Configure git user for the project."""
        project_path = self.project.get_path_or_raise(request.project_id)

        returncode, _, stderr = await self.command.run(
            ["git", "config", "user.name", request.user_name], project_path
        )
        if returncode != 0:
            raise GitOperationError("config user.name", stderr)

        returncode, _, stderr = await self.command.run(
            ["git", "config", "user.email", request.user_email], project_path
        )
        if returncode != 0:
            raise GitOperationError("config user.email", stderr)

        return {
            "success": True,
            "message": "Git config updated successfully",
            "user_name": request.user_name,
            "user_email": request.user_email,
        }

    async def checkout(self, request: GitCheckoutRequest) -> Dict[str, Any]:
        """Checkout a branch."""
        project_path = self.project.get_path_or_raise(request.project_id)

        if request.create:
            cmd = ["git", "checkout", "-b", request.branch]
        else:
            cmd = ["git", "checkout", request.branch]

        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        if returncode != 0:
            # Check if branch doesn't exist (common git error patterns)
            error_lower = stderr.lower()
            if (
                "did not match any file(s) known to git" in error_lower
                or ("pathspec" in error_lower and "did not match" in error_lower)
                or "invalid reference" in error_lower
            ):
                # Return specific error message that frontend can detect
                raise GitOperationError(
                    "checkout",
                    f"BRANCH_NOT_FOUND: Branch '{request.branch}' does not exist",
                )
            raise GitOperationError("checkout", stderr)

        return {
            "success": True,
            "message": f"Switched to branch '{request.branch}'",
            "branch": request.branch,
            "created": request.create,
        }

    async def fetch(
        self,
        project_id: str,
        username: Optional[str] = None,
        token: Optional[str] = None,
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Fetch updates from remote."""
        project_path = self.project.get_path_or_raise(project_id)

        remote_urls = await self._get_remote_urls(project_path)
        username, token = await self._resolve_credentials(
            project_id,
            remote_urls,
            username,
            token,
            session=session,
            user_id=user_id,
        )
        auth_env = self._get_http_auth_env_for_urls(
            remote_urls, username=username, token=token
        )

        returncode, stdout, stderr = await self.command.run(
            ["git", "fetch", "--all", "--prune"], project_path, env=auth_env
        )

        if returncode != 0:
            if _looks_like_auth_failure(stderr):
                await self._delete_git_credentials(
                    project_id, remote_urls, session=session, user_id=user_id
                )
            raise GitOperationError("fetch", stderr)

        for remote_url in remote_urls:
            await self._save_git_credentials(
                project_id,
                remote_url,
                username,
                token,
                session=session,
                user_id=user_id,
            )

        return {
            "success": True,
            "message": "Fetched updates from remote",
            "output": stdout or stderr,
        }

    async def _get_remote_urls(self, project_path: Path) -> List[str]:
        """Return unique fetch/push URLs configured for this repository."""
        returncode, stdout, _ = await self.command.run(
            ["git", "remote", "-v"], project_path
        )
        if returncode != 0:
            return []

        urls: List[str] = []
        for line in stdout.splitlines():
            parts = line.split()
            if len(parts) >= 2 and parts[1] not in urls:
                urls.append(parts[1])
        return urls

    async def _resolve_credentials(
        self,
        project_id: str,
        remote_urls: Sequence[Optional[str]],
        username: Optional[str],
        token: Optional[str],
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> Tuple[Optional[str], Optional[str]]:
        if username and token:
            return username, token
        stored = await self._load_git_credentials(
            project_id, remote_urls, session=session, user_id=user_id
        )
        return stored or (username, token)

    async def _save_git_credentials(
        self,
        project_id: str,
        remote_url: Optional[str],
        username: Optional[str],
        token: Optional[str],
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> None:
        if not session or not user_id or not remote_url or not username or not token:
            return
        if not remote_url.startswith("https://"):
            return

        try:
            encrypted_token = encrypt_secret(token)
        except EncryptionError as exc:
            raise GitOperationError("credential", str(exc)) from exc
        await session.execute(
            text(
                """
                INSERT INTO git_credentials
                    (id, project_id, owner, remote_url, username, token_encrypted)
                VALUES
                    (CAST(:id AS uuid), CAST(:project_id AS uuid),
                     CAST(:owner AS uuid), :remote_url, :username,
                     :token_encrypted)
                ON CONFLICT (project_id, owner, remote_url)
                DO UPDATE SET
                    username = EXCLUDED.username,
                    token_encrypted = EXCLUDED.token_encrypted,
                    updated_at = CURRENT_TIMESTAMP
                """
            ),
            {
                "project_id": project_id,
                "id": str(uuid.uuid4()),
                "owner": user_id,
                "remote_url": remote_url,
                "username": username,
                "token_encrypted": encrypted_token,
            },
        )
        await session.commit()

    async def _load_git_credentials(
        self,
        project_id: str,
        remote_urls: Sequence[Optional[str]],
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> Optional[Tuple[str, str]]:
        if not session or not user_id:
            return None

        urls = {url for url in remote_urls if url and url.startswith("https://")}
        result = await session.execute(
            text(
                """
                SELECT remote_url, username, token_encrypted
                FROM git_credentials
                WHERE project_id = CAST(:project_id AS uuid)
                  AND owner = CAST(:owner AS uuid)
                ORDER BY updated_at DESC
                """
            ),
            {"project_id": project_id, "owner": user_id},
        )

        rows = result.mappings().all()
        if urls:
            row = next((item for item in rows if item["remote_url"] in urls), None)
        else:
            row = rows[0] if rows else None
        if not row:
            return None
        try:
            token = decrypt_secret(row["token_encrypted"])
        except EncryptionError as exc:
            raise GitOperationError("credential", str(exc)) from exc
        return row["username"], token

    async def _delete_git_credentials(
        self,
        project_id: str,
        remote_urls: Sequence[Optional[str]],
        session: Optional[Any] = None,
        user_id: Optional[str] = None,
    ) -> None:
        if not session or not user_id:
            return

        urls = [url for url in remote_urls if url and url.startswith("https://")]
        if not urls:
            return

        await session.execute(
            text(
                """
                DELETE FROM git_credentials
                WHERE project_id = CAST(:project_id AS uuid)
                  AND owner = CAST(:owner AS uuid)
                  AND remote_url = ANY(:remote_urls)
                """
            ),
            {"project_id": project_id, "owner": user_id, "remote_urls": urls},
        )
        await session.commit()

    async def get_diff(
        self, project_id: str, file_path: Optional[str] = None
    ) -> Dict[str, Any]:
        """Get diff of changes."""
        project_path = self.project.get_path_or_raise(project_id)

        if file_path:
            cmd = ["git", "diff", "--", file_path]
        else:
            cmd = ["git", "diff"]

        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        # Also get staged diff
        if file_path:
            cmd_staged = ["git", "diff", "--cached", "--", file_path]
        else:
            cmd_staged = ["git", "diff", "--cached"]

        _, staged_diff, _ = await self.command.run(cmd_staged, project_path)

        return {"success": True, "unstaged_diff": stdout, "staged_diff": staged_diff}

    async def add(
        self, project_id: str, files: Optional[List[str]] = None
    ) -> Dict[str, Any]:
        """Stage files for commit."""
        project_path = self.project.get_path_or_raise(project_id)

        if files:
            cmd = ["git", "add"] + files
        else:
            cmd = ["git", "add", "-A"]

        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        if returncode != 0:
            raise GitOperationError("add", stderr)

        return {
            "success": True,
            "message": "Files staged successfully",
            "files": files or ["all"],
        }

    async def reset(
        self, project_id: str, files: Optional[List[str]] = None, hard: bool = False
    ) -> Dict[str, Any]:
        """Unstage files or reset changes."""
        project_path = self.project.get_path_or_raise(project_id)

        if hard:
            cmd = ["git", "reset", "--hard", "HEAD"]
        elif files:
            cmd = ["git", "reset", "HEAD", "--"] + files
        else:
            cmd = ["git", "reset", "HEAD"]

        returncode, stdout, stderr = await self.command.run(cmd, project_path)

        if returncode != 0:
            raise GitOperationError("reset", stderr)

        return {"success": True, "message": "Reset successful", "hard": hard}
