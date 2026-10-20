"""Exact B-rep classification data for native mapped hex meshing.

The browser decides block structure, solves edge interval equations and builds
transfinite hex meshes itself. This module only supplies exact geometry facts
from the OpenCASCADE kernel: oriented face loops, interior corner angles,
per-solid dihedral angles and analytic surface/curve descriptors. It performs
geometry queries (evaluation, projection, point classification) and never
calls a Gmsh mesher. On analytic planes, which side of an edge a face or a
solid lies on follows from the kernel's orientations; other surfaces are
probed with points.
"""

import math

import numpy as np

CURVE_SAMPLES = 129


def unit(vector):
    vector = np.asarray(vector, dtype=float)
    length = float(np.linalg.norm(vector))
    return vector / length if length > 0 else vector


def _angle(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, float(np.dot(a, b))))))


class _Geometry:
    def __init__(self, gmsh, data):
        self.model = gmsh.model
        bounds = data["bounds"]
        self.span = max(max(bounds[i + 3] - bounds[i] for i in range(3)), 1e-9)
        self.tolerance = max(self.span * 1e-7, 1e-10)
        self.vertices = {}
        for _, tag in self.model.getEntities(0):
            self.vertices[int(tag)] = np.array(self.model.getValue(0, tag, []), dtype=float)
        self.edges = {}
        self.inverses = {}
        self.surface_kinds = {}
        self.types = {}
        self.frames = {}
        self.solid_senses = {}

    def nearest_vertex(self, point, candidates=None):
        best, distance = None, math.inf
        for tag in (candidates if candidates else self.vertices):
            if tag not in self.vertices:
                continue
            d = float(np.linalg.norm(self.vertices[tag] - point))
            if d < distance:
                best, distance = tag, d
        return best if distance <= max(self.span * 1e-6, 1e-8) else None

        self.inverses = {}

    def _inverse(self, face):
        """Analytic point inversion for planar and cylindrical parametrizations.

        OpenCASCADE point inversion is accurate but slow; planes and cylinders
        dominate prepared CAD, so their (u, v) maps are reconstructed from a few
        exact evaluations. Every inversion is verified by evaluating it again.
        """
        if face in self.inverses:
            return self.inverses[face]
        model, inverse = self.model, None
        try:
            kind = model.getType(2, face)
            # Extrusions of circles parametrize like cylinders; the fitted
            # descriptor (verified on samples) decides, not the type name.
            fitted = self.surface_kinds.get(face)
            if fitted == "plane":
                kind = "Plane"
            elif fitted == "cylinder":
                kind = "Cylinder"
            lower, upper = model.getParametrizationBounds(2, face)
            u0, v0 = float(lower[0]), float(lower[1])
            origin = np.array(model.getValue(2, face, [u0, v0]), dtype=float)
            if kind == "Plane":
                du = np.array(model.getValue(2, face, [u0 + 1, v0]), dtype=float) - origin
                dv = np.array(model.getValue(2, face, [u0, v0 + 1]), dtype=float) - origin
                matrix = np.array([[du @ du, du @ dv], [du @ dv, dv @ dv]])
                if abs(np.linalg.det(matrix)) > 1e-18:
                    solve = np.linalg.inv(matrix)
                    inverse = ("plane", origin, du, dv, solve, u0, v0)
            elif kind == "Cylinder":
                period = 2 * math.pi
                points = [np.array(model.getValue(2, face, [u0 + a, v0]), dtype=float) for a in (0, math.pi / 2, math.pi)]
                axis_step = np.array(model.getValue(2, face, [u0, v0 + 1]), dtype=float) - origin
                center = (points[0] + points[2]) / 2
                x_axis, y_axis = points[0] - center, points[1] - center
                radius = float(np.linalg.norm(x_axis))
                if radius > 0 and np.linalg.norm(axis_step) > 0:
                    inverse = ("cylinder", center, x_axis / radius, unit(y_axis), axis_step, u0, v0, period)
        except Exception:
            inverse = None
        self.inverses[face] = inverse
        return inverse

    def parametrize(self, face, point):
        inverse = self._inverse(face)
        if inverse is not None:
            if inverse[0] == "plane":
                _, origin, du, dv, solve, u0, v0 = inverse
                offset = point - origin
                u, v = solve @ np.array([offset @ du, offset @ dv])
                uv = [u0 + float(u), v0 + float(v)]
            else:
                _, center, x_axis, y_axis, axis_step, u0, v0, period = inverse
                offset = point - center
                length = float(axis_step @ axis_step)
                v = float(offset @ axis_step) / length
                radial = offset - (offset @ axis_step) / length * axis_step
                angle = math.atan2(float(radial @ y_axis), float(radial @ x_axis))
                uv = [u0 + (angle % period), v0 + v]
            evaluated = np.array(self.model.getValue(2, face, uv), dtype=float)
            normal = unit(self.model.getNormal(face, uv))
            projected = point - float((point - evaluated) @ normal) * normal
            if float(np.linalg.norm(projected - evaluated)) <= max(self.tolerance * 100, 1e-9):
                return uv
        return list(map(float, self.model.getParametrization(2, face, list(map(float, point)))))

    def face_inside(self, face, point, reach):
        """True when point projects onto the trimmed face near itself."""
        try:
            uv = self.parametrize(face, point)
            if not self.model.isInside(2, face, uv, parametric=True):
                return False
            on = np.array(self.model.getValue(2, face, uv), dtype=float)
            return float(np.linalg.norm(on - point)) < reach
        except Exception:
            return False

    def in_face_direction(self, face, point, tangent, step):
        """Unit direction at an edge point, perpendicular to the edge and into the face.

        Thin faces can be narrower than the first probe, so the probe shrinks
        until exactly one side of the edge lies on the face.
        """
        uv = self.parametrize(face, point)
        normal = unit(self.model.getNormal(face, uv))
        direction = unit(np.cross(normal, tangent))
        if np.linalg.norm(direction) < 0.5:
            return None
        for probe in probes(step, self.tolerance):
            forward = self.face_inside(face, point + probe * direction, probe * 0.5)
            backward = self.face_inside(face, point - probe * direction, probe * 0.5)
            if forward != backward:
                return direction if forward else -direction
        return None

    def plane_frame(self, face):
        """Orientation data of an analytic plane face, or None.

        OpenCASCADE keeps a face to the left of each boundary edge, walked in
        its oriented sense, about the parametric normal du x dv. getNormal()
        gives the same normal, possibly reversed; on a plane it is constant.
        """
        if face in self.frames:
            return self.frames[face]
        frame = None
        try:
            if self.types.get(face) == "Plane":
                model = self.model
                lower, upper = model.getParametrizationBounds(2, face)
                uv = [(float(lower[0]) + float(upper[0])) / 2, (float(lower[1]) + float(upper[1])) / 2]
                normal = unit(model.getNormal(face, uv))
                du, dv = np.array(model.getDerivative(2, face, uv), dtype=float).reshape(2, 3)
                natural = unit(np.cross(du, dv))
                agreement = float(np.dot(normal, natural))
                senses = {}
                for _, signed in model.getBoundary([(2, face)], oriented=True):
                    senses.setdefault(abs(int(signed)), []).append(1 if int(signed) > 0 else -1)
                if abs(agreement) > 0.5:
                    frame = {"normal": normal, "natural": natural, "stored": 1 if agreement > 0 else -1,
                             "senses": {edge: sense[0] for edge, sense in senses.items() if len(sense) == 1}}
        except Exception:
            frame = None
        self.frames[face] = frame
        return frame

    def solid_sense(self, volume, face):
        """+1 or -1 when du x dv of the face points out of the solid; None if ambiguous."""
        if volume not in self.solid_senses:
            senses = {}
            try:
                for _, signed in self.model.getBoundary([(3, volume)], oriented=True):
                    senses.setdefault(abs(int(signed)), []).append(1 if int(signed) > 0 else -1)
            except Exception:
                senses = {}
            self.solid_senses[volume] = {f: s[0] for f, s in senses.items() if len(s) == 1}
        return self.solid_senses[volume].get(face)


def probes(step, tolerance):
    """Probe distances, smallest first: local probes cannot cross a narrow gap
    into unrelated material. Larger ones are fallbacks for coarse tolerances."""
    out = [step]
    while out[-1] / 6 > tolerance * 200 and len(out) < 5:
        out.append(out[-1] / 6)
    return out[::-1]


def _edge_data(geometry, edge):
    model, tag = geometry.model, edge["id"]
    lo, hi = (float(v[0]) for v in model.getParametrizationBounds(1, tag))
    # One evaluation call per quantity: each Gmsh API call has a fixed cost.
    start_point, end_point = np.array(model.getValue(1, tag, [lo, hi]), dtype=float).reshape(2, 3)
    boundary = [abs(int(t)) for _, t in model.getBoundary([(1, tag)], oriented=False)]
    start = geometry.nearest_vertex(start_point, boundary or None) or geometry.nearest_vertex(start_point)
    end = geometry.nearest_vertex(end_point, boundary or None) or geometry.nearest_vertex(end_point)
    closed = float(np.linalg.norm(start_point - end_point)) <= geometry.tolerance * 10
    if closed and start is None:
        start = end = geometry.nearest_vertex(start_point)
    d_start, d_end = (unit(d) for d in np.array(model.getDerivative(1, tag, [lo, hi]), dtype=float).reshape(2, 3))
    record = {"vertices": [start, end], "closed": bool(closed), "param": [lo, hi]}
    kind = edge.get("type")
    if kind != "Line":
        params = [lo + (hi - lo) * i / (CURVE_SAMPLES - 1) for i in range(CURVE_SAMPLES)]
        samples = np.array(model.getValue(1, tag, params), dtype=float).reshape(-1, 3)
        # Edges made by slicing are often trimmed or B-spline curves that are
        # geometrically straight or circular; classify them by their samples.
        chord = samples[-1] - samples[0]
        length = float(np.linalg.norm(chord))
        straight = length > 0 and not closed and float(np.max(np.linalg.norm(np.cross(samples - samples[0], chord), axis=1))) / length <= geometry.tolerance * 10
        if straight:
            record["curve"] = {"kind": "line"}
        else:
            record["samples"] = [round(v, 12) for v in samples.ravel().tolist()]
            record["curve"] = _circle(samples) or {"kind": "curve"}
    else:
        record["curve"] = {"kind": "line"}
    geometry.edges[tag] = {"start": start, "end": end, "lo": lo, "hi": hi, "line": record["curve"]["kind"] == "line",
                           "out_start": d_start, "out_end": -d_end, "length": edge.get("length", 0)}
    return record


def _circle(samples):
    """Fit a circle through three samples and accept it only if all samples agree."""
    count = len(samples)
    a, b, c = samples[0], samples[count // 3], samples[(2 * count) // 3]
    ab, ac = b - a, c - a
    normal = np.cross(ab, ac)
    area = float(np.linalg.norm(normal))
    if area < 1e-14:
        return None
    center = a + (np.dot(ac, ac) * np.cross(normal, ab) + np.dot(ab, ab) * np.cross(ac, normal)) / (2 * area * area)
    radius = float(np.linalg.norm(a - center))
    axis = unit(normal)
    offsets = samples - center
    residual = float(np.max(np.abs(np.linalg.norm(offsets, axis=1) - radius)))
    planar = float(np.max(np.abs(offsets @ axis)))
    if residual > max(radius * 1e-6, 1e-9) or planar > max(radius * 1e-6, 1e-9):
        return None
    return {"kind": "circle", "center": center.tolist(), "axis": axis.tolist(), "radius": radius}


def _oriented_loop(geometry, curves):
    curves = [int(c) for c in curves]
    edges = geometry.edges
    if any(c not in edges for c in curves):
        return None
    if len(curves) == 1:
        return [[curves[0], 1]]

    def ends(tag, sense):
        info = edges[tag]
        return (info["start"], info["end"]) if sense > 0 else (info["end"], info["start"])

    for first in (1, -1):
        result = [[curves[0], first]]
        origin, current = ends(curves[0], first)
        valid = current is not None
        for tag in curves[1:]:
            start, end = edges[tag]["start"], edges[tag]["end"]
            if start == current:
                result.append([tag, 1])
                current = end
            elif end == current:
                result.append([tag, -1])
                current = start
            else:
                valid = False
                break
        if valid and current == origin:
            return result
    return None


def _corner_angle(geometry, face, incoming, outgoing):
    """Interior angle of a face where loop edge `incoming` meets `outgoing`."""
    edges = geometry.edges
    tag_in, sense_in = incoming
    tag_out, sense_out = outgoing
    info_in, info_out = edges[tag_in], edges[tag_out]
    vertex = info_out["start"] if sense_out > 0 else info_out["end"]
    if vertex is None or vertex not in geometry.vertices:
        return vertex, None
    back = info_in["out_end"] if sense_in > 0 else info_in["out_start"]
    ahead = info_out["out_start"] if sense_out > 0 else info_out["out_end"]
    cosine = float(np.dot(back, ahead))
    if cosine < -0.99999:
        return vertex, 180.0
    angle = _angle(back, ahead)
    bisector = unit(back + ahead)
    if np.linalg.norm(bisector) < 0.5:
        return vertex, 360.0 if angle < 1 else angle
    lengths = [max(info_in["length"], 0), max(info_out["length"], 0)]
    step = max(min(min(l for l in lengths if l > 0) * 0.02 if any(lengths) else geometry.span * 1e-3,
                   geometry.span * 2e-3), geometry.tolerance * 50)
    inside = _plane_corner_inside(geometry, face, incoming, outgoing, back, ahead)
    if inside is None:
        origin = geometry.vertices[vertex]
        # Near a convex corner the bisector stays on the face for small enough probes;
        # for a reflex corner it leaves the face at every size.
        inside = geometry.face_inside(face, origin + probes(step, geometry.tolerance)[0] * bisector, probes(step, geometry.tolerance)[0] * 0.5)
    return vertex, angle if inside else 360.0 - angle


def _plane_corner_inside(geometry, face, incoming, outgoing, back, ahead):
    """Whether a corner of an analytic plane face between two straight edges is
    convex, from orientations alone; None when that cannot be decided.

    Walked in the sense of the face's oriented boundary, the face lies to the
    left about du x dv, so a convex corner turns left.
    """
    frame = geometry.plane_frame(face)
    (tag_in, sense_in), (tag_out, sense_out) = incoming, outgoing
    if frame is None or not (geometry.edges[tag_in]["line"] and geometry.edges[tag_out]["line"]):
        return None
    oriented_in, oriented_out = frame["senses"].get(tag_in), frame["senses"].get(tag_out)
    if oriented_in is None or oriented_out is None or sense_in * oriented_in != sense_out * oriented_out:
        return None
    # back points back along the incoming edge, ahead along the outgoing one.
    turn = float(np.dot(np.cross(back, ahead), frame["natural"])) * sense_in * oriented_in
    if abs(turn) < 1e-6:
        return None
    return turn < 0


def _surface(geometry, face, kind):
    model = geometry.model
    try:
        lower, upper = model.getParametrizationBounds(2, face)
        grid = [[lower[0] + (upper[0] - lower[0]) * a, lower[1] + (upper[1] - lower[1]) * b]
                for a in (0.2, 0.5, 0.8) for b in (0.2, 0.5, 0.8)]
        points = list(np.array(model.getValue(2, face, [x for uv in grid for x in uv]), dtype=float).reshape(-1, 3))
        mid = grid[4]
        point = points[4]
        normal = unit(model.getNormal(face, mid))
        tolerance = max(geometry.span * 1e-6, 1e-9)
        # Fit by geometry, not by the kernel's type name: STEP files often store
        # cylinders as extrusions or B-splines. Every fit is checked on samples.
        if kind == "Plane" or max(abs(float(np.dot(p - point, normal))) for p in points) < tolerance:
            if max(abs(float(np.dot(p - point, normal))) for p in points) < tolerance:
                return {"kind": "plane", "origin": point.tolist(), "normal": normal.tolist()}
            return {"kind": "mesh"}
        k_max, k_min, d_max, d_min = model.getPrincipalCurvatures(face, mid)
        k_max, k_min = float(k_max[0]), float(k_min[0])
        large, small = (k_max, k_min) if abs(k_max) >= abs(k_min) else (k_min, k_max)
        if abs(large) <= 0:
            return {"kind": "mesh"}
        radius = 1.0 / abs(large)
        if abs(small) * radius < 1e-6:
            axis = unit(d_min if abs(k_min) < abs(k_max) else d_max)
            for sign in (1, -1):
                origin = point - sign * radius * normal
                distances = [float(np.linalg.norm(np.cross(p - origin, axis))) for p in points]
                if max(abs(d - radius) for d in distances) < tolerance * 10:
                    return {"kind": "cylinder", "origin": origin.tolist(), "axis": axis.tolist(), "radius": radius}
        elif abs(abs(small) - abs(large)) * radius < 1e-6:
            for sign in (1, -1):
                center = point - sign * radius * normal
                if max(abs(float(np.linalg.norm(p - center)) - radius) for p in points) < tolerance * 10:
                    return {"kind": "sphere", "center": center.tolist(), "radius": radius}
    except Exception:
        pass
    return {"kind": "mesh"}


def _material_outside(geometry, volume, surface, point, step):
    """For cylinders: True when solid material lies outside the radius (a hole or concave fillet)."""
    origin, axis = np.array(surface["origin"]), np.array(surface["axis"])
    offset = point - origin
    radial = unit(offset - np.dot(offset, axis) * axis)
    try:
        outside = geometry.model.isInside(3, volume, list(map(float, point + step * radial)))
        inside = geometry.model.isInside(3, volume, list(map(float, point - step * radial)))
    except Exception:
        return None
    if bool(outside) == bool(inside):
        return None
    return bool(outside)


def _plane_dihedral(geometry, volume, edge, faces, tangent):
    """Material dihedral across an edge between two analytic plane faces, from
    orientations alone: no point is evaluated or classified.

    Each face lies to the left of the edge (walked in its oriented sense) about
    du x dv, which gives the direction into the face; du x dv times the face's
    sign in the solid points out of the material. Returns False when the
    orientation data is missing or ambiguous, so the caller probes instead.
    """
    directions, outward = [], []
    for face in faces:
        frame = geometry.plane_frame(face)
        solid = geometry.solid_sense(volume, face)
        if frame is None or solid is None or edge not in frame["senses"]:
            return False
        # The same vector the probe would orient: normal x tangent, normalized.
        direction = unit(np.cross(frame["normal"], tangent))
        if np.linalg.norm(direction) < 0.5:
            return False
        directions.append(direction if frame["senses"][edge] * frame["stored"] > 0 else -direction)
        outward.append(solid * frame["natural"])
    first, second = directions
    if float(np.dot(first, second)) < -0.99999:
        return 180.0
    angle = _angle(first, second)
    # The narrower wedge between the faces is material when each face's
    # direction lies on the material side of the other face.
    a, b = float(np.dot(second, outward[0])), float(np.dot(first, outward[1]))
    if min(abs(a), abs(b)) < 1e-9 or (a < 0) != (b < 0):
        return False
    return angle if a < 0 else 360.0 - angle


def _dihedral(geometry, volume, edge, faces):
    """Interior solid angle (degrees) across an edge between two faces of one volume."""
    model = geometry.model
    info = geometry.edges[edge]
    middle = (info["lo"] + info["hi"]) / 2
    tangent = unit(model.getDerivative(1, edge, [middle]))
    analytic = _plane_dihedral(geometry, volume, edge, faces, tangent)
    if analytic is not False:
        return analytic
    point = np.array(model.getValue(1, edge, [middle]), dtype=float)
    length = info["length"] or geometry.span * 1e-2
    step = max(min(length * 0.02, geometry.span * 2e-3), geometry.tolerance * 50)
    first = geometry.in_face_direction(faces[0], point, tangent, step)
    second = geometry.in_face_direction(faces[1], point, tangent, step)
    if first is None or second is None:
        return None
    if float(np.dot(first, second)) < -0.99999:
        return 180.0
    angle = _angle(first, second)
    bisector = unit(first + second)
    probe = probes(step, geometry.tolerance)[0]
    inside = model.isInside(3, volume, list(map(float, point + probe * bisector)))
    return angle if inside else 360.0 - angle


def augment(gmsh, data):
    """Add mapped-meshing classification data to a topology record in place."""
    geometry = _Geometry(gmsh, data)
    model = geometry.model
    data["vertices"] = [{"id": tag, "point": point.tolist()} for tag, point in geometry.vertices.items()]
    for edge in data["edges"]:
        try:
            edge.update(_edge_data(geometry, edge))
        except Exception:
            edge.update({"vertices": [None, None], "closed": False, "curve": {"kind": "unknown"}})
    faces = {face["id"]: face for face in data["faces"]}
    for face in data["faces"]:
        face["surface"] = _surface(geometry, face["id"], face.get("type"))
        geometry.surface_kinds[face["id"]] = face["surface"]["kind"]
        geometry.types[face["id"]] = face.get("type")
    for face in data["faces"]:
        tag = face["id"]
        loops, corners = [], []
        try:
            _, curve_lists = model.occ.getCurveLoops(tag)
        except Exception:
            curve_lists = []
        # OpenCASCADE does not list the outer wire first; consumers rely on it.
        def extent(curves):
            boxes = [model.getBoundingBox(1, abs(int(c))) for c in curves]
            low = [min(b[i] for b in boxes) for i in range(3)]
            high = [max(b[i + 3] for b in boxes) for i in range(3)]
            return sum((high[i] - low[i]) ** 2 for i in range(3))
        try:
            curve_lists = sorted((c for c in curve_lists if len(c)), key=extent, reverse=True)
        except Exception:
            pass
        for curves in curve_lists:
            if not len(curves):
                continue
            loop = _oriented_loop(geometry, curves)
            if loop is None:
                loops.append([[int(c), 0] for c in curves])
                corners.append([])
                continue
            loops.append(loop)
            angles = []
            for index, outgoing in enumerate(loop):
                incoming = loop[index - 1]
                if len(loop) == 1:
                    info = geometry.edges[outgoing[0]]
                    angles.append([info["start"], 180.0])
                    continue
                try:
                    vertex, angle = _corner_angle(geometry, tag, incoming, outgoing)
                except Exception:
                    vertex, angle = None, None
                angles.append([vertex, None if angle is None else round(angle, 4)])
            corners.append(angles)
        face["orientedLoops"] = loops
        face["corners"] = corners
        if face["surface"]["kind"] == "cylinder" and face.get("volumes"):
            try:
                lower, upper = model.getParametrizationBounds(2, tag)
                mid = [(lower[0] + upper[0]) / 2, (lower[1] + upper[1]) / 2]
                point = np.array(model.getValue(2, tag, mid), dtype=float)
                step = min(face["surface"]["radius"] * 0.05, geometry.span * 2e-3)
                face["concave"] = _material_outside(geometry, face["volumes"][0], face["surface"], point, step)
            except Exception:
                face["concave"] = None
    for volume in data["volumes"]:
        uses = {}
        for face_id in volume["faces"]:
            for loop in faces.get(face_id, {}).get("orientedLoops", []):
                for edge, _ in loop:
                    uses.setdefault(edge, []).append(face_id)
        angles = []
        for edge, owners in sorted(uses.items()):
            if len(owners) == 2 and owners[0] == owners[1]:
                angles.append([edge, 180.0])
                continue
            if len(owners) != 2:
                angles.append([edge, None])
                continue
            try:
                angle = _dihedral(geometry, volume["id"], edge, owners)
            except Exception:
                angle = None
            angles.append([edge, None if angle is None else round(angle, 4)])
        volume["edgeAngles"] = angles
    data["mapping"] = {"version": 1}
    return data
