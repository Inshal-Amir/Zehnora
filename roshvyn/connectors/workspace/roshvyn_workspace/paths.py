"""Workspace root selection and path confinement (Mac/Linux/Windows)."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

FILE_LIKE_SUFFIXES = {".html", ".htm", ".css", ".js", ".jsx", ".ts", ".tsx", ".txt", ".md", ".json", ".py", ".csv",
                      ".xml", ".yaml", ".yml", ".toml", ".sql", ".sqlite", ".db"}


class ToolError(Exception):
    pass


def desktop_dir() -> Path:
    """The real Desktop folder. On Windows this asks the Known Folder API, which follows OneDrive redirection."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        class GUID(ctypes.Structure):
            _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD), ("Data3", wintypes.WORD), ("Data4", wintypes.BYTE * 8)]

        # FOLDERID_Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}
        fid = GUID(0xB4BFCC3A, 0xDB2C, 0x424C, (wintypes.BYTE * 8)(0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41))
        out = ctypes.c_wchar_p()
        if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(out)) == 0:
            path = out.value
            ctypes.windll.ole32.CoTaskMemFree(out)
            return Path(path)
    return Path.home() / "Desktop"


def config_path() -> Path:
    return Path(os.environ.get("ROSHVYN_CONNECTOR_CONFIG", Path.home() / ".roshvyn" / "workspace.json"))


def workspace_root() -> Path:
    """Explicitly selected workspace: env var, then the Desktop app's config file, then the default demo root.
    Re-read on every call so switching folders in Roshvyn Desktop applies immediately."""
    chosen = os.environ.get("ROSHVYN_WORKSPACE")
    if not chosen:
        try:
            chosen = json.loads(config_path().read_text()).get("workspace_root")
        except (OSError, ValueError):
            chosen = None
    root = Path(chosen).expanduser() if chosen else desktop_dir() / "Roshvyn-Workspace"
    root.mkdir(parents=True, exist_ok=True)
    real = Path(os.path.realpath(root))
    if real == Path(real.anchor) or real == Path.home().resolve():
        raise ToolError("Refusing to use a filesystem root or the whole home folder as the workspace. Select a project folder.")
    return real


def inside(path: Path, root: Path) -> bool:
    return path == root or root in path.parents


def resolve(relative_path: str, *, must_exist: bool = False) -> tuple[Path, Path]:
    """Return (real target path, workspace root). Rejects absolute paths, traversal and link escapes."""
    root = workspace_root()
    if not isinstance(relative_path, str):
        raise ToolError("path must be a string")
    raw = relative_path.strip().replace("\\", "/") if sys.platform == "win32" else relative_path.strip()
    if raw in ("", "/"):
        raw = "."
    if "\x00" in raw:
        raise ToolError("path contains a NUL byte")
    if raw.startswith("~") or os.path.isabs(raw) or (len(raw) > 1 and raw[1] == ":"):
        raise ToolError(f"absolute paths are not allowed; use a path relative to the workspace (got {relative_path!r})")
    normalized = os.path.normpath(raw)
    if normalized == ".." or normalized.startswith(".." + os.sep) or normalized.startswith("../"):
        raise ToolError(f"path escapes the workspace (got {relative_path!r})")
    real = Path(os.path.realpath(root / normalized))  # follows symlinks and Windows junctions
    if not inside(real, root):
        raise ToolError(f"path resolves outside the workspace (got {relative_path!r})")
    if not real.exists():
        if must_exist:
            raise ToolError(f"not found: {relative_path}")
        parent = real.parent
        while not parent.exists():
            parent = parent.parent
        if not inside(Path(os.path.realpath(parent)), root):
            raise ToolError(f"parent directory resolves outside the workspace (got {relative_path!r})")
    return real, root


def refuse_hidden(relative_path: str) -> None:
    parts = [p for p in os.path.normpath(relative_path.strip()).replace("\\", "/").split("/") if p not in ("", ".")]
    hidden = [p for p in parts if p.startswith(".") and p not in (".gitignore", ".env.example")]
    if hidden:
        raise ToolError(f"names starting with '.' are hidden ({hidden[0]!r}); use the name without the leading dot.")


def rel(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix() or "."
