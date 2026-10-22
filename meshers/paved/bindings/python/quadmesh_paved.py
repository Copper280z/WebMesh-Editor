"""Standard-library ctypes binding for the paved mesher's C ABI.

The ABI is the quadtree mesher's (quadmesh.h, ABI 0.2), so this binding also
works with libquadmesh_core built as a shared library, and the quadtree
mesher's own binding works with libquadmesh_paved.

    from quadmesh_paved import Mesher
    m = Mesher("zig-out/lib/libquadmesh_paved.dylib")
    out = m.mesh([{"points": [(0, 0), (40, 0), (40, 20), (0, 20)]}], target_size=4)
"""
import ctypes as C


class Point(C.Structure):
    _fields_ = [("x", C.c_double), ("y", C.c_double)]


class Quad(C.Structure):
    _fields_ = [("nodes", C.c_uint32 * 4)]


class Sample(C.Structure):
    _fields_ = [("arc_fraction", C.c_double), ("target_cell_size", C.c_double)]


class BoundaryNode(C.Structure):
    _fields_ = [("node", C.c_uint32), ("loop", C.c_uint32), ("segment", C.c_uint32),
                ("fixed_run", C.c_int32), ("fixed_node", C.c_int32),
                ("reserved", C.c_uint32), ("parameter", C.c_double)]


class BoundaryEdge(C.Structure):
    _fields_ = [("node_a", C.c_uint32), ("node_b", C.c_uint32), ("loop", C.c_uint32),
                ("segment", C.c_uint32), ("fixed_run", C.c_int32), ("fixed_edge", C.c_int32),
                ("parameter_start", C.c_double), ("parameter_end", C.c_double)]


class Quality(C.Structure):
    _fields_ = [("min_jacobian", C.c_double), ("min_scaled_jacobian", C.c_double)]


class Summary(C.Structure):
    _fields_ = [(name, C.c_double) for name in
                ("min_angle", "max_angle", "min_scaled_jacobian", "min_edge_ratio", "max_boundary_deviation")]


class PavedQuality(C.Structure):
    _fields_ = [(name, C.c_double) for name in
                ("min_angle", "max_angle", "min_scaled_jacobian", "p5_scaled_jacobian",
                 "share_scaled_jacobian_05", "irregular_share", "min_edge_ratio",
                 "max_boundary_deviation")] + \
               [(name, C.c_uint32) for name in
                ("quad_count", "node_count", "interior_nodes", "irregular_nodes", "inverted")] + \
               [(name, C.c_uint8) for name in ("all_quads", "conforming", "covers_domain", "fixed_kept")]


OPTIONS = {
    "target_size": 0, "max_refinement_level": 1, "local_sizing_promotion": 2,
    "feature_angle": 3, "chord_tolerance": 4, "finite_element_sizing": 5,
    "elements_per_circle": 6, "enable_smoothing": 7, "smoothing_iterations": 8,
    "absolute_tolerance": 9, "relative_tolerance": 10,
    "growth_rate": 64, "enable_cleanup": 65,
}

ROLES = {"outer": 0, "hole": 1, "control": 2, "curve": 3}


class MeshError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Mesher:
    def __init__(self, library):
        self.lib = C.CDLL(str(library))
        ptr, u32, size, number = C.c_void_p, C.c_uint32, C.c_size_t, C.c_double

        def declare(name, result, *args):
            fn = getattr(self.lib, name)
            fn.restype, fn.argtypes = result, args

        declare("mq_abi_version", u32)
        declare("mq_context_create", C.c_int, C.POINTER(ptr))
        declare("mq_context_last_error", C.c_char_p, ptr)
        for kind in ("context", "domain", "options", "mesh", "validation_report"):
            declare(f"mq_{kind}_destroy", None, ptr)
        for kind in ("domain", "options"):
            declare(f"mq_{kind}_create", C.c_int, ptr, C.POINTER(ptr))
        declare("mq_options_set", C.c_int, ptr, ptr, C.c_int, number)
        declare("mq_domain_add_loop", C.c_int, ptr, ptr, C.c_int, C.POINTER(Point), size, C.POINTER(u32))
        declare("mq_domain_set_loop_sizing", C.c_int, ptr, ptr, u32, number, C.POINTER(Sample), size)
        declare("mq_domain_set_vertex_kinds", C.c_int, ptr, ptr, u32, C.POINTER(C.c_uint8), size)
        declare("mq_domain_add_fixed_run", C.c_int, ptr, ptr, u32, u32, number, u32, number,
                C.POINTER(Point), size, C.c_uint8, C.POINTER(u32))
        declare("mq_mesh_generate_with_options", C.c_int, ptr, ptr, ptr, C.POINTER(ptr), C.POINTER(ptr))
        for name in ("node", "quad", "boundary_node", "boundary_edge"):
            declare(f"mq_mesh_{name}_count", size, ptr)
        for name, record in (("nodes", Point), ("quads", Quad), ("boundary_nodes", BoundaryNode),
                             ("boundary_edges", BoundaryEdge), ("quad_quality", Quality)):
            declare(f"mq_mesh_copy_{name}", C.c_int, ptr, ptr, C.POINTER(record), size)
        declare("mq_validation_report_ok", C.c_uint8, ptr)
        declare("mq_validation_report_issue_count", size, ptr)
        declare("mq_validation_report_issue", C.c_char_p, ptr, size)
        declare("mq_validation_report_quality", C.c_int, ptr, C.POINTER(Summary))
        self.paved = hasattr(self.lib, "mq_validation_report_paved_quality")
        if self.paved:
            declare("mq_validation_report_paved_quality", C.c_int, ptr, C.POINTER(PavedQuality))
        if self.lib.mq_abi_version() < (2 << 12):
            raise RuntimeError("quadmesh ABI 0.2 or newer is required")

    def mesh(self, loops, **options):
        """Mesh the loops and return plain Python data (all native handles are released).

        Each loop is a dict with points=[(x, y), ...], role='outer'/'hole'/'control'/'curve'
        (default: first loop outer, others holes), and optional target_size,
        sizing_samples=[(arc_fraction, size), ...], vertex_kinds=[0|1|2, ...] and
        fixed_runs=[{"nodes": [...], "start": (segment, t), "end": (segment, t),
        "closed": bool}, ...]. A curve (ABI 0.3) is open: fix it with
        {"nodes": points, "start": (0, 0), "end": (n - 2, 1), "closed": False}.
        """
        lib = self.lib
        ctx, domain, config, mesh, report = (C.c_void_p() for _ in range(5))

        def check(status):
            if status:
                message = lib.mq_context_last_error(ctx)
                raise MeshError(status, message.decode() if message else f"quadmesh error {status}")

        def points(values):
            return (Point * len(values))(*(Point(*p) for p in values))

        def records(name, record, count):
            data = (record * max(count, 1))()
            check(getattr(lib, f"mq_mesh_copy_{name}")(ctx, mesh, data, count))
            return data[:count]

        def fields(record):
            return {name: getattr(record, name) for name, _ in record._fields_ if name != "reserved"}

        try:
            check(lib.mq_context_create(C.byref(ctx)))
            check(lib.mq_domain_create(ctx, C.byref(domain)))
            check(lib.mq_options_create(ctx, C.byref(config)))
            for name, value in options.items():
                if name not in OPTIONS:
                    raise ValueError(f"unknown meshing option: {name}")
                check(lib.mq_options_set(ctx, config, OPTIONS[name], float(value)))
            for index, loop in enumerate(loops):
                role = ROLES[loop.get("role", "outer" if index == 0 else "hole")]
                loop_id = C.c_uint32()
                check(lib.mq_domain_add_loop(ctx, domain, role, points(loop["points"]),
                                             len(loop["points"]), C.byref(loop_id)))
                if "target_size" in loop or "sizing_samples" in loop:
                    samples = loop.get("sizing_samples", [])
                    check(lib.mq_domain_set_loop_sizing(
                        ctx, domain, loop_id, loop.get("target_size", 0),
                        (Sample * max(len(samples), 1))(*(Sample(*s) for s in samples)), len(samples)))
                if "vertex_kinds" in loop:
                    kinds = loop["vertex_kinds"]
                    check(lib.mq_domain_set_vertex_kinds(ctx, domain, loop_id,
                                                         (C.c_uint8 * len(kinds))(*kinds), len(kinds)))
                for run in loop.get("fixed_runs", []):
                    start, end = run.get("start", (0, 0)), run.get("end", (0, 0))
                    check(lib.mq_domain_add_fixed_run(ctx, domain, loop_id, *start, *end,
                                                      points(run["nodes"]), len(run["nodes"]),
                                                      bool(run.get("closed", False)), None))
            check(lib.mq_mesh_generate_with_options(ctx, domain, config, C.byref(mesh), C.byref(report)))
            nq, nn = lib.mq_mesh_quad_count(mesh), lib.mq_mesh_node_count(mesh)
            summary = Summary()
            check(lib.mq_validation_report_quality(report, C.byref(summary)))
            out = {
                "nodes": [(p.x, p.y) for p in records("nodes", Point, nn)],
                "quads": [tuple(q.nodes) for q in records("quads", Quad, nq)],
                "quality": [fields(q) for q in records("quad_quality", Quality, nq)],
                "boundary_nodes": [fields(n) for n in records("boundary_nodes", BoundaryNode,
                                                                 lib.mq_mesh_boundary_node_count(mesh))],
                "boundary_edges": [fields(e) for e in records("boundary_edges", BoundaryEdge,
                                                                 lib.mq_mesh_boundary_edge_count(mesh))],
                "summary": fields(summary),
                "valid": bool(lib.mq_validation_report_ok(report)),
                "issues": [lib.mq_validation_report_issue(report, i).decode()
                           for i in range(lib.mq_validation_report_issue_count(report))],
            }
            if self.paved:
                pq = PavedQuality()
                check(lib.mq_validation_report_paved_quality(report, C.byref(pq)))
                out["report"] = fields(pq)
            return out
        finally:
            for kind, handle in (("validation_report", report), ("mesh", mesh), ("options", config),
                                 ("domain", domain), ("context", ctx)):
                if handle:
                    getattr(lib, f"mq_{kind}_destroy")(handle)
