#!/usr/bin/env python3
"""Local WebMesh server and optional Gmsh CAD meshing bridge (stdlib only).

Run ``python3 server.py`` and visit http://127.0.0.1:8765. Gmsh must be on PATH
or supplied using --gmsh. The server deliberately binds only to IPv4 loopback.
Uploaded GEO programs are not accepted: CAD is read from fixed-name data files,
and every GEO command is generated here from validated numeric parameters.

The legacy /api/mesh hex path uses transfinite six-face blocks. Editable CAD
sessions additionally support verified source-face and layered column sweeps.
Quad meshing uses recombination followed by all-quad subdivision. Requests
are rejected if the result has any unexpected top-dimensional element type.

Gmsh options, MSH 2.2 layout, and the source of the node-order permutations:
https://gmsh.info/doc/texinfo/gmsh.html#Structured-grids
https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options
https://gmsh.info/doc/texinfo/gmsh.html#MSH-file-format-version-2-_0028Legacy_0029
https://gmsh.info/doc/texinfo/gmsh.html#Node-ordering
"""

from __future__ import annotations

import argparse
import base64
import binascii
from collections import Counter
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import importlib.util
import math
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import unquote, urlsplit

from cad_sessions import CadError, CadSessions


ROOT = Path(__file__).resolve().parent
MAX_REQUEST = 34 * 1024 * 1024  # Room for base64 expansion of a 24 MiB CAD file.
MAX_CAD = 24 * 1024 * 1024
MAX_MESH = 160 * 1024 * 1024
MAX_LOG = 4 * 1024 * 1024
MAX_RSS = 2 * 1024 * 1024 * 1024
MAX_ENTITIES = 500_000
MESH_TIMEOUT = 90
PS = shutil.which("ps")
FORMATS = {"step": "step", "stp": "step", "iges": "iges", "igs": "iges", "brep": "brep", "stl": "stl"}
EXPECTED = {("tri", 1): 2, ("tri", 2): 9, ("quad", 1): 3, ("quad", 2): 16,
            ("tet", 1): 4, ("tet", 2): 11, ("hex", 1): 5, ("hex", 2): 17}
ELEMENTS = {2: ("CTRIA3", 3), 9: ("CTRIA6", 6), 3: ("CQUAD4", 4),
            16: ("CQUAD8", 8), 4: ("CTETRA", 4), 11: ("CTETRA", 10),
            5: ("CHEXA", 8), 17: ("CHEXA", 20)}
DIMENSIONS = {1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 6: 3, 7: 3, 8: 1, 9: 2,
              10: 2, 11: 3, 12: 3, 13: 3, 14: 3, 15: 0, 16: 2, 17: 3,
              18: 3, 19: 3, 20: 2, 21: 2, 22: 2, 23: 2, 24: 2, 25: 2,
              26: 1, 27: 1, 28: 1, 29: 3, 30: 3, 31: 3}
# Gmsh tet edges end in (2,3),(1,3); Nastran ends in (1,3),(2,3).
# Gmsh hex edge order is 01,03,04,12,15,23,26,37,45,47,56,67.
# Nastran CHEXA20 is 01,12,23,30,45,56,67,74,04,15,26,37.
PERMUTATIONS = {11: [0, 1, 2, 3, 4, 5, 6, 7, 9, 8],
                17: list(range(8)) + [8, 11, 13, 9, 16, 18, 19, 17, 10, 12, 14, 15]}


class MeshError(Exception):
    def __init__(self, message, log="", status=422):
        super().__init__(message)
        self.log = log
        self.status = status


def finite_number(value, name, minimum=None, maximum=1e12):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        raise MeshError(f"{name} must be a finite number.", status=400)
    if abs(value) > maximum or not math.isfinite(value) or (minimum is not None and value < minimum):
        raise MeshError(f"{name} is outside the allowed range.", status=400)
    return float(value)


def vector(value, name, count, positive=False):
    if not isinstance(value, list) or len(value) != count:
        raise MeshError(f"{name} must contain {count} numbers.", status=400)
    return [finite_number(x, name, minimum=1e-9 if positive else None) for x in value]


def find_gmsh(explicit=None):
    if explicit:
        return shutil.which(explicit)
    return shutil.which("gmsh") or ("/opt/homebrew/bin/gmsh" if Path("/opt/homebrew/bin/gmsh").is_file() else None)


def health(gmsh):
    version = None
    if gmsh:
        try:
            result = subprocess.run([gmsh, "-version"], capture_output=True, text=True, timeout=5, check=False)
            if result.returncode == 0:
                version = (result.stdout + result.stderr).strip()[:160]
        except (OSError, subprocess.TimeoutExpired):
            pass
    kernel = importlib.util.find_spec("gmsh") is not None or any((Path(folder) / "gmsh.py").is_file()
                for folder in ("/opt/homebrew/opt/gmsh/lib", "/usr/local/opt/gmsh/lib"))
    return {"ok": True, "gmsh": {"available": version is not None, "version": version},
            "cad": {"available": kernel, "operations": ["preview", "split", "project", "passages", "defeature", "heal", "sweep", "layered", "mapped"]},
            "formats": ["step", "iges", "brep", "stl"], "topologies": ["tri", "quad", "tet", "hex"],
            "orders": [1, 2], "limits": {"cadBytes": MAX_CAD, "timeoutSeconds": MESH_TIMEOUT,
                                        "meshBytes": MAX_MESH, "residentBytes": MAX_RSS},
            "notes": ["Hex meshing requires compatible mapped blocks, a verified sweep, or prepared common-base columns.",
                      "STL remeshing requires a manifold surface; volume meshing requires a closed shell.",
                      "Executable .geo files are intentionally not accepted."]}


def validate_request(data):
    if not isinstance(data, dict):
        raise MeshError("The request must be a JSON object.", status=400)
    topology = data.get("topology", "tet")
    if not isinstance(topology, str) or topology not in {"tri", "quad", "tet", "hex"}:
        raise MeshError("Choose tri, quad, tet, or hex topology.", status=400)
    dimension = data.get("dimension", 2 if topology in {"tri", "quad"} else 3)
    if type(dimension) is not int or dimension != (2 if topology in {"tri", "quad"} else 3):
        raise MeshError("Triangles/quads require dimension 2; tetrahedra/hexes require dimension 3.", status=400)
    order = data.get("order", 1)
    if type(order) is not int or order not in {1, 2}:
        raise MeshError("Element order must be 1 or 2.", status=400)
    size = finite_number(data.get("size", 1), "Mesh size", minimum=1e-8)
    divisions = data.get("divisions", 6)
    if not isinstance(divisions, list):
        divisions = [divisions] * 3
    if len(divisions) != 3 or any(type(n) is not int or not 1 <= n <= 80 for n in divisions):
        raise MeshError("Divisions must be an integer from 1 to 80, or three such integers.", status=400)
    return topology, dimension, order, size, divisions


def geometry_source(data, directory):
    geometry = data.get("geometry")
    if geometry is not None:
        if not isinstance(geometry, dict):
            raise MeshError("Geometry must be an object.", status=400)
        kind = geometry.get("kind")
        origin = vector(geometry.get("origin", [0, 0, 0]), "Origin", 3)
        if kind == "block":
            sizes = vector(geometry.get("size", [10, 10, 10]), "Block size", 3, positive=True)
            return 'SetFactory("OpenCASCADE");\nBox(1) = {' + ",".join(map(str, origin + sizes)) + "};\n", False
        if kind == "cylinder":
            radius, height = vector(geometry.get("size", [5, 10]), "Cylinder [radius,height]", 2, positive=True)
            values = origin + [0.0, 0.0, height, radius]
            return 'SetFactory("OpenCASCADE");\nCylinder(1) = {' + ",".join(map(str, values)) + "};\n", False
        if kind == "rectangle":
            sizes = vector(geometry.get("size", [10, 10]), "Rectangle size", 2, positive=True)
            return 'SetFactory("OpenCASCADE");\nRectangle(1) = {' + ",".join(map(str, origin + sizes)) + "};\n", False
        raise MeshError("Geometry kind must be block, cylinder, or rectangle.", status=400)
    file_format = data.get("format")
    if not isinstance(file_format, str) or file_format.lower() not in FORMATS:
        raise MeshError("Upload STEP, IGES, BREP, or STL CAD data. Executable GEO files are not accepted.", status=400)
    file_format = FORMATS[file_format.lower()]
    content = data.get("content")
    if not isinstance(content, str) or len(content) > (MAX_CAD + 2) // 3 * 4:
        raise MeshError("CAD data must be base64 encoded and no larger than 24 MiB.", status=400)
    try:
        raw = base64.b64decode(content, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise MeshError("Invalid base64 CAD data.", status=400) from exc
    if not raw or len(raw) > MAX_CAD:
        raise MeshError("The CAD file is empty or exceeds 24 MiB.", status=400)
    # Ignore the supplied filename entirely: it is display metadata, never a path.
    filename = "input." + file_format
    (directory / filename).write_bytes(raw)
    source = ('SetFactory("OpenCASCADE");\n' if file_format != "stl" else "") + f'Merge "{filename}";\n'
    if file_format == "stl":
        # Gmsh tutorial t13: build reparametrizable discrete surfaces from STL.
        # https://gmsh.info/doc/texinfo/gmsh.html#t13
        source += "ClassifySurfaces {40*Pi/180, 1, 1, Pi};\nCreateGeometry;\n"
        if data.get("topology", "tet") in {"tet", "hex"}:
            source += "Surface Loop(1) = Surface{:};\nVolume(1) = {1};\n"
    return source, file_format == "stl"


def meshing_script(source, topology, dimension, order, size, divisions):
    source += f"\nMesh.MshFileVersion = 2.2;\nMesh.Binary = 0;\nMesh.SaveAll = 1;\nMesh.ElementOrder = {order};\n"
    source += f"Mesh.SecondOrderIncomplete = 1;\nMesh.MeshSizeMin = {size};\nMesh.MeshSizeMax = {size};\n"
    source += "Mesh.MaxNumThreads1D = 1;\nMesh.MaxNumThreads2D = 1;\nMesh.MaxNumThreads3D = 1;\n"
    if topology == "quad":
        # Full-quad Blossom algorithms 2/3 fail on periodic CAD surfaces such as
        # cylindrical holes. Normal Blossom plus all-quad subdivision supports
        # those surfaces and removes leftover triangles, at a finer final size.
        source += "Mesh.Algorithm = 8;\nMesh.RecombinationAlgorithm = 1;\nMesh.SubdivisionAlgorithm = 1;\nRecombine Surface {:};\n"
    if topology == "hex":
        if len(set(divisions)) == 1:
            source += f"Transfinite Curve {{:}} = {divisions[0] + 1};\n"
        else:
            # Axis counts are useful for aligned CAD blocks. Other blocks should
            # use a uniform count, since opposite edges need compatible counts.
            source += "curves() = Curve{:};\nFor i In {0:#curves()-1}\n"
            source += "  b() = BoundingBox Curve {curves(i)};\n  dx = b(3)-b(0); dy = b(4)-b(1); dz = b(5)-b(2);\n"
            source += f"  If (dx >= dy && dx >= dz)\n    Transfinite Curve {{curves(i)}} = {divisions[0] + 1};\n"
            source += f"  ElseIf (dy >= dz)\n    Transfinite Curve {{curves(i)}} = {divisions[1] + 1};\n"
            source += f"  Else\n    Transfinite Curve {{curves(i)}} = {divisions[2] + 1};\n  EndIf\nEndFor\n"
        source += "Transfinite Surface {:};\nRecombine Surface {:};\nTransfinite Volume {:};\n"
    return source


def parse_msh(path, topology, dimension, order):
    if path.stat().st_size > MAX_MESH:
        raise MeshError("The generated mesh is too large. Increase the target size or reduce divisions.")
    lines = iter(path.read_text(encoding="utf-8").splitlines())
    nodes = {}
    elements = []
    unexpected = Counter()
    try:
        for line in lines:
            if line == "$Nodes":
                count = int(next(lines))
                if count > MAX_ENTITIES:
                    raise MeshError("Mesh exceeds 500,000 nodes. Increase mesh size or reduce divisions.")
                for _ in range(count):
                    fields = next(lines).split()
                    nid = int(fields[0])
                    coordinates = list(map(float, fields[1:]))
                    if len(coordinates) != 3 or not all(map(math.isfinite, coordinates)) or nid in nodes:
                        raise MeshError("Gmsh returned invalid node coordinates or duplicate IDs.")
                    nodes[nid] = dict(zip(("id", "x", "y", "z"), [nid] + coordinates))
            elif line == "$Elements":
                count = int(next(lines))
                if count > MAX_ENTITIES * 5:
                    raise MeshError("Mesh exceeds the element limit. Increase mesh size or reduce divisions.")
                for _ in range(count):
                    values = list(map(int, next(lines).split()))
                    eid, gmsh_type, ntags = values[:3]
                    if DIMENSIONS.get(gmsh_type, dimension) != dimension:
                        continue
                    if gmsh_type != EXPECTED[topology, order]:
                        unexpected[gmsh_type] += 1
                        continue
                    tags = values[3:3 + ntags]
                    connectivity = values[3 + ntags:]
                    name, expected_nodes = ELEMENTS[gmsh_type]
                    if len(connectivity) != expected_nodes:
                        raise MeshError("Gmsh returned invalid element connectivity.")
                    if gmsh_type in PERMUTATIONS:
                        connectivity = [connectivity[index] for index in PERMUTATIONS[gmsh_type]]
                    pid = (tags[0] if tags and tags[0] > 0 else tags[1] if len(tags) > 1 else 1) or 1
                    elements.append({"id": eid, "type": name, "pid": pid, "nodes": connectivity})
    except (ValueError, IndexError, StopIteration) as exc:
        raise MeshError("Gmsh returned an invalid MSH 2.2 mesh.") from exc
    if unexpected:
        raise MeshError(f"Requested {topology} order {order}, but CAD produced other element types {dict(unexpected)}. "
                        + ("Structured hex meshing needs compatible six-sided blocks with matching edge divisions." if topology == "hex" else "Try another topology or prepare the CAD surfaces."))
    if not elements:
        raise MeshError("No requested elements were generated. Check for valid surfaces or closed CAD volumes.")
    if len(elements) > MAX_ENTITIES:
        raise MeshError("Mesh exceeds 500,000 elements. Increase mesh size or reduce divisions.")
    used = {nid for element in elements for nid in element["nodes"]}
    if not used.issubset(nodes):
        raise MeshError("Gmsh returned missing node references.")
    return {"nodes": [node for nid, node in nodes.items() if nid in used], "elements": elements}


def resident_bytes(pid):
    """Read this child process's RSS without unsafe preexec hooks in HTTP threads.

    Linux exposes RSS in procfs. macOS and other POSIX hosts expose it through ps.
    If neither is available, deadline and output-size limits remain enforced.
    This is a polling guard: memory can briefly exceed the cap between samples.
    """
    try:
        status = Path(f"/proc/{pid}/status")
        if status.is_file():
            match = re.search(r"^VmRSS:\s+(\d+)\s+kB", status.read_text(), re.MULTILINE)
            if match:
                return int(match.group(1)) * 1024
        if PS:
            result = subprocess.run([PS, "-o", "rss=", "-p", str(pid)], capture_output=True,
                                    text=True, timeout=1, check=False)
            value = result.stdout.strip()
            if result.returncode == 0 and value.isdigit():
                return int(value) * 1024
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    return None


def log_tail(path):
    with path.open("rb") as stream:
        stream.seek(max(0, path.stat().st_size - 24_000))
        return stream.read().decode("utf-8", errors="replace")


def watch_process(process, directory):
    """Bound a running mesher and always reap it, including on cancellation."""
    deadline = time.monotonic() + MESH_TIMEOUT
    next_rss_check = 0
    try:
        while True:
            for filename, maximum in (("mesh.msh", MAX_MESH), ("gmsh.log", MAX_LOG), ("worker-result.json", MAX_MESH)):
                try:
                    size = (directory / filename).stat().st_size
                except FileNotFoundError:
                    continue
                if size > maximum:
                    raise MeshError(f"Gmsh exceeded the {filename} output limit. Increase mesh size or simplify the CAD.")
            code = process.poll()
            if code is not None:
                return code
            now = time.monotonic()
            if now >= deadline:
                raise MeshError(f"Meshing exceeded {MESH_TIMEOUT} seconds. Increase size or simplify the CAD.", status=504)
            if now >= next_rss_check:
                usage = resident_bytes(process.pid)
                if usage is not None and usage > MAX_RSS:
                    raise MeshError("Gmsh exceeded the 2 GiB memory limit. Increase mesh size or simplify the CAD.")
                next_rss_check = now + 0.5
            try:
                process.wait(timeout=min(0.25, max(0.001, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def generate_mesh(data, gmsh):
    topology, dimension, order, size, divisions = validate_request(data)
    if not gmsh:
        raise MeshError("Gmsh is unavailable. Install Gmsh and restart the local server.", status=503)
    with tempfile.TemporaryDirectory(prefix="webmesh-") as temporary:
        directory = Path(temporary)
        source, is_stl = geometry_source(data, directory)
        if is_stl and topology == "hex":
            raise MeshError("Structured hex meshing requires CAD blocks; STL has no transfinite CAD topology.")
        (directory / "mesh.geo").write_text(meshing_script(source, topology, dimension, order, size, divisions), encoding="utf-8")
        log_path = directory / "gmsh.log"
        with log_path.open("wb") as output:
            try:
                process = subprocess.Popen([gmsh, "mesh.geo", f"-{dimension}", "-format", "msh2", "-o", "mesh.msh",
                                            "-nt", "1", "-nopopup", "-v", "4"],
                                           cwd=directory, stdout=output, stderr=subprocess.STDOUT)
                returncode = watch_process(process, directory)
            except MeshError as exc:
                output.flush()
                exc.log = log_tail(log_path)
                raise
            except OSError as exc:
                raise MeshError("Gmsh could not be started. Check the installed executable.", status=503) from exc
            output.flush()
            log = log_tail(log_path)
        mesh_path = directory / "mesh.msh"
        if returncode or re.search(r"\bError\s*:", log) or not mesh_path.is_file():
            detail = "Structured hex meshing requires compatible six-sided CAD blocks and matching edge divisions." if topology == "hex" else "Check the geometry and target mesh size."
            raise MeshError("Gmsh could not complete this mesh. " + detail, log)
        try:
            mesh = parse_msh(mesh_path, topology, dimension, order)
        except MeshError as exc:
            exc.log = log
            raise
        return {"mesh": mesh, "log": log,
                "stats": {"nodes": len(mesh["nodes"]), "elements": len(mesh["elements"]),
                          "dimension": dimension, "topology": topology, "order": order,
                          "parts": len({element["pid"] for element in mesh["elements"]})}}


def run_cad_worker(request, source, output):
    """Execute a single CAD task in the same bounded process envelope as meshing."""
    with tempfile.TemporaryDirectory(prefix="webmesh-cad-task-") as temporary:
        directory = Path(temporary)
        request = {**request, "input": str(source), "output": str(output) if output else None}
        request_path = directory / "request.json"
        request_path.write_text(json.dumps(request, allow_nan=False))
        log_path = directory / "gmsh.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen([sys.executable, str(ROOT / "cad_kernel.py"), str(request_path)],
                                       cwd=directory, stdout=log, stderr=subprocess.STDOUT)
            code = watch_process(process, directory)
        result_path = directory / "worker-result.json"
        if code or not result_path.is_file():
            raise CadError("The CAD kernel could not complete this operation. Check the Gmsh Python bindings.", log=log_tail(log_path))
        result = json.loads(result_path.read_text())
        if result.get("error"):
            raise CadError(result["error"], log=result.get("log", log_tail(log_path)))
        if output and output.is_file() and output.stat().st_size > MAX_CAD:
            raise CadError("The prepared geometry exceeds 24 MiB. Simplify it or prepare smaller regions so exported projects remain importable.")
        if request["action"] == "mesh":
            topology_name = request.get("topology", "tet")
            dimension = 2 if topology_name in {"tri", "quad"} else 3
            order = request.get("order", 1)
            result["mesh"] = parse_msh(directory / "mesh.msh", topology_name, dimension, order)
            result["stats"] = {"nodes": len(result["mesh"]["nodes"]), "elements": len(result["mesh"]["elements"]),
                               "topology": topology_name, "dimension": dimension, "order": order,
                               "parts": len({element["pid"] for element in result["mesh"]["elements"]})}
        return result


class WebMeshHandler(SimpleHTTPRequestHandler):
    """Same-origin loopback service; no CORS and no writeable static endpoints."""

    def __init__(self, *args, gmsh=None, **kwargs):
        self.gmsh = gmsh
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def json_response(self, status, value):
        encoded = json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def trusted_request(self):
        port = self.server.server_address[1]
        valid_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        if port == 80:
            valid_hosts.update({"127.0.0.1", "localhost"})
        host = self.headers.get("Host", "").lower()
        origin = self.headers.get("Origin")
        if host not in valid_hosts or (origin is not None and origin != f"http://{host}") or self.headers.get("Sec-Fetch-Site") == "cross-site":
            self.json_response(403, {"error": "Only requests from this local WebMesh origin are accepted."})
            return False
        return True

    def static_path_allowed(self):
        path = Path(unquote(urlsplit(self.path).path).lstrip("/"))
        if any(part.startswith(".") for part in path.parts):
            return False
        try:
            resolved = (ROOT / path).resolve()
            resolved.relative_to(ROOT)
        except (ValueError, OSError):
            return False
        return not any(part.startswith(".") for part in resolved.relative_to(ROOT).parts)

    def do_GET(self):
        if not self.trusted_request():
            return
        if urlsplit(self.path).path == "/api/health":
            self.json_response(200, health(self.gmsh))
        elif self.static_path_allowed():
            super().do_GET()
        else:
            self.send_error(404)

    def do_HEAD(self):
        if self.trusted_request():
            if self.static_path_allowed():
                super().do_HEAD()
            else:
                self.send_error(404)

    def list_directory(self, path):
        self.send_error(404, "Directory listings are disabled")
        return None

    def do_POST(self):
        if not self.trusted_request():
            return
        endpoint = urlsplit(self.path).path
        if endpoint not in {"/api/mesh", "/api/cad/import", "/api/cad/prepare", "/api/cad/undo", "/api/cad/export", "/api/cad/mesh"}:
            self.json_response(404, {"error": "Unknown API endpoint."})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            self.json_response(415, {"error": "Use Content-Type: application/json."})
            return
        if self.headers.get("Transfer-Encoding"):
            self.json_response(400, {"error": "Chunked requests are not supported."})
            return
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            self.json_response(400, {"error": "Invalid Content-Length."})
            return
        if not 0 < length <= MAX_REQUEST:
            self.json_response(413, {"error": "Request must be between 1 byte and 34 MiB."})
            return
        # Acquire before reading a potentially large body so parallel tabs cannot
        # allocate many request-sized buffers while the mesher is already busy.
        if not self.server.mesh_slot.acquire(blocking=False):
            self.json_response(409, {"error": "Another mesh is running. Wait for it to finish."})
            return
        try:
            try:
                self.connection.settimeout(15)
                raw = self.rfile.read(length)
                if len(raw) != length:
                    raise ValueError("incomplete request")
                data = json.loads(raw)
            except (ValueError, UnicodeDecodeError, TimeoutError, OSError, RecursionError):
                self.json_response(400, {"error": "Invalid or incomplete JSON request."})
                return
            try:
                if not isinstance(data, dict):
                    raise MeshError("The request must be a JSON object.", status=400)
                if endpoint == "/api/mesh":
                    result = generate_mesh(data, self.gmsh)
                else:
                    if endpoint == "/api/cad/mesh":
                        validate_request(data)
                    method = endpoint.rsplit("/", 1)[1]
                    handler = self.server.cad_sessions.import_cad if method == "import" else getattr(self.server.cad_sessions, method)
                    result = handler(data)
                self.json_response(200, result)
            except (MeshError, CadError) as exc:
                self.json_response(exc.status, {"error": str(exc), "log": exc.log})
            except Exception as exc:
                self.log_error("Meshing failed: %s", type(exc).__name__)
                self.json_response(500, {"error": "The local meshing service encountered an unexpected error."})
        finally:
            self.server.mesh_slot.release()


def make_server(port=8765, gmsh=None):
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(WebMeshHandler, gmsh=gmsh))
    server.mesh_slot = threading.BoundedSemaphore(1)
    server.cad_sessions = CadSessions(run_cad_worker)
    server.daemon_threads = True
    return server


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--gmsh", help="Path to the Gmsh executable")
    args = parser.parse_args()
    gmsh = find_gmsh(args.gmsh)
    with make_server(args.port, gmsh) as server:
        print(f"WebMesh: http://127.0.0.1:{server.server_address[1]}")
        print(f"Gmsh: {gmsh or 'unavailable; CAD meshing disabled'}")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
