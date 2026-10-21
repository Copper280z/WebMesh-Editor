"""Gmsh as an optional meshing plugin.

WebMesh's CAD core (import, preparation, sheets, topology, display tessellation,
quad shell meshing, mapped-hex data) runs on OpenCASCADE through cad_geom.py and
does not need Gmsh. Gmsh (GPL-2.0-or-later) adds meshers the core does not have:

* tetrahedra, and Gmsh's own tri/quad/hex methods (mapped, sweep, layered sweep);
* triangle (CTRIA3) shell meshes;
* STL and MSH import, which has no CAD topology and is meshed as it is;
* the legacy ``/api/mesh`` GEO path (server.py runs the gmsh program for it).

This is the only module that imports Gmsh, and it does so lazily: every entry
point reports a clear error when Gmsh is missing, so nothing else depends on
it. A task that needs the plugin runs in a process that never loaded OpenCASCADE
through OCP (the two OpenCASCADE builds must not share a process), see
``cad_kernel.run_plugin``. cad_sweep.py, cad_controls.py and
cad_mesh_extrusion.py are the plugin's sweep meshers; they receive the gmsh
module as an argument and are only called from here.
"""

import importlib.util
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

BINDING_FOLDERS = ("/opt/homebrew/opt/gmsh/lib", "/usr/local/opt/gmsh/lib")
# Set to "1" to behave as if Gmsh were not installed (used to test the core without it).
BLOCK_ENV = "WEBMESH_BLOCK_GMSH"
INSTALL = "Install Gmsh and its Python bindings (python3 -m pip install gmsh), then restart python3 server.py."
MISSING = "The Gmsh plugin is not installed. " + INSTALL
DISCRETE = {".stl", ".msh"}
OPERATIONS = ["tet", "tri-shell", "quad", "sweep", "layered", "stl"]


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
    if blocked() or sys.modules.get("gmsh", 1) is None:  # None: an import hook has made 'import gmsh' fail
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
    return {"available": python, "executable": version is not None, "version": version, "blocked": blocked(),
            "operations": OPERATIONS if python else [],
            "note": None if python else MISSING}


def handles(request):
    """True for a worker request only the plugin can do."""
    if Path(str(request.get("input", ""))).suffix.lower() in DISCRETE:
        return True
    action = request.get("action")
    return action == "mesh" or (action == "shell" and request.get("element") == "tri")


# --------------------------------------------------------------------------
# Meshes


def mesh_quality(gmsh, dimension):
    import numpy as np
    types, element_tags, _ = gmsh.model.mesh.getElements(dimension)
    tags = np.concatenate(element_tags) if len(element_tags) else np.array([], dtype=np.uint64)
    if not len(tags):
        raise ValueError("No requested mesh elements were generated.")
    determinants = gmsh.model.mesh.getElementQualities(tags, "minDetJac")
    scaled = gmsh.model.mesh.getElementQualities(tags, "minSJ")
    minimum = float(np.min(determinants))
    if not np.all(np.isfinite(determinants)) or minimum <= 0:
        raise ValueError(f"Mesh has nonpositive Jacobians (minimum {minimum:g}). Refine or repartition the CAD.")
    return {"minDetJac": minimum, "minScaledJacobian": float(np.min(scaled)),
            "elementTypes": list(map(int, types)), "checkedElements": len(tags)}


def mesh(gmsh, request):
    """Tet, tri, quad or hex mesh of the loaded model, written to mesh.msh (see cad_sweep)."""
    # Sweep implementation is intentionally separate from preparation: source CAD
    # equivalence is checked before generating any extrusion-based mesh.
    import cad_kernel
    from cad_sweep import generate
    return generate(gmsh, request, cad_kernel.topology, mesh_quality)


def tri_shell(gmsh, request):
    """Triangles from Gmsh on the chosen faces only (shared edges conform)."""
    import numpy as np
    import cad_shell
    model = gmsh.model
    size = float(request["size"])
    faces = cad_shell._select_faces(gmsh, request)
    area = sum(float(model.occ.getMass(2, f)) for f in faces)
    if 2.3 * area / (size * size) > cad_shell.MAX_ELEMENTS:
        raise ValueError(f"About {2.3 * area / (size * size):,.0f} elements exceed the {cad_shell.MAX_ELEMENTS:,} limit. Raise the element size.")
    for option, value in (("Mesh.MeshSizeMin", size), ("Mesh.MeshSizeMax", size), ("Mesh.Algorithm", 6), ("Mesh.ElementOrder", 1)):
        gmsh.option.setNumber(option, value)
    counts, _ = cad_shell._controls(request)
    for edge, count in counts.items():
        model.mesh.setTransfiniteCurve(edge, count + 1)
    model.setVisibility(model.getEntities(), 0)
    model.setVisibility([(2, f) for f in faces], 1, recursive=True)
    gmsh.option.setNumber("Mesh.MeshOnlyVisible", 1)
    model.mesh.generate(2)
    tags, coords, _ = model.mesh.getNodes()
    coordinates = {int(t): np.array(coords[3 * i:3 * i + 3]) for i, t in enumerate(tags)}
    elements, reports = [], []
    pid_of, _, offsets = cad_shell._properties(faces, request)
    for index, face in enumerate(faces):
        types, _, nodes = model.mesh.getElements(2, face)
        count = 0
        for kind, connectivity in zip(types, nodes):
            if int(kind) != 2:
                continue
            for k in range(0, len(connectivity), 3):
                ids = [int(n) for n in connectivity[k:k + 3]]
                p = [coordinates[n] for n in ids]
                uv = model.getParametrization(2, face, np.mean(p, axis=0).tolist())
                normal = np.array(model.getNormal(face, list(uv)), dtype=float)
                if np.dot(np.cross(p[1] - p[0], p[2] - p[0]), normal) < 0:
                    ids = [ids[0], ids[2], ids[1]]
                elements.append({"type": "CTRIA3", "pid": pid_of[face], "nodes": ids, "face": face, **({"zoffs": offsets[face]} if face in offsets else {})})
                count += 1
        reports.append({"face": face, "quads": count, "valid": count > 0, "issues": [] if count else ["Gmsh produced no triangles."]})
    used = {n for e in elements for n in e["nodes"]}
    coordinates = {n: p for n, p in coordinates.items() if n in used}
    return elements, coordinates, reports, None, faces, "gmsh", []


def tri_shell_mesh(gmsh, request):
    """A triangle shell mesh of the chosen faces, placed and reported like the quad one."""
    import cad_shell
    cad_shell.check_request(request)
    cad_shell.check_faces(gmsh, request)
    return cad_shell.finish(gmsh, request, tri_shell(gmsh, request))


# --------------------------------------------------------------------------
# STL and MSH: a surface mesh with no CAD topology


def discrete_preview(gmsh, data):
    """Display triangles and edge polylines of a surface mesh read as discrete geometry."""
    import cad_kernel
    positions, face_ids = discrete_tessellation(gmsh, data)
    return {"positions": positions, "triangleFaceIds": face_ids, "edges": cad_kernel.edge_polylines(gmsh, data), "faces": data["faces"]}


def discrete_tessellation(gmsh, data):
    """The triangles of the merged surface mesh, per face."""
    model = gmsh.model
    node_ids, coordinates, _ = model.mesh.getNodes()
    nodes = {int(nid): list(map(float, coordinates[3 * i:3 * i + 3])) for i, nid in enumerate(node_ids)}
    positions, face_ids = [], []
    for _, tag in model.getEntities(2):
        triangles = []
        types, _, connectivity = model.mesh.getElements(2, tag)
        for element_type, node_list in zip(types, connectivity):
            if element_type != 2:
                raise ValueError("CAD preview returned unexpected non-triangle elements.")
            for nid in node_list:
                triangles.extend(nodes[int(nid)])
        positions.extend(triangles)
        face_ids.extend([tag] * (len(triangles) // 9))
    if len(face_ids) > 250_000:
        raise ValueError("CAD preview exceeds 250,000 triangles. Simplify the geometry first.")
    return positions, face_ids


def execute(request):
    """Run a plugin task (see `handles`) with Gmsh: a mesh, a triangle shell, or an STL import."""
    import cad_kernel
    import cad_sheets
    gmsh = load()
    gmsh.initialize(["webmesh-cad", "-nopopup"], readConfigFiles=False, interruptible=False)
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.option.setNumber("General.NumThreads", 1)
    gmsh.logger.start()
    try:
        discrete = Path(request["input"]).suffix.lower() in DISCRETE
        action = request["action"]
        if discrete:
            gmsh.merge(request["input"])
        else:
            cad_kernel.load(gmsh, request["input"])
        sheets = None if discrete else cad_sheets.clean(gmsh, request.get("sheets"))
        if sheets is None and not discrete:
            sheets = []
        if not discrete:
            # Free faces other than sheets (what an operation left over) do not carry over.
            cad_sheets.protect(gmsh, sheets)
            cad_kernel.remove_loose(gmsh)
        if action == "prepare":
            raise ValueError("STL is a discrete surface mesh. Split and defeature require editable STEP, IGES, or BREP geometry.")
        if action == "mesh":
            if discrete:
                if request.get("topology") == "hex":
                    raise ValueError("STL has no editable CAD topology for mapped or swept hexes. Import the source STEP/BREP instead.")
                # STL defines a piecewise linear boundary. Projecting quadratic
                # nodes onto an inferred parametrization can fold its sharp
                # seams; straight midside interpolation preserves that boundary.
                gmsh.option.setNumber("Mesh.SecondOrderLinear", 1)
                gmsh.model.mesh.classifySurfaces(40 * math.pi / 180, True, True, math.pi)
                gmsh.model.mesh.createGeometry()
                if request.get("topology", "tet") == "tet":
                    shell = gmsh.model.geo.addSurfaceLoop([tag for _, tag in gmsh.model.getEntities(2)])
                    gmsh.model.geo.addVolume([shell])
                    gmsh.model.geo.synchronize()
            result = mesh(gmsh, request)
        elif action == "shell":
            if discrete:
                raise ValueError("STL has no CAD faces to shell mesh. Import the source STEP/BREP instead.")
            result = tri_shell_mesh(gmsh, {**request, "sheets": sheets})
        elif discrete:
            # Importing an STL: report its faces and edges, and keep the mesh as the next snapshot.
            gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
            gmsh.option.setNumber("Mesh.Binary", 0)
            gmsh.write(request["output"])
            gmsh.clear()
            gmsh.merge(request["output"])
            cad_sheets.protect(gmsh, [])
            data = cad_kernel.topology(gmsh)
            data["discrete"] = True
            data["sheets"] = []
            result = {"topology": data, "preview": discrete_preview(gmsh, data)}
        else:
            raise ValueError("Only STL and MSH geometry is imported through the Gmsh plugin.")
        result["log"] = "\n".join(gmsh.logger.get())[-24_000:]
        return result
    finally:
        gmsh.finalize()
