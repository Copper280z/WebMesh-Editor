//! The meshing pipeline: boundary -> size field -> constrained Delaunay ->
//! frontal insertion -> Q-Morph -> fallback -> cleanup -> smoothing -> report.

const std = @import("std");
const geom = @import("geom.zig");
const tm = @import("trimesh.zig");
const boundary = @import("boundary.zig");
const cdt = @import("cdt.zig");
const qmorph = @import("qmorph.zig");
const fallback = @import("fallback.zig");
const polymesh = @import("polymesh.zig");
const smooth = @import("smooth.zig");
const cleanup = @import("cleanup.zig");
const quality = @import("quality.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const Options = boundary.Options;
pub const Loop = boundary.Loop;
pub const Diag = boundary.Diag;
pub const Report = quality.Report;

pub const Error = error{ InvalidInput, OddBoundary, Unsupported, OutOfMemory };

/// Boundary node provenance (same layout as mq_boundary_node_t). A node can have two
/// records where one fixed run ends and the next begins. fixed_run/fixed_node are -1 for
/// nodes placed on free runs. Segment parameters are in [0, 1].
pub const BoundaryNode = extern struct {
    node: u32,
    loop: u32,
    segment: u32,
    fixed_run: i32,
    fixed_node: i32,
    reserved: u32 = 0,
    parameter: f64,
};

/// Boundary edge provenance (same layout as mq_boundary_edge_t). A mesh edge spanning
/// several input segments has one record per segment piece.
pub const BoundaryEdge = extern struct {
    node_a: u32,
    node_b: u32,
    loop: u32,
    segment: u32,
    fixed_run: i32,
    fixed_edge: i32,
    parameter_start: f64,
    parameter_end: f64,
};

pub const QuadQuality = extern struct {
    min_jacobian: f64,
    min_scaled_jacobian: f64,
};

pub const Result = struct {
    nodes: []Vec2,
    quads: [][4]u32,
    quality: []QuadQuality,
    boundary_nodes: []BoundaryNode,
    boundary_edges: []BoundaryEdge,
    report: Report,
    /// Triangles that could not be converted (empty for a successful mesh).
    tris: [][3]u32,
    /// Boundary edges as node pairs (one per mesh edge), for drawing.
    boundary_pairs: [][2]u32,
    stats: qmorph.Stats,
    cleanup: cleanup.Stats = .{},
    fallback: fallback.Stats = .{},

    pub fn deinit(self: *Result, gpa: Allocator) void {
        gpa.free(self.nodes);
        gpa.free(self.quads);
        gpa.free(self.quality);
        gpa.free(self.boundary_nodes);
        gpa.free(self.boundary_edges);
        gpa.free(self.tris);
        gpa.free(self.boundary_pairs);
        self.report.deinit(gpa);
    }
};

/// Remeshes small patches around quads that are still poor after cleanup and smoothing.
/// A patch is a bad quad with its neighbors; if its boundary is a simple polygon, the patch
/// is meshed again with this pipeline (patch boundary nodes kept as a closed fixed run) and
/// the new quads replace the old ones when their worst element is better.
fn remeshPatches(gpa: Allocator, pm: *polymesh.PolyMesh, constrained: *const std.AutoHashMap(u64, void), opts: Options, target: f64) !bool {
    const PM = polymesh.PolyMesh;
    var changed = false;
    var round: usize = 0;
    while (round < 3) : (round += 1) {
        // Bad quads, worst first.
        const Bad = struct { q: f64, x: u32 };
        var bad: std.ArrayList(Bad) = .empty;
        defer bad.deinit(gpa);
        for (pm.elems.items, 0..) |e, xi| {
            if (!pm.alive.items[xi] or PM.isTri(e)) continue;
            const s = pm.elemSJ(@intCast(xi));
            if (s < opts.remesh_below) try bad.append(gpa, .{ .q = s, .x = @intCast(xi) });
        }
        if (bad.items.len == 0) break;
        std.mem.sort(Bad, bad.items, {}, struct {
            fn lt(_: void, a: Bad, b: Bad) bool {
                return a.q < b.q or (a.q == b.q and a.x < b.x);
            }
        }.lt);
        var any = false;
        for (bad.items) |b| {
            if (!pm.alive.items[b.x]) continue;
            if (pm.elemSJ(b.x) >= opts.remesh_below) continue;
            var rings: usize = 1;
            while (rings <= 3) : (rings += 1) {
                if (try remeshOne(gpa, pm, constrained, opts, target, b.x, rings)) {
                    any = true;
                    changed = true;
                    break;
                }
            }
        }
        if (!any) break;
    }
    return changed;
}

fn remeshOne(gpa: Allocator, pm: *polymesh.PolyMesh, constrained: *const std.AutoHashMap(u64, void), opts: Options, target: f64, seed: u32, rings: usize) !bool {
    const PM = polymesh.PolyMesh;
    // Patch: elements within `rings` node-rings of the seed.
    var patch: std.ArrayList(u32) = .empty;
    defer patch.deinit(gpa);
    try patch.append(gpa, seed);
    var r: usize = 0;
    while (r < rings) : (r += 1) {
        const n0 = patch.items.len;
        for (0..n0) |i| {
            const e = pm.elems.items[patch.items[i]];
            for (0..PM.nv(e)) |k| {
                for (pm.node_elems.items[e[k]].items) |y| {
                    if (std.mem.indexOfScalar(u32, patch.items, y) == null) try patch.append(gpa, y);
                }
            }
        }
    }
    if (patch.items.len > 200) return false;
    // Directed boundary edges of the patch (used once inside it).
    var nxt = std.AutoHashMap(u32, u32).init(gpa);
    defer nxt.deinit();
    var old_min: f64 = 1;
    for (patch.items) |x| {
        const e = pm.elems.items[x];
        if (PM.isTri(e)) return false;
        old_min = @min(old_min, pm.elemSJ(x));
        for (0..4) |k| {
            const a = e[k];
            const b = e[(k + 1) % 4];
            const other = pm.across(x, a, b);
            const inside = other != polymesh.NONE and std.mem.indexOfScalar(u32, patch.items, other) != null;
            if (inside) {
                if (constrained.contains(cleanup.ekey(a, b))) return false;
                continue;
            }
            if (nxt.contains(a)) return false; // pinch: not a simple polygon
            try nxt.put(a, b);
        }
    }
    // Walk the cycle; it must use every boundary edge once.
    var poly: std.ArrayList(u32) = .empty;
    defer poly.deinit(gpa);
    // Deterministic start: smallest node index on the boundary.
    var start: u32 = std.math.maxInt(u32);
    var kit = nxt.keyIterator();
    while (kit.next()) |k| start = @min(start, k.*);
    var cur = start;
    var guard: usize = 0;
    while (guard <= nxt.count()) : (guard += 1) {
        try poly.append(gpa, cur);
        cur = nxt.get(cur) orelse return false;
        if (cur == start) break;
    } else return false;
    if (poly.items.len != nxt.count() or poly.items.len < 4 or poly.items.len % 2 != 0) return false;
    // Interior nodes of the patch must be free (boundary nodes never move or vanish).
    for (patch.items) |x| {
        const e = pm.elems.items[x];
        for (0..4) |k| {
            const v = e[k];
            if (pm.fixed.items[v] and std.mem.indexOfScalar(u32, poly.items, v) == null) return false;
        }
    }
    // Mesh the polygon with the pipeline (boundary nodes fixed, no recursion).
    const pts = try gpa.alloc(Vec2, poly.items.len);
    defer gpa.free(pts);
    for (poly.items, 0..) |v, k| pts[k] = pm.p(v);
    const runs = [_]boundary.FixedRun{.{ .nodes = pts, .closed = true }};
    const sub_loops = [_]Loop{.{ .role = .outer, .points = pts, .fixed_runs = &runs }};
    var sub_opts = opts;
    sub_opts.enable_cleanup = true;
    sub_opts.remesh_patches = false;
    sub_opts.target_size = target;
    var diag = Diag{};
    var sub = generate(gpa, &sub_loops, sub_opts, &diag) catch return false;
    defer sub.deinit(gpa);
    if (!sub.report.valid) return false;
    if (sub.report.min_scaled_jacobian <= old_min + 0.02) return false;
    // Replace: sub node k < poly.len is poly[k]; others are new interior nodes.
    const map = try gpa.alloc(u32, sub.nodes.len);
    defer gpa.free(map);
    for (0..sub.nodes.len) |k| {
        if (k < poly.items.len) {
            if (!sub.nodes[k].eql(pts[k])) return false;
            map[k] = poly.items[k];
        } else map[k] = try pm.addNode(sub.nodes[k], false);
    }
    for (patch.items) |x| pm.killElem(x);
    for (sub.quads) |q| _ = try pm.addElem(.{ map[q[0]], map[q[1]], map[q[2]], map[q[3]] });
    return true;
}

/// FNV-1a hash of the node coordinates and quad node indices (little-endian bytes), used to
/// check that runs on different platforms give bit-identical meshes.
pub fn meshHash(nodes: []const Vec2, quads: []const [4]u32) u64 {
    var h: u64 = 0xcbf29ce484222325;
    for (std.mem.sliceAsBytes(nodes)) |b| {
        h ^= b;
        h *%= 0x100000001b3;
    }
    for (std.mem.sliceAsBytes(quads)) |b| {
        h ^= b;
        h *%= 0x100000001b3;
    }
    return h;
}

pub fn generate(gpa: Allocator, loops: []const Loop, opts: Options, diag: *Diag) Error!Result {
    return generateTuned(gpa, loops, opts, diag, .{});
}

pub fn generateDebug(gpa: Allocator, loops: []const Loop, opts: Options, diag: *Diag, max_steps: usize) Error!Result {
    return generateTuned(gpa, loops, opts, diag, .{ .max_steps = max_steps });
}

/// As generate, with explicit Q-Morph parameters (for tuning and debugging).
pub fn generateTuned(gpa: Allocator, loops: []const Loop, opts: Options, diag: *Diag, qopts: qmorph.Options) Error!Result {
    var bd = try boundary.build(gpa, loops, opts, diag);
    defer bd.deinit(gpa);
    var mesh = tm.Mesh.init(gpa);
    defer mesh.deinit();
    try cdt.triangulateBoundary(gpa, &bd, &mesh, diag);
    try cdt.frontalInsert(gpa, &mesh, &bd.field.?, .{});
    var qm = try qmorph.QMorph.init(gpa, &mesh, &bd.field.?, qopts);
    defer qm.deinit();
    try qm.run();
    var fstats = fallback.Stats{};
    try fallback.run(gpa, &qm, &fstats);

    // Mixed mesh for repair, cleanup and smoothing.
    var pm = polymesh.PolyMesh.init(gpa);
    defer pm.deinit();
    for (mesh.pts.items, 0..) |q, v| _ = try pm.addNode(q, mesh.isFixed(@intCast(v)));
    for (qm.quads.items, 0..) |q, qi| {
        if (qm.qalive.items[qi]) _ = try pm.addElem(q);
    }
    for (mesh.tv.items, 0..) |tv, ti| {
        if (mesh.talive.items[ti]) _ = try pm.addElem(.{ tv[0], tv[1], tv[2], tm.NONE });
    }
    // Control-loop and curve edges must survive repair, cleanup and remeshing.
    var constrained = std.AutoHashMap(u64, void).init(gpa);
    defer constrained.deinit();
    for (bd.loops.items) |bl| {
        if (!bl.interior()) continue;
        for (0..bl.edgeCount()) |k| try constrained.put(cleanup.ekey(bl.items[k].node, bl.items[(k + 1) % bl.items.len].node), {});
    }
    pm.constrained = &constrained;
    fstats.repaired = pm.triCount();
    _ = try pm.repairTriangles();
    if (opts.enable_smoothing) try smooth.smooth(&pm, .{ .iterations = opts.smoothing_iterations });
    var cstats = cleanup.Stats{};
    if (opts.enable_cleanup) {
        try cleanup.cleanup(&pm, &constrained, .{}, &cstats);
        if (opts.enable_smoothing) try smooth.smooth(&pm, .{ .iterations = opts.smoothing_iterations });
    }

    if (opts.enable_cleanup and opts.remesh_patches) {
        if (try remeshPatches(gpa, &pm, &constrained, opts, bd.target_size)) {
            if (opts.enable_smoothing) try smooth.smooth(&pm, .{ .iterations = opts.smoothing_iterations });
        }
    }

    // Compact output: boundary nodes first (loop order), then interior nodes.
    const n = pm.pts.items.len;
    const remap = try gpa.alloc(u32, n);
    defer gpa.free(remap);
    @memset(remap, tm.NONE);
    var nodes: std.ArrayList(Vec2) = .empty;
    defer nodes.deinit(gpa);
    const nb = bd.points.items.len;
    for (0..nb) |v| {
        remap[v] = @intCast(nodes.items.len);
        try nodes.append(gpa, pm.pts.items[v]);
    }
    var quads: std.ArrayList([4]u32) = .empty;
    defer quads.deinit(gpa);
    var tris: std.ArrayList([3]u32) = .empty;
    defer tris.deinit(gpa);
    for (pm.elems.items, 0..) |e, xi| {
        if (!pm.alive.items[xi]) continue;
        const nv = polymesh.PolyMesh.nv(e);
        var out: [4]u32 = undefined;
        for (0..nv) |k| {
            const v = e[k];
            if (remap[v] == tm.NONE) {
                remap[v] = @intCast(nodes.items.len);
                try nodes.append(gpa, pm.pts.items[v]);
            }
            out[k] = remap[v];
        }
        if (nv == 4) try quads.append(gpa, out) else try tris.append(gpa, .{ out[0], out[1], out[2] });
    }

    // Per-quad quality.
    const qual = try gpa.alloc(QuadQuality, quads.items.len);
    errdefer gpa.free(qual);
    for (quads.items, 0..) |q, qi| {
        const pq = [4]Vec2{ nodes.items[q[0]], nodes.items[q[1]], nodes.items[q[2]], nodes.items[q[3]] };
        var mj: f64 = std.math.inf(f64);
        for (0..4) |k| {
            const e1 = pq[(k + 1) % 4].sub(pq[k]);
            const e2 = pq[(k + 3) % 4].sub(pq[k]);
            mj = @min(mj, e1.cross(e2));
        }
        qual[qi] = .{ .min_jacobian = mj, .min_scaled_jacobian = geom.quadScaledJacobian(pq) };
    }

    // Provenance.
    var bnodes: std.ArrayList(BoundaryNode) = .empty;
    defer bnodes.deinit(gpa);
    var bedges: std.ArrayList(BoundaryEdge) = .empty;
    defer bedges.deinit(gpa);
    var pairs: std.ArrayList([2]u32) = .empty;
    defer pairs.deinit(gpa);
    var deviation: f64 = 0;
    var qloops: std.ArrayList(quality.LoopEdges) = .empty;
    defer {
        for (qloops.items) |l| gpa.free(l.nodes);
        qloops.deinit(gpa);
    }
    var fixed_nodes: std.ArrayList(quality.FixedNode) = .empty;
    defer fixed_nodes.deinit(gpa);
    var fixed_edges: std.ArrayList([2]u32) = .empty;
    defer fixed_edges.deinit(gpa);
    for (bd.loops.items, 0..) |bl, li| {
        const m = bl.items.len;
        const npts = loops[li].points.len;
        const ln = try gpa.alloc(u32, m);
        for (bl.items, 0..) |it, k| ln[k] = remap[it.node];
        try qloops.append(gpa, .{ .nodes = ln, .control = bl.interior(), .hole = bl.role == .hole, .open = bl.open });
        for (bl.items) |it| {
            const node = remap[it.node];
            try bnodes.append(gpa, .{ .node = node, .loop = @intCast(li), .segment = it.segment, .fixed_run = it.fixed_run, .fixed_node = it.fixed_node, .parameter = it.parameter });
            if (it.fixed_run2 >= 0) try bnodes.append(gpa, .{ .node = node, .loop = @intCast(li), .segment = it.segment, .fixed_run = it.fixed_run2, .fixed_node = it.fixed_node2, .parameter = it.parameter });
            if (it.fixed_run >= 0) {
                // A node shared with another loop or curve keeps the first loop's coordinates;
                // the others matched it within the tolerance.
                var given = loops[li].fixed_runs[@intCast(it.fixed_run)].nodes[@intCast(it.fixed_node)];
                if (!given.eql(nodes.items[node]) and given.dist(nodes.items[node]) <= bd.tol) given = nodes.items[node];
                try fixed_nodes.append(gpa, .{ .node = node, .pos = given });
            } else {
                const a = loops[li].points[it.segment];
                const b = loops[li].points[(it.segment + 1) % npts];
                deviation = @max(deviation, nodes.items[node].dist(a.lerp(b, it.parameter)));
            }
        }
        for (0..bl.edgeCount()) |k| {
            const x = bl.items[k];
            const y = bl.items[(k + 1) % m];
            const na = remap[x.node];
            const nbn = remap[y.node];
            try pairs.append(gpa, .{ na, nbn });
            if (bl.edge_run[k] >= 0) try fixed_edges.append(gpa, .{ na, nbn });
            // Records per input segment spanned from x to y (in loop direction).
            const rec = BoundaryEdge{ .node_a = na, .node_b = nbn, .loop = @intCast(li), .segment = x.segment, .fixed_run = bl.edge_run[k], .fixed_edge = bl.edge_index[k], .parameter_start = x.parameter, .parameter_end = y.parameter };
            if (x.segment == y.segment and y.parameter > x.parameter) {
                try bedges.append(gpa, rec);
            } else {
                var r = rec;
                if (x.parameter < 1) {
                    r.parameter_end = 1;
                    try bedges.append(gpa, r);
                }
                var s: u32 = @intCast((x.segment + 1) % npts);
                var guard: usize = 0;
                while (s != y.segment and guard < npts) : (guard += 1) {
                    r.segment = s;
                    r.parameter_start = 0;
                    r.parameter_end = 1;
                    try bedges.append(gpa, r);
                    s = @intCast((s + 1) % npts);
                }
                if (y.parameter > 0) {
                    r.segment = y.segment;
                    r.parameter_start = 0;
                    r.parameter_end = y.parameter;
                    try bedges.append(gpa, r);
                }
            }
        }
    }

    var report = try quality.validate(gpa, .{
        .nodes = nodes.items,
        .quads = quads.items,
        .tris = tris.items,
        .loops = qloops.items,
        .fixed_nodes = fixed_nodes.items,
        .fixed_edges = fixed_edges.items,
        .boundary_deviation = deviation,
    });
    errdefer report.deinit(gpa);
    return .{
        .nodes = try nodes.toOwnedSlice(gpa),
        .quads = try quads.toOwnedSlice(gpa),
        .quality = qual,
        .boundary_nodes = try bnodes.toOwnedSlice(gpa),
        .boundary_edges = try bedges.toOwnedSlice(gpa),
        .report = report,
        .tris = try tris.toOwnedSlice(gpa),
        .boundary_pairs = try pairs.toOwnedSlice(gpa),
        .stats = qm.stats,
        .cleanup = cstats,
        .fallback = fstats,
    };
}
