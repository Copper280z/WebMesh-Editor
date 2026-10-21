"""Gmsh as an optional meshing plugin.

WebMesh's CAD core (import, preparation, sheets, topology, display tessellation,
quad shell meshing, mapped-hex data) runs on OpenCASCADE through cad_geom.py and
does not need Gmsh. Gmsh (GPL-2.0-or-later) adds meshers the core does not have:
tetrahedra, triangle shells, Gmsh's own quad/hex methods and sweeps, STL import
and the legacy ``/api/mesh`` GEO path.

This is the only module that imports Gmsh. Every entry point imports it lazily
and reports a clear error when it is missing, so the rest of WebMesh never
depends on it.
"""

import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import sys

BINDING_FOLDERS = ("/opt/homebrew/opt/gmsh/lib", "/usr/local/opt/gmsh/lib")
# Set to "1" to behave as if Gmsh were not installed (used to test the core without it).
BLOCK_ENV = "WEBMESH_BLOCK_GMSH"
MISSING = "The Gmsh plugin is not installed. Install Gmsh (and its Python bindings: python3 -m pip install gmsh) to use this."


def blocked():
    return os.environ.get(BLOCK_ENV, "").strip().lower() in {"1", "true", "yes"}


def binding_folder():
    """The Homebrew folder holding gmsh.py when pip has not installed the module, else None."""
    for folder in BINDING_FOLDERS:
        if (Path(folder) / "gmsh.py").is_file():
            return folder
    return None


def module_available():
    """Whether the Gmsh Python module can be imported (without importing it)."""
    if blocked():
        return False
    return importlib.util.find_spec("gmsh") is not None or binding_folder() is not None


def load():
    """The gmsh module, imported on first use. Raises ImportError when it is absent or blocked."""
    if blocked():
        raise ImportError(MISSING)
    if importlib.util.find_spec("gmsh") is None:
        folder = binding_folder()
        if folder is None:
            raise ImportError(MISSING)
        sys.path.insert(0, folder)
    import gmsh
    return gmsh


def find_executable(explicit=None):
    """Path of the gmsh command-line program, or None."""
    if blocked():
        return None
    if explicit:
        return shutil.which(explicit)
    return shutil.which("gmsh") or ("/opt/homebrew/bin/gmsh" if Path("/opt/homebrew/bin/gmsh").is_file() else None)


def status(executable=None):
    """What the health report says about the plugin."""
    version = None
    if executable:
        try:
            result = subprocess.run([executable, "-version"], capture_output=True, text=True, timeout=5, check=False)
            if result.returncode == 0:
                version = (result.stdout + result.stderr).strip()[:160]
        except (OSError, subprocess.TimeoutExpired):
            pass
    python = module_available()
    return {"available": python, "executable": version is not None, "version": version,
            "blocked": blocked(),
            "operations": ["tet", "tri-shell", "quad", "sweep", "layered", "stl"] if python else []}
