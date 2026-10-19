"""Conforming explicit extrusion of mixed mapped/unstructured all-quad seeds.

Gmsh's quasi-structured quadrilateral mesher can change an extruded face's node
layout after OCC extrusion constraints are recorded. Meshing planar seeds first
and sharing explicit layer node maps avoids those stale extrusion references.
"""

import json
import os


def extrude_seed_mesh(gmsh, plan, seed_regions, column_seeds, counts, controls, order):
    from cad_sweep import improve_quadratic_hexes
    model, occ = gmsh.model, gmsh.model.occ
    axis = "xyz".index(plan["axis"])
    seeds = {tag for _, tag in seed_regions}
    occ.remove(model.getEntities(3), recursive=False)
    occ.synchronize()
    occ.remove([entity for entity in model.getEntities(2) if entity[1] not in seeds], recursive=False)
    occ.synchronize()
    for dimension in (1, 0):
        unused = [entity for entity in model.getEntities(dimension) if not len(model.getAdjacencies(*entity)[0])]
        if unused:
            occ.remove(unused, recursive=False)
            occ.synchronize()
    gmsh.option.setNumber("Mesh.Algorithm", 8)
    gmsh.option.setNumber("Mesh.RecombinationAlgorithm", 1)
    gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", 0)
    controls.apply(plan["axis"], subdivision=0, map_patches=True)
    controls.conform_boundary_counts(seed_regions)
    # MeshAdapt preserves the shared constrained boundary mesh. Global full-quad
    # subdivision would double mapped counts, including an explicitly chosen 3.
    gmsh.option.setNumber("Mesh.RecombineMinimumQuality", 0.01)
    gmsh.option.setNumber("Mesh.RecombineOptimizeTopology", 20)
    def invalid_faces(expected, minimum_scaled):
        invalid, diagnostics = set(), []
        for _, face in seed_regions:
            kinds, face_tags, _ = model.mesh.getElements(2, face)
            ids = [int(tag) for group in face_tags for tag in group]
            determinant = min(map(float, model.mesh.getElementQualities(ids, "minDetJac"))) if ids else 0
            scaled = min(map(float, model.mesh.getElementQualities(ids, "minSJ"))) if ids else 0
            if not ids or any(int(kind) != expected for kind in kinds) or determinant <= 0 or scaled < minimum_scaled:
                invalid.add(face)
                diagnostics.append({"sourceFaces": [column["sourceFace"] for column in plan["columns"] if face in column_seeds[column["volumeId"]]],
                                    "types": list(map(int, kinds)), "counts": list(map(len, face_tags)),
                                    "minDetJac": determinant, "minScaledJacobian": scaled})
        return invalid, diagnostics

    optimization = None
    for refinement in range(5):
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        model.mesh.clear()
        for _, face in seed_regions:
            if face not in controls.mapped_faces:
                model.mesh.setAlgorithm(2, face, 1)
            model.mesh.setRecombine(2, face)
        model.mesh.generate(2)
        linear_kinds, _, _ = model.mesh.getElements(2)
        pure_linear = len(linear_kinds) and all(int(kind) == 3 for kind in linear_kinds)
        if pure_linear:
            # Smoothing while the source is linear avoids warped quadratic
            # transition cells; all CAD boundary nodes/counts remain fixed.
            model.mesh.optimize("Laplace2D", force=True, niter=20)
        bad, diagnostics = invalid_faces(3, 0.12)
        if not bad and order == 2:
            model.mesh.setOrder(2)
            _, tags, _ = model.mesh.getElements(2)
            try:
                optimization = improve_quadratic_hexes(gmsh, 2, tags)
            except ValueError:
                optimization = None
            bad, diagnostics = invalid_faces(16, 0.1)
        if os.environ.get("WEBMESH_CAD_DEBUG"):
            print(json.dumps({"algorithm": 1, "refinement": refinement, "invalid": diagnostics}), flush=True)
        if not bad:
            break
        # Refine only troublesome transition patches, keeping bulk targets and
        # the explicit mapped interface counts. No global subdivision is used.
        field = model.mesh.field
        local = field.add("Constant")
        field.setNumbers(local, "SurfacesList", sorted(bad))
        field.setNumber(local, "IncludeBoundary", 0)
        field.setNumber(local, "VIn", controls.size / 2 ** (refinement + 1))
        field.setNumber(local, "VOut", controls.size)
        if controls.background is not None:
            combined = field.add("Min")
            field.setNumbers(combined, "FieldsList", [controls.background, local])
            local = combined
        controls.background = local
        field.setAsBackgroundMesh(local)
        gmsh.option.setNumber("Mesh.MeshSizeMin", min(gmsh.option.getNumber("Mesh.MeshSizeMin"), controls.size / 2 ** (refinement + 1)))
        # A failed curved transition may need more arc segments as well as
        # interior nodes. Explicit user counts remain fixed in the parity solve.
        fixed = {tag for edge in controls.controls["edgeDivisions"] for tag in controls.matches[edge]}
        curved = set()
        for face in bad if pure_linear and refinement >= 2 else ():
            for _, edge in model.getBoundary([(2, face)], oriented=False):
                if edge in fixed:
                    continue
                low, high = model.getParametrizationBounds(1, edge)
                midpoint = [(float(low[0]) + float(high[0])) / 2]
                if max(map(abs, model.getCurvature(1, edge, midpoint))) * occ.getMass(1, edge) > 1e-6:
                    count = sum(len(tags) for tags in model.mesh.getElements(1, edge)[1])
                    model.mesh.setTransfiniteCurve(edge, min(200, count * 2) + 1)
                    curved.add(edge)
        if curved:
            model.mesh.clear()
            controls.conform_boundary_counts(seed_regions)
    else:
        profiles = sorted({column["sourceFace"] for column in plan["columns"] if column_seeds[column["volumeId"]] & bad})
        raise ValueError(f"The controlled source profiles did not produce valid pure quadrilaterals. Partition or refine source faces {profiles}; no mixed or folded mesh was accepted.")
    controls.report()
    quads = {}
    for _, face in seed_regions:
        _, _, groups = model.mesh.getElements(2, face)
        raw = list(map(int, groups[0]))
        width = 8 if order == 2 else 4
        quads[face] = [raw[i:i + width] for i in range(0, len(raw), width)]
    count = sum(len(quads[face]) * layers for interval, layers in zip(plan["intervals"], counts)
                for face in set().union(*(column_seeds[volume] for volume in interval["volumeIds"])))
    if count > 500_000:
        raise ValueError("The controlled extrusion would exceed 500,000 elements. Reduce local divisions or layers.")
    ids, flat, _ = model.mesh.getNodes()
    coordinates = {int(tag): list(map(float, flat[3 * i:3 * i + 3])) for i, tag in enumerate(ids)}
    base = plan["levels"][0]
    levels = [base]
    for interval, layers in zip(plan["intervals"], counts):
        levels.extend(interval["start"] + (interval["end"] - interval["start"]) * step / layers for step in range(1, layers + 1))
    level_nodes, new_ids, new_xyz = {}, [], []
    next_node = max(map(int, ids), default=0) + 1
    def node(source, level):
        nonlocal next_node
        key = (source, level)
        if key not in level_nodes:
            if len(new_ids) >= 500_000:
                raise ValueError("The controlled extrusion would exceed 500,000 nodes. Reduce local divisions or layers.")
            point = list(coordinates[source])
            point[axis] += level - base
            level_nodes[key] = next_node
            new_ids.append(next_node)
            new_xyz.extend(point)
            next_node += 1
        return level_nodes[key]
    groups, step_index = [], 0
    for interval, layers in zip(plan["intervals"], counts):
        active = set().union(*(column_seeds[volume] for volume in interval["volumeIds"]))
        for face in sorted(active):
            connectivity = []
            for step in range(step_index, step_index + layers):
                low, high = levels[step], levels[step + 1]
                for quad in quads[face]:
                    # Gmsh uses clockwise local faces for some CAD normals.
                    # Keep the sweep orientation right-handed for either axis.
                    q = list(quad)
                    a, b, c = (coordinates[q[i]] for i in (0, 1, 2))
                    normal = (b[(axis + 1) % 3] - a[(axis + 1) % 3]) * (c[(axis + 2) % 3] - a[(axis + 2) % 3]) - (b[(axis + 2) % 3] - a[(axis + 2) % 3]) * (c[(axis + 1) % 3] - a[(axis + 1) % 3])
                    if normal < 0:
                        q = [q[i] for i in ([0, 3, 2, 1, 7, 6, 5, 4] if order == 2 else [0, 3, 2, 1])]
                    corners = [node(tag, low) for tag in q[:4]] + [node(tag, high) for tag in q[:4]]
                    if order == 2:
                        bottom = [node(tag, low) for tag in q[4:8]]
                        top = [node(tag, high) for tag in q[4:8]]
                        vertical = [node(tag, (low + high) / 2) for tag in q[:4]]
                        # Gmsh HEX20 edge order (converted to Nastran on import).
                        corners += [bottom[0], bottom[3], vertical[0], bottom[1], vertical[1], bottom[2], vertical[2], vertical[3], top[0], top[3], top[1], top[2]]
                    connectivity.extend(corners)
            groups.append((model.addDiscreteEntity(3), connectivity))
        step_index += layers
    if len(new_ids) > 500_000:
        raise ValueError("The controlled extrusion would exceed 500,000 nodes. Reduce local divisions or layers.")
    model.mesh.addNodes(3, groups[0][0], new_ids, new_xyz)
    for volume, connectivity in groups:
        model.mesh.addElementsByType(volume, 17 if order == 2 else 5, [], connectivity)
    return optimization
