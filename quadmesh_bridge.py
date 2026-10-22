"""Locate and call the native quad face meshers.

Two separate libraries implement the same C ABI (quadmesh.h, 0.2 or later):
quadmesh (C++, meshers/quadmesh: quadtree and recombination paths) and the
paved Q-Morph mesher (Zig, meshers/paved). `zig build` in the repository root
builds both into zig-out/lib, and both are loaded through quadmesh's
standard-library ctypes binding. WEBMESH_QUADMESH_LIB and WEBMESH_PAVED_LIB name
other builds; WEBMESH_QUADMESH_BINDING another binding. Nothing here depends on Gmsh.
"""

import importlib.util
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILT = ROOT / "zig-out"
HINT = "Run `zig build` (Zig 0.17) in the WebMesh folder"
LIBRARIES = {
    "quadmesh": {"env": "WEBMESH_QUADMESH_LIB", "names": ("libquadmesh_capi.dylib", "libquadmesh_capi.so", "quadmesh_capi.dll"),
                 "hint": f"{HINT}, or set WEBMESH_QUADMESH_LIB."},
    "paved": {"env": "WEBMESH_PAVED_LIB", "names": ("libquadmesh_paved.dylib", "libquadmesh_paved.so", "quadmesh_paved.dll"),
              "hint": f"{HINT}, or set WEBMESH_PAVED_LIB."},
}

# Face meshers WebMesh offers, by name: the library and how each one is asked for.
MESHERS = {
    # Fixed boundary nodes and element-based sizing select quadmesh's constrained
    # triangulation and recombination path: neighbors conform.
    "recombined": {"label": "Recombined", "library": "quadmesh", "fixed": True, "options": {"finite_element_sizing": 1, "enable_smoothing": 1}},
    # Q-Morph rows that follow every boundary (paving look), with fixed boundary nodes.
    "paved": {"label": "Paved", "library": "paved", "fixed": True, "options": {"finite_element_sizing": 1, "enable_smoothing": 1}},
    # The quadtree path chooses its own boundary nodes: one face at a time.
    "quadtree": {"label": "Quadtree", "library": "quadmesh", "fixed": False, "options": {"enable_smoothing": 1}},
}

_loaded = {}


def _binding():
    configured = os.environ.get("WEBMESH_QUADMESH_BINDING")
    path = Path(configured) if configured else ROOT / "meshers" / "quadmesh" / "bindings" / "python" / "quadmesh.py"
    if path.is_file():
        spec = importlib.util.spec_from_file_location("webmesh_quadmesh_binding", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module
    raise ImportError(f"quadmesh's Python binding ({path}) was not found; set WEBMESH_QUADMESH_BINDING.")


def _candidates(spec):
    configured = os.environ.get(spec["env"])
    if configured:
        yield Path(configured).expanduser()
        return
    for name in spec["names"]:
        yield BUILT / ("bin" if name.endswith(".dll") else "lib") / name


def _load(name):
    if name in _loaded:
        return _loaded[name]
    spec = LIBRARIES[name]
    error = f"The {name} library was not found. {spec['hint']}"
    for library in _candidates(spec):
        if not library.is_file():
            continue
        try:
            mesher = _binding().Mesher(str(library))
            version = int(mesher.lib.mq_abi_version())
        except (OSError, AttributeError, ImportError) as exc:
            error = f"Could not load {name} from {library}: {exc}"
            continue
        abi = f"{version >> 24}.{(version >> 12) & 0xFFF}.{version & 0xFFF}"
        if version >> 12 < 2:  # fixed boundary runs and provenance arrived in 0.2
            error = f"{name} at {library} is ABI {abi}; WebMesh needs 0.2 or later."
            continue
        _loaded[name] = {"mesher": mesher, "library": str(library), "abi": abi, "version": version, "error": None}
        return _loaded[name]
    _loaded[name] = {"mesher": None, "library": None, "abi": None, "error": error}
    return _loaded[name]


def available(mesher):
    return mesher in MESHERS and _load(MESHERS[mesher]["library"])["mesher"] is not None


def follows_curves(mesher):
    """Whether a mesher takes open control curves (ABI 0.3): junctions that stop inside a face."""
    loaded = _load(MESHERS[mesher]["library"]) if mesher in MESHERS else {"mesher": None}
    return loaded["mesher"] is not None and loaded["version"] >> 12 >= 3


def status():
    """Availability for the health report: each library and each face mesher."""
    libraries = {name: {key: value for key, value in _load(name).items() if key not in ("mesher", "version")} for name in LIBRARIES}
    meshers = [{"id": key, "label": value["label"], "conforming": value["fixed"], "library": value["library"],
                "available": libraries[value["library"]]["error"] is None,
                "curves": libraries[value["library"]]["error"] is None and value["fixed"] and follows_curves(key)} for key, value in MESHERS.items()]
    return {"available": any(m["available"] for m in meshers), "libraries": libraries, "meshers": meshers,
            "error": None if any(m["available"] for m in meshers) else libraries["quadmesh"]["error"]}


def mesh_domain(loops, mesher="recombined", **options):
    """Mesh 2D loops (outer first, then holes) with one of MESHERS.

    Each loop is {"points": [(x, y), ...], "role": "outer"|"hole"|"curve", "fixed": bool}.
    With a conforming mesher a fixed loop's points are kept exactly as its
    boundary nodes. A curve is open, end to end: a junction that stops inside
    the face (ABI 0.3; see quadmesh's webmesh_faces/OPEN_CURVES.md). Returns the binding's result: nodes, quads, per-quad
    quality, boundary provenance, summary, valid and issues.
    """
    if mesher not in MESHERS:
        raise ValueError(f"Unknown face mesher {mesher!r}. Choose {', '.join(MESHERS)}.")
    spec = MESHERS[mesher]
    loaded = _load(spec["library"])
    if loaded["mesher"] is None:
        raise ValueError(loaded["error"])
    request = []
    for loop in loops:
        item = {"points": [tuple(map(float, p)) for p in loop["points"]], "role": loop.get("role", "outer")}
        if item["role"] == "curve":
            if not spec["fixed"] or not follows_curves(mesher):
                raise ValueError(f"The {spec['label']} mesher (ABI {loaded['abi']}) cannot follow a junction that stops inside a face. "
                                 "Split the sheets along it (Split sheets along its plane, on the joining sheet's card) or update the mesher.")
            item["fixed_runs"] = [{"nodes": item["points"], "start": (0, 0), "end": (len(item["points"]) - 2, 1), "closed": False}]
        elif spec["fixed"] and loop.get("fixed", True):
            item["fixed_runs"] = [{"nodes": item["points"], "closed": True}]
        request.append(item)
    return loaded["mesher"].mesh(request, **{**spec["options"], **options})
