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


def safe_mass(gmsh, dimension, tag):
    try:
        if (dimension, tag) not in gmsh.model.occ.getEntities(dimension):
            return 0.0
        return float(gmsh.model.occ.getMass(dimension, tag))
    except Exception:
        return 0.0


def topology(gmsh):
    model = gmsh.model
    faces, edges, volumes = [], [], []
    for _, tag in model.getEntities(2):
        bounds = list(map(float, model.getBoundingBox(2, tag)))
        native = (2, tag) in model.occ.getEntities(2)
        try:
            if not native:
                raise ValueError("Discrete geometry has no CAD center of mass")
            center = list(map(float, model.occ.getCenterOfMass(2, tag)))
        except Exception:
            center = [(bounds[i] + bounds[i + 3]) / 2 for i in range(3)]
        face = {"id": tag, "type": model.getType(2, tag), "area": safe_mass(gmsh, 2, tag),
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
        edges.append({"id": tag, "type": model.getType(1, tag), "length": safe_mass(gmsh, 1, tag),
                      "bounds": list(map(float, model.getBoundingBox(1, tag))),
                      "faces": list(map(int, model.getAdjacencies(1, tag)[0]))})
    by_face = {face["id"]: face for face in faces}
    for _, tag in model.getEntities(3):
        boundary = [abs(int(t)) for _, t in model.getBoundary([(3, tag)], oriented=False)]
        volumes.append({"id": tag, "volume": safe_mass(gmsh, 3, tag), "faces": boundary,
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


def preview(gmsh, data):
    model = gmsh.model
    bounds = data["bounds"]
    diagonal = math.sqrt(sum((bounds[i + 3] - bounds[i]) ** 2 for i in range(3)))
    size = max(diagonal / 24, 1e-5)
    gmsh.option.setNumber("Mesh.MeshSizeMin", size)
    gmsh.option.setNumber("Mesh.MeshSizeMax", size)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 48)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    if not data.get("discrete"):
        model.mesh.generate(2)
    node_ids, coordinates, _ = model.mesh.getNodes()
    nodes = {int(nid): list(map(float, coordinates[3 * i:3 * i + 3])) for i, nid in enumerate(node_ids)}
    positions, face_ids = [], []
    for _, tag in model.getEntities(2):
        types, _, connectivity = model.mesh.getElements(2, tag)
        for element_type, node_list in zip(types, connectivity):
            if element_type != 2:
                raise ValueError("CAD preview returned unexpected non-triangle elements.")
            for i in range(0, len(node_list), 3):
                for nid in node_list[i:i + 3]:
                    positions.extend(nodes[int(nid)])
                face_ids.append(tag)
    if len(face_ids) > 250_000:
        raise ValueError("CAD preview exceeds 250,000 triangles. Simplify the geometry first.")
    edges = []
    for edge in data["edges"]:
        tag = edge["id"]
        try:
            lower, upper = model.getParametrizationBounds(1, tag)
            start, end = float(lower[0]), float(upper[0])
            count = 2 if edge["type"] == "Line" else 65
            parameters = [start + (end - start) * i / (count - 1) for i in range(count)]
            points = list(map(float, model.getValue(1, tag, parameters)))
            edges.append({"id": tag, "points": points})
        except Exception:
            pass
    if not data.get("discrete"):
        model.mesh.clear()
    return {"positions": positions, "triangleFaceIds": face_ids, "edges": edges, "faces": data["faces"]}


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
        boxes.append((coordinate, corner, size))
    if faces:
        result = occ.defeature([tag for _, tag in volumes], faces, removeVolume=True)
        occ.synchronize()
        if not result:
            raise ValueError("The selected feature faces could not be replaced before cutting the passages.")
        volumes = model.getEntities(3)
    mass = sum(safe_mass(gmsh, 3, tag) for _, tag in volumes)
    tolerance = max(mass * 1e-9, 1e-8)
    tools = []
    for coordinate, corner, size in boxes:
        tool = (3, occ.addBox(*corner, *size))
        # Each cut must cross material and both ends must finish in free space.
        # This rejects blind pockets and accidentally truncated through ranges.
        intersection, _ = occ.intersect(occ.copy(volumes), occ.copy([tool]))
        removed = sum(occ.getMass(dimension, tag) for dimension, tag in intersection if dimension == 3)
        if intersection:
            occ.remove(intersection, recursive=True)
        if removed <= tolerance:
            raise ValueError("A rectangular passage does not intersect material. Review its center and dimensions.")
        thickness = max(span * 1e-7, 1e-7)
        for end in (0, 1):
            cap_corner, cap_size = list(corner), list(size)
            cap_corner[coordinate] += (size[coordinate] - 2 * thickness) if end else thickness
            cap_size[coordinate] = thickness
            cap = (3, occ.addBox(*cap_corner, *cap_size))
            overlap, _ = occ.intersect(occ.copy(volumes), [cap])
            cap_mass = sum(occ.getMass(dimension, tag) for dimension, tag in overlap if dimension == 3)
            if overlap:
                occ.remove(overlap, recursive=True)
            if cap_mass > max(tolerance * 0.001, thickness * size[(coordinate + 1) % 3] * size[(coordinate + 2) % 3] * 1e-4):
                raise ValueError("Both passage range endpoints must finish in free space; extend the range through the wall.")
        tools.append(tool)
    result, mapping = occ.cut(volumes, tools, removeObject=True, removeTool=True)
    occ.synchronize()
    solids = [entity for entity in result if entity[0] == 3]
    if not solids or any(len([entity for entity in group if entity[0] == 3]) != 1 for group in mapping[:len(volumes)]):
        raise ValueError("The passages would sever a solid or remove it completely. Reduce the opening to preserve its ligaments.")
    final_mass = sum(safe_mass(gmsh, 3, tag) for _, tag in solids)
    if final_mass >= mass - tolerance:
        raise ValueError("The passage cuts did not remove material.")


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
    else:
        raise ValueError("Unknown preparation operation. Choose split, project, passages, defeature, or heal.")
    if not model.getEntities(3) or any(safe_mass(gmsh, 3, t) <= 0 for _, t in model.getEntities(3)):
        raise ValueError("The operation did not produce valid positive-volume CAD solids.")
    if kind in {"split", "project"}:
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
            result = {"topology": data, "preview": preview(gmsh, data)}
        result["log"] = "\n".join(gmsh.logger.get())[-24_000:]
        return result
    finally:
        gmsh.finalize()


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    try:
        result = execute(request)
    except Exception as error:
        result = {"error": str(error)}
    Path("worker-result.json").write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
