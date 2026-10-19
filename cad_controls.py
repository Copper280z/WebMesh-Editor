"""Local CAD mesh sizing and verified curve division constraints.

Controls refer to the current immutable CAD revision. Copied sweep seeds inherit
controls through geometric matching, including translation along a sweep axis.
Gmsh size fields are documented at https://gmsh.info/doc/texinfo/gmsh.html#Mesh-size-fields
"""

import math


class LocalControls:
    def __init__(self, gmsh, request, geometry):
        self.gmsh, self.size = gmsh, float(request.get("size", 1.5))
        self.default_divisions = request.get("divisions", 6) if request.get("method", "mapped") == "mapped" else None
        self.order = request.get("order", 1)
        self.edges = {edge["id"]: edge for edge in geometry["edges"]}
        self.faces = {face["id"]: face for face in geometry["faces"]}
        self.controls = {}
        self.matches = {}
        self.mapped_faces = set()
        self.background = None
        self.tolerance = max(max(geometry["bounds"][i + 3] - geometry["bounds"][i] for i in range(3)) * 1e-7, 1e-7)
        for name, entities in (("edgeSizes", self.edges), ("faceSizes", self.faces), ("edgeDivisions", self.edges)):
            values = request.get(name, [])
            if not isinstance(values, list) or len(values) > 256:
                raise ValueError(f"{name} must contain at most 256 local controls.")
            by_id = {}
            for item in values:
                if not isinstance(item, dict) or type(item.get("id")) is not int or item["id"] not in entities:
                    raise ValueError(f"{name} must identify existing entities in the current CAD revision.")
                key = "divisions" if name == "edgeDivisions" else "size"
                value = item.get(key)
                if name == "edgeDivisions":
                    if type(value) is not int or not 1 <= value <= 200:
                        raise ValueError("Local edge divisions must be an integer between 1 and 200.")
                elif type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
                    raise ValueError("Local element sizes must be finite positive numbers.")
                if item["id"] in by_id:
                    raise ValueError(f"{name} contains a duplicate entity ID.")
                by_id[item["id"]] = value
            self.controls[name] = by_id
        self.active = any(self.controls.values())
        self.full_quad = any(value % 2 for value in self.controls["edgeDivisions"].values())

    def equivalent(self, original, dimension, tag, axis):
        model = self.gmsh.model
        if original["type"] != model.getType(dimension, tag):
            return False
        bounds = model.getBoundingBox(dimension, tag)
        ignored = "xyz".index(axis) if axis in ("x", "y", "z") else -1
        if any(abs(bounds[i] - original["bounds"][i]) > self.tolerance for i in range(6) if i % 3 != ignored):
            return False
        measure = original["length" if dimension == 1 else "area"]
        return abs(self.gmsh.model.occ.getMass(dimension, tag) - measure) <= max(measure * 1e-7, self.tolerance)

    def apply(self, axis=None, subdivision=1, map_patches=False):
        if not self.active:
            return
        model, field = self.gmsh.model, self.gmsh.model.mesh.field
        self.matches = {edge: [tag for _, tag in model.getEntities(1) if self.equivalent(self.edges[edge], 1, tag, axis)]
                        for edge in set(self.controls["edgeSizes"]) | set(self.controls["edgeDivisions"])
                        | {edge for face in self.controls["faceSizes"] for edge in self.faces[face]["edges"]}}
        fields, sizes = [], [self.size]
        edge_sizes = dict(self.controls["edgeSizes"])
        for face, size in self.controls["faceSizes"].items():
            matches = [tag for _, tag in model.getEntities(2) if self.equivalent(self.faces[face], 2, tag, axis)]
            if not matches and not any(self.matches.get(edge) for edge in self.faces[face]["edges"]):
                raise ValueError(f"Controlled CAD face {face} has no applicable source face or boundary edge in this mesh.")
            if matches:
                constant = field.add("Constant")
                field.setNumbers(constant, "SurfacesList", matches)
                field.setNumber(constant, "VIn", size)
                field.setNumber(constant, "VOut", self.size)
                fields.append(constant)
            for edge in self.faces[face]["edges"]:
                edge_sizes[edge] = min(edge_sizes.get(edge, self.size), size)
            sizes.append(size)
        for edge, size in edge_sizes.items():
            matches = self.matches.get(edge, [])
            if not matches:
                if edge in self.controls["edgeSizes"]:
                    raise ValueError(f"Controlled CAD edge {edge} has no applicable source edge in this mesh.")
                continue
            distance = field.add("Distance")
            field.setNumbers(distance, "CurvesList", matches)
            field.setNumber(distance, "Sampling", 100)
            threshold = field.add("Threshold")
            for name, value in (("InField", distance), ("SizeMin", size), ("SizeMax", self.size),
                                ("DistMin", size), ("DistMax", max(self.size * 2, size * 4))):
                field.setNumber(threshold, name, value)
            fields.append(threshold)
            sizes.append(size)
        if fields:
            minimum = field.add("Min")
            field.setNumbers(minimum, "FieldsList", fields)
            field.setAsBackgroundMesh(minimum)
            self.background = minimum
            self.gmsh.option.setNumber("Mesh.MeshSizeMin", min(sizes))
        requested = self.controls["edgeDivisions"]
        counts = {}
        for edge, count in requested.items():
            if not self.matches[edge]:
                raise ValueError(f"Controlled CAD edge {edge} does not belong to this mesh's source profiles.")
            if subdivision and count % 2:
                raise ValueError("Exact odd edge divisions require a four-sided mapped source patch. Split the geometry around the thin section before meshing.")
            for tag in self.matches[edge]:
                counts[tag] = count // 2 if subdivision else count
        if requested and not subdivision and map_patches:
            patches, parent = {}, {}
            for _, face in model.getEntities(2):
                bounds = model.getBoundingBox(2, face)
                if axis in ("x", "y", "z") and bounds["xyz".index(axis) + 3] - bounds["xyz".index(axis)] > self.tolerance * 3:
                    continue
                _, loops = model.occ.getCurveLoops(face)
                if len(loops) != 1 or len(loops[0]) != 4:
                    continue
                edges = [abs(int(tag)) for tag in loops[0]]
                # Automatic mapping is limited to straight-sided patches.
                # Four native edges can also bound a concave fillet transition;
                # those need an unstructured quad mesh or further preparation.
                straight = True
                for edge in edges:
                    low, high = model.getParametrizationBounds(1, edge)
                    sample = [float(low[0]) + (float(high[0]) - float(low[0])) * fraction for fraction in (0.2, 0.5, 0.8)]
                    if max(map(abs, model.getCurvature(1, edge, sample))) * model.occ.getMass(1, edge) > 1e-6:
                        straight = False
                        break
                if not straight and self.default_divisions is None:
                    continue
                patches[face] = edges
                for edge in edges:
                    parent.setdefault(edge, edge)
            def find(edge):
                while parent[edge] != edge:
                    parent[edge] = parent[parent[edge]]
                    edge = parent[edge]
                return edge
            for edges in patches.values():
                for a, b in ((edges[0], edges[2]), (edges[1], edges[3])):
                    parent[find(a)] = find(b)
            fixed, groups = {}, {}
            for edge in parent:
                groups.setdefault(find(edge), []).append(edge)
                if edge in counts:
                    group = find(edge)
                    if group in fixed and fixed[group] != counts[edge]:
                        raise ValueError("Opposite edges of mapped patches need equal division counts.")
                    fixed[group] = counts[edge]
            for group, edges in groups.items():
                value = fixed.get(group, self.default_divisions or max(1, max(math.ceil(model.occ.getMass(1, edge) / self.size) for edge in edges)))
                for edge in edges:
                    counts[edge] = value
            for face in patches:
                model.mesh.setTransfiniteSurface(face)
                model.mesh.setRecombine(2, face)
                self.mapped_faces.add(face)
            if any(tag not in parent for edge, count in requested.items() if count % 2 for tag in self.matches[edge]):
                raise ValueError("Exact odd edge divisions require four-sided mapped source patches. Partition the thin section first; no rounded division count was accepted.")
        for tag, count in counts.items():
            model.mesh.setTransfiniteCurve(tag, count + 1)
        if counts:
            minimum = min(model.occ.getMass(1, tag) / count for tag, count in counts.items())
            self.gmsh.option.setNumber("Mesh.MeshSizeMin", min(self.gmsh.option.getNumber("Mesh.MeshSizeMin"), minimum))
        if self.default_divisions and requested and map_patches:
            # Exact entity-interior counts include local groups and count shared
            # CAD interfaces once, before any structured mesh allocation.
            nodes, elements = len(model.getEntities(0)), 0
            for _, edge in model.getEntities(1):
                n = counts.get(edge, self.default_divisions)
                nodes += n - 1 + (n if self.order == 2 else 0)
            for face in self.mapped_faces:
                edges = patches[face]
                a, b = counts[edges[0]], counts[edges[1]]
                nodes += (a - 1) * (b - 1)
                if self.order == 2:
                    nodes += a * (b - 1) + b * (a - 1)
            for _, volume in model.getEntities(3):
                edges = {abs(int(edge)) for _, face in model.getBoundary([(3, volume)], oriented=False)
                         for _, edge in model.getBoundary([(2, face)], oriented=False)}
                directions = {find(edge): counts[edge] for edge in edges}
                if len(directions) != 3:
                    raise ValueError("The controlled mapped block does not have three consistent opposite-edge groups.")
                a, b, c = directions.values()
                elements += a * b * c
                nodes += (a - 1) * (b - 1) * (c - 1)
                if self.order == 2:
                    nodes += a * (b - 1) * (c - 1) + b * (a - 1) * (c - 1) + c * (a - 1) * (b - 1)
            if nodes > 500_000 or elements > 500_000:
                raise ValueError(f"Local mapped controls would produce {nodes:,} nodes and {elements:,} elements, exceeding the 500,000 limit before generation.")

    def conform_boundary_counts(self, seed_regions):
        """Preserve requested counts and make every quad patch boundary even.

        Mapped opposite edges form equality groups. Free groups may gain one
        segment to satisfy the shared faces' parity equations; fixed user counts
        never change. Solving all patches together avoids one patch repairing its
        parity by breaking its neighbor's shared interface.
        """
        model = self.gmsh.model
        model.mesh.generate(1)
        face_edges = {face: [abs(int(edge)) for loop in model.occ.getCurveLoops(face)[1] for edge in loop]
                      for _, face in seed_regions}
        parent = {edge: edge for edges in face_edges.values() for edge in edges}
        def find(edge):
            while parent[edge] != edge:
                parent[edge] = parent[parent[edge]]
                edge = parent[edge]
            return edge
        for face in self.mapped_faces:
            edges = face_edges[face]
            for a, b in ((edges[0], edges[2]), (edges[1], edges[3])):
                parent[find(a)] = find(b)
        groups = {}
        for edge in parent:
            groups.setdefault(find(edge), []).append(edge)
        fixed = {}
        for edge, divisions in self.controls["edgeDivisions"].items():
            for tag in self.matches[edge]:
                group = find(tag)
                if group in fixed and fixed[group] != divisions:
                    raise ValueError("Mapped patch interfaces require matching opposite edge division counts.")
                fixed[group] = divisions
        counts = {}
        for group, edges in groups.items():
            value = max(sum(len(tags) for tags in model.mesh.getElements(1, edge)[1]) for edge in edges)
            for edge in edges:
                try:
                    low, high = model.getParametrizationBounds(1, edge)
                    sample = [float(low[0]) + (float(high[0]) - float(low[0])) * fraction for fraction in (0.2, 0.5, 0.8)]
                    curvature = max(map(abs, model.getCurvature(1, edge, sample)))
                    value = max(value, min(200, math.ceil(model.occ.getMass(1, edge) * curvature * 12 / math.pi)))
                except Exception:
                    pass
            counts[group] = fixed.get(group, value + value % 2)
        variables = {group: index for index, group in enumerate(group for group in groups if group not in fixed)}
        pivots = {}
        for face, edges in face_edges.items():
            mask, parity = 0, 0
            for edge in edges:
                group = find(edge)
                parity ^= counts[group] % 2
                if group in variables:
                    mask ^= 1 << variables[group]
            while mask:
                pivot = (mask & -mask).bit_length() - 1
                if pivot not in pivots:
                    pivots[pivot] = (mask, parity)
                    break
                previous, value = pivots[pivot]
                mask ^= previous
                parity ^= value
            if not mask and parity:
                raise ValueError(f"Exact edge counts give CAD face {face} an odd boundary. Match the opposite interface divisions or add a mapped partition.")
        solution = 0
        for pivot in sorted(pivots, reverse=True):
            mask, parity = pivots[pivot]
            value = parity ^ ((mask & ~(1 << pivot) & solution).bit_count() % 2)
            if value:
                solution |= 1 << pivot
        model.mesh.clear()
        point_sizes, local_edges = {}, {}
        for group, edges in groups.items():
            count = counts[group] + (int(bool(solution & (1 << variables[group]))) if group in variables else 0)
            for edge in edges:
                model.mesh.setTransfiniteCurve(edge, count + 1)
                spacing = model.occ.getMass(1, edge) / count
                if spacing < self.size * 0.75:
                    local_edges.setdefault(float(f"{spacing:.3g}"), []).append(edge)
                for _, point in model.getBoundary([(1, edge)], oriented=False):
                    point_sizes[point] = min(point_sizes.get(point, self.size), spacing)
        if point_sizes:
            for point, spacing in point_sizes.items():
                model.mesh.setSize([(0, point)], spacing)
            self.gmsh.option.setNumber("Mesh.MeshSizeMin", min(self.gmsh.option.getNumber("Mesh.MeshSizeMin"), min(point_sizes.values())))
        if local_edges:
            field, fields = model.mesh.field, []
            if self.background is not None:
                fields.append(self.background)
            for spacing, edges in local_edges.items():
                distance = field.add("Distance")
                field.setNumbers(distance, "CurvesList", edges)
                field.setNumber(distance, "Sampling", 100)
                threshold = field.add("Threshold")
                for name, value in (("InField", distance), ("SizeMin", spacing), ("SizeMax", self.size),
                                    ("DistMin", spacing), ("DistMax", max(spacing * 5, self.size))):
                    field.setNumber(threshold, name, value)
                fields.append(threshold)
            minimum = field.add("Min")
            field.setNumbers(minimum, "FieldsList", fields)
            field.setAsBackgroundMesh(minimum)
            self.background = minimum

    def report(self):
        result = []
        for edge, requested in self.controls["edgeDivisions"].items():
            achieved = sorted({sum(len(tags) for tags in self.gmsh.model.mesh.getElements(1, tag)[1]) for tag in self.matches.get(edge, [])})
            if achieved != [requested]:
                raise ValueError(f"CAD edge {edge} requested exactly {requested} divisions but achieved {achieved}. Partition a compatible mapped patch; no rounded count was accepted.")
            result.append({"id": edge, "requested": requested, "achieved": requested})
        return result
