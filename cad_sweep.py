"""Mapped and swept CAD meshing with exact geometry and mesh validation.

A sweep is permitted only when the proposed extrusion is geometrically equivalent
to the current prepared CAD. Symmetric OpenCASCADE Boolean differences check this;
matching mass alone is insufficient. No model-specific features or IDs are used.
"""

import math


def difference_volume(gmsh, left, right):
    occ = gmsh.model.occ
    objects, tools = occ.copy(left), occ.copy(right)
    result, _ = occ.cut(objects, tools, removeObject=True, removeTool=True)
    mass = sum(occ.getMass(dimension, tag) for dimension, tag in result if dimension == 3)
    if result:
        occ.remove(result, recursive=True)
    occ.synchronize()
    return float(mass)


def connected_components(gmsh, dimension):
    """Count components joined by full element faces (edges for shells)."""
    types, _, connectivity = gmsh.model.mesh.getElements(dimension)
    templates = {2: (3, [(0, 1), (1, 2), (2, 0)]), 9: (6, [(0, 1), (1, 2), (2, 0)]),
                 3: (4, [(0, 1), (1, 2), (2, 3), (3, 0)]), 16: (8, [(0, 1), (1, 2), (2, 3), (3, 0)]),
                 4: (4, [(0, 1, 2), (0, 1, 3), (1, 2, 3), (0, 2, 3)]),
                 11: (10, [(0, 1, 2), (0, 1, 3), (1, 2, 3), (0, 2, 3)]),
                 5: (8, [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]),
                 17: (20, [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])}
    midsides = {9: [(0, 1, 3), (1, 2, 4), (2, 0, 5)],
                16: [(0, 1, 4), (1, 2, 5), (2, 3, 6), (3, 0, 7)],
                11: [(0, 1, 4), (1, 2, 5), (2, 0, 6), (0, 3, 7), (2, 3, 8), (1, 3, 9)],
                17: [(0, 1, 8), (0, 3, 9), (0, 4, 10), (1, 2, 11), (1, 5, 12), (2, 3, 13),
                     (2, 6, 14), (3, 7, 15), (4, 5, 16), (4, 7, 17), (5, 6, 18), (6, 7, 19)]}
    parents, owners, counts, face_midsides = [], {}, {}, {}
    quadratic = False

    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for kind, raw in zip(types, connectivity):
        if int(kind) not in templates:
            raise ValueError("The mesh contains an unexpected element topology.")
        count, faces = templates[int(kind)]
        edge_slots = {tuple(sorted((a, b))): mid for a, b, mid in midsides.get(int(kind), [])}
        quadratic = quadratic or bool(edge_slots)
        for start in range(0, len(raw), count):
            element = len(parents)
            parents.append(element)
            for face in faces:
                key = tuple(sorted(int(raw[start + i]) for i in face))
                # Compare the node assigned to each shared edge, rather than only
                # its corner nodes or the unordered set of face nodes. This also
                # detects midside nodes swapped between edges of a shared face.
                signature = []
                edge_pairs = [(face[0], face[1])] if len(face) == 2 else [(face[i], face[(i + 1) % len(face)]) for i in range(len(face))]
                for a, b in edge_pairs:
                    slot = edge_slots.get(tuple(sorted((a, b))))
                    if slot is not None:
                        endpoints = sorted((int(raw[start + a]), int(raw[start + b])))
                        signature.append((*endpoints, int(raw[start + slot])))
                signature = tuple(sorted(signature))
                counts[key] = counts.get(key, 0) + 1
                if key in owners:
                    if face_midsides[key] != signature:
                        raise ValueError("The mesh has a nonconforming shared interface: quadratic midside node IDs do not match by edge.")
                    parents[find(element)] = find(owners[key])
                else:
                    owners[key] = element
                    face_midsides[key] = signature
    nonmanifold = sum(value > 2 for value in counts.values())
    if nonmanifold:
        raise ValueError(f"The mesh has {nonmanifold} non-manifold interfaces.")
    return {"components": len({find(i) for i in range(len(parents))}),
            "boundaryFaces": sum(value == 1 for value in counts.values()), "nonManifoldFaces": nonmanifold,
            "conformingInterfaces": sum(value == 2 for value in counts.values()),
            "midsideConformityChecked": quadratic, "nonConformingFaces": 0}


def cad_components(volumes):
    """Count solid regions connected through shared CAD faces."""
    parents = list(range(len(volumes)))
    owners = {}
    def find(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index
    for index, volume in enumerate(volumes):
        for face in volume["faces"]:
            if face in owners:
                parents[find(index)] = find(owners[face])
            else:
                owners[face] = index
    return len({find(i) for i in range(len(volumes))})


def improve_quadratic_hexes(gmsh, dimension, element_tags):
    """Repair coarse curved hexes without adding elements or changing CAD.

    Gmsh's high-order optimizer moves nodes in their CAD parametrizations. Its
    bounded nonlinear pass is used only for poor quadratic hexes; final adaptive
    Jacobian and shared-node checks remain mandatory.
    https://gmsh.info/doc/texinfo/gmsh.html#Mesh-options
    """
    tags = [int(tag) for group in element_tags for tag in group]
    initial = min(map(float, gmsh.model.mesh.getElementQualities(tags, "minSJ")))
    if initial >= 0.1:
        return None
    for option, value in (("Mesh.HighOrderThresholdMin", 0.3), ("Mesh.HighOrderIterMax", 30),
                          ("Mesh.HighOrderPassMax", 5)):
        gmsh.option.setNumber(option, value)
    try:
        gmsh.model.mesh.optimize("HighOrder")
    except Exception:
        # The optimizer's internal target can be stricter than the public gate.
        # Accept only the independently recomputed final metric below.
        pass
    final = min(map(float, gmsh.model.mesh.getElementQualities(tags, "minSJ")))
    if not math.isfinite(final) or final < 0.1:
        raise ValueError(f"The quadratic hex mesh remains poorly shaped after high-order optimization (minimum scaled Jacobian {final:g}). Refine its curved edges or reduce the surface size.")
    return {"method": "HighOrder", "initialMinScaledJacobian": initial, "finalMinScaledJacobian": final}


def layered_sweep(gmsh, request, geometry, original, controls):
    """Sweep reviewed column occupancies through explicit planar intervals.

    All projected seed regions share the same 2D subdivision at every level.
    Empty intervals use temporary support extrusions, whose volume elements are
    discarded after order elevation. This preserves conformity when material
    restarts above a transverse opening without filling that opening in the mesh.
    """
    model, occ = gmsh.model, gmsh.model.occ
    axis = request.get("axis")
    plans = [plan for plan in geometry.get("layeredSweeps", []) if plan["axis"] == axis]
    if not plans:
        raise ValueError("No constant-section sweep columns were found on this axis. Project-partition planar ledges, passage floors or ceilings, then review the detected column intervals.")
    plan = plans[0]
    intervals = plan["intervals"]
    counts = request.get("layerCounts")
    if not isinstance(counts, list) or len(counts) != len(intervals) or any(type(n) is not int or not 1 <= n <= 80 for n in counts):
        raise ValueError(f"Specify one integer layer count (1–80) for each of the {len(intervals)} detected intervals.")
    if len(plan["columns"]) > 64 or len(intervals) > 24 or sum(counts) > 240:
        raise ValueError("The layered sweep exceeds the region/layer limit. Prepare fewer columns or reduce the layer counts.")
    coordinate = "xyz".index(axis)
    base = plan["levels"][0]
    seeds = []
    for column in plan["columns"]:
        copy = occ.copy([(2, column["sourceFace"])])
        vector = [0.0] * 3
        vector[coordinate] = base - column["min"]
        occ.translate(copy, *vector)
        seeds.extend(copy)
    if len(seeds) > 1:
        fragments, mapping = occ.fragment(seeds[:1], seeds[1:], removeObject=True, removeTool=True)
        seed_regions = [entity for entity in fragments if entity[0] == 2]
        column_seeds = {column["volumeId"]: {int(tag) for dimension, tag in group if dimension == 2}
                        for column, group in zip(plan["columns"], mapping)}
    else:
        seed_regions = seeds
        column_seeds = {plan["columns"][0]["volumeId"]: {seeds[0][1]}}
    occ.synchronize()
    caps = {tag: tag for _, tag in seed_regions}
    swept, empty, source_caps = [], [], set(caps.values())
    tolerance = max((plan["levels"][-1] - base) * 1e-6, 1e-7)
    for interval, layers in zip(intervals, counts):
        active = set().union(*(column_seeds[volume] for volume in interval["volumeIds"]))
        sources = [(2, caps[tag]) for tag in sorted(caps)]
        lookup = {caps[tag]: tag for tag in caps}
        vector = [0.0] * 3
        vector[coordinate] = interval["end"] - interval["start"]
        output = occ.extrude(sources, *vector, numElements=[layers], recombine=True)
        occ.synchronize()
        volumes = [(dimension, tag) for dimension, tag in output if dimension == 3]
        if len(volumes) != len(caps):
            raise ValueError("A layered interval did not create one solid per projected seed region.")
        for volume in volumes:
            boundary = [tag for _, tag in model.getBoundary([volume], oriented=False)]
            bottom = [tag for tag in boundary if tag in lookup]
            top = [tag for tag in boundary
                   if abs(model.getBoundingBox(2, tag)[coordinate] - interval["end"]) < tolerance
                   and abs(model.getBoundingBox(2, tag)[coordinate + 3] - interval["end"]) < tolerance]
            if len(bottom) != 1 or len(top) != 1:
                raise ValueError("Could not trace a unique shared source/target face through the layered interval.")
            caps[lookup[bottom[0]]] = top[0]
            source_caps.add(top[0])
            (swept if lookup[bottom[0]] in active else empty).append(volume)
    removed, added = difference_volume(gmsh, original, swept), difference_volume(gmsh, swept, original)
    volume_tolerance = max(geometry["volume"] * 1e-7, 1e-8)
    if removed > volume_tolerance or added > volume_tolerance:
        raise ValueError(f"The layered sweep would change prepared CAD (missing volume {removed:g}, added volume {added:g}). Repartition the geometry first.")
    if controls.full_quad:
        from cad_mesh_extrusion import extrude_seed_mesh
        optimization = extrude_seed_mesh(gmsh, plan, seed_regions, column_seeds, counts, controls, request.get("order", 1))
        return {"method": "layered", "originalVolume": geometry["volume"], "missingVolume": removed,
                "addedVolume": added, "tolerance": volume_tolerance, "axis": axis,
                "levels": plan["levels"], "layerCounts": counts, "columns": plan["columns"],
                "_orderReady": True, "_sourceOptimization": optimization}
    occ.remove(original, recursive=True)
    occ.synchronize()
    for tag in source_caps:
        model.mesh.setRecombine(2, tag)
    gmsh.option.setNumber("Mesh.Algorithm", 8)
    gmsh.option.setNumber("Mesh.RecombinationAlgorithm", 3 if controls.full_quad else 1)
    gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", 0 if controls.full_quad else 1)
    controls.apply(axis, subdivision=0 if controls.full_quad else 1, map_patches=True)
    model.mesh.generate(2)
    model.mesh.generate(3)
    return {"method": "layered", "originalVolume": geometry["volume"], "missingVolume": removed,
            "addedVolume": added, "tolerance": volume_tolerance, "axis": axis,
            "levels": plan["levels"], "layerCounts": counts, "columns": plan["columns"],
            "_emptyVolumes": [tag for _, tag in empty]}


def generate(gmsh, request, topology, quality):
    model, occ = gmsh.model, gmsh.model.occ
    kind, order, size = request.get("topology", "hex"), request.get("order", 1), request.get("size", 1.5)
    if kind not in {"tri", "quad", "tet", "hex"} or type(order) is not int or order not in (1, 2):
        raise ValueError("Choose a supported topology and element order.")
    if type(size) not in (int, float) or not math.isfinite(size) or size <= 0:
        raise ValueError("Element size must be a finite positive number.")
    dimension = 2 if kind in {"tri", "quad"} else 3
    original = model.getEntities(3)
    geometry = topology(gmsh)
    from cad_controls import LocalControls
    controls = LocalControls(gmsh, request, geometry)
    fidelity = None
    for option, value in (("Mesh.MeshSizeMin", size), ("Mesh.MeshSizeMax", size),
                          ("Mesh.SecondOrderIncomplete", 1), ("Mesh.ElementOrder", 1)):
        gmsh.option.setNumber(option, value)
    if kind == "hex" and request.get("method") == "layered":
        fidelity = layered_sweep(gmsh, request, geometry, original, controls)
    elif kind == "hex" and request.get("method", "mapped") == "sweep":
        if len(original) != 1:
            raise ValueError("Sweep one connected prepared solid at a time. Use mapped hexes for a partitioned block assembly.")
        source = request.get("sourceFace")
        target = request.get("targetFace")
        valid_faces = {face["id"] for face in geometry["faces"]}
        if source is not None and (type(source) is not int or source not in valid_faces):
            raise ValueError("Source face ID must be a positive integer identifying an existing CAD face.")
        if target is not None and (type(target) is not int or target not in valid_faces or target == source):
            raise ValueError("Choose a different numeric target face ID, or leave it blank for detection.")
        candidates = geometry["sweepCandidates"]
        if source is not None:
            if type(source) is not int:
                raise ValueError("Choose a numeric source face ID.")
            candidates = [candidate for candidate in candidates if source in (candidate["sourceFace"], candidate["targetFace"])]
        if target is not None:
            candidates = [candidate for candidate in candidates if target in (candidate["sourceFace"], candidate["targetFace"])]
        if not candidates:
            raise ValueError("No matching translated end faces were found. Remove transverse holes/bosses or split the solid into sweepable regions.")
        by_id = {face["id"]: face for face in geometry["faces"]}
        candidate = max(candidates, key=lambda c: by_id[c["sourceFace"]]["area"])
        source = source if source is not None else candidate["sourceFace"]
        vector = candidate["vector"] if source == candidate["sourceFace"] else [-v for v in candidate["vector"]]
        layers = request.get("layers", max(1, math.ceil(candidate["distance"] / size)))
        if type(layers) is not int or not 1 <= layers <= 100:
            raise ValueError("Sweep layers must be an integer between 1 and 100.")
        seed = occ.copy([(2, source)])
        output = occ.extrude(seed, *vector, numElements=[layers], recombine=True)
        swept = [(d, t) for d, t in output if d == 3]
        occ.synchronize()
        if not swept:
            raise ValueError("The selected source face did not create a valid swept solid.")
        removed = difference_volume(gmsh, original, swept)
        added = difference_volume(gmsh, swept, original)
        original_volume = geometry["volume"]
        tolerance = max(original_volume * 1e-7, 1e-8)
        if removed > tolerance or added > tolerance:
            raise ValueError(f"This sweep would change prepared CAD geometry (missing volume {removed:g}, added volume {added:g}). Prepare or partition the solid first.")
        fidelity = {"originalVolume": original_volume, "missingVolume": removed, "addedVolume": added,
                    "tolerance": tolerance, "sourceFace": source, "vector": vector, "layers": layers}
        occ.remove(original, recursive=True)
        occ.synchronize()
        gmsh.option.setNumber("Mesh.Algorithm", 8)
        gmsh.option.setNumber("Mesh.RecombinationAlgorithm", 3 if controls.full_quad else 1)
        gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", 0 if controls.full_quad else 1)
        sweep_axis = next(("xyz"[i] for i in range(3) if abs(vector[i]) > 1e-7 and all(abs(vector[j]) < 1e-7 for j in range(3) if j != i)), None)
        controls.apply(sweep_axis, subdivision=0 if controls.full_quad else 1, map_patches=True)
        model.mesh.setRecombine(2, seed[0][1])
        # The 2D stage applies all-quad subdivision before the 3D extrusion.
        # Calling generate(3) alone can leave prism elements on the sweep.
        model.mesh.generate(2)
        model.mesh.generate(3)
    else:
        if kind == "hex":
            if not original or not all(volume["mapped"] for volume in geometry["volumes"]):
                raise ValueError("Mapped hex meshing requires six-face, four-edge-face blocks. Split the CAD into compatible blocks, or use a validated source-face sweep.")
            divisions = request.get("divisions", 6)
            if type(divisions) is not int or not 1 <= divisions <= 80:
                raise ValueError("Mapped curve divisions must be between 1 and 80.")
            # Uniform transfinite blocks have an exact count before meshing.
            # Shared CAD edges/faces are counted once, including quadratic edge
            # nodes, so connected block assemblies are not overestimated.
            vertices, curves, surfaces, cells = [len(model.getEntities(d)) for d in range(4)]
            interior = divisions - 1
            predicted_elements = cells * divisions ** 3
            predicted_nodes = vertices + curves * interior + surfaces * interior ** 2 + cells * interior ** 3
            if order == 2:
                predicted_nodes += (curves * divisions + surfaces * 2 * divisions * interior
                                    + cells * 3 * divisions * interior ** 2)
            if predicted_elements > 500_000 or predicted_nodes > 500_000:
                raise ValueError(f"The mapped mesh would contain {predicted_nodes:,} nodes and {predicted_elements:,} elements, exceeding the 500,000 limit before generation. Reduce curve divisions.")
            for _, tag in model.getEntities(1):
                model.mesh.setTransfiniteCurve(tag, divisions + 1)
            for _, tag in model.getEntities(2):
                model.mesh.setTransfiniteSurface(tag)
                model.mesh.setRecombine(2, tag)
            for _, tag in original:
                model.mesh.setTransfiniteVolume(tag)
        elif kind == "quad":
            gmsh.option.setNumber("Mesh.Algorithm", 8)
            gmsh.option.setNumber("Mesh.RecombinationAlgorithm", 1)
            gmsh.option.setNumber("Mesh.SubdivisionAlgorithm", 1)
            for _, tag in model.getEntities(2):
                model.mesh.setRecombine(2, tag)
        controls.apply(subdivision=0 if kind in {"tri", "tet", "hex"} else 1, map_patches=kind == "hex")
        model.mesh.generate(dimension)
    order_ready = fidelity.pop("_orderReady", False) if fidelity else False
    source_optimization = fidelity.pop("_sourceOptimization", None) if fidelity else None
    if order == 2 and not order_ready:
        model.mesh.setOrder(2)
    if fidelity:
        for tag in fidelity.pop("_emptyVolumes", []):
            # removeElements removes only this volume's 3D elements; shared
            # boundary/midside nodes remain available to adjacent solid elements.
            # Unreferenced support nodes are omitted by the MSH2 importer.
            model.mesh.removeElements(3, tag)
    expected = {("tri", 1): 2, ("tri", 2): 9, ("quad", 1): 3, ("quad", 2): 16,
                ("tet", 1): 4, ("tet", 2): 11, ("hex", 1): 5, ("hex", 2): 17}[kind, order]
    kinds, tags, _ = model.mesh.getElements(dimension)
    if not len(kinds) or any(int(value) != expected for value in kinds):
        raise ValueError(f"Requested pure {kind} elements, but the geometry produced other topologies. Repartition the CAD; no fallback mesh was accepted.")
    if sum(len(group) for group in tags) > 500_000 or len(model.mesh.getNodes()[0]) > 500_000:
        raise ValueError("The mesh exceeds 500,000 nodes or elements. Increase the target size or reduce layers.")
    optimization = improve_quadratic_hexes(gmsh, dimension, tags) if kind == "hex" and order == 2 and not order_ready else source_optimization
    checks = quality(gmsh, dimension)
    if order_ready and order == 2 and checks["minScaledJacobian"] < 0.1:
        raise ValueError("The controlled quadratic source mesh remains poorly shaped. Refine the curved source edges before extrusion.")
    if optimization:
        checks["optimization"] = optimization
    checks["achievedEdgeDivisions"] = controls.report()
    checks.update(connected_components(gmsh, dimension))
    expected_components = cad_components(geometry["volumes"])
    if dimension == 3 and expected_components and checks["components"] != expected_components:
        raise ValueError(f"The mesh has {checks['components']} components but CAD has {expected_components} face-connected regions. No disconnected mesh was accepted.")
    checks["cadComponents"] = expected_components
    if fidelity:
        checks["cadEquivalence"] = fidelity
    gmsh.option.setNumber("Mesh.MshFileVersion", 2.2)
    gmsh.option.setNumber("Mesh.Binary", 0)
    gmsh.option.setNumber("Mesh.SaveAll", 1)
    gmsh.write("mesh.msh")
    return {"quality": checks}
