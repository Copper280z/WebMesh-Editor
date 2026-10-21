"""Shell (surface) meshing of CAD faces.

Quads come from quadmesh, edge first: every CAD edge of the chosen faces gets
one node distribution with an even count, shared by every face that uses it,
so neighboring faces conform. Each face is meshed in its parameter plane,
scaled so that lengths there match lengths on the surface, with its boundary
nodes fixed; interior nodes are then mapped back onto the surface. Triangles
are the Gmsh plugin's (cad_gmsh_plugin.tri_shell, which reuses the helpers here).

A pad is one ring of quads around a picked hole whose outside is a square:
the square's nodes are fixed, and the rest of the face is meshed to them.
"""

import math

import numpy as np

import quadmesh_bridge

MAX_ELEMENTS = 500_000
SAMPLES = 128
FLAT = 0.05  # a face mesh with a quad this flat also tries the other conforming mesher


class Edges:
    """Node distributions of CAD edges, shared by every face that uses them."""

    def __init__(self, geom, size, per_circle, counts=None, sizes=None, even_edges=False):
        # even_edges: every edge even (the recombination mesher keeps every
        # other boundary node, so corners must fall on even positions); else
        # natural counts with each loop made even.
        self.geom, self.size, self.per_circle, self.even_edges = geom, size, per_circle, even_edges
        self.counts, self.sizes = counts or {}, sizes or {}
        self.points, self.ids, self.vertex_ids = {}, {}, {}
        self.next_id = 1
        self.odd = []
        self.planned, self.degenerate = {}, set()
        self.pinned = set()  # counts a pad sets: 4 × its elements per side

    def plan(self, loops_of):
        """Choose every edge's count before any node is placed.

        A face bounded by four edges (a band: a chamfer, a bend, a tube wall)
        gets equal counts on opposite edges, so it meshes as a regular strip
        instead of skewed slivers; counts only grow, so this settles.
        """
        edges = sorted({c for loops in loops_of.values() for loop in loops for c, _ in loop})
        for edge in edges:
            params, samples, cumulative = self.curve(edge)
            length = float(cumulative[-1])
            if length <= 0:
                self.degenerate.add(edge)
                continue
            vertices = self.geom.model.getAdjacencies(1, edge)[1]
            closed = len(vertices) < 2 or int(vertices[0]) == int(vertices[-1])
            self.planned[edge] = self.count(edge, length, samples, closed)
        for _ in range(12):
            changed = False
            for loops in loops_of.values():
                if len(loops) != 1 or len(loops[0]) != 4:
                    continue
                loop = [c for c, _ in loops[0]]
                for a, b in ((loop[0], loop[2]), (loop[1], loop[3])):
                    if a == b or a not in self.planned or b not in self.planned or a in self.counts or b in self.counts:
                        continue
                    target = max(self.planned[a], self.planned[b])
                    for edge in (a, b):
                        if self.planned[edge] != target:
                            self.planned[edge], changed = target, True
            if not changed:
                break
        if not self.even_edges:
            self.even_loops(loops_of)

    def even_loops(self, loops_of):
        """Make every boundary loop's edge count even, as an all-quad mesh needs.

        An edge's count flips the parity of each loop it bounds (a seam bounds
        its loop twice, so it never helps). Odd loops are paired along the
        cheapest chain of edges between them, and every edge on the chain gets
        one more element: long edges are cheap, band edges and edges whose count
        the user fixed are avoided. An edge on the rim of the chosen faces
        bounds a single loop and absorbs a pairing on its own.
        """
        import heapq
        loops, owners = [], {}
        bands = set()
        for face, face_loops in sorted(loops_of.items()):
            for loop in face_loops:
                index = len(loops)
                loops.append(loop)
                if len(face_loops) == 1 and len(loop) == 4:
                    bands.update(c for c, _ in loop)
                for c, _ in loop:
                    owners.setdefault(c, []).append(index)
        sink = len(loops)
        links = {}
        for edge, seen in owners.items():
            if edge not in self.planned or edge in self.counts:
                continue
            ends = sorted(set(i for i in seen if seen.count(i) == 1))
            if not ends:
                continue  # a seam: counted twice in its own loop
            a, b = (ends + [sink])[:2]
            length = float(self.curve(edge)[2][-1])
            cost = (10.0 if edge in bands else 1.0) * self.size / max(length, 1e-12) + 1e-9 * edge
            links.setdefault(a, []).append((cost, b, edge))
            links.setdefault(b, []).append((cost, a, edge))
        def parity(index):
            return sum(self.planned.get(c, 0) for c, _ in loops[index]) % 2
        odd = [i for i in range(len(loops)) if parity(i)]
        pending = set(odd)
        for start in odd:
            if start not in pending:
                continue
            pending.discard(start)
            # Dijkstra to the nearest other odd loop, or to the rim.
            best, previous, heap, found = {start: 0.0}, {}, [(0.0, start)], None
            while heap:
                cost, at = heapq.heappop(heap)
                if cost > best.get(at, float("inf")):
                    continue
                if at != start and (at in pending or at == sink):
                    found = at
                    break
                for step, nxt, edge in links.get(at, []):
                    if cost + step < best.get(nxt, float("inf")):
                        best[nxt], previous[nxt] = cost + step, (at, edge)
                        heapq.heappush(heap, (cost + step, nxt))
            if found is None:
                continue  # left odd: the mesher reports it
            pending.discard(found)
            at = found
            while at != start:
                at, edge = previous[at]
                self.planned[edge] += 1

    def curve(self, edge):
        """(params, points, cumulative length) of a dense sample of the edge."""
        model = self.geom.model
        lower, upper = model.getParametrizationBounds(1, edge)
        params = np.linspace(lower[0], upper[0], SAMPLES + 1)
        points = np.array(model.getValue(1, edge, params.tolist()), dtype=float).reshape(-1, 3)
        steps = np.linalg.norm(np.diff(points, axis=0), axis=1)
        return params, points, np.concatenate([[0.0], np.cumsum(steps)])

    def count(self, edge, length, points, closed):
        if edge in self.counts:
            count = self.counts[edge]
            if count % 2 and edge not in self.pinned:
                self.odd.append(edge)
            return count
        size = self.sizes.get(edge, self.size)
        count = max(1, math.ceil(length / size - 1e-9))
        # Curved edges get at least per_circle elements per full turn.
        directions = np.diff(points, axis=0)
        lengths = np.linalg.norm(directions, axis=1)
        keep = lengths > max(length, 1e-30) * 1e-9
        unit = directions[keep] / lengths[keep][:, None]
        turn = float(np.sum(np.arccos(np.clip(np.sum(unit[1:] * unit[:-1], axis=1), -1, 1)))) if len(unit) > 1 else 0.0
        if turn > 1e-6:
            count = max(count, math.ceil(self.per_circle * turn / (2 * math.pi) - 1e-9))
        if closed:
            count = max(count, 4)
        return count + count % 2 if self.even_edges else count

    def nodes(self, edge, count=None):
        """Node ids and points of an edge from its start vertex to its end vertex."""
        if edge in self.ids:
            return self.ids[edge], self.points[edge]
        model = self.geom.model
        params, samples, cumulative = self.curve(edge)
        length = float(cumulative[-1])
        if length <= 0:
            raise ValueError(f"Edge {edge} has zero length (a cone apex or a pole). Faces with such edges cannot be shell meshed yet.")
        start, end = (int(v) for v in model.getAdjacencies(1, edge)[1][:2]) if len(model.getAdjacencies(1, edge)[1]) >= 2 else (None, None)
        closed = start == end or start is None
        n = count or self.planned.get(edge) or self.count(edge, length, samples, closed)
        targets = np.linspace(0, length, n + 1)
        at = np.interp(targets, cumulative, params)
        points = np.array(model.getValue(1, edge, at.tolist()), dtype=float).reshape(-1, 3)
        ids = []
        for k in range(n + 1):
            vertex = start if k == 0 else end if k == n else None
            if vertex is not None:
                if vertex not in self.vertex_ids:
                    self.vertex_ids[vertex] = self.new()
                    self.vertex_points = getattr(self, "vertex_points", {})
                ids.append(self.vertex_ids[vertex])
            else:
                ids.append(self.new())
        if closed and start is None:
            ids[-1] = ids[0]
        self.ids[edge], self.points[edge] = ids, points
        return ids, points

    def new(self):
        self.next_id += 1
        return self.next_id - 1


def oriented_loops(geom, face):
    """Each boundary loop of a face as [(edge, sense), ...] in traversal order.

    Edges that bound the face once take their direction from the face's
    oriented boundary; a seam (listed twice) is traversed from wherever the loop
    has arrived. OpenCASCADE may list a wire against the face's orientation, so
    both orders are tried and the one that closes is kept.
    """
    model, occ = geom.model, geom.model.occ
    _, curve_lists = occ.getCurveLoops(face)
    signs = {}
    for _, tag in model.getBoundary([(2, face)], oriented=True):
        signs.setdefault(abs(int(tag)), 1 if tag > 0 else -1)
    ends = {}

    def follow(curves, flip):
        loop, at = [], None
        for index, c in enumerate(curves):
            a, b = ends[c]
            if curves.count(c) == 1 and c in signs:
                sense = signs[c] * flip
            elif at is None:
                nxt = ends[curves[(index + 1) % len(curves)]]
                sense = 1 if b in nxt else -1
            else:
                sense = 1 if a == at else -1
            start = a if sense > 0 else b
            if at is not None and start != at:
                return None
            loop.append((c, sense))
            at = b if sense > 0 else a
        first = ends[loop[0][0]]
        return loop if at == (first[0] if loop[0][1] > 0 else first[1]) else None

    loops = []
    for curves in curve_lists:
        curves = [abs(int(c)) for c in curves]
        if not curves:
            continue
        for c in curves:
            vertices = [int(v) for v in model.getAdjacencies(1, c)[1]]
            ends[c] = (vertices[0], vertices[-1]) if vertices else (None, None)
        loop = follow(curves, 1) or follow(curves[::-1], 1) or follow(curves, -1) or follow(curves[::-1], -1)
        if loop is None:
            raise ValueError(f"WebMesh cannot follow a boundary loop of face {face}.")
        loops.append(loop)
    return loops


def _unwrap(uv, periodic, periods):
    """Unwrap a loop across a periodic seam in place: consecutive points are close."""
    if periodic is not None:
        for k in range(1, len(uv)):
            jump = uv[k, periodic] - uv[k - 1, periodic]
            uv[k, periodic] -= periods[periodic] * round(jump / periods[periodic])


def _align(loops_uv, periodic, period):
    """Shift inner loops by whole periods into the outer loop's span, in place.

    Each loop is unwrapped from its own first point, so on a cylinder the outer
    loop can run from -2π to 0 while a hole sits at +π: outside the domain.
    """
    if periodic is None or len(loops_uv) < 2:
        return
    outer = max(range(len(loops_uv)), key=lambda i: abs(_area(loops_uv[i])))
    middle = lambda uv: (uv[:, periodic].min() + uv[:, periodic].max()) / 2
    target = middle(loops_uv[outer])
    for i, uv in enumerate(loops_uv):
        if i != outer:
            uv[:, periodic] += period * round((target - middle(uv)) / period)


def _periodic(geom, face, loops, edges):
    """The periodic parameter direction of a face with a seam (or None), and its periods."""
    model = geom.model
    seams = {c for loop in loops for c, _ in loop if sum(1 for d, _ in loop if d == c) > 1}
    lower, upper = model.getParametrizationBounds(2, face)
    periods = [upper[0] - lower[0], upper[1] - lower[1]]
    if not seams:
        return None, periods
    # The seam runs along the periodic direction's constant line.
    ends = edges.curve(next(iter(seams)))[1][[0, -1]]
    seam_uv = np.array(model.getParametrization(2, face, ends.ravel().tolist())).reshape(2, 2)
    return (0 if abs(seam_uv[0, 0] - seam_uv[1, 0]) < abs(seam_uv[0, 1] - seam_uv[1, 1]) else 1), periods


def _scales(geom, face):
    """Lengths along u and v per unit parameter, averaged over the face."""
    model = geom.model
    lower, upper = model.getParametrizationBounds(2, face)
    du, dv = [], []
    for a in (0.2, 0.5, 0.8):
        for b in (0.2, 0.5, 0.8):
            uv = [lower[0] + (upper[0] - lower[0]) * a, lower[1] + (upper[1] - lower[1]) * b]
            d = np.array(model.getDerivative(2, face, uv), dtype=float).reshape(2, 3)
            du.append(np.linalg.norm(d[0]))
            dv.append(np.linalg.norm(d[1]))
    su, sv = float(np.mean(du)), float(np.mean(dv))
    if not (su > 0 and sv > 0):
        raise ValueError(f"Face {face} has a degenerate parametrization.")
    return su, sv


def _area(points):
    p = np.asarray(points)
    return 0.5 * float(np.sum(p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]))


def _quality(points):
    """Minimum scaled Jacobian of a 3D quad (corner sines about its mean normal),
    or of a triangle (scaled so an equilateral one is 1)."""
    p = np.asarray(points, dtype=float)
    if len(p) == 3:
        normal = np.cross(p[1] - p[0], p[2] - p[0])
        size = np.linalg.norm(normal)
        if size <= 0:
            return -1.0
        worst = min(float(np.dot(np.cross(p[(k + 1) % 3] - p[k], p[(k + 2) % 3] - p[k]), normal / size)
                          / (np.linalg.norm(p[(k + 1) % 3] - p[k]) * np.linalg.norm(p[(k + 2) % 3] - p[k]))) for k in range(3))
        return min(1.0, worst * 2 / math.sqrt(3))
    normal = np.cross(p[2] - p[0], p[3] - p[1])
    size = np.linalg.norm(normal)
    if size <= 0:
        return -1.0
    normal /= size
    worst = 1.0
    for k in range(4):
        a, b = p[(k + 1) % 4] - p[k], p[(k + 3) % 4] - p[k]
        la, lb = np.linalg.norm(a), np.linalg.norm(b)
        if la <= 0 or lb <= 0:
            return -1.0
        worst = min(worst, float(np.dot(np.cross(a, b), normal) / (la * lb)))
    return worst


def _loops_uv(geom, face, loops, edges):
    """Each loop of a face as a dense polyline in its scaled parameter plane,
    with the edge each point lies on (unwrapped across a periodic seam)."""
    model = geom.model
    su, sv = _scales(geom, face)
    periodic, periods = _periodic(geom, face, loops, edges)
    out = []
    for loop in loops:
        points, owner = [], []
        for c, sense in loop:
            samples = edges.curve(c)[1]
            samples = samples[::-1] if sense < 0 else samples
            points.extend(samples[:-1])
            owner.extend([c] * (len(samples) - 1))
        uv = np.array(model.getParametrization(2, face, np.asarray(points).ravel().tolist()), dtype=float).reshape(-1, 2)
        _unwrap(uv, periodic, periods)
        out.append((uv, owner))
    _align([uv for uv, _ in out], periodic, periods[periodic] if periodic is not None else 0)
    return [(np.column_stack([uv[:, 0] * su, uv[:, 1] * sv]), owner) for uv, owner in out]


def _centroid(points):
    p = np.asarray(points)
    cross = p[:, 0] * np.roll(p[:, 1], -1) - np.roll(p[:, 0], -1) * p[:, 1]
    area = cross.sum() / 2
    return np.array([np.sum((p[:, 0] + np.roll(p[:, 0], -1)) * cross), np.sum((p[:, 1] + np.roll(p[:, 1], -1)) * cross)]) / (6 * area)


def _square_angle(polyline, owner):
    """Direction of the longest straight edge of a face's outer loop, modulo 90°:
    pads line up with the face's edges (0 when it has none)."""
    best, angle = 0.0, 0.0
    for c in dict.fromkeys(owner):
        p = polyline[[i for i, o in enumerate(owner) if o == c]]
        if len(p) < 2:
            continue
        chord = p[-1] - p[0]
        length = float(np.linalg.norm(chord))
        if length <= best:
            continue
        rel = p - p[0]
        off = np.abs(chord[0] * rel[:, 1] - chord[1] * rel[:, 0]) / length
        if float(off.max()) <= length * 1e-6:
            best, angle = length, math.atan2(chord[1], chord[0]) % (math.pi / 2)
    return angle


def plan_pads(geom, request, loops_of, edges, size, per_circle, mesher):
    """Size every pad and pin its hole's edge counts before any node is placed.

    A pad's square has k elements per side (4k nodes on the hole). Its default
    guess matches the face's element size h with a ring about one element
    thick, k = round(D/h + 2), then shrinks to keep about one element between
    it and the face's other boundaries; k then follows the square's size so
    its nodes stay about h apart (at least 2 per side: the pad's own setting,
    not elements per circle, sets the hole's count). A size or k given by the
    user is used as given. Returns {face: {loop index: pad}} and the reports.
    """
    items = request.get("pads") or []
    if not items:
        return {}, []
    if not quadmesh_bridge.MESHERS[mesher]["fixed"]:
        raise ValueError("Pads need fixed boundary nodes: mesh with Recombined or Paved.")
    model = geom.model
    even = mesher == "recombined"  # its recombination keeps every other boundary node: corners on even positions

    def per_side(x):
        return max(2, 2 * math.floor(x / 2 + 0.5) if even else round(x))
    pads_of, reports, claimed = {}, [], {}
    frames = {}
    for index, item in enumerate(items):
        bore = {int(f) for f in item.get("faces") or []}
        hole_edges = {abs(int(t)) for f in bore for _, t in model.getBoundary([(2, f)], oriented=False)}
        found, touching = [], []
        for face, loops in loops_of.items():
            if face in bore:
                continue
            for li, loop in enumerate(loops):
                if len(loops) > 1 and all(c in hole_edges for c, _ in loop):
                    found.append((face, li))
                elif any(c in hole_edges for c, _ in loop):
                    touching.append(face)
        if not found:
            where = ", ".join(map(str, sorted(bore)))
            if touching:
                raise ValueError(f"Pad {index + 1}: the hole of face {where} is not a loop of its own in face {touching[0]} (it meets that face's edge or seam), so it cannot be padded.")
            raise ValueError(f"Pad {index + 1}: the hole of face {where} is not in any face being meshed.")
        for face, li in found:
            if face not in frames:
                polys = _loops_uv(geom, face, loops_of[face], edges)
                outer = max(range(len(polys)), key=lambda i: abs(_area(polys[i][0])))
                frames[face] = {"polys": polys, "outer": outer, "angle": _square_angle(*polys[outer]), "pads": []}
            frame = frames[face]
            if li == frame["outer"]:
                raise ValueError(f"Pad {index + 1}: the hole of face {', '.join(map(str, sorted(bore)))} bounds face {face} on the outside.")
            if (face, li) in claimed:
                raise ValueError(f"Pads {claimed[(face, li)] + 1} and {index + 1} are around the same hole.")
            claimed[(face, li)] = index
            hole = frame["polys"][li][0]
            frame["pads"].append({"index": index, "loop": li, "center": _centroid(hole), "radius": math.sqrt(abs(_area(hole)) / math.pi),
                                  "size": item.get("size"), "perSide": item.get("perSide"), "bore": sorted(bore)})
    h = size
    for face, frame in sorted(frames.items()):
        b = frame["angle"]
        axes = np.array([[math.cos(b), -math.sin(b)], [math.sin(b), math.cos(b)]])
        pads = frame["pads"]

        def room(pad, clearance):
            """Largest half-side that keeps `clearance` from every other boundary of the face."""
            limit = math.inf
            for j, (poly, _) in enumerate(frame["polys"]):
                if j == pad["loop"]:
                    continue
                q = np.abs((poly - pad["center"]) @ axes)
                limit = min(limit, float(np.max(q, axis=1).min()) - clearance)
            for other in pads:
                if other is not pad:
                    gap = float(np.max(np.abs((other["center"] - pad["center"]) @ axes)))
                    limit = min(limit, (gap - clearance) / 2)
            return limit

        for pad in pads:
            r, label = pad["radius"], f"Pad {pad['index'] + 1} (Ø{2 * pad['radius']:.3g} hole in face {face})"
            k = pad["perSide"]
            if k is not None and even and k % 2:
                raise ValueError(f"{label}: Recombined needs an even number of elements per pad side; use Paved or an even number.")
            shrunk = False
            if pad["size"] is not None:
                w = float(pad["size"]) / 2
                if w <= r * 1.05:
                    raise ValueError(f"{label}: a {2 * w:.3g} mm pad is not larger than its hole.")
                if w > room(pad, 0.0):
                    raise ValueError(f"{label}: a {2 * w:.3g} mm pad runs off its face or into a neighbor; there is room for {2 * room(pad, 0.0):.3g} mm.")
            else:
                guess = k if k is not None else per_side(2 * r / h + 2)
                w = max(guess * h / 2, r + 0.75 * h)
                for clearance in (h, h / 2):
                    fit = room(pad, clearance)
                    if min(w, fit) >= r * 1.15:
                        break
                if fit < r * 1.15:
                    raise ValueError(f"{label}: there is no room for a pad half an element clear of the face's edges; set a size, or leave this hole out.")
                shrunk, w = fit < w * (1 - 1e-9), min(w, fit)
            if k is None:
                k = per_side(2 * w / h)
                if not even:
                    # Corners take the hole nodes nearest the diagonals. Where the hole's own
                    # vertex sits between them the ring twists; one element more or less per
                    # side can line them up.
                    hole = frame["polys"][pad["loop"]][0]
                    start = (hole[0] - pad["center"]) @ axes
                    alpha = math.atan2(start[1], start[0])

                    def mismatch(n):
                        step = math.pi / (2 * n)
                        d = (math.pi / 4 - alpha) % step
                        return min(d, step - d) / step
                    if mismatch(k) > 0.25:
                        # Only where the square's nodes stay about h apart: a spacing that differs from
                        # the face's costs more than a twist.
                        options = [n for n in (k + 1, k - 1) if n >= 2 and mismatch(n) < mismatch(k) and abs(2 * w / n - h) <= 0.2 * h]
                        if options:
                            k = min(options, key=lambda n: (mismatch(n), -n))
            pad.update(half=w, perSide=k, angle=b, shrunk=shrunk)
            # Pin the hole's edges: 4k nodes, shared out by length.
            loop = loops_of[face][pad["loop"]]
            lengths = [float(edges.curve(c)[2][-1]) for c, _ in loop]
            counts = [max(1, round(4 * k * L / sum(lengths))) for L in lengths]
            counts[int(np.argmax(lengths))] += 4 * k - sum(counts)
            for (c, _), n in zip(loop, counts):
                if c in edges.counts and c not in edges.pinned and edges.counts[c] != n:
                    raise ValueError(f"{label}: edge {c} has {edges.counts[c]} divisions set, but the pad needs {n}.")
                edges.counts[c] = n
                edges.pinned.add(c)
            pads_of.setdefault(face, {})[pad["loop"]] = pad
            reports.append({"pad": pad["index"], "face": face, "holeFaces": pad["bore"], "diameter": 2 * r, "size": 2 * w, "perSide": k, "shrunk": shrunk})
    return pads_of, reports


def _pad_square(hole, pad):
    """The pad's square nodes, one per hole node and in the same order: the
    hole nodes nearest the square's diagonals take its corners, and the rest
    spread evenly along its sides."""
    n, k = len(hole), pad["perSide"]
    if n != 4 * k:
        raise ValueError(f"A pad with {k} elements per side needs {4 * k} nodes on its hole, not {n}.")
    c, w = np.asarray(pad["center"]), pad["half"]
    theta = np.arctan2(hole[:, 1] - c[1], hole[:, 0] - c[0])
    turn = np.angle(np.exp(1j * (np.roll(theta, -1) - theta))).sum()
    sense = 1.0 if turn > 0 else -1.0
    first = pad["angle"] + math.pi / 4
    start = int(np.argmin(np.abs(np.angle(np.exp(1j * (theta - first))))))
    corners = [c + w * math.sqrt(2) * np.array([math.cos(first + sense * m * math.pi / 2), math.sin(first + sense * m * math.pi / 2)]) for m in range(5)]
    square = np.zeros_like(hole)
    for m in range(4):
        for j in range(k):
            square[(start + m * k + j) % n] = corners[m] + (corners[m + 1] - corners[m]) * j / k
    return square


def _face_uv(geom, face, loops, edges, points, polys=None):
    """Scaled parameter-plane coordinates of points on a face, unwrapped like its loops."""
    model = geom.model
    su, sv = _scales(geom, face)
    periodic, periods = _periodic(geom, face, loops, edges)
    uv = np.array(model.getParametrization(2, face, np.asarray(points).ravel().tolist()), dtype=float).reshape(-1, 2)
    _unwrap(uv, periodic, periods)
    scaled = np.column_stack([uv[:, 0] * su, uv[:, 1] * sv])
    if periodic is not None and polys:
        # Into the outer loop's span, as _align does for holes.
        outer = max(polys, key=lambda p: abs(_area(p)))
        period = periods[periodic] * (su if periodic == 0 else sv)
        middle = lambda p: (p[:, periodic].min() + p[:, periodic].max()) / 2  # noqa: E731
        scaled[:, periodic] += period * round((middle(outer) - middle(scaled)) / period)
    return scaled


def embedded_edges(geom, face, loops, edges, candidates):
    """Edges lying inside a face without bounding it: junctions that stop partway
    across it, such as a brace's foot on a floor. OpenCASCADE marks such an edge
    INTERNAL in the face's wire and keeps it out of the face's loops; the kernel
    lists them. Only edges of `candidates` (those of sheets) are junctions."""
    own = {c for loop in loops for c, _ in loop}
    allowed = set(candidates)
    return [c for c in geom.model.getInternalEdges(face) if c in allowed and c not in own and c not in edges.degenerate
            and edges.curve(c)[2][-1] > 0]


def mesh_face(geom, face, edges, mesher, size, per_circle, pads=None, curves=()):
    """Quads of one face: (boundary-mapped node ids, new interior nodes, quads, report)."""
    model = geom.model
    loops = oriented_loops(geom, face)
    if not loops:
        raise ValueError(f"Face {face} has no boundary (a closed sphere or torus); slice it before shell meshing.")
    su, sv = _scales(geom, face)
    periodic, periods = _periodic(geom, face, loops, edges)
    loop_ids, loop_uv = [], []
    for loop in loops:
        ids, points = [], []
        for c, sense in loop:
            node_ids, node_points = edges.nodes(c)
            if sense < 0:
                node_ids, node_points = node_ids[::-1], node_points[::-1]
            ids.extend(node_ids[:-1])
            points.extend(node_points[:-1])
        uv = np.array(model.getParametrization(2, face, np.asarray(points).ravel().tolist()), dtype=float).reshape(-1, 2)
        _unwrap(uv, periodic, periods)
        loop_ids.append(ids)
        loop_uv.append(uv)
    _align(loop_uv, periodic, periods[periodic] if periodic is not None else 0)
    scaled = [np.column_stack([uv[:, 0] * su, uv[:, 1] * sv]) for uv in loop_uv]
    # A pad replaces its hole with the square of fixed nodes the mesher works to; its ring is made here.
    pad_points, pad_quads = {}, []
    for li, pad in sorted((pads or {}).items()):
        hole, hole_ids = scaled[li], loop_ids[li]
        square = _pad_square(hole, pad)
        count = len(square)
        quads = [[hole[i], hole[(i + 1) % count], square[(i + 1) % count], square[i]] for i in range(count)]
        areas = [_area(q) for q in quads]
        if not (all(a > 0 for a in areas) or all(a < 0 for a in areas)) or min(_quality(np.column_stack([q, np.zeros(4)])) for q in quads) < 0.05:
            raise ValueError(f"Pad {pad['index'] + 1} folds over its hole in face {face}: make it larger, or give it more elements per side.")
        ids = [edges.new() for _ in range(count)]
        xyz = np.array(model.getValue(2, face, (square / [su, sv]).ravel().tolist()), dtype=float).reshape(-1, 3)
        pad_points.update(zip(ids, xyz))
        for i in range(count):
            j = (i + 1) % count
            pad_quads.append({"nodes": [hole_ids[i], hole_ids[j], ids[j], ids[i]], "uv": np.mean(quads[i], axis=0) / [su, sv], "pad": pad["index"]})
        scaled[li], loop_ids[li] = square, ids
    order = sorted(range(len(scaled)), key=lambda i: -abs(_area(scaled[i])))
    request = [{"points": scaled[i].tolist(), "role": "outer" if rank == 0 else "hole"} for rank, i in enumerate(order)]
    request_ids = [loop_ids[i] for i in order]
    # Junctions that stop inside the face: open curves through their own (shared) nodes.
    for c in curves:
        node_ids, node_points = edges.nodes(c)
        request.append({"points": _face_uv(geom, face, loops, edges, node_points, scaled).tolist(), "role": "curve"})
        request_ids.append(list(node_ids))
    if not quadmesh_bridge.MESHERS[mesher]["fixed"]:
        # The quadtree samples its own boundary; give it the curves densely.
        dense = [uv for uv, _ in _loops_uv(geom, face, loops, edges)]
        request = [{"points": dense[i].tolist(), "role": "outer" if rank == 0 else "hole", "fixed": False} for rank, i in enumerate(order)]
        if curves:
            raise ValueError(f"Face {face} has {len(curves)} junction{'s' if len(curves) > 1 else ''} inside it, which the quadtree cannot follow: mesh it with Paved or Recombined.")
    def attempt(name):
        try:
            return quadmesh_bridge.mesh_domain(request, name, target_size=size, elements_per_circle=per_circle)
        except ValueError as exc:
            return {"valid": False, "issues": [str(exc)], "quads": [], "summary": {"min_scaled_jacobian": -1}}

    result, used = attempt(mesher), mesher
    flat = result["valid"] and result["summary"].get("min_scaled_jacobian", 1) < FLAT
    if (not result["valid"] or flat) and quadmesh_bridge.MESHERS[mesher]["fixed"]:
        # The other conforming mesher keeps the same fixed boundary, so
        # neighbors still conform; keep whichever face mesh is valid.
        for other in (name for name, spec in quadmesh_bridge.MESHERS.items() if spec["fixed"] and name != mesher):
            if quadmesh_bridge.available(other):
                second = attempt(other)
                better = bool(second["quads"]) and second["summary"]["min_scaled_jacobian"] > result["summary"]["min_scaled_jacobian"]
                # An invalid mesh gives way to a valid or better one; a flat one only to a valid, better one.
                if (second["valid"] or better) if not result["valid"] else (second["valid"] and better):
                    result, used = second, other
                    break
    if not result["quads"]:
        raise ValueError(result["issues"][0] if result["issues"] else f"Face {face} could not be meshed.")
    nodes2d = np.asarray(result["nodes"], dtype=float)
    mapped = {}
    if quadmesh_bridge.MESHERS[mesher]["fixed"]:
        for record in result["boundary_nodes"]:
            if record["fixed_node"] >= 0:
                mapped[record["node"]] = request_ids[record["loop"]][record["fixed_node"]]
    interior = [n for n in range(len(nodes2d)) if n not in mapped]
    new_points = []
    if interior:
        uv = np.column_stack([nodes2d[interior, 0] / su, nodes2d[interior, 1] / sv])
        new_points = np.array(model.getValue(2, face, uv.ravel().tolist()), dtype=float).reshape(-1, 3)
    return {"mapped": mapped, "interior": interior, "points": new_points, "uv": nodes2d / [su, sv], "quads": result["quads"],
            "valid": result["valid"], "issues": result["issues"], "summary": result["summary"], "mesher": used,
            "pad_points": pad_points, "pad_quads": pad_quads, "curves": len(curves)}


def _properties(faces, request):
    """Each face's property number and element offset. A sheet's thickness and
    offset set its group, so sheets of one thickness share a PSHELL; other faces
    share one (or, with pidPerFace, every face gets its own)."""
    sheets = {r["face"]: r for r in request.get("sheets") or []}
    per_face = request.get("pidPerFace", False)
    pid_of, thickness, groups = {}, {}, {}
    for face in faces:
        record = sheets.get(face)
        key = face if per_face else None if record is None else (record["thickness"], record["offset"])
        pid_of[face] = groups.setdefault(key, len(groups) + 1)
        if record is not None and record["thickness"] is not None:
            thickness[pid_of[face]] = record["thickness"]
    offsets = {face: sheets[face]["offset"] for face in faces if face in sheets and sheets[face]["offset"]}
    return pid_of, thickness, offsets


def _select_faces(geom, request):
    existing = sorted(int(tag) for _, tag in geom.model.getEntities(2))
    chosen = request.get("faceIds") or existing
    if not isinstance(chosen, list) or any(type(f) is not int or f not in existing for f in chosen):
        raise ValueError("Choose existing CAD faces to mesh, or leave the selection empty for every face.")
    return sorted(set(chosen))


def _controls(request):
    counts = {int(item["id"]): int(item["divisions"]) for item in request.get("edgeDivisions", []) or []}
    sizes = {int(item["id"]): float(item["size"]) for item in request.get("edgeSizes", []) or []}
    return counts, sizes


def quad_shell(geom, request):
    model = geom.model
    size = float(request["size"])
    per_circle = int(request.get("elementsPerCircle", 12))
    mesher = request.get("mesher", "recombined")
    faces = _select_faces(geom, request)
    area = sum(float(model.occ.getMass(2, f)) for f in faces)
    if area / (size * size) > MAX_ELEMENTS:
        raise ValueError(f"About {area / (size * size):,.0f} elements exceed the {MAX_ELEMENTS:,} limit. Raise the element size.")
    counts, sizes = _controls(request)
    edges = Edges(geom, size, per_circle, counts, sizes, even_edges=mesher == "recombined")
    loops_of, broken = {}, {}
    for f in faces:
        try:
            loops_of[f] = oriented_loops(geom, f)
        except ValueError as exc:
            broken[f] = str(exc)
    pads_of, pads = plan_pads(geom, request, loops_of, edges, size, per_circle, mesher)
    edges.plan(loops_of)
    # Junction curves come from sheets (faces of no solid): a solid's edges inside a sheet lying
    # on its face are that face's boundary, not junctions.
    sheet_edges = [int(tag) for _, tag in model.getEntities(1)
                   if all(not len(model.getAdjacencies(2, f)[0]) for f in model.getAdjacencies(1, tag)[0])]
    curves_of = {f: embedded_edges(geom, f, loops, edges, sheet_edges) for f, loops in loops_of.items()}
    for f, loops in loops_of.items():
        bad = sorted({c for loop in loops for c, _ in loop if c in edges.degenerate})
        if bad:
            broken[f] = f"Edge {bad[0]} has zero length (a cone apex or a pole). Faces with such edges cannot be shell meshed yet."
    # Edge nodes first, in edge order, so numbering does not depend on face order.
    used = sorted({c for f, loops in loops_of.items() if f not in broken for loop in loops for c, _ in loop}
                  | {c for f, curves in curves_of.items() if f not in broken for c in curves})
    for c in used:
        edges.nodes(c)
    coordinates = {}
    for c in used:
        for node, point in zip(edges.ids[c], edges.points[c]):
            coordinates[node] = point
    elements, reports = [], []
    pid_of, _, offsets = _properties(faces, request)
    for face in faces:
        if face in broken:
            reports.append({"face": face, "quads": 0, "valid": False, "issues": [broken[face]]})
            continue
        try:
            meshed = mesh_face(geom, face, edges, mesher, size, per_circle, pads_of.get(face), curves_of.get(face, ()))
        except ValueError as exc:
            reports.append({"face": face, "quads": 0, "valid": False, "issues": [str(exc)]})
            continue
        local = dict(meshed["mapped"])
        for node, point in zip(meshed["interior"], meshed["points"]):
            local[node] = edges.new()
            coordinates[local[node]] = point
        coordinates.update(meshed["pad_points"])
        pid = pid_of[face]
        count = 0
        quads = [([local[n] for n in quad], np.mean(meshed["uv"][list(quad)], axis=0), None) for quad in meshed["quads"]]
        quads += [(q["nodes"], q["uv"], q["pad"]) for q in meshed["pad_quads"]]
        for ids, centroid, pad in quads:
            corners = [coordinates[n] for n in ids]
            # Gmsh's face normal already points out of the solid (a sheet: its own normal).
            normal = np.array(model.getNormal(face, list(centroid)), dtype=float)
            if np.dot(np.cross(corners[2] - corners[0], corners[3] - corners[1]), normal) < 0:
                ids = [ids[0], ids[3], ids[2], ids[1]]
            element = {"type": "CQUAD4", "pid": pid, "nodes": ids, "face": face}
            if face in offsets:
                element["zoffs"] = offsets[face]  # the element normal follows the sheet's
            if pad is not None:
                element["pad"] = pad
            elements.append(element)
            count += 1
        reports.append({"face": face, "quads": count, "valid": meshed["valid"], "issues": meshed["issues"], "mesher": meshed["mesher"], "curves": meshed["curves"]})
    if not elements:
        raise ValueError("No face could be meshed: " + "; ".join(f"face {r['face']}: {r['issues'][0]}" for r in reports if r["issues"]))
    return elements, coordinates, reports, edges, faces, mesher, pads


def _node_normals(elements, coordinates):
    """Area-weighted unit normals of the mesh at its nodes."""
    sums = {}
    for element in elements:
        p = [coordinates[n] for n in element["nodes"]]
        normal = np.cross(p[2] - p[0], p[3] - p[1]) if len(p) == 4 else np.cross(p[1] - p[0], p[2] - p[0])
        for n in element["nodes"]:
            sums[n] = sums.get(n, 0) + normal
    return {n: v / (np.linalg.norm(v) or 1.0) for n, v in sums.items()}


def _closest_on_faces(geom, points, faces):
    """Closest points on the trimmed faces (falling back to the untrimmed surface)."""
    model = geom.model
    points = np.asarray(points, dtype=float)
    best = np.full(len(points), np.inf)
    fallback = np.full(len(points), np.inf)
    nearest = points.copy()
    loose = points.copy()
    for face in faces:
        projected, params = model.getClosestPoint(2, face, points.ravel().tolist())
        projected = np.asarray(projected, dtype=float).reshape(-1, 3)
        params = np.asarray(params, dtype=float).reshape(-1, 2)
        distance = np.linalg.norm(projected - points, axis=1)
        for i in range(len(points)):
            if distance[i] < fallback[i]:
                fallback[i], loose[i] = distance[i], projected[i]
            if distance[i] < best[i] and model.isInside(2, face, params[i].tolist(), parametric=True):
                best[i], nearest[i] = distance[i], projected[i]
    missing = ~np.isfinite(best)
    nearest[missing], best[missing] = loose[missing], fallback[missing]
    return nearest, best


def place(geom, elements, coordinates, request):
    """Move the mesh off the faces it was made on: to the midsurface or by an offset."""
    placement = request.get("placement", "surface")
    if placement == "surface":
        return None
    nodes = sorted({n for e in elements for n in e["nodes"]})
    points = np.array([coordinates[n] for n in nodes])
    if placement == "midsurface":
        nearest, distance = _closest_on_faces(geom, points, request["facesB"])
        for n, p, q in zip(nodes, points, nearest):
            coordinates[n] = (p + q) / 2
        return {"placement": "midsurface", "thickness": float(np.median(distance)), "minThickness": float(distance.min()),
                "maxThickness": float(distance.max()), "facesB": request["facesB"]}
    if placement == "offset":
        # Along the surface normal of the faces each node lies on (averaged
        # where faces meet), so an offset of a cylinder stays a cylinder.
        offset = float(request["offset"])
        model = geom.model
        faces_of = {}
        for element in elements:
            for n in element["nodes"]:
                faces_of.setdefault(n, set()).add(element["face"])
        fallback = _node_normals(elements, coordinates)
        for n, p in zip(nodes, points):
            total = np.zeros(3)
            for face in sorted(faces_of[n]):
                uv = model.getParametrization(2, face, list(p))
                normal = np.array(model.getNormal(face, list(uv)), dtype=float)
                if np.dot(normal, fallback[n]) < 0:
                    normal = -normal
                total += normal
            size = np.linalg.norm(total)
            coordinates[n] = p + offset * (total / size if size > 0 else fallback[n])
        return {"placement": "offset", "offset": offset}
    raise ValueError("Place the shell on the faces, at the midsurface, or at an offset.")


def _result(elements, coordinates, reports, edges, faces, mesher, placed=None, pads=None, request=None):
    # Each mesh edge bounds two elements, or one on the rim of the chosen faces.
    uses = {}
    for element in elements:
        ids = element["nodes"]
        for k in range(len(ids)):
            key = tuple(sorted((ids[k], ids[(k + 1) % len(ids)])))
            uses[key] = uses.get(key, 0) + 1
    free = sum(1 for n in uses.values() if n == 1)
    nonmanifold = sum(1 for n in uses.values() if n > 2)
    qualities = [_quality([coordinates[n] for n in e["nodes"]]) for e in elements]
    for report in reports:
        own = [q for q, e in zip(qualities, elements) if e["face"] == report["face"]]
        report["minScaledJacobian"] = min(own) if own else None
    for pad in pads or []:
        ring = [q for q, e in zip(qualities, elements) if e.get("pad") == pad["pad"] and e["face"] == pad["face"]]
        pad["minScaledJacobian"] = min(ring) if ring else None
    histogram = [0] * 10
    for q in qualities:
        histogram[min(9, max(0, int(q * 10)))] += 1
    ordered = sorted(coordinates)
    renumber = {old: new for new, old in enumerate(ordered, start=1)}
    nodes = [{"id": renumber[n], "x": float(coordinates[n][0]), "y": float(coordinates[n][1]), "z": float(coordinates[n][2])} for n in ordered]
    out = [{"id": i, "type": e["type"], "pid": e["pid"], "nodes": [renumber[n] for n in e["nodes"]], **({"zoffs": e["zoffs"]} if "zoffs" in e else {})}
           for i, e in enumerate(elements, start=1)]
    quality = {"elements": len(out), "nodes": len(nodes), "freeEdges": free, "nonManifoldEdges": nonmanifold,
               "minScaledJacobian": min(qualities) if qualities else None,
               "meanScaledJacobian": float(np.mean(qualities)) if qualities else None,
               "histogram": histogram, "faces": reports, "mesher": mesher,
               "oddEdges": sorted(edges.odd) if edges else [],
               "failedFaces": [r["face"] for r in reports if not r["quads"]], "placement": placed or {"placement": "surface"},
               "pads": pads or []}
    _, by_property, _ = _properties(faces, request) if request is not None else ({}, {}, {})
    return {"mesh": {"nodes": nodes, "elements": out}, "quality": quality,
            "thicknessByProperty": {str(pid): t for pid, t in by_property.items()},
            "stats": {"nodes": len(nodes), "elements": len(out), "topology": "quad" if mesher != "geom" else "tri", "dimension": 2, "order": 1,
                      "parts": len({e["pid"] for e in out}), "faces": len(faces)}}


def check_request(request):
    """Refuse a shell request that cannot be meshed, before any geometry is read."""
    element = request.get("element", "quad")
    if element not in ("quad", "tri"):
        raise ValueError("Shell elements are quad or tri.")
    placement = request.get("placement", "surface")
    if placement == "midsurface":
        other = request.get("facesB")
        if not isinstance(other, list) or not other:
            raise ValueError("Pick the faces of the opposite side for the midsurface.")
        if set(other) & set(request.get("faceIds") or []):
            raise ValueError("A face cannot be on both sides of the midsurface.")
    elif placement == "offset":
        offset = request.get("offset")
        if type(offset) not in (int, float) or not math.isfinite(offset):
            raise ValueError("Enter a finite offset distance.")
    elif placement != "surface":
        raise ValueError("Place the shell on the faces, at the midsurface, or at an offset.")
    if request.get("pads") and element != "quad":
        raise ValueError("Pads are rings of quads: mesh with quad elements.")


def finish(geom, request, made):
    """Place a meshed shell (on the faces, at the midsurface or offset) and report it."""
    elements, coordinates, reports, edges, faces, mesher, pads = made
    placed = place(geom, elements, coordinates, request)
    return _result(elements, coordinates, reports, edges, faces, mesher, placed, pads, request)


def check_faces(geom, request):
    """Refuse a midsurface whose opposite side names faces the model does not have."""
    if request.get("placement") == "midsurface":
        existing = {int(tag) for _, tag in geom.model.getEntities(2)}
        if any(type(f) is not int or f not in existing for f in request["facesB"]):
            raise ValueError("Pick the faces of the opposite side for the midsurface.")


def shell_mesh(geom, request):
    """Quad shell mesh of the chosen faces. Triangles are Gmsh's (cad_gmsh_plugin)."""
    check_request(request)
    check_faces(geom, request)
    if request.get("element", "quad") != "quad":
        raise ValueError("Triangle shells come from the Gmsh plugin.")
    return finish(geom, request, quad_shell(geom, request))
