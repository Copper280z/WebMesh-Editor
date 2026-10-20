#!/usr/bin/env python3
"""Isolated OpenCASCADE/Gmsh worker for CAD preview, preparation and mesh checks.

The HTTP process never loads Gmsh's global C API. A worker imports one immutable
BREP snapshot, performs one operation, and exits; failed operations cannot alter a
session. Gmsh's OpenCASCADE API is documented at:
https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002focc
https://gmsh.info/doc/texinfo/gmsh.html#Namespace-gmsh_002fmodel_002fmesh
"""

import importlib.util
import json
import math
import os
from pathlib import Path
import sys


def gmsh_module():
    """Find pip installations or the Python bindings bundled with Homebrew."""
    if importlib.util.find_spec("gmsh") is None:
        for directory in ("/opt/homebrew/opt/gmsh/lib", "/usr/local/opt/gmsh/lib"):
            if (Path(directory) / "gmsh.py").is_file():
                sys.path.insert(0, directory)
                break
    import gmsh
    return gmsh


def safe_mass(gmsh, dimension, tag, native=None):
    """OpenCASCADE mass of an entity; `native` may hold the current occ entities of that dimension."""
    try:
        if (dimension, tag) not in (native if native is not None else gmsh.model.occ.getEntities(dimension)):
            return 0.0
        return float(gmsh.model.occ.getMass(dimension, tag))
    except Exception:
        return 0.0


def topology(gmsh):
    model = gmsh.model
    faces, edges, volumes = [], [], []
    # Listing the kernel's entities is costly; the model does not change here.
    occ = {dimension: set(model.occ.getEntities(dimension)) for dimension in (1, 2, 3)}
    for _, tag in model.getEntities(2):
        bounds = list(map(float, model.getBoundingBox(2, tag)))
        native = (2, tag) in occ[2]
        try:
            if not native:
                raise ValueError("Discrete geometry has no CAD center of mass")
            center = list(map(float, model.occ.getCenterOfMass(2, tag)))
        except Exception:
            center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        face = {"id": tag, "type": model.getType(2, tag), "area": safe_mass(gmsh, 2, tag, occ[2]),
                "bounds": bounds, "center": center,
                "edges": [abs(int(t)) for _, t in model.getBoundary([(2, tag)], oriented=False)],
                "volumes": list(map(int, model.getAdjacencies(2, tag)[0]))}
        try:
            if not native:
                raise ValueError("Discrete geometry has no CAD curvatures")
            _, loops = model.occ.getCurveLoops(tag)
            face["loops"] = [list(map(int, loop)) for loop in loops]
            lower, upper = model.getParametrizationBounds(2, tag)
            parameter = [(float(a) + float(b)) / 2 for a, b in zip(lower, upper)]
            face["normal"] = list(map(float, model.getNormal(tag, parameter)))
            maximum, minimum, _, _ = model.getPrincipalCurvatures(tag, parameter)
            face["curvatures"] = [float(maximum[0]), float(minimum[0])]
            nonzero = [abs(v) for v in face["curvatures"] if abs(v) > 1e-7]
            if nonzero:
                face["radius"] = 1 / max(nonzero)
        except Exception:
            pass
        faces.append(face)
    for _, tag in model.getEntities(1):
        edges.append({"id": tag, "type": model.getType(1, tag), "length": safe_mass(gmsh, 1, tag, occ[1]),
                      "bounds": list(map(float, model.getBoundingBox(1, tag))),
                      "faces": list(map(int, model.getAdjacencies(1, tag)[0]))})
    by_face = {face["id"]: face for face in faces}
    for _, tag in model.getEntities(3):
        boundary = [abs(int(t)) for _, t in model.getBoundary([(3, tag)], oriented=False)]
        volumes.append({"id": tag, "volume": safe_mass(gmsh, 3, tag, occ[3]), "faces": boundary,
                        "bounds": list(map(float, model.getBoundingBox(3, tag))),
                        "mapped": len(boundary) == 6 and all(len(by_face[t]["edges"]) == 4 for t in boundary)})
    bounds = list(map(float, model.getBoundingBox(-1, -1)))
    candidates = []
    diagonal = math.sqrt(sum((bounds[i + 3] - bounds[i]) ** 2 for i in range(3)))
    tolerance = max(diagonal * 1e-6, 1e-7)
    for face in faces:
        if face["type"] != "Plane" or not face.get("normal"):
            continue
        for target in faces:
            if face["id"] >= target["id"] or target["type"] != "Plane":
                continue
            if abs(face["area"] - target["area"]) > max(face["area"], 1) * 1e-6:
                continue
            vector = [b - a for a, b in zip(face["center"], target["center"])]
            distance = math.sqrt(sum(v * v for v in vector))
            if distance < tolerance:
                continue
            parallel = abs(sum(v * n for v, n in zip(vector, face["normal"]))) / distance
            if parallel < 1 - 1e-6:
                continue
            if any(abs(face["bounds"][i] + vector[i % 3] - target["bounds"][i]) > tolerance for i in range(6)):
                continue
            candidates.append({"sourceFace": face["id"], "targetFace": target["id"], "vector": vector,
                               "distance": distance})
    layered = []
    for coordinate, axis in enumerate("xyz"):
        columns = []
        for volume in volumes:
            choices = []
            for candidate in candidates:
                source, target = by_face[candidate["sourceFace"]], by_face[candidate["targetFace"]]
                if source["id"] not in volume["faces"] or target["id"] not in volume["faces"]:
                    continue
                vector = candidate["vector"]
                if abs(vector[coordinate]) < tolerance or any(abs(vector[i]) > tolerance for i in range(3) if i != coordinate):
                    continue
                low, high = sorted((source, target), key=lambda face: face["center"][coordinate])
                start, end = low["center"][coordinate], high["center"][coordinate]
                if abs(low["area"] * (end - start) - volume["volume"]) > max(volume["volume"], 1) * 1e-6:
                    continue
                choices.append({"volumeId": volume["id"], "sourceFace": low["id"], "targetFace": high["id"],
                                "min": start, "max": end, "area": low["area"]})
            if not choices:
                break
            columns.append(max(choices, key=lambda choice: choice["area"]))
        if not columns or len(columns) != len(volumes):
            continue
        levels = []
        for value in sorted([value for column in columns for value in (column["min"], column["max"])]):
            if not levels or value - levels[-1] > tolerance:
                levels.append(value)
        intervals = [{"start": a, "end": b, "volumeIds": [column["volumeId"] for column in columns
                      if column["min"] < (a + b) / 2 < column["max"]]}
                     for a, b in zip(levels, levels[1:])]
        layered.append({"axis": axis, "columns": columns, "levels": levels, "intervals": intervals})
    return {"faces": faces, "edges": edges, "volumes": volumes, "bounds": bounds,
            "volume": sum(v["volume"] for v in volumes), "sweepCandidates": candidates,
            "layeredSweeps": layered,
            "features": [{"faceId": f["id"], "type": f["type"], "area": f["area"],
                          "radius": f.get("radius")} for f in faces if f["type"] != "Plane"]}


def tessellation(gmsh, data, cache=None, keys=None, out=None):
    """Display triangles of every face, as flat positions and owning face ids.

    Faces with an analytic surface whose triangles the previous revision
    already computed (`cache`, keyed by the Signatures `keys`) are not meshed
    again; only new or changed faces are. Triangles go into `out` for the next.
    """
    model = gmsh.model
    bounds = data["bounds"]
    diagonal = math.sqrt(sum((bounds[i + 3] - bounds[i]) ** 2 for i in range(3)))
    size = max(diagonal / 24, 1e-5)
    gmsh.option.setNumber("Mesh.MeshSizeMin", size)
    gmsh.option.setNumber("Mesh.MeshSizeMax", size)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 48)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    previous = (cache or {}).get("triangles", {}) if keys is not None and out is not None else {}
    analytic = {face["id"] for face in data["faces"] if face.get("surface", {}).get("kind") in {"plane", "cylinder", "sphere"}}
    reused = {tag: previous[keys.face[tag]] for tag in analytic if keys.face.get(tag) in previous}
    if not data.get("discrete"):
        faces = [tag for _, tag in model.getEntities(2)]
        if reused:
            gmsh.option.setNumber("Mesh.MeshOnlyVisible", 1)
            model.setVisibility([(2, tag) for tag in reused], 0)
        if len(reused) < len(faces):
            model.mesh.generate(2)
    node_ids, coordinates, _ = model.mesh.getNodes()
    nodes = {int(nid): list(map(float, coordinates[3 * i:3 * i + 3])) for i, nid in enumerate(node_ids)}
    positions, face_ids = [], []
    for _, tag in model.getEntities(2):
        if tag in reused:
            triangles = reused[tag]
        else:
            triangles = []
            types, _, connectivity = model.mesh.getElements(2, tag)
            for element_type, node_list in zip(types, connectivity):
                if element_type != 2:
                    raise ValueError("CAD preview returned unexpected non-triangle elements.")
                for nid in node_list:
                    triangles.extend(nodes[int(nid)])
        positions.extend(triangles)
        face_ids.extend([tag] * (len(triangles) // 9))
        if tag in analytic and out is not None:
            out["triangles"][keys.face[tag]] = triangles
    if len(face_ids) > 250_000:
        raise ValueError("CAD preview exceeds 250,000 triangles. Simplify the geometry first.")
    return positions, face_ids


def edge_polylines(gmsh, data):
    """Display polylines of every edge; mapped-meshing samples move here from the topology."""
    model = gmsh.model
    edges = []
    for edge in data["edges"]:
        tag = edge["id"]
        try:
            if edge.get("samples"):
                edges.append({"id": tag, "points": edge.pop("samples")})
                continue
            lower, upper = model.getParametrizationBounds(1, tag)
            start, end = float(lower[0]), float(upper[0])
            count = 2 if edge["type"] == "Line" else 65
            parameters = [start + (end - start) * i / (count - 1) for i in range(count)]
            points = list(map(float, model.getValue(1, tag, parameters)))
            edges.append({"id": tag, "points": points})
        except Exception:
            pass
    return edges


def preview(gmsh, data, edges=None, cache=None, keys=None, out=None):
    """Display tessellation and edge polylines. Edges are sampled once the mesh
    exists, since discrete (STL) curves follow it; OpenCASCADE curves do not."""
    positions, face_ids = tessellation(gmsh, data, cache, keys, out)
    if edges is None:
        edges = edge_polylines(gmsh, data)
    if not data.get("discrete"):
        gmsh.model.mesh.clear()
    return {"positions": positions, "triangleFaceIds": face_ids, "edges": edges, "faces": data["faces"]}


def write_early(path, result):
    """Publish a result before the worker exits: written whole, then renamed into place."""
    partial = Path(path + ".part")
    partial.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
    os.replace(partial, path)


def rectangular_passages(gmsh, operation, volumes):
    """Explicit reviewed box cuts, optionally replacing selected curved features.

    Width and height use the two non-axis coordinates in XYZ order. The axis
    coordinate of center is ignored: range sets the two passage endpoints. This
    is a CAD preparation edit, never an automatic meshing simplification.
    """
    model, occ = gmsh.model, gmsh.model.occ
    specifications = operation.get("passages")
    if operation.get("kind") == "passage":
        specifications = [operation]
    if not isinstance(specifications, list) or not 1 <= len(specifications) <= 24:
        raise ValueError("Provide between 1 and 24 rectangular passages.")
    faces = operation.get("faceIds", [])
    if not isinstance(faces, list) or any(type(tag) is not int or (2, tag) not in model.getEntities(2) for tag in faces):
        raise ValueError("Choose existing feature faces to replace, or leave the selection empty for a new opening.")
    # Validate all numeric inputs before doing any kernel work. Only primitive
    # numbers reach addBox: filenames and script text never enter this path.
    boxes = []
    bounds = model.getBoundingBox(-1, -1)
    span = max(bounds[i + 3] - bounds[i] for i in range(3))
    for item in specifications:
        if not isinstance(item, dict) or item.get("axis") not in ("x", "y", "z"):
            raise ValueError("Each passage requires an X, Y or Z axis.")
        center, interval = item.get("center"), item.get("range")
        width, height = item.get("width"), item.get("height")
        values = (center if isinstance(center, list) else []) + (interval if isinstance(interval, list) else []) + [width, height]
        if (not isinstance(center, list) or len(center) != 3 or not isinstance(interval, list) or len(interval) != 2
                or any(type(value) not in (int, float) or not math.isfinite(value) for value in values)
                or width <= 0 or height <= 0 or interval[1] <= interval[0]):
            raise ValueError("Passage center, width, height and ascending range must contain finite positive dimensions.")
        coordinate = "xyz".index(item["axis"])
        varying = [i for i in range(3) if i != coordinate]
        corner, size = list(center), [0.0] * 3
        corner[coordinate], size[coordinate] = interval[0], interval[1] - interval[0]
        for index, length in zip(varying, (width, height)):
            corner[index], size[index] = center[index] - length / 2, length
        if any(size[i] > span * 4 or corner[i] < bounds[i] - 2 * span or corner[i] + size[i] > bounds[i + 3] + 2 * span for i in range(3)):
            raise ValueError("Passage bounds must remain near the CAD and below four times its largest dimension.")
        boxes.append((coordinate, corner, size, item.get("fit") is True))
    if faces:
        result = occ.defeature([tag for _, tag in volumes], faces, removeVolume=True)
        occ.synchronize()
        if not result:
            raise ValueError("The selected feature faces could not be replaced before cutting the passages.")
        volumes = model.getEntities(3)
    mass = sum(safe_mass(gmsh, 3, tag) for _, tag in volumes)
    tolerance = max(mass * 1e-9, 1e-8)
    tools = []
    # Probe slab for the end checks. OpenCASCADE returns an empty intersection
    # for slabs much thinner than this, which would make every end look open.
    thickness = max(span * 1e-5, 1e-6)

    def cap_mass(corner, size, coordinate, position):
        cap_corner, cap_size = list(corner), list(size)
        cap_corner[coordinate], cap_size[coordinate] = position, thickness
        cap = (3, occ.addBox(*cap_corner, *cap_size))
        overlap, _ = occ.intersect(occ.copy(volumes), [cap])
        value = sum(occ.getMass(dimension, tag) for dimension, tag in overlap if dimension == 3)
        if overlap:
            occ.remove(overlap, recursive=True)
        return value

    for coordinate, corner, size, fit in boxes:
        if fit:
            # The range is the extent of the replaced feature. Move each end just
            # past it, or just inside it when the feature ends against material
            # (a bore that starts at an inner wall), so both ends are open.
            lo, hi = corner[coordinate], corner[coordinate] + size[coordinate]
            pad = max(span * 5e-3, (hi - lo) * 0.02)
            # An oblique exit reaches past the feature's vertices by up to a width.
            reach = max(size[(coordinate + 1) % 3], size[(coordinate + 2) % 3])
            free = lambda t: cap_mass(corner, size, coordinate, t) <= thickness * size[(coordinate + 1) % 3] * size[(coordinate + 2) % 3] * 1e-4
            # Nearest open position first, alternating outward and inward.
            start = next((t for t in (lo - pad, lo + pad, lo - reach, lo + 3 * pad, lo - 2 * reach, lo + 6 * pad) if free(t)), lo - pad)
            end = next((t for t in (hi + pad, hi - pad, hi + reach, hi - 3 * pad, hi + 2 * reach, hi - 6 * pad) if free(t - thickness)), hi + pad)
            if end - start > 2 * pad:
                corner[coordinate], size[coordinate] = start, end - start
        tool = (3, occ.addBox(*corner, *size))
        # Each cut must cross material and both ends must finish in free space.
        # This rejects blind pockets and accidentally truncated through ranges.
        intersection, _ = occ.intersect(occ.copy(volumes), occ.copy([tool]))
        removed = sum(occ.getMass(dimension, tag) for dimension, tag in intersection if dimension == 3)
        if intersection:
            occ.remove(intersection, recursive=True)
        if removed <= tolerance:
            raise ValueError("A rectangular passage does not intersect material. Review its center and dimensions.")
        for end in (0, 1):
            position = corner[coordinate] + ((size[coordinate] - 2 * thickness) if end else thickness)
            if cap_mass(corner, size, coordinate, position) > max(tolerance * 0.001, thickness * size[(coordinate + 1) % 3] * size[(coordinate + 2) % 3] * 1e-4):
                raise ValueError("Both passage range endpoints must finish in free space; extend the range through the wall.")
        tools.append(tool)
    if len(tools) > 1:
        # Crossing passages become one opening (with unified faces) instead of
        # leaving the walls and floors of each crossing split into slivers.
        fused, _ = occ.fuse(tools[:1], tools[1:], removeObject=True, removeTool=True)
        occ.synchronize()
        tools = [entity for entity in fused if entity[0] == 3]
    result, mapping = occ.cut(volumes, tools, removeObject=True, removeTool=True)
    occ.synchronize()
    solids = [entity for entity in result if entity[0] == 3]
    if not solids or any(len([entity for entity in group if entity[0] == 3]) != 1 for group in mapping[:len(volumes)]):
        raise ValueError("The passages would sever a solid or remove it completely. Reduce the opening to preserve its ligaments.")
    final_mass = sum(safe_mass(gmsh, 3, tag) for _, tag in solids)
    if final_mass >= mass - tolerance:
        raise ValueError("The passage cuts did not remove material.")


def _vector3(value, label):
    if (not isinstance(value, list) or len(value) != 3
            or any(type(v) not in (int, float) or not math.isfinite(v) or abs(v) > 1e9 for v in value)):
        raise ValueError(f"{label} must contain three finite coordinates.")
    return [float(v) for v in value]


def _unit3(value, label):
    vector = _vector3(value, label)
    length = math.sqrt(sum(v * v for v in vector))
    if length < 1e-12:
        raise ValueError(f"{label} must be a nonzero direction.")
    return [v / length for v in vector]


def _both_sides_inside(gmsh, face, volume, step):
    """True when points just off both sides of a face lie inside one solid."""
    model = gmsh.model
    try:
        lower, upper = model.getParametrizationBounds(2, face)
        for a in (0.5, 0.3, 0.7, 0.15, 0.85):
            for b in (0.5, 0.3, 0.7, 0.15, 0.85):
                uv = [lower[0] + (upper[0] - lower[0]) * a, lower[1] + (upper[1] - lower[1]) * b]
                if not model.isInside(2, face, uv, parametric=True):
                    continue
                point = model.getValue(2, face, uv)
                normal = model.getNormal(face, uv)
                ahead = [point[i] + step * normal[i] for i in range(3)]
                behind = [point[i] - step * normal[i] for i in range(3)]
                return bool(model.isInside(3, volume, ahead)) and bool(model.isInside(3, volume, behind))
    except Exception:
        return False
    return False


def slice_solids(gmsh, operation, volumes):
    """Fragment solids with arbitrary planes and coaxial cylinders.

    Planes and cylinders are generated here from validated numbers, sized to
    pass completely through the model. Fragmenting keeps every resulting piece
    and imprints the new interfaces on neighbors so their meshes can conform.
    """
    model, occ = gmsh.model, gmsh.model.occ
    planes = operation.get("planes", [])
    cylinders = operation.get("cylinders", [])
    rays = operation.get("rays", [])
    if (not isinstance(planes, list) or not isinstance(cylinders, list) or not isinstance(rays, list)
            or not 1 <= len(planes) + len(cylinders) + len(rays) <= 16):
        raise ValueError("Slice with between 1 and 16 planes, cylinders or radial cuts.")
    selected = operation.get("volumeIds", [])
    if not isinstance(selected, list) or any(type(tag) is not int or (3, tag) not in volumes for tag in selected):
        raise ValueError("Choose existing solid IDs to slice, or leave the selection empty for every solid.")

    def scope_of(item):
        # A tool may carry its own solids, so one operation can cut a split and
        # continue it through neighbors without leaving T-junction imprints.
        own = item.get("volumeIds") if isinstance(item, dict) else None
        if own is None:
            return tuple(selected)
        if not isinstance(own, list) or not own or any(type(tag) is not int or (3, tag) not in volumes for tag in own):
            raise ValueError("A slice tool lists solids that do not exist in this revision.")
        return tuple(own)
    scoped = []
    bounds = model.getBoundingBox(-1, -1)
    lower, upper = bounds[:3], bounds[3:]
    diagonal = math.sqrt(sum((upper[i] - lower[i]) ** 2 for i in range(3)))
    center = [(lower[i] + upper[i]) / 2 for i in range(3)]
    reach = diagonal * 0.75 + 1
    tools, tool_planes = [], []
    for plane in planes:
        if not isinstance(plane, dict):
            raise ValueError("Each slice plane needs an origin and a normal.")
        origin, normal = _vector3(plane.get("origin"), "Plane origin"), _unit3(plane.get("normal"), "Plane normal")
        helper = min(range(3), key=lambda i: abs(normal[i]))
        axis = [0.0, 0.0, 0.0]
        axis[helper] = 1.0
        u = [normal[1] * axis[2] - normal[2] * axis[1], normal[2] * axis[0] - normal[0] * axis[2], normal[0] * axis[1] - normal[1] * axis[0]]
        length = math.sqrt(sum(v * v for v in u))
        u = [v / length for v in u]
        w = [normal[1] * u[2] - normal[2] * u[1], normal[2] * u[0] - normal[0] * u[2], normal[0] * u[1] - normal[1] * u[0]]
        offset = sum((center[i] - origin[i]) * normal[i] for i in range(3))
        middle = [center[i] - offset * normal[i] for i in range(3)]
        points = [occ.addPoint(*[middle[i] + reach * (a * u[i] + b * w[i]) for i in range(3)])
                  for a, b in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
        lines = [occ.addLine(points[i], points[(i + 1) % 4]) for i in range(4)]
        tools.append((2, occ.addPlaneSurface([occ.addCurveLoop(lines)])))
        tool_planes.append((origin, normal))
        scoped.append(scope_of(plane))
    for cylinder in cylinders:
        if not isinstance(cylinder, dict):
            raise ValueError("Each slice cylinder needs an origin, axis and radius.")
        origin, axis = _vector3(cylinder.get("origin"), "Cylinder origin"), _unit3(cylinder.get("axis"), "Cylinder axis")
        radius = cylinder.get("radius")
        if type(radius) not in (int, float) or not math.isfinite(radius) or not 0 < radius < diagonal * 2:
            raise ValueError("Cylinder radius must be positive and smaller than twice the model size.")
        extent = [sum((corner[i] - origin[i]) * axis[i] for i in range(3))
                  for corner in ([x, y, z] for x in (lower[0], upper[0]) for y in (lower[1], upper[1]) for z in (lower[2], upper[2]))]
        start = min(extent) - 0.1 * diagonal - 1
        span = max(extent) - min(extent) + 0.2 * diagonal + 2
        base = [origin[i] + start * axis[i] for i in range(3)]
        circle = occ.addCircle(*base, float(radius), zAxis=axis)
        surfaces = [entity for entity in occ.extrude([(1, circle)], *[span * a for a in axis]) if entity[0] == 2]
        tools.extend(surfaces)
        scoped.extend([scope_of(cylinder)] * len(surfaces))
    for ray in rays:
        # A half-plane bounded by an axis line: radial cuts from a hole to a corner.
        if not isinstance(ray, dict):
            raise ValueError("Each radial cut needs an origin, axis, direction and length.")
        origin, axis = _vector3(ray.get("origin"), "Radial cut origin"), _unit3(ray.get("axis"), "Radial cut axis")
        direction = _vector3(ray.get("direction"), "Radial cut direction")
        along = sum(direction[i] * axis[i] for i in range(3))
        direction = [direction[i] - along * axis[i] for i in range(3)]
        size = math.sqrt(sum(v * v for v in direction))
        length = ray.get("length")
        if size < 1e-12 or type(length) not in (int, float) or not math.isfinite(length) or not 0 < length < diagonal * 4:
            raise ValueError("A radial cut needs a direction across its axis and a positive length.")
        direction = [v / size for v in direction]
        start = [origin[i] - reach * axis[i] for i in range(3)]
        corners = [start, [start[i] + 2 * reach * axis[i] for i in range(3)]]
        corners += [[corners[1][i] + length * direction[i] for i in range(3)], [start[i] + length * direction[i] for i in range(3)]]
        points = [occ.addPoint(*corner) for corner in corners]
        lines = [occ.addLine(points[i], points[(i + 1) % 4]) for i in range(4)]
        tools.append((2, occ.addPlaneSurface([occ.addCurveLoop(lines)])))
        normal = [axis[1] * direction[2] - axis[2] * direction[1], axis[2] * direction[0] - axis[0] * direction[2], axis[0] * direction[1] - axis[1] * direction[0]]
        size = math.sqrt(sum(v * v for v in normal))
        tool_planes.append((origin, [v / size for v in normal]))
        scoped.append(scope_of(ray))
    before = len(volumes)
    # Fragment each group of tools against its own solids, following the solids
    # through earlier fragments (their tags change when they are cut).
    current = {tag: [tag] for _, tag in volumes}
    partial = False
    groups = []
    for tool, scope in zip(tools, scoped):
        if groups and groups[-1][0] == scope:
            groups[-1][1].append(tool)
        else:
            groups.append((scope, [tool]))
    for scope, group in groups:
        if scope:
            partial = True
            objects = [(3, tag) for original in scope for tag in current.get(original, [])]
        else:
            objects = model.getEntities(3)
        _, mapping = occ.fragment(objects, group, removeObject=True, removeTool=True)
        occ.synchronize()
        replaced = {tag: [t for d, t in result if d == 3] for (_, tag), result in zip(objects, mapping[:len(objects)])}
        for original, tags in current.items():
            current[original] = [new for tag in tags for new in replaced.get(tag, [tag])]
    if partial:
        occ.fragment(model.getEntities(3), [], removeObject=True, removeTool=True)
        occ.synchronize()
    for dimension in (2, 1, 0):
        loose = [entity for entity in model.getEntities(dimension) if not len(model.getAdjacencies(*entity)[0])]
        if loose:
            occ.remove(loose, recursive=True)
            occ.synchronize()
    # A cutting surface that ends inside material embeds a slit instead of
    # separating two solids; such geometry cannot be meshed conformingly. A slit
    # is a face of one solid with that solid on both sides. Only faces on a tool
    # plane are tested, found by position because fragments renumber faces.
    flat = [(origin, normal) for origin, normal in tool_planes]
    step = max(diagonal * 1e-5, 1e-7)
    for _, tag in model.getEntities(2):
        owners = list(model.getAdjacencies(2, tag)[0])
        if len(owners) != 1 or model.getType(2, tag) != "Plane":
            continue
        try:
            lower, upper = model.getParametrizationBounds(2, tag)
            point = model.getValue(2, tag, [(lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2])
        except Exception:
            continue
        if not any(abs(sum((point[i] - o[i]) * n[i] for i in range(3))) < diagonal * 1e-7 for o, n in flat):
            continue
        if _both_sides_inside(gmsh, tag, int(owners[0]), step):
            raise ValueError("A cut ends inside the material and leaves a slit. Extend it to the boundary or add cuts so every region is closed.")
    if len(model.getEntities(3)) <= before:
        raise ValueError("The slice did not divide a solid. Move it through the material of the chosen solids.")
    if any(not len(model.getAdjacencies(2, tag)[0]) for _, tag in model.getEntities(2)):
        raise ValueError("The slice left surface fragments outside every solid. Adjust the cut and try again.")


def fuse_solids(gmsh, operation, volumes):
    """Merge neighboring solids back into one, e.g. to redo an unwanted cut.

    Coplanar faces left by the removed interfaces are unified. Every other
    solid stays, and the result is imprinted again so neighbors keep sharing
    conforming faces.
    """
    model, occ = gmsh.model, gmsh.model.occ
    selected = operation.get("volumeIds")
    if (not isinstance(selected, list) or not 2 <= len(selected) <= 256 or len(set(selected)) != len(selected)
            or any(type(tag) is not int or (3, tag) not in volumes for tag in selected)):
        raise ValueError("Choose two or more existing solids to fuse.")
    before = len(volumes)
    result, _ = occ.fuse([(3, selected[0])], [(3, tag) for tag in selected[1:]], removeObject=True, removeTool=True)
    occ.synchronize()
    if len([entity for entity in result if entity[0] == 3]) != 1:
        raise ValueError("The selected solids do not form one piece. Fuse solids that share faces.")
    if len(model.getEntities(3)) > 1:
        occ.fragment(model.getEntities(3), [], removeObject=True, removeTool=True)
        occ.synchronize()
    for dimension in (2, 1, 0):
        loose = [entity for entity in model.getEntities(dimension) if not len(model.getAdjacencies(*entity)[0])]
        if loose:
            occ.remove(loose, recursive=True)
            occ.synchronize()
    if len(model.getEntities(3)) != before - len(selected) + 1:
        raise ValueError("Fusing changed other solids. The previous geometry was retained.")


def prepare(gmsh, operation):
    model, occ = gmsh.model, gmsh.model.occ
    kind = operation.get("kind")
    volumes = model.getEntities(3)
    if not volumes:
        raise ValueError("CAD preparation requires closed solid volumes.")
    original_mass = sum(safe_mass(gmsh, 3, tag) for _, tag in volumes)
    if kind == "defeature":
        faces = operation.get("faceIds", [])
        if not isinstance(faces, list) or not faces or any(type(t) is not int or (2, t) not in model.getEntities(2) for t in faces):
            raise ValueError("Select existing CAD faces to remove. Include all faces of the hole, boss or fillet.")
        before = sum(safe_mass(gmsh, 3, t) for _, t in volumes)
        result = occ.defeature([tag for _, tag in volumes], faces, removeVolume=True)
        occ.synchronize()
        after = sum(safe_mass(gmsh, 3, t) for _, t in model.getEntities(3))
        if not result or abs(after - before) < max(before, 1) * 1e-10:
            raise ValueError("Removing these faces did not change the solid. Select the complete feature, including blind-hole caps.")
    elif kind == "heal":
        import tempfile
        from collections import Counter

        def signature(path):
            # Entity tags and BREP reference ordering can change on a clean heal.
            # Compare geometry/incidence independently of numbering, while keeping
            # tolerances and shape flags so actual representation repairs count.
            gmsh.write(str(path))
            lines = path.read_text().splitlines()
            tolerances, flags = [], []
            for index, line in enumerate(lines):
                token = line.strip()
                if token in {"Ve", "Ed", "Fa"} and index + 1 < len(lines):
                    values = lines[index + 1].split()
                    try:
                        tolerances.append((token, float(values[1 if token == "Fa" else 0])))
                    except (ValueError, IndexError):
                        pass
                if len(token) == 7 and set(token) <= {"0", "1"}:
                    flags.append(token)
            entities = []
            for dimension in range(4):
                for _, tag in model.getEntities(dimension):
                    upper, lower = model.getAdjacencies(dimension, tag)
                    bounds = tuple(float(f"{value:.12g}") for value in model.getBoundingBox(dimension, tag))
                    entities.append((dimension, model.getType(dimension, tag), bounds,
                                     float(f"{safe_mass(gmsh, dimension, tag):.12g}"), len(upper), len(lower)))
            return Counter(entities), Counter(tolerances), Counter(flags)

        with tempfile.TemporaryDirectory(prefix="webmesh-heal-check-") as temporary:
            before_signature = signature(Path(temporary) / "before.brep")
            occ.healShapes(volumes, tolerance=1e-7, fixDegenerated=True, fixSmallEdges=True,
                           fixSmallFaces=True, sewFaces=True, makeSolids=True)
            occ.synchronize()
            healed_mass = sum(safe_mass(gmsh, 3, tag) for _, tag in model.getEntities(3))
            tolerance = max(original_mass * 1e-6, 1e-8)
            if abs(healed_mass - original_mass) > tolerance:
                raise ValueError(f"Healing would change solid material volume by {healed_mass - original_mass:g}, beyond tolerance {tolerance:g}. The previous CAD was retained; use explicit defeaturing to remove features.")
            if signature(Path(temporary) / "after.brep") == before_signature:
                raise ValueError("Healing found no geometry, topology, or tolerance repairs to make. The previous CAD was retained.")
    elif kind in {"passage", "passages"}:
        rectangular_passages(gmsh, operation, volumes)
    elif kind == "project":
        axis = operation.get("axis")
        selected = operation.get("faceIds", [])
        if axis not in ("x", "y", "z") or not isinstance(selected, list) or not selected:
            raise ValueError("Project partition requires an axis and one or more selected planar faces.")
        coordinate = "xyz".index(axis)
        bounds = model.getBoundingBox(-1, -1)
        span = max(bounds[i + 3] - bounds[i] for i in range(3))
        tolerance, padding = max(span * 1e-6, 1e-7), max(span * 0.1, 1)
        tools = []
        for face in selected:
            if type(face) is not int or (2, face) not in model.getEntities(2) or model.getType(2, face) != "Plane":
                raise ValueError("Choose existing planar CAD faces for projection partitioning.")
            face_bounds = model.getBoundingBox(2, face)
            if face_bounds[coordinate + 3] - face_bounds[coordinate] > tolerance:
                raise ValueError("Each selected face must be perpendicular to the projection axis.")
            copy = occ.copy([(2, face)])
            center = occ.getCenterOfMass(2, face)[coordinate]
            offset = [0.0] * 3
            offset[coordinate] = bounds[coordinate] - padding - center
            occ.translate(copy, *offset)
            direction = [0.0] * 3
            direction[coordinate] = bounds[coordinate + 3] - bounds[coordinate] + 2 * padding
            tools.extend(entity for entity in occ.extrude(copy, *direction) if entity[0] == 3)
        result, mapping = occ.fragment(volumes, tools, removeObject=True, removeTool=True)
        occ.synchronize()
        keep = {tuple(entity) for group in mapping[:len(volumes)] for entity in group if entity[0] == 3}
        discard = [entity for entity in result if entity[0] == 3 and tuple(entity) not in keep]
        if discard:
            occ.remove(discard, recursive=True)
        occ.synchronize()
        for dimension in (2, 1, 0):
            loose = [entity for entity in model.getEntities(dimension) if not len(model.getAdjacencies(*entity)[0])]
            if loose:
                occ.remove(loose, recursive=True)
                occ.synchronize()
        if len(model.getEntities(3)) <= len(volumes):
            raise ValueError("The projected faces did not partition a solid. Choose an internal ledge or pocket floor.")
    elif kind == "split":
        axis = operation.get("axis")
        position = operation.get("position")
        if axis not in ("x", "y", "z") or type(position) not in (int, float) or not math.isfinite(position):
            raise ValueError("Split requires an X, Y or Z plane and a finite coordinate.")
        bounds = model.getBoundingBox(-1, -1)
        index = "xyz".index(axis)
        if not bounds[index] + 1e-7 < position < bounds[index + 3] - 1e-7:
            raise ValueError("The split plane must pass inside the CAD bounds.")
        varying = [i for i in range(3) if i != index]
        padding = max(bounds[i + 3] - bounds[i] for i in range(3)) * 0.1 + 1
        corners = []
        for a, b in ((0, 0), (1, 0), (1, 1), (0, 1)):
            point = [0.0] * 3
            point[index] = position
            for coordinate, high in zip(varying, (a, b)):
                point[coordinate] = bounds[coordinate + (3 if high else 0)] + (padding if high else -padding)
            corners.append(occ.addPoint(*point))
        lines = [occ.addLine(corners[i], corners[(i + 1) % 4]) for i in range(4)]
        plane = occ.addPlaneSurface([occ.addCurveLoop(lines)])
        selected = operation.get("volumeIds", [])
        if not isinstance(selected, list) or any(type(tag) is not int or (3, tag) not in volumes for tag in selected):
            raise ValueError("Choose existing solid volume IDs for the split, or leave the selection empty for all volumes.")
        objects = [(3, tag) for tag in selected] if selected else volumes
        before = len(volumes)
        occ.fragment(objects, [(2, plane)], removeObject=True, removeTool=True)
        occ.synchronize()
        if selected:
            # Imprint the new interfaces on adjacent unsplit solids. Their volume
            # stays intact, but shared topology must reflect the split faces.
            occ.fragment(model.getEntities(3), [], removeObject=True, removeTool=True)
            occ.synchronize()
        for entity in list(model.getEntities(2)):
            if not len(model.getAdjacencies(*entity)[0]):
                occ.remove([entity], recursive=True)
        occ.synchronize()
        if len(model.getEntities(3)) <= before:
            raise ValueError("The plane did not split a solid. Choose a coordinate through the material.")
    elif kind == "slice":
        slice_solids(gmsh, operation, volumes)
    elif kind == "fuse":
        fuse_solids(gmsh, operation, volumes)
    else:
        raise ValueError("Unknown preparation operation. Choose slice, fuse, split, project, passages, defeature, or heal.")
    if not model.getEntities(3) or any(safe_mass(gmsh, 3, t) <= 0 for _, t in model.getEntities(3)):
        raise ValueError("The operation did not produce valid positive-volume CAD solids.")
    if kind in {"split", "project", "slice", "fuse"}:
        final_mass = sum(safe_mass(gmsh, 3, tag) for _, tag in model.getEntities(3))
        if abs(final_mass - original_mass) > max(original_mass * 1e-7, 1e-8):
            raise ValueError("The split changed the solid volume beyond CAD tolerance. The previous geometry was retained.")


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
    # Sweep implementation is intentionally separate from preparation: source CAD
    # equivalence is checked before generating any extrusion-based mesh.
    from cad_sweep import generate
    return generate(gmsh, request, topology, mesh_quality)


def read_cache(path):
    """Per-entity results of the previous revision; a missing or bad cache is just a miss."""
    if not path:
        return None
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return None


def write_cache(path, cache):
    try:
        Path(path).write_text(json.dumps(cache, allow_nan=False, separators=(",", ":")))
    except (OSError, ValueError):
        Path(path).unlink(missing_ok=True)


def execute(request):
    gmsh = gmsh_module()
    gmsh.initialize(["webmesh-cad", "-nopopup"], readConfigFiles=False, interruptible=False)
    gmsh.option.setNumber("General.Terminal", 0)
    gmsh.option.setNumber("General.NumThreads", 1)
    gmsh.logger.start()
    try:
        discrete = Path(request["input"]).suffix.lower() in {".stl", ".msh"}
        if discrete:
            gmsh.merge(request["input"])
        else:
            gmsh.model.occ.importShapes(request["input"])
            gmsh.model.occ.synchronize()
        action = request["action"]
        if action == "prepare":
            if discrete:
                raise ValueError("STL is a discrete surface mesh. Split and defeature require editable STEP, IGES, or BREP geometry.")
            prepare(gmsh, request["operation"])
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
        else:
            if discrete:
                gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
                gmsh.option.setNumber("Mesh.Binary", 0)
            gmsh.write(request["output"])
            # BREP serialization assigns fresh entity tags on import. Preview the
            # exact canonical snapshot that the next worker will load.
            gmsh.clear()
            if discrete:
                gmsh.merge(request["output"])
            else:
                gmsh.model.occ.importShapes(request["output"])
                gmsh.model.occ.synchronize()
            data = topology(gmsh)
            data["discrete"] = discrete
            cache = keys = out = None
            if not discrete:
                from cad_mapping import augment
                cache = read_cache(request.get("cache"))
                augment(gmsh, data, cache)
                keys, out = data.pop("_signatures"), data.pop("_cache")
            if request.get("early") and not discrete:
                # Lite preview: report the topology first, then finish the
                # display tessellation that committing this result needs.
                edges = edge_polylines(gmsh, data)
                write_early(request["early"], {"topology": data, "preview": {"lite": True, "edges": edges},
                                               "log": "\n".join(gmsh.logger.get())[-24_000:]})
                result = {"topology": data, "preview": preview(gmsh, data, edges, cache, keys, out)}
            else:
                result = {"topology": data, "preview": preview(gmsh, data, None, cache, keys, out)}
            if out is not None and request.get("cacheOut"):
                write_cache(request["cacheOut"], out)
        result["log"] = "\n".join(gmsh.logger.get())[-24_000:]
        return result
    finally:
        gmsh.finalize()


def main(request_path=None):
    request = json.loads(Path(request_path or sys.argv[1]).read_text())
    try:
        result = execute(request)
    except Exception as error:
        result = {"error": str(error)}
    Path("worker-result.json").write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))


def serve():
    """A worker started ahead of time: libraries are loaded before the task
    exists. It reads one request path from stdin, runs it in that task's
    directory with output to its log, and exits like a cold worker would."""
    sources = [Path(__file__), Path(__file__).with_name("cad_mapping.py")]
    stamps = [path.stat().st_mtime for path in sources]
    gmsh_module()
    import cad_mapping  # noqa: F401  (loads numpy too)
    line = sys.stdin.readline().strip()
    if not line:
        return
    request_path = Path(line)
    os.chdir(request_path.parent)
    log = os.open(request_path.parent / "gmsh.log", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    os.dup2(log, 1)
    os.dup2(log, 2)
    if [path.stat().st_mtime for path in sources] != stamps:
        # The kernel changed on disk while this worker waited: run the new code.
        os.execv(sys.executable, [sys.executable, str(Path(__file__)), str(request_path)])
    main(request_path)


if __name__ == "__main__":
    if sys.argv[1:] == ["--serve"]:
        serve()
    else:
        main()
