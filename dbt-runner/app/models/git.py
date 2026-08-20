"""
Pydantic models for git operations.
"""

from typing import Optional

from pydantic import BaseModel, Field


class GitCloneRequest(BaseModel):
    """Request to clone a Git repository."""

    project_id: str = Field(..., description="Project identifier")
    git_url: str = Field(..., description="Git repository URL")
    branch: str = Field("main", description="Branch to clone")
    username: Optional[str] = Field(None, description="Git username for authentication")
    token: Optional[str] = Field(None, description="Git token for authentication")


class GitPullRequest(BaseModel):
    """Request to pull latest changes."""

    project_id: str = Field(..., description="Project identifier")
    branch: Optional[str] = Field(None, description="Branch to pull from")
    username: Optional[str] = Field(None, description="Git username for authentication")
    token: Optional[str] = Field(None, description="Git token for authentication")


class GitCommitRequest(BaseModel):
    """Request to commit changes."""

    project_id: str = Field(..., description="Project identifier")
    message: str = Field(..., description="Commit message")
    stage_all: bool = Field(
        False, description="Stage all changes before commit (like 'git commit -a')"
    )


class GitPushRequest(BaseModel):
    """Request to push changes to remote."""

    project_id: str = Field(..., description="Project identifier")
    remote: str = Field("origin", description="Remote name")
    branch: Optional[str] = Field(
        None, description="Branch to push (uses current if None)"
    )
    force: bool = Field(False, description="Force push")
    username: Optional[str] = Field(None, description="Git username for authentication")
    token: Optional[str] = Field(None, description="Git token for authentication")


class GitFetchRequest(BaseModel):
    """Request to fetch remote updates."""

    username: Optional[str] = Field(None, description="Git username for authentication")
    token: Optional[str] = Field(None, description="Git token for authentication")


class GitInitRequest(BaseModel):
    """Request to initialize a new git repository."""

    project_id: str = Field(..., description="Project identifier")
    remote_url: Optional[str] = Field(None, description="Remote URL to add as origin")
    branch: str = Field("main", description="Default branch name")


class GitAddRemoteRequest(BaseModel):
    """Request to add a remote to git repository."""

    project_id: str = Field(..., description="Project identifier")
    remote_name: str = Field("origin", description="Remote name")
    remote_url: str = Field(..., description="Remote URL")


class GitConfigRequest(BaseModel):
    """Request to configure git user."""

    project_id: str = Field(..., description="Project identifier")
    user_name: str = Field(..., description="Git user name")
    user_email: str = Field(..., description="Git user email")


class GitCheckoutRequest(BaseModel):
    """Request to checkout a branch."""

    project_id: str = Field(..., description="Project identifier")
    branch: str = Field(..., description="Branch name")
    create: bool = Field(False, description="Create new branch if True")
