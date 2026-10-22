//! Smoothing of quad meshes. Fixed (boundary) nodes never move.
//!
//! 1. Angle-based smoothing (Zhou and Shimada 2000) blended with
//!    length-weighted Laplacian smoothing. A move is accepted only if it keeps
//!    every incident quad convex and does not lower their worst corner much.
//! 2. Local optimization of the worst elements: a deterministic pattern search
//!    on each node that maximizes the minimum corner scaled Jacobian of its
//!    quads. Inverted or reflex quads have negative corners, so the same
//!    search untangles them first.

const std = @import("std");
const geom = @import("geom.zig");
const polymesh = @import("polymesh.zig");
const Vec2 = geom.Vec2;
const PolyMesh = polymesh.PolyMesh;
const NONE = polymesh.NONE;

pub const Options = struct {
    iterations: u32 = 30,
    /// Elements below this scaled Jacobian get local optimization.
    optimize_below: f64 = 0.55,
    optimize_rounds: u32 = 8,
};

/// Objective of node v: minimum corner scaled Jacobian over its elements.
fn nodeObjective(pm: *const PolyMesh, v: u32) f64 {
    return pm.minSJAround(v);
}

/// Neighbors of v connected by an element edge, appended to out (unique).
fn edgeNeighbors(pm: *const PolyMesh, v: u32, out: *std.ArrayList(u32)) !void {
    out.clearRetainingCapacity();
    for (pm.node_elems.items[v].items) |x| {
        const e = pm.elems.items[x];
        const n = PolyMesh.nv(e);
        var k: usize = 0;
        while (e[k] != v) k += 1;
        for ([_]u32{ e[(k + 1) % n], e[(k + n - 1) % n] }) |w| {
            if (std.mem.indexOfScalar(u32, out.items, w) == null) try out.append(pm.gpa, w);
        }
    }
}

/// Angle-based target for v (Zhou-Shimada): for each edge (j, v), rotate v about j onto the
/// bisector of the two element edges at j adjacent to (j, v).
fn angleTarget(pm: *const PolyMesh, v: u32, nbrs: []const u32) ?Vec2 {
    const pv = pm.p(v);
    var acc = Vec2.init(0, 0);
    var cnt: f64 = 0;
    for (nbrs) |j| {
        const pj = pm.p(j);
        // Edges at j adjacent to (j, v): in each element containing edge (j, v).
        var ks: [2]u32 = .{ NONE, NONE };
        var nk: usize = 0;
        for (pm.node_elems.items[v].items) |x| {
            const e = pm.elems.items[x];
            const n = PolyMesh.nv(e);
            var kj: usize = n;
            for (0..n) |k| if (e[k] == j) {
                kj = k;
            };
            if (kj == n) continue;
            // v must be adjacent to j in this element.
            const nx = e[(kj + 1) % n];
            const pr = e[(kj + n - 1) % n];
            if (nx == v) {
                if (nk < 2) ks[nk] = pr;
                nk += 1;
            } else if (pr == v) {
                if (nk < 2) ks[nk] = nx;
                nk += 1;
            }
        }
        if (nk != 2) continue;
        const u = pv.sub(pj);
        const a1 = pm.p(ks[0]).sub(pj).normalized();
        const a2 = pm.p(ks[1]).sub(pj).normalized();
        // Bisector of the two neighboring edges on the side of u (no trigonometry, so the
        // result is identical on every platform).
        var b = a1.add(a2);
        if (b.len2() < 1e-24) b = a1.perp();
        b = b.normalized();
        if (b.dot(u) < 0) b = b.scale(-1);
        acc = acc.add(pj.add(b.scale(u.len())));
        cnt += 1;
    }
    if (cnt == 0) return null;
    return acc.scale(1.0 / cnt);
}

fn laplaceTarget(pm: *const PolyMesh, v: u32, nbrs: []const u32) ?Vec2 {
    if (nbrs.len == 0) return null;
    const pv = pm.p(v);
    var acc = Vec2.init(0, 0);
    var w: f64 = 0;
    for (nbrs) |j| {
        const pj = pm.p(j);
        const l = pv.dist(pj);
        acc = acc.add(pj.scale(l));
        w += l;
    }
    if (w == 0) return null;
    return acc.scale(1.0 / w);
}

/// Moves v to q if all incident elements stay valid and the worst corner does not drop
/// below min(current worst, floor). Returns true if moved.
fn tryMove(pm: *PolyMesh, v: u32, q: Vec2, floor: f64) bool {
    if (pm.fixed.items[v]) return false;
    if (!std.math.isFinite(q.x) or !std.math.isFinite(q.y)) return false;
    const old = pm.pts.items[v];
    const before = nodeObjective(pm, v);
    pm.pts.items[v] = q;
    var ok = true;
    for (pm.node_elems.items[v].items) |x| {
        if (!pm.elemValid(x)) {
            ok = false;
            break;
        }
    }
    if (ok) {
        const after = nodeObjective(pm, v);
        if (after < @min(before, floor)) ok = false;
    }
    if (!ok) pm.pts.items[v] = old;
    return ok;
}

/// Pattern search maximizing the node objective. Works on tangled neighborhoods too.
pub fn optimizeNode(pm: *PolyMesh, v: u32) void {
    if (pm.fixed.items[v]) return;
    const elems = pm.node_elems.items[v].items;
    if (elems.len == 0) return;
    var scale: f64 = 0;
    var cnt: f64 = 0;
    for (elems) |x| {
        const e = pm.elems.items[x];
        const n = PolyMesh.nv(e);
        for (0..n) |k| {
            scale += pm.p(e[k]).dist(pm.p(e[(k + 1) % n]));
            cnt += 1;
        }
    }
    scale /= cnt;
    var best = nodeObjective(pm, v);
    var step = 0.15 * scale;
    const start = pm.pts.items[v];
    const max_move = 0.6 * scale;
    const dirs = [8][2]f64{ .{ 1, 0 }, .{ 0.7071067811865476, 0.7071067811865476 }, .{ 0, 1 }, .{ -0.7071067811865476, 0.7071067811865476 }, .{ -1, 0 }, .{ -0.7071067811865476, -0.7071067811865476 }, .{ 0, -1 }, .{ 0.7071067811865476, -0.7071067811865476 } };
    var iter: usize = 0;
    while (step > 1e-3 * scale and iter < 80) : (iter += 1) {
        const cur = pm.pts.items[v];
        var improved = false;
        var best_p = cur;
        for (dirs) |d| {
            const q = Vec2.init(cur.x + d[0] * step, cur.y + d[1] * step);
            if (q.dist(start) > max_move) continue;
            pm.pts.items[v] = q;
            const f = nodeObjective(pm, v);
            if (f > best + 1e-12) {
                best = f;
                best_p = q;
                improved = true;
            }
        }
        pm.pts.items[v] = best_p;
        if (!improved) step *= 0.5;
    }
}

pub fn smooth(pm: *PolyMesh, opts: Options) !void {
    var nbrs: std.ArrayList(u32) = .empty;
    defer nbrs.deinit(pm.gpa);
    const n = pm.pts.items.len;
    // Untangle first: optimize nodes of invalid elements.
    for (0..3) |_| {
        var any = false;
        for (pm.elems.items, 0..) |e, xi| {
            if (!pm.alive.items[xi]) continue;
            if (pm.elemValid(@intCast(xi))) continue;
            any = true;
            for (0..PolyMesh.nv(e)) |k| optimizeNode(pm, e[k]);
        }
        if (!any) break;
    }
    var it: u32 = 0;
    while (it < opts.iterations) : (it += 1) {
        // Largest move relative to the local edge length; stop once the sweep has converged.
        var moved: f64 = 0;
        for (0..n) |vi| {
            const v: u32 = @intCast(vi);
            if (pm.fixed.items[v] or pm.node_elems.items[v].items.len == 0) continue;
            try edgeNeighbors(pm, v, &nbrs);
            const ta = angleTarget(pm, v, nbrs.items) orelse continue;
            const tl = laplaceTarget(pm, v, nbrs.items) orelse continue;
            const target = ta.lerp(tl, 0.5);
            const cur = pm.p(v);
            var lsum: f64 = 0;
            for (nbrs.items) |w| lsum += cur.dist(pm.p(w));
            const lref = lsum / @as(f64, @floatFromInt(nbrs.items.len));
            if (tryMove(pm, v, target, 0.5)) {
                moved = @max(moved, cur.dist(target) / lref);
            } else if (tryMove(pm, v, cur.lerp(target, 0.5), 0.5)) {
                moved = @max(moved, 0.5 * cur.dist(target) / lref);
            }
        }
        if (moved < 2e-3) break;
    }
    // Local optimization of poor elements, worst first.
    var round: u32 = 0;
    var worst: std.ArrayList(struct { q: f64, x: u32 }) = .empty;
    defer worst.deinit(pm.gpa);
    while (round < opts.optimize_rounds) : (round += 1) {
        worst.clearRetainingCapacity();
        for (pm.elems.items, 0..) |_, xi| {
            if (!pm.alive.items[xi]) continue;
            const q = pm.elemSJ(@intCast(xi));
            if (q < opts.optimize_below) try worst.append(pm.gpa, .{ .q = q, .x = @intCast(xi) });
        }
        if (worst.items.len == 0) break;
        std.mem.sort(@TypeOf(worst.items[0]), worst.items, {}, struct {
            fn lt(_: void, a: @TypeOf(worst.items[0]), b: @TypeOf(worst.items[0])) bool {
                if (a.q != b.q) return a.q < b.q;
                return a.x < b.x;
            }
        }.lt);
        var before: f64 = 0;
        for (worst.items) |w| before += w.q;
        for (worst.items) |w| {
            const e = pm.elems.items[w.x];
            if (!pm.alive.items[w.x]) continue;
            for (0..PolyMesh.nv(e)) |k| optimizeNode(pm, e[k]);
        }
        // Stop when a round no longer improves the poor elements.
        var after: f64 = 0;
        for (worst.items) |w| after += pm.elemSJ(w.x);
        if (after - before < 1e-4 * @as(f64, @floatFromInt(worst.items.len))) break;
    }
}

/// Smoothing and optimization restricted to the given nodes (after a topological change).
/// The first `core` nodes are the nodes of the changed elements: only they get the
/// (costly) pattern-search optimization; all nodes are smoothed.
pub fn smoothPatch(pm: *PolyMesh, nodes: []const u32, core: usize, iters: u32) !void {
    var nbrs: std.ArrayList(u32) = .empty;
    defer nbrs.deinit(pm.gpa);
    // Untangle / repair invalid elements first.
    for (0..2) |_| {
        for (nodes[0..core]) |v| {
            if (pm.fixed.items[v]) continue;
            var bad = false;
            for (pm.node_elems.items[v].items) |x| {
                if (!pm.elemValid(x)) bad = true;
            }
            if (bad) optimizeNode(pm, v);
        }
    }
    var it: u32 = 0;
    while (it < iters) : (it += 1) {
        for (nodes) |v| {
            if (pm.fixed.items[v] or pm.node_elems.items[v].items.len == 0) continue;
            try edgeNeighbors(pm, v, &nbrs);
            const ta = angleTarget(pm, v, nbrs.items) orelse continue;
            const tl = laplaceTarget(pm, v, nbrs.items) orelse continue;
            const target = ta.lerp(tl, 0.5);
            if (!tryMove(pm, v, target, 0.5)) _ = tryMove(pm, v, pm.p(v).lerp(target, 0.5), 0.5);
        }
    }
    for (nodes[0..core]) |v| {
        if (pm.fixed.items[v]) continue;
        if (pm.minSJAround(v) < 0.5) optimizeNode(pm, v);
    }
}
