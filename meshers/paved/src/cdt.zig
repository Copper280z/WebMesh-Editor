//! Constrained Delaunay triangulation of the boundary nodes (Bowyer-Watson,
//! constraints recovered by edge flips and never split), followed by frontal
//! Delaunay point insertion (Rebay 1993): rows of nearly equilateral triangles
//! of the local size are laid down from the boundary inward.

const std = @import("std");
const geom = @import("geom.zig");
const tm = @import("trimesh.zig");
const boundary = @import("boundary.zig");
const sizefield = @import("sizefield.zig");
const Vec2 = geom.Vec2;
const Mesh = tm.Mesh;
const NONE = tm.NONE;
const next3 = tm.next3;
const prev3 = tm.prev3;
const Allocator = std.mem.Allocator;

pub const Error = error{ InvalidInput, OutOfMemory };

/// Builds the constrained Delaunay triangulation of the boundary. Node i of the mesh is
/// boundary node i. Exterior triangles are removed; boundary edges get NONE neighbors and
/// control-loop edges stay constrained with triangles on both sides.
pub fn triangulateBoundary(gpa: Allocator, bd: *const boundary.Boundary, mesh: *Mesh, diag: *boundary.Diag) Error!void {
    const pts = bd.points.items;
    var lo = Vec2.init(std.math.inf(f64), std.math.inf(f64));
    var hi = Vec2.init(-std.math.inf(f64), -std.math.inf(f64));
    for (pts) |q| {
        lo.x = @min(lo.x, q.x);
        lo.y = @min(lo.y, q.y);
        hi.x = @max(hi.x, q.x);
        hi.y = @max(hi.y, q.y);
    }
    for (pts) |q| _ = try mesh.addNode(q, tm.NodeFlags.fixed);
    // Super triangle.
    const c = lo.mid(hi);
    const ext = @max(hi.x - lo.x, hi.y - lo.y) + 1.0;
    const s0 = try mesh.addNode(.init(c.x - 20 * ext, c.y - 12 * ext), tm.NodeFlags.deleted);
    const s1 = try mesh.addNode(.init(c.x + 20 * ext, c.y - 12 * ext), tm.NodeFlags.deleted);
    const s2 = try mesh.addNode(.init(c.x, c.y + 24 * ext), tm.NodeFlags.deleted);
    const super = try mesh.newTri(s0, s1, s2);

    var cavity: std.ArrayList(u32) = .empty;
    defer cavity.deinit(gpa);
    var bnd: std.ArrayList(Mesh.BEdge) = .empty;
    defer bnd.deinit(gpa);

    // Insert boundary nodes loop by loop (spatially coherent walk).
    var last = super;
    var placed = try gpa.alloc(bool, pts.len);
    defer gpa.free(placed);
    @memset(placed, false);
    for (pts, 0..) |q, vi| {
        const loc = mesh.locate(q, last);
        if (loc.outside) {
            diag.set("internal error: boundary node outside the super triangle", .{});
            return error.InvalidInput;
        }
        // Duplicate node?
        const tv = mesh.tv.items[loc.t];
        for (tv) |w| if (w < pts.len and mesh.p(w).eql(q)) {
            diag.set("boundary nodes {d} and {d} coincide at ({d}, {d})", .{ w, vi, q.x, q.y });
            return error.InvalidInput;
        };
        // Insert as the pre-allocated node vi: insertBW creates a new node; remap afterwards.
        const m = (try insertExisting(mesh, @intCast(vi), loc.t, &cavity, &bnd)) orelse {
            diag.set("internal error: could not insert boundary node {d}", .{vi});
            return error.InvalidInput;
        };
        _ = m;
        placed[vi] = true;
        last = mesh.vtri.items[vi];
    }

    // Recover constrained edges by flips.
    var edges: std.ArrayList([2]u32) = .empty;
    defer edges.deinit(gpa);
    for (bd.loops.items) |bl| {
        const m = bl.items.len;
        for (0..bl.edgeCount()) |k| try edges.append(gpa, .{ bl.items[k].node, bl.items[(k + 1) % m].node });
    }
    for (edges.items) |e| {
        try recoverEdge(gpa, mesh, e[0], e[1], diag);
    }

    // Classify triangles: crossing an outer/hole edge toggles inside/outside.
    const ntri = mesh.tv.items.len;
    var toggle = std.AutoHashMap(u64, void).init(gpa);
    defer toggle.deinit();
    for (bd.loops.items) |bl| {
        if (bl.interior()) continue;
        const m = bl.items.len;
        for (0..m) |k| {
            const a = bl.items[k].node;
            const b = bl.items[(k + 1) % m].node;
            try toggle.put(edgeKey(a, b), {});
        }
    }
    const depth = try gpa.alloc(i32, ntri);
    defer gpa.free(depth);
    @memset(depth, -1);
    var stack: std.ArrayList(u32) = .empty;
    defer stack.deinit(gpa);
    // Seed: any alive triangle touching a super vertex is outside.
    var next_stack: std.ArrayList(u32) = .empty;
    defer next_stack.deinit(gpa);
    for (0..ntri) |ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        const tv = mesh.tv.items[t];
        if (tv[0] >= pts.len or tv[1] >= pts.len or tv[2] >= pts.len) {
            try next_stack.append(gpa, t);
            break;
        }
    }
    // BFS by layers: a layer is everything reachable without crossing a loop edge.
    var layer: i32 = 0;
    while (next_stack.items.len > 0) : (layer += 1) {
        std.mem.swap(std.ArrayList(u32), &stack, &next_stack);
        next_stack.clearRetainingCapacity();
        var k: usize = 0;
        while (k < stack.items.len) {
            if (depth[stack.items[k]] >= 0) {
                _ = stack.swapRemove(k);
            } else {
                depth[stack.items[k]] = layer;
                k += 1;
            }
        }
        while (stack.pop()) |t| {
            const tv = mesh.tv.items[t];
            for (0..3) |i| {
                const u = mesh.tn.items[t][i];
                if (u == NONE or depth[u] >= 0) continue;
                const a = tv[next3(i)];
                const b = tv[prev3(i)];
                if (mesh.isCons(t, i) and toggle.contains(edgeKey(a, b))) {
                    try next_stack.append(gpa, u);
                } else {
                    depth[u] = layer;
                    try stack.append(gpa, u);
                }
            }
        }
    }
    // Remove exterior triangles.
    for (0..ntri) |ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        if (@mod(depth[t], 2) == 0) {
            // Detach from neighbors.
            for (0..3) |i| {
                const u = mesh.tn.items[t][i];
                if (u == NONE) continue;
                const tv = mesh.tv.items[t];
                if (mesh.edgeIndex(u, tv[prev3(i)], tv[next3(i)])) |j| mesh.tn.items[u][j] = NONE;
                mesh.tn.items[t][i] = NONE;
            }
            try mesh.killTri(t);
        }
    }
    // Repair vertex seeds and drop super vertices.
    for (mesh.vtri.items) |*v| v.* = NONE;
    for (0..ntri) |ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        for (mesh.tv.items[t]) |v| mesh.vtri.items[v] = t;
    }
    // Every boundary edge must now be a domain edge (NONE on one side) or a control edge.
    for (pts, 0..) |_, vi| {
        if (mesh.vtri.items[vi] == NONE) {
            diag.set("boundary node {d} is not part of the meshed domain (loops overlap or a hole lies outside the outer loop)", .{vi});
            return error.InvalidInput;
        }
    }
    // Delaunay restoration for unconstrained edges.
    try lawsonAll(gpa, mesh);
}

pub inline fn edgeKey(a: u32, b: u32) u64 {
    const x = @min(a, b);
    const y = @max(a, b);
    return (@as(u64, x) << 32) | y;
}

/// Inserts already-allocated node v (position mesh.pts[v]) with Bowyer-Watson.
fn insertExisting(mesh: *Mesh, v: u32, t0: u32, cavity: *std.ArrayList(u32), bnd: *std.ArrayList(Mesh.BEdge)) !?u32 {
    const q = mesh.p(v);
    const m = (try mesh.insertBW(q, t0, 0, cavity, bnd)) orelse return null;
    // Re-label the new node m as v (m is the last node; drop it).
    for (bnd.items) |e| {
        const t = e.tri;
        for (&mesh.tv.items[t]) |*w| {
            if (w.* == m) w.* = v;
        }
    }
    mesh.vtri.items[v] = bnd.items[0].tri;
    _ = mesh.pts.pop();
    _ = mesh.nflags.pop();
    _ = mesh.vtri.pop();
    return v;
}

fn findEdge(mesh: *const Mesh, a: u32, b: u32) ?struct { t: u32, i: usize } {
    // Walk the fan of a.
    const t0 = mesh.vtri.items[a];
    if (t0 == NONE) return null;
    var cur = t0;
    var guard: usize = 0;
    while (guard < 4096) : (guard += 1) {
        if (mesh.edgeIndex(cur, a, b)) |i| return .{ .t = cur, .i = i };
        if (mesh.edgeIndex(cur, b, a)) |i| return .{ .t = cur, .i = i };
        const i = mesh.vertIndex(cur, a).?;
        const nxt = mesh.tn.items[cur][next3(i)];
        if (nxt == NONE or nxt == t0) break;
        cur = nxt;
    }
    // Clockwise side.
    cur = t0;
    guard = 0;
    while (guard < 4096) : (guard += 1) {
        const i = mesh.vertIndex(cur, a).?;
        const nxt = mesh.tn.items[cur][prev3(i)];
        if (nxt == NONE or nxt == t0) break;
        cur = nxt;
        if (mesh.edgeIndex(cur, a, b)) |k| return .{ .t = cur, .i = k };
        if (mesh.edgeIndex(cur, b, a)) |k| return .{ .t = cur, .i = k };
    }
    return null;
}

fn markConstrained(mesh: *Mesh, t: u32, i: usize) void {
    mesh.setCons(t, i, true);
    const u = mesh.tn.items[t][i];
    if (u != NONE) {
        const tv = mesh.tv.items[t];
        if (mesh.edgeIndex(u, tv[prev3(i)], tv[next3(i)])) |j| mesh.setCons(u, j, true);
    }
}

/// Recovers segment (a, b) as a mesh edge by flipping crossing edges (Sloan 1993).
fn recoverEdge(gpa: Allocator, mesh: *Mesh, a: u32, b: u32, diag: *boundary.Diag) Error!void {
    if (findEdge(mesh, a, b)) |e| {
        markConstrained(mesh, e.t, e.i);
        return;
    }
    const pa = mesh.p(a);
    const pb = mesh.p(b);
    // Collect crossing edges by walking from a toward b.
    var crossing: std.ArrayList([2]u32) = .empty;
    defer crossing.deinit(gpa);
    // Find the triangle in a's fan whose opposite edge is crossed by (a, b).
    var t = mesh.vtri.items[a];
    var guard: usize = 0;
    var start: ?struct { t: u32, i: usize } = null;
    // Rotate around a (full fan: interior during this phase, convex hull of super triangle).
    while (guard < 100000) : (guard += 1) {
        const ia = mesh.vertIndex(t, a).?;
        const x = mesh.tv.items[t][next3(ia)];
        const y = mesh.tv.items[t][prev3(ia)];
        const ox = geom.orient(pa, pb, mesh.p(x));
        const oy = geom.orient(pa, pb, mesh.p(y));
        if (ox == 0 and x != b and mesh.p(x).sub(pa).dot(pb.sub(pa)) > 0 and mesh.p(x).sub(pa).len2() < pb.sub(pa).len2()) {
            diag.set("boundary node {d} lies on boundary edge ({d}, {d})", .{ x, a, b });
            return error.InvalidInput;
        }
        if (ox < 0 and oy > 0) {
            start = .{ .t = t, .i = ia };
            break;
        }
        t = mesh.tn.items[t][next3(ia)];
        if (t == NONE) break;
    }
    const st = start orelse {
        diag.set("internal error: cannot start recovering boundary edge ({d}, {d})", .{ a, b });
        return error.InvalidInput;
    };
    // Walk.
    t = st.t;
    var i = st.i; // edge opposite a in t is crossed
    guard = 0;
    while (guard < 1_000_000) : (guard += 1) {
        const tv = mesh.tv.items[t];
        const x = tv[next3(i)];
        const y = tv[prev3(i)];
        if (mesh.isCons(t, i)) {
            diag.set("boundary edges ({d}, {d}) and ({d}, {d}) cross: loops intersect", .{ a, b, x, y });
            return error.InvalidInput;
        }
        try crossing.append(gpa, .{ x, y });
        const u = mesh.tn.items[t][i];
        if (u == NONE) {
            diag.set("internal error: walk left the triangulation while recovering ({d}, {d})", .{ a, b });
            return error.InvalidInput;
        }
        const j = mesh.edgeIndex(u, y, x).?;
        const w = mesh.tv.items[u][j];
        if (w == b) break;
        const ow = geom.orient(pa, pb, mesh.p(w));
        if (ow == 0) {
            diag.set("boundary node {d} lies on boundary edge ({d}, {d})", .{ w, a, b });
            return error.InvalidInput;
        }
        // Next crossed edge in u: either (y, w) or (w, x).
        t = u;
        // u = (w, y, x); keep the right-hand vertex first: (x, w) if w is left, else (w, y).
        i = if (ow > 0) mesh.edgeIndex(u, x, w).? else mesh.edgeIndex(u, w, y).?;
    }
    // Flip loop.
    var queue = crossing;
    crossing = .empty;
    var qi: usize = 0;
    var iter: usize = 0;
    while (qi < queue.items.len) : (iter += 1) {
        if (iter > 1_000_000) {
            diag.set("internal error: edge recovery for ({d}, {d}) did not converge", .{ a, b });
            queue.deinit(gpa);
            return error.InvalidInput;
        }
        const e = queue.items[qi];
        qi += 1;
        const f = findEdge(mesh, e[0], e[1]) orelse continue;
        if (!mesh.canFlip(f.t, f.i)) {
            try queue.append(gpa, e);
            continue;
        }
        const r = mesh.flip(f.t, f.i);
        // New edge is (c, d) = tv[t][0] and tv[t][2].
        const c = mesh.tv.items[r[0]][0];
        const d = mesh.tv.items[r[0]][2];
        if (geom.segmentsCross(pa, pb, mesh.p(c), mesh.p(d))) try queue.append(gpa, .{ c, d });
        // Compact occasionally.
        if (qi > 4096 and qi * 2 > queue.items.len) {
            const rest = queue.items.len - qi;
            std.mem.copyForwards([2]u32, queue.items[0..rest], queue.items[qi..]);
            queue.shrinkRetainingCapacity(rest);
            qi = 0;
        }
    }
    queue.deinit(gpa);
    const fe = findEdge(mesh, a, b) orelse {
        diag.set("internal error: edge ({d}, {d}) not recovered", .{ a, b });
        return error.InvalidInput;
    };
    markConstrained(mesh, fe.t, fe.i);
}

/// Lawson flips over all unconstrained interior edges until locally Delaunay.
pub fn lawsonAll(gpa: Allocator, mesh: *Mesh) !void {
    var stack: std.ArrayList([2]u32) = .empty;
    defer stack.deinit(gpa);
    for (mesh.tv.items, 0..) |tv, ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        for (0..3) |i| {
            const u = mesh.tn.items[t][i];
            if (u == NONE or u < t) continue;
            try stack.append(gpa, .{ tv[next3(i)], tv[prev3(i)] });
        }
    }
    try lawsonStack(gpa, mesh, &stack);
}

/// Flips edges from the stack (given as node pairs) while they are not locally Delaunay.
pub fn lawsonStack(gpa: Allocator, mesh: *Mesh, stack: *std.ArrayList([2]u32)) !void {
    var guard: usize = 0;
    while (stack.pop()) |e| {
        guard += 1;
        if (guard > 10_000_000) break;
        const f = findEdge(mesh, e[0], e[1]) orelse continue;
        const t = f.t;
        const i = f.i;
        const u = mesh.tn.items[t][i];
        if (u == NONE or mesh.isCons(t, i)) continue;
        const tv = mesh.tv.items[t];
        const j = mesh.edgeIndex(u, tv[prev3(i)], tv[next3(i)]) orelse continue;
        const d = mesh.tv.items[u][j];
        const pp = mesh.triPoints(t);
        if (geom.inCircle(pp[0], pp[1], pp[2], mesh.p(d)) <= 0) continue;
        if (!mesh.canFlip(t, i)) continue;
        const r = mesh.flip(t, i);
        // (c, a, d) and (c, d, b): push the four outer edges.
        const t1 = mesh.tv.items[r[0]];
        const t2 = mesh.tv.items[r[1]];
        try stack.append(gpa, .{ t1[1], t1[2] });
        try stack.append(gpa, .{ t1[0], t1[1] });
        try stack.append(gpa, .{ t2[1], t2[2] });
        try stack.append(gpa, .{ t2[0], t2[2] });
    }
}

// ---------------------------------------------------------------------------
// Frontal Delaunay insertion (Rebay 1993)

const QItem = struct {
    ratio: f64,
    t: u32,
    gen: u32,
};

fn qCompare(_: void, x: QItem, y: QItem) std.math.Order {
    // Max-heap on ratio; ties broken by triangle index then generation for determinism.
    if (x.ratio > y.ratio) return .lt;
    if (x.ratio < y.ratio) return .gt;
    if (x.t < y.t) return .lt;
    if (x.t > y.t) return .gt;
    return std.math.order(x.gen, y.gen);
}

pub const FrontalOptions = struct {
    /// Triangles with circumradius below accept * (h / sqrt 3) are accepted.
    accept: f64 = 1.33,
};

pub fn frontalInsert(gpa: Allocator, mesh: *Mesh, field: *const sizefield.SizeField, fo: FrontalOptions) !void {
    var accepted: std.ArrayList(bool) = .empty;
    defer accepted.deinit(gpa);
    var ratio: std.ArrayList(f64) = .empty;
    defer ratio.deinit(gpa);
    var pq = std.PriorityQueue(QItem, void, qCompare).initContext({});
    defer pq.deinit(gpa);
    var cavity: std.ArrayList(u32) = .empty;
    defer cavity.deinit(gpa);
    var bnd: std.ArrayList(Mesh.BEdge) = .empty;
    defer bnd.deinit(gpa);

    const inv_sqrt3 = 1.0 / @sqrt(3.0);
    const Ctx = struct {
        fn evalTri(m: *const Mesh, f: *const sizefield.SizeField, t: u32) f64 {
            const q = m.triPoints(t);
            const cen = q[0].add(q[1]).add(q[2]).scale(1.0 / 3.0);
            const h = f.eval(cen);
            const r = geom.circumradius(q[0], q[1], q[2]);
            return r / (h * (1.0 / @sqrt(3.0)));
        }
    };
    const ensure = struct {
        fn f(g: Allocator, acc: *std.ArrayList(bool), rat: *std.ArrayList(f64), n: usize) !void {
            while (acc.items.len < n) {
                try acc.append(g, false);
                try rat.append(g, 0);
            }
        }
    }.f;
    try ensure(gpa, &accepted, &ratio, mesh.tv.items.len);
    for (mesh.tv.items, 0..) |_, ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        ratio.items[t] = Ctx.evalTri(mesh, field, t);
        accepted.items[t] = ratio.items[t] <= fo.accept;
    }
    const isActive = struct {
        fn f(m: *const Mesh, acc: []const bool, t: u32) bool {
            if (!m.talive.items[t] or acc[t]) return false;
            for (0..3) |i| {
                const u = m.tn.items[t][i];
                if (u == NONE or m.isCons(t, i) or acc[u]) return true;
            }
            return false;
        }
    }.f;
    for (mesh.tv.items, 0..) |_, ti| {
        const t: u32 = @intCast(ti);
        if (isActive(mesh, accepted.items, t)) try pq.push(gpa, .{ .ratio = ratio.items[t], .t = t, .gen = mesh.tgen.items[t] });
    }
    var iterations: usize = 0;
    while (pq.pop()) |item| {
        iterations += 1;
        if (iterations > 50_000_000) break;
        const t = item.t;
        if (!mesh.talive.items[t] or mesh.tgen.items[t] != item.gen) continue;
        if (!isActive(mesh, accepted.items, t)) continue;
        // Choose the front edge: the longest edge shared with an accepted triangle or the boundary.
        const q = mesh.triPoints(t);
        var best_i: usize = 3;
        var best_len: f64 = -1;
        for (0..3) |i| {
            const u = mesh.tn.items[t][i];
            if (!(u == NONE or mesh.isCons(t, i) or accepted.items[u])) continue;
            const l = q[next3(i)].dist2(q[prev3(i)]);
            if (l > best_len) {
                best_len = l;
                best_i = i;
            }
        }
        const pa = q[next3(best_i)];
        const pb = q[prev3(best_i)];
        const pc = q[best_i];
        const mid = pa.mid(pb);
        const half = 0.5 * pa.dist(pb);
        var nrm = pb.sub(pa).perp().normalized(); // left of a->b: toward the apex (CCW triangle)
        if (nrm.dot(pc.sub(mid)) < 0) nrm = nrm.scale(-1);
        const cc = geom.circumcenter(q[0], q[1], q[2]);
        const qd = cc.sub(mid).dot(nrm);
        const hm = field.eval(mid);
        var rho = @max(hm * inv_sqrt3, half);
        var dist: f64 = undefined;
        if (qd > 0) {
            rho = @min(rho, (half * half + qd * qd) / (2.0 * qd));
            dist = rho + @sqrt(@max(rho * rho - half * half, 0));
        } else {
            const rt = @sqrt(half * half + qd * qd);
            dist = @min(rho + @sqrt(@max(rho * rho - half * half, 0)), 0.9 * (qd + rt));
        }
        const x = mid.add(nrm.scale(dist));
        const hx = field.eval(x);
        var ok = dist > 0.25 * hm;
        var loc: Mesh.Located = undefined;
        if (ok) {
            loc = mesh.locate(x, t);
            if (loc.outside) ok = false;
        }
        if (ok) {
            // Reject points too close to existing nodes or constrained edges near the target.
            const lt = loc.t;
            const lq = mesh.triPoints(lt);
            for (0..3) |i| {
                if (lq[i].dist(x) < 0.45 * hx) ok = false;
                if (mesh.isCons(lt, i) or mesh.tn.items[lt][i] == NONE) {
                    if (geom.pointSegmentDist(x, lq[next3(i)], lq[prev3(i)]) < 0.4 * hx) ok = false;
                }
            }
        }
        var inserted = false;
        if (ok) {
            if (try mesh.insertBW(x, loc.t, 0, &cavity, &bnd)) |_| {
                // Reject if the new star has nodes too close (check new edges), else keep.
                inserted = true;
                try ensure(gpa, &accepted, &ratio, mesh.tv.items.len);
                for (bnd.items) |e| {
                    const nt = e.tri;
                    ratio.items[nt] = Ctx.evalTri(mesh, field, nt);
                    accepted.items[nt] = ratio.items[nt] <= fo.accept;
                }
                for (bnd.items) |e| {
                    const nt = e.tri;
                    if (isActive(mesh, accepted.items, nt)) try pq.push(gpa, .{ .ratio = ratio.items[nt], .t = nt, .gen = mesh.tgen.items[nt] });
                    const u = e.outside;
                    if (u != NONE and isActive(mesh, accepted.items, u)) try pq.push(gpa, .{ .ratio = ratio.items[u], .t = u, .gen = mesh.tgen.items[u] });
                }
            }
        }
        if (!inserted or (mesh.talive.items[t] and mesh.tgen.items[t] == item.gen)) {
            // t survived: accept it so the front moves on.
            if (mesh.talive.items[t]) {
                accepted.items[t] = true;
                for (0..3) |i| {
                    const u = mesh.tn.items[t][i];
                    if (u != NONE and isActive(mesh, accepted.items, u)) try pq.push(gpa, .{ .ratio = ratio.items[u], .t = u, .gen = mesh.tgen.items[u] });
                }
            }
        }
    }
}

test "cdt of a square with a hole keeps boundary edges" {
    const gpa = std.testing.allocator;
    const sq = [_]Vec2{ .init(0, 0), .init(40, 0), .init(40, 20), .init(0, 20) };
    var hole: [64]Vec2 = undefined;
    for (0..64) |i| {
        const a = -2.0 * std.math.pi * @as(f64, @floatFromInt(i)) / 64.0;
        hole[i] = .init(20 + 5 * @cos(a), 10 + 5 * @sin(a));
    }
    const loops = [_]boundary.Loop{ .{ .role = .outer, .points = &sq }, .{ .role = .hole, .points = &hole } };
    var diag = boundary.Diag{};
    var bd = try boundary.build(gpa, &loops, .{ .target_size = 2 }, &diag);
    defer bd.deinit(gpa);
    var mesh = Mesh.init(gpa);
    defer mesh.deinit();
    try triangulateBoundary(gpa, &bd, &mesh, &diag);
    try std.testing.expect(mesh.checkConsistency());
    // Every boundary edge is present with NONE on one side.
    for (bd.loops.items) |bl| {
        const m = bl.items.len;
        for (0..m) |k| {
            const a = bl.items[k].node;
            const b = bl.items[(k + 1) % m].node;
            const f = findEdge(&mesh, a, b) orelse return error.TestUnexpectedResult;
            try std.testing.expect(mesh.tn.items[f.t][f.i] == NONE);
        }
    }
    // Area equals the domain area.
    var area: f64 = 0;
    for (mesh.tv.items, 0..) |_, ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        const q = mesh.triPoints(t);
        area += geom.triArea(q[0], q[1], q[2]);
    }
    var poly_area = geom.polygonArea(&sq);
    var hp: [64]Vec2 = undefined;
    for (bd.loops.items[1].items, 0..) |it, k| hp[k] = bd.points.items[it.node];
    poly_area += geom.polygonArea(hp[0..bd.loops.items[1].items.len]);
    try std.testing.expectApproxEqRel(poly_area, area, 1e-9);

    try frontalInsert(gpa, &mesh, &bd.field.?, .{});
    try std.testing.expect(mesh.checkConsistency());
    var min_q: f64 = 1;
    var cnt: usize = 0;
    for (mesh.tv.items, 0..) |_, ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        const q = mesh.triPoints(t);
        min_q = @min(min_q, geom.triQuality(q[0], q[1], q[2]));
        cnt += 1;
    }
    try std.testing.expect(cnt > 300);
    try std.testing.expect(min_q > 0.3);
}

test "milestone 1: fixed boundary nodes kept exactly in the triangulation" {
    const gpa = std.testing.allocator;
    const fixtures = @import("fixtures.zig");
    var fx = try fixtures.plateWithHoleFixed(gpa);
    defer fx.deinit(gpa);
    var diag = boundary.Diag{};
    var bd = try boundary.build(gpa, fx.loops.items, .{ .target_size = 2 }, &diag);
    defer bd.deinit(gpa);
    try std.testing.expectEqual(@as(usize, 76), bd.points.items.len);
    var mesh = Mesh.init(gpa);
    defer mesh.deinit();
    try triangulateBoundary(gpa, &bd, &mesh, &diag);
    try frontalInsert(gpa, &mesh, &bd.field.?, .{});
    try std.testing.expect(mesh.checkConsistency());
    // The given nodes are exactly the first 76 mesh nodes, bit for bit.
    var k: usize = 0;
    for (fx.loops.items) |l| for (l.fixed_runs[0].nodes) |q| {
        try std.testing.expect(mesh.p(@intCast(k)).eql(q));
        k += 1;
    };
    // Boundary edges of the triangulation are exactly the fixed node pairs.
    var nb: usize = 0;
    for (mesh.tv.items, 0..) |tv, ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        for (0..3) |i| {
            if (mesh.tn.items[t][i] != NONE) continue;
            nb += 1;
            const a = tv[next3(i)];
            const b = tv[prev3(i)];
            try std.testing.expect(a < 76 and b < 76);
            const d = if (a > b) a - b else b - a;
            try std.testing.expect(d == 1 or d == 59 or d == 15);
        }
        for (tv) |v| if (v >= 76) try std.testing.expect(!mesh.isFixed(v));
    }
    try std.testing.expectEqual(@as(usize, 76), nb);
    var min_q: f64 = 1;
    for (mesh.tv.items, 0..) |_, ti| {
        const t: u32 = @intCast(ti);
        if (!mesh.talive.items[t]) continue;
        const q = mesh.triPoints(t);
        min_q = @min(min_q, geom.triQuality(q[0], q[1], q[2]));
    }
    try std.testing.expect(min_q > 0.4);
}
