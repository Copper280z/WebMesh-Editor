"""Sheets: free faces that stand for thin walls (midsurfaces and offset shells).

A sheet record is {"face", "sheet", "thickness", "offset", "label"}: the face,
the sheet it belongs to (a sheet can be several faces once joined or
extended), the wall thickness its shell property gets (None when unknown, as
for a surface model imported from a file), and the element offset (ZOFFS):
the distance from the face to the middle of the wall, along the face normal.

Records follow their faces by centre of mass and area: tags change when a
snapshot is written and read back, and when an operation renumbers entities.
Solid operations leave sheets alone (see `protected` and `is_sheet`).
"""

import math
from types import SimpleNamespace

import numpy as np

OPERATIONS = {"surface", "extend", "join", "split-sheets", "sheet"}
# Signatures of the sheets of the model being worked on: solid operations keep these faces.
protected = []


def _span(geom):
    b = geom.model.getBoundingBox(-1, -1)
    return max(math.sqrt(sum((b[i + 3] - b[i]) ** 2 for i in range(3))), 1e-9)


def _loose(geom):
    return {int(tag) for _, tag in geom.model.getEntities(2) if not len(geom.model.getAdjacencies(2, tag)[0])}


def signature(geom, face):
    return np.array(geom.model.occ.getCenterOfMass(2, face), dtype=float), float(geom.model.occ.getMass(2, face))


def _same(a, b, tolerance):
    return float(np.linalg.norm(a[0] - b[0])) <= tolerance and abs(a[1] - b[1]) <= max(abs(b[1]), 1.0) * 1e-6


def capture(geom, records):
    """Each record with its face's signature, to find the face again later."""
    return [(dict(record), signature(geom, record["face"])) for record in records]


def rematch(geom, captured):
    """The records with their faces' current tags; a record whose face is gone is dropped."""
    tolerance = _span(geom) * 1e-6 * 10
    free = {face: signature(geom, face) for face in _loose(geom)}
    out, taken = [], set()
    for record, old in captured:
        match = next((face for face, now in free.items() if face not in taken and _same(now, old, tolerance)), None)
        if match is not None:
            taken.add(match)
            out.append({**record, "face": match})
    return out


def protect(geom, records):
    protected[:] = [signature(geom, r["face"]) for r in records]


def is_sheet(geom, face):
    """True for a free face that is one of the protected sheets."""
    if not protected or len(geom.model.getAdjacencies(2, face)[0]):
        return False
    tolerance = _span(geom) * 1e-6 * 10
    try:
        now = signature(geom, face)
    except Exception:
        return False
    return any(_same(now, old, tolerance) for old in protected)


def clean(geom, raw):
    """Sheet records sent with a request, keeping those whose face is a free face of this model."""
    if raw is None:
        return None
    if not isinstance(raw, list) or len(raw) > 10_000:
        raise ValueError("Sheets must be a list of face records.")
    free, out = _loose(geom), []
    for item in raw:
        if not isinstance(item, dict) or type(item.get("face")) is not int or type(item.get("sheet")) is not int or item["sheet"] < 1:
            raise ValueError("Each sheet names its face and sheet number.")
        thickness, offset = item.get("thickness"), item.get("offset", 0)
        if thickness is not None and (isinstance(thickness, bool) or not isinstance(thickness, (int, float)) or not math.isfinite(thickness) or thickness <= 0):
            raise ValueError("A sheet thickness must be positive.")
        if isinstance(offset, bool) or not isinstance(offset, (int, float)) or not math.isfinite(offset):
            raise ValueError("A sheet offset must be finite.")
        if item["face"] in free:
            label = item.get("label")
            out.append({"face": item["face"], "sheet": item["sheet"], "thickness": None if thickness is None else float(thickness),
                        "offset": float(offset), "label": label[:160] if isinstance(label, str) else f"Sheet {item['sheet']}"})
    return out


def discovered(geom, open_cut, step):
    """Sheets of an imported file: its free faces, except the open cuts preparation leaves inside solids."""
    out = []
    for face in sorted(_loose(geom)):
        cut = open_cut(geom, face, step)
        if cut and cut[1]:
            continue
        out.append({"face": face, "sheet": len(out) + 1, "thickness": None, "offset": 0.0, "label": f"Imported surface {len(out) + 1}"})
    return out


def surface(geom, face):
    """The face's analytic surface, fitted from its shape (see cad_mapping)."""
    from cad_mapping import _surface
    return _surface(SimpleNamespace(model=geom.model, span=_span(geom)), face, geom.model.getType(2, face))


def _sample(geom, face):
    model = geom.model
    lower, upper = model.getParametrizationBounds(2, face)
    for a in (0.5, 0.3, 0.7, 0.15, 0.85):
        for b in (0.5, 0.3, 0.7, 0.15, 0.85):
            uv = [lower[0] + (upper[0] - lower[0]) * a, lower[1] + (upper[1] - lower[1]) * b]
            if model.isInside(2, face, uv, parametric=True):
                normal = np.array(model.getNormal(face, uv), dtype=float)
                return np.array(model.getValue(2, face, uv), dtype=float), normal / (np.linalg.norm(normal) or 1.0)
    raise ValueError(f"Face {face} has no interior point to measure from.")


def _normal_at(geom, face, point):
    """The face's unit normal at the point of it nearest `point`."""
    uv = geom.model.getParametrization(2, face, list(point))
    normal = np.array(geom.model.getNormal(face, list(uv)), dtype=float)
    return normal / (np.linalg.norm(normal) or 1.0)


def _outward(geom, face, normal):
    """The face normal pointing out of the solid the face bounds: Gmsh's face normal already
    does (a sheet: its own normal)."""
    return normal


def _radial(axis, origin, point):
    """Unit vector from a cylinder's axis to a point, and the point's foot on the axis."""
    foot = origin + axis * float(np.dot(point - origin, axis))
    vector = point - foot
    return vector / (np.linalg.norm(vector) or 1.0), foot


def _scale_about_axis(geom, dimtags, origin, axis, factor):
    """Scale distances from an axis (a cylinder's radius) and keep positions along it."""
    p = np.outer(axis, axis)
    a = p + factor * (np.eye(3) - p)
    b = (1 - factor) * (np.eye(3) - p) @ origin
    geom.model.occ.affineTransform(dimtags, [*a[0], b[0], *a[1], b[1], *a[2], b[2]])


def _next_sheet(records):
    return max((r["sheet"] for r in records), default=0) + 1


def make_surface(geom, operation, records):
    """A sheet between two faces (Midway, or on either one) or from one face (offset, with a thickness)."""
    model, occ = geom.model, geom.model.occ
    faces = operation.get("faces")
    existing = {int(tag) for _, tag in model.getEntities(2)}
    if not isinstance(faces, list) or len(faces) not in (1, 2) or any(type(f) is not int or f not in existing for f in faces) or len(set(faces)) != len(faces):
        raise ValueError("Pick two faces for a midsurface, or one face to copy or offset.")
    tolerance = _span(geom) * 1e-6
    place = operation.get("place", "mid" if len(faces) == 2 else "offset")
    kinds = [surface(geom, f) for f in faces]
    if len(faces) == 2:
        if place not in ("mid", "first", "second"):
            raise ValueError("Place a midsurface midway, on the first face or on the second.")
        (a, b), (sa, sb) = faces, kinds
        if sa["kind"] == sb["kind"] == "plane":
            na, oa, ob = np.array(sa["normal"]), np.array(sa["origin"]), np.array(sb["origin"])
            if abs(abs(float(np.dot(na, sb["normal"]))) - 1) > 1e-6:
                raise ValueError(f"Faces {a} and {b} are not parallel.")
            gap = float(np.dot(ob - oa, na))
            if abs(gap) <= tolerance:
                raise ValueError(f"Faces {a} and {b} lie in the same plane.")
            thickness = abs(gap)
            middle = lambda point: point - na * float(np.dot(point - (oa + na * gap / 2), na))  # noqa: E731
            move = lambda dimtags: occ.translate(dimtags, *(na * gap / 2))  # noqa: E731
        elif sa["kind"] == sb["kind"] == "cylinder":
            axis, oa = np.array(sa["axis"]), np.array(sa["origin"])
            ob = np.array(sb["origin"])
            off = (ob - oa) - axis * float(np.dot(ob - oa, axis))
            if abs(abs(float(np.dot(axis, sb["axis"]))) - 1) > 1e-6 or float(np.linalg.norm(off)) > tolerance * 10:
                raise ValueError(f"Faces {a} and {b} are cylinders on different axes.")
            ra, rb = float(sa["radius"]), float(sb["radius"])
            if abs(ra - rb) <= tolerance:
                raise ValueError(f"Faces {a} and {b} are the same cylinder.")
            thickness, rm = abs(ra - rb), (ra + rb) / 2
            middle = lambda point: _radial(axis, oa, point)[1] + rm * _radial(axis, oa, point)[0]  # noqa: E731
            move = lambda dimtags: _scale_about_axis(geom, dimtags, oa, axis, rm / ra)  # noqa: E731
        elif sa["kind"] == sb["kind"] == "sphere":
            ca, cb = np.array(sa["center"]), np.array(sb["center"])
            if float(np.linalg.norm(ca - cb)) > tolerance * 10:
                raise ValueError(f"Faces {a} and {b} are spheres with different centres.")
            ra, rb = float(sa["radius"]), float(sb["radius"])
            if abs(ra - rb) <= tolerance:
                raise ValueError(f"Faces {a} and {b} are the same sphere.")
            thickness, rm = abs(ra - rb), (ra + rb) / 2
            middle = lambda point: ca + rm * (point - ca) / (np.linalg.norm(point - ca) or 1.0)  # noqa: E731
            move = lambda dimtags: occ.dilate(dimtags, *ca, rm / ra, rm / ra, rm / ra)  # noqa: E731
        else:
            raise ValueError(f"A midsurface needs two parallel flat faces, two coaxial cylinders or two concentric spheres; faces {a} and {b} are a {sa['kind']} and a {sb['kind']}.")
        base = b if place == "second" else a
        copy = occ.copy([(2, base)])
        if place == "mid":
            move(copy)
        default = {"mid": f"Midsurface of faces {a} and {b}", "first": f"Surface on face {a}", "second": f"Surface on face {b}"}[place]
    else:
        (a,), (sa,) = faces, kinds
        offset = operation.get("offset", 0)
        thickness = operation.get("thickness")
        if isinstance(offset, bool) or not isinstance(offset, (int, float)) or not math.isfinite(offset):
            raise ValueError("Enter a finite offset.")
        if thickness is not None and (isinstance(thickness, bool) or not isinstance(thickness, (int, float)) or not math.isfinite(thickness) or thickness <= 0):
            raise ValueError("Enter a positive thickness, or leave it unknown.")
        point, normal = _sample(geom, a)
        out = _outward(geom, a, normal)
        copy = occ.copy([(2, a)])
        if offset:
            if sa["kind"] == "plane":
                occ.translate(copy, *(out * offset))
            elif sa["kind"] == "cylinder":
                axis, origin = np.array(sa["axis"]), np.array(sa["origin"])
                u, _ = _radial(axis, origin, point)
                radius = float(sa["radius"]) + offset * float(np.dot(out, u))
                if radius <= tolerance:
                    raise ValueError("The offset would shrink the cylinder to nothing.")
                _scale_about_axis(geom, copy, origin, axis, radius / float(sa["radius"]))
            elif sa["kind"] == "sphere":
                center = np.array(sa["center"])
                radius = float(sa["radius"]) + offset * float(np.dot(out, (point - center) / (np.linalg.norm(point - center) or 1.0)))
                if radius <= tolerance:
                    raise ValueError("The offset would shrink the sphere to nothing.")
                occ.dilate(copy, *center, *([radius / float(sa["radius"])] * 3))
            else:
                raise ValueError(f"Face {a} is a {sa['kind']} surface: only flat faces, cylinders and spheres can be offset. Use an offset of 0 to copy it.")
        # The wall is taken to run `thickness` into the material from the picked face,
        # so its middle lies offset + thickness / 2 behind the sheet, against `out`.
        behind = None if not thickness else (offset + thickness / 2)
        middle = None
        default = f"Offset of face {a} by {offset:g}" if offset else f"Surface on face {a}"
    occ.synchronize()
    created = [int(tag) for dim, tag in copy if dim == 2]
    if len(created) != 1:
        raise ValueError("The surface could not be created.")
    face = created[0]
    if len(faces) == 1:
        # Along the copy's own normal: a free face keeps its surface's orientation, which
        # can be opposite to the one the face had in its solid.
        sheet_normal = _normal_at(geom, face, point + out * offset)
        zoffset = 0.0 if behind is None else -behind * float(np.sign(np.dot(out, sheet_normal)))
    else:
        point, normal = _sample(geom, face)
        zoffset = float(np.dot(middle(point) - point, normal))
    if abs(zoffset) < tolerance:
        zoffset = 0.0
    label = operation.get("label")
    records.append({"face": face, "sheet": _next_sheet(records), "thickness": None if thickness is None else float(thickness),
                    "offset": zoffset, "label": label[:160] if isinstance(label, str) and label.strip() else default})
    return records


def _line_ends(geom, edge):
    model = geom.model
    lower, upper = model.getParametrizationBounds(1, edge)
    points = np.array(model.getValue(1, edge, [lower[0], (lower[0] + upper[0]) / 2, upper[0]]), dtype=float).reshape(3, 3)
    chord = points[2] - points[0]
    length = float(np.linalg.norm(chord))
    if length <= 0 or float(np.linalg.norm(np.cross(points[1] - points[0], chord))) / length > length * 1e-6:
        return None
    return points[0], points[2]


def _inside_flat(geom, face, point, normal):
    """Whether a point in a flat face's plane lies inside the face (holes excluded), by
    counting crossings of the face's sampled edges: Gmsh's parametric test can say
    inside for points well outside a copied face."""
    model = geom.model
    u = np.cross(normal, np.eye(3)[int(np.argmin(np.abs(normal)))])
    u /= np.linalg.norm(u)
    w = np.cross(normal, u)
    qx, qy = float(point @ u), float(point @ w)
    crossings = 0
    for _, tag in model.getBoundary([(2, face)], oriented=False):
        edge = abs(int(tag))
        lower, upper = model.getParametrizationBounds(1, edge)
        samples = np.array(model.getValue(1, edge, list(np.linspace(lower[0], upper[0], 33))), dtype=float).reshape(-1, 3)
        xy = np.column_stack([samples @ u, samples @ w])
        for (x0, y0), (x1, y1) in zip(xy[:-1], xy[1:]):
            if (y0 > qy) != (y1 > qy) and qx < x0 + (qy - y0) * (x1 - x0) / (y1 - y0):
                crossings += 1
    return crossings % 2 == 1


def extend(geom, operation, records):
    """Extend straight edges of flat sheets, in their own plane, until they meet a flat target face."""
    model, occ = geom.model, geom.model.occ
    edges, target = operation.get("edges"), operation.get("target")
    sheet_faces = {r["face"]: r for r in records}
    if type(target) is not int or (2, target) not in model.getEntities(2):
        raise ValueError("Pick the face to extend to.")
    if not isinstance(edges, list) or not edges or any(type(e) is not int or (1, e) not in model.getEntities(1) for e in edges):
        raise ValueError("Pick sheet edges to extend.")
    goal = surface(geom, target)
    if goal["kind"] != "plane":
        raise ValueError(f"Face {target} is not flat: edges extend to flat faces only, for now.")
    ot, nt = np.array(goal["origin"]), np.array(goal["normal"])
    tolerance = _span(geom) * 1e-6
    strips = {}
    for edge in edges:
        owners = [int(f) for f in model.getAdjacencies(1, edge)[0] if int(f) in sheet_faces]
        if len(owners) != 1:
            raise ValueError(f"Edge {edge} is not a free edge of one sheet.")
        face = owners[0]
        if face == target:
            raise ValueError("An edge cannot be extended to its own face.")
        own = surface(geom, face)
        ends = _line_ends(geom, edge)
        if own["kind"] != "plane" or ends is None:
            raise ValueError(f"Edge {edge} is not a straight edge of a flat sheet.")
        p0, p1 = ends
        ns = np.array(own["normal"])
        tangent = (p1 - p0) / np.linalg.norm(p1 - p0)
        direction = np.cross(ns, tangent)
        middle = (p0 + p1) / 2
        probe = middle + direction * max(tolerance * 1e3, float(np.linalg.norm(p1 - p0)) * 1e-3)
        if _inside_flat(geom, face, probe, ns):
            direction = -direction
        along = float(np.dot(direction, nt))
        if abs(along) < 1e-9:
            raise ValueError(f"Edge {edge} runs parallel to face {target}: it never meets it.")
        reach = [float(np.dot(ot - p, nt)) / along for p in (p0, p1)]
        if max(reach) <= tolerance:
            if min(reach) < -tolerance:
                raise ValueError(f"Face {target} lies behind edge {edge}: pick a face it can grow toward.")
            continue  # it already meets the face
        if min(reach) < -tolerance:
            raise ValueError(f"Edge {edge} crosses face {target}; extend it to a face beyond its end.")
        corners = [p0, p1, p1 + direction * max(reach[1], 0), p0 + direction * max(reach[0], 0)]
        if float(np.dot(np.cross(p1 - p0, direction), ns)) < 0:
            # The strip faces the way the sheet does: faces of opposite sense are not merged into one.
            corners = corners[::-1]
        points = [occ.addPoint(*c) for c in corners]
        lines = [occ.addLine(points[i], points[(i + 1) % 4]) for i in range(4) if np.linalg.norm(corners[i] - corners[(i + 1) % 4]) > tolerance]
        strips.setdefault(face, []).append((2, occ.addPlaneSurface([occ.addCurveLoop(lines)])))
    if not strips:
        raise ValueError("Those edges already meet the face.")
    kept = [r for r in records if r["face"] not in strips]
    for face, tools in strips.items():
        record = sheet_faces[face]
        _, mapping = occ.fuse([(2, face)], tools)
        occ.synchronize()
        grown = {int(tag) for group in mapping for dim, tag in group if dim == 2}
        kept.extend({**record, "face": f} for f in sorted(grown))
    records[:] = kept
    return records


def join(geom, operation, records):
    """Fuse sheets where they meet, so every junction becomes an edge they share."""
    occ = geom.model.occ
    chosen = operation.get("faces")
    faces = [r["face"] for r in records] if not chosen else chosen
    if not isinstance(faces, list) or any(type(f) is not int for f in faces) or not set(faces) <= {r["face"] for r in records}:
        raise ValueError("Join works on sheets: pick sheet faces, or none for all of them.")
    if len(set(faces)) < 2:
        raise ValueError("Join needs at least two sheet faces.")
    by_face = {r["face"]: r for r in records}
    order = sorted(set(faces))
    _, mapping = occ.fragment([(2, order[0])], [(2, f) for f in order[1:]])
    occ.synchronize()
    out, seen = [r for r in records if r["face"] not in by_face or r["face"] not in order], set()
    for face, group in zip(order, mapping):
        for dim, tag in group:
            if dim == 2 and int(tag) not in seen:
                seen.add(int(tag))
                out.append({**by_face[face], "face": int(tag)})
    records[:] = out
    return records


def _drop(geom, faces):
    """Remove faces, then the edges and points no other face uses."""
    model, occ = geom.model, geom.model.occ
    boundary = {abs(int(t)) for f in faces for _, t in model.getBoundary([(2, f)], oriented=False)}
    occ.remove([(2, f) for f in faces])
    occ.synchronize()
    loose = [(1, e) for e in boundary if (1, e) in model.getEntities(1) and not len(model.getAdjacencies(1, e)[0])]
    if loose:
        occ.remove(loose, recursive=True)
        occ.synchronize()


def split(geom, operation, records):
    """Split sheets along a plane: each sheet face it crosses becomes pieces that share
    the cut as an edge, a control curve the mesh follows (where a brace meets a floor)."""
    model, occ = geom.model, geom.model.occ
    plane = operation.get("plane")
    if not isinstance(plane, dict):
        raise ValueError("Split needs a plane: an origin and a normal.")
    origin = np.array(plane.get("origin", []), dtype=float)
    normal = np.array(plane.get("normal", []), dtype=float)
    if origin.shape != (3,) or normal.shape != (3,) or not np.all(np.isfinite(origin)) or not np.all(np.isfinite(normal)) or np.linalg.norm(normal) == 0:
        raise ValueError("Split needs a plane: an origin and a normal.")
    normal /= np.linalg.norm(normal)
    by_face = {r["face"]: r for r in records}
    chosen = operation.get("faces") or list(by_face)
    if not isinstance(chosen, list) or any(type(f) is not int or f not in by_face for f in chosen):
        raise ValueError("Split works on sheets: pick sheet faces, or none for all of them.")
    tolerance = _span(geom) * 1e-6
    targets = []
    for face in sorted(set(chosen)):
        # A sheet lying in the plane is not split by it.
        own = surface(geom, face)
        if own["kind"] == "plane" and abs(abs(float(np.dot(own["normal"], normal))) - 1) < 1e-9 and abs(float(np.dot(np.array(own["origin"]) - origin, normal))) < tolerance:
            continue
        b = model.getBoundingBox(2, face)
        corners = np.array([[x, y, z] for x in (b[0], b[3]) for y in (b[1], b[4]) for z in (b[2], b[5])])
        side = (corners - origin) @ normal
        if side.min() < -tolerance and side.max() > tolerance:
            targets.append(face)
    if not targets:
        raise ValueError("The plane does not cross those sheets.")
    # A square in the plane, larger than the model.
    b = model.getBoundingBox(-1, -1)
    reach = math.sqrt(sum((b[i + 3] - b[i]) ** 2 for i in range(3))) + 1
    helper = np.eye(3)[int(np.argmin(np.abs(normal)))]
    u = np.cross(normal, helper)
    u /= np.linalg.norm(u)
    w = np.cross(normal, u)
    middle = np.array([(b[i] + b[i + 3]) / 2 for i in range(3)])
    middle -= normal * float(np.dot(middle - origin, normal))
    points = [occ.addPoint(*(middle + reach * (a * u + c * w))) for a, c in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    lines = [occ.addLine(points[i], points[(i + 1) % 4]) for i in range(4)]
    tool = occ.addPlaneSurface([occ.addCurveLoop(lines)])
    _, mapping = occ.fragment([(2, f) for f in targets], [(2, tool)])
    occ.synchronize()
    pieces = {face: [int(t) for d, t in group if d == 2] for face, group in zip(targets, mapping[:len(targets)])}
    kept = {t for group in pieces.values() for t in group}
    leftovers = [int(t) for d, t in mapping[len(targets)] if d == 2 and int(t) not in kept]
    if leftovers:
        _drop(geom, leftovers)
    out = [r for r in records if r["face"] not in pieces]
    for face, group in pieces.items():
        out.extend({**by_face[face], "face": t} for t in group)
    if len(out) == len(records):
        raise ValueError("The plane does not cross those sheets.")
    records[:] = out
    return records


def edit(geom, operation, records):
    """Change a sheet's thickness, offset or name, or remove it, or some of its faces
    (pieces a join split off, such as the overhang past a junction)."""
    model, occ = geom.model, geom.model.occ
    sheet = operation.get("sheet")
    mine = [r for r in records if r["sheet"] == sheet]
    if type(sheet) is not int or not mine:
        raise ValueError("Choose an existing sheet.")
    if operation.get("remove"):
        faces = operation.get("faces")
        if faces is not None:
            own = {r["face"] for r in mine}
            if not isinstance(faces, list) or not faces or any(type(f) is not int or f not in own for f in faces):
                raise ValueError(f"Pick faces of sheet {sheet} to remove.")
            mine = [r for r in mine if r["face"] in faces]
        _drop(geom, [r["face"] for r in mine])
        gone = {r["face"] for r in mine}
        records[:] = [r for r in records if r["face"] not in gone]
        return records
    changes = {}
    if "thickness" in operation:
        t = operation["thickness"]
        if t is not None and (isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t <= 0):
            raise ValueError("A sheet thickness must be positive.")
        changes["thickness"] = None if t is None else float(t)
    if "offset" in operation:
        z = operation["offset"]
        if isinstance(z, bool) or not isinstance(z, (int, float)) or not math.isfinite(z):
            raise ValueError("A sheet offset must be finite.")
        changes["offset"] = float(z)
    if isinstance(operation.get("name"), str) and operation["name"].strip():
        changes["label"] = operation["name"].strip()[:160]
    if not changes:
        raise ValueError("Give the sheet a new thickness, offset or name.")
    for r in mine:
        r.update(changes)
    return records


def apply(geom, operation, records):
    kind = operation.get("kind")
    return {"surface": make_surface, "extend": extend, "join": join, "split-sheets": split, "sheet": edit}[kind](geom, operation, records)
