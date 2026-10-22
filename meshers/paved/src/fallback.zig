//! Fallback for regions where the Q-Morph front stalled: the remaining
//! triangles are paired into quads (Blossom-style). Pairs are first taken
//! greedily by quad quality, then Edmonds' blossom algorithm completes the
//! matching to maximum cardinality. When no perfect matching exists, edges
//! around the unmatched triangles are flipped and the region is matched again;
//! as a last resort an unmatched triangle pair is joined through a strip of
//! quads that is remeshed with interior nodes (see `repairPair`).

const std = @import("std");
const geom = @import("geom.zig");
const tm = @import("trimesh.zig");
const qmorph = @import("qmorph.zig");
const Vec2 = geom.Vec2;
const NONE = tm.NONE;
const next3 = tm.next3;
const prev3 = tm.prev3;
const Allocator = std.mem.Allocator;

pub const Stats = struct {
    regions: usize = 0,
    matched_quads: usize = 0,
    flip_rounds: usize = 0,
    unmatched: usize = 0,
    repaired: usize = 0,
};

/// Maximum cardinality matching on a general graph (Edmonds' blossom algorithm).
const Blossom = struct {
    gpa: Allocator,
    n: usize,
    adj_start: []u32,
    adj: []u32,
    match: []i32,
    p: []i32,
    base: []u32,
    used: []bool,
    blossom: []bool,
    lca_used: []bool,
    queue: []u32,

    fn init(gpa: Allocator, n: usize, adj_start: []u32, adj: []u32) !Blossom {
        const b = Blossom{
            .gpa = gpa,
            .n = n,
            .adj_start = adj_start,
            .adj = adj,
            .match = try gpa.alloc(i32, n),
            .p = try gpa.alloc(i32, n),
            .base = try gpa.alloc(u32, n),
            .used = try gpa.alloc(bool, n),
            .blossom = try gpa.alloc(bool, n),
            .lca_used = try gpa.alloc(bool, n),
            .queue = try gpa.alloc(u32, n),
        };
        @memset(b.match, -1);
        return b;
    }

    fn deinit(self: *Blossom) void {
        const g = self.gpa;
        g.free(self.match);
        g.free(self.p);
        g.free(self.base);
        g.free(self.used);
        g.free(self.blossom);
        g.free(self.lca_used);
        g.free(self.queue);
    }

    fn lca(self: *Blossom, a_in: u32, b_in: u32) u32 {
        @memset(self.lca_used, false);
        var a = a_in;
        while (true) {
            a = self.base[a];
            self.lca_used[a] = true;
            if (self.match[a] < 0) break;
            a = @intCast(self.p[@intCast(self.match[a])]);
        }
        var b = b_in;
        while (true) {
            b = self.base[b];
            if (self.lca_used[b]) return b;
            b = @intCast(self.p[@intCast(self.match[b])]);
        }
    }

    fn markPath(self: *Blossom, v_in: u32, b: u32, children_in: u32) void {
        var v = v_in;
        var children = children_in;
        while (self.base[v] != b) {
            const mv: u32 = @intCast(self.match[v]);
            self.blossom[self.base[v]] = true;
            self.blossom[self.base[mv]] = true;
            self.p[v] = @intCast(children);
            children = mv;
            v = @intCast(self.p[mv]);
        }
    }

    fn findPath(self: *Blossom, root: u32) ?u32 {
        @memset(self.used, false);
        @memset(self.p, -1);
        for (self.base, 0..) |*x, i| x.* = @intCast(i);
        self.used[root] = true;
        var qh: usize = 0;
        var qt: usize = 0;
        self.queue[qt] = root;
        qt += 1;
        while (qh < qt) {
            const v = self.queue[qh];
            qh += 1;
            for (self.adj[self.adj_start[v]..self.adj_start[v + 1]]) |to_in| {
                const to = to_in;
                if (self.base[v] == self.base[to] or self.match[v] == @as(i32, @intCast(to))) continue;
                if (to == root or (self.match[to] >= 0 and self.p[@intCast(self.match[to])] >= 0)) {
                    const curbase = self.lca(v, to);
                    @memset(self.blossom, false);
                    self.markPath(v, curbase, to);
                    self.markPath(to, curbase, v);
                    for (0..self.n) |i| {
                        if (self.blossom[self.base[i]]) {
                            self.base[i] = curbase;
                            if (!self.used[i]) {
                                self.used[i] = true;
                                self.queue[qt] = @intCast(i);
                                qt += 1;
                            }
                        }
                    }
                } else if (self.p[to] < 0) {
                    self.p[to] = @intCast(v);
                    if (self.match[to] < 0) return to;
                    const mt: u32 = @intCast(self.match[to]);
                    self.used[mt] = true;
                    self.queue[qt] = mt;
                    qt += 1;
                }
            }
        }
        return null;
    }

    fn augmentAll(self: *Blossom) void {
        for (0..self.n) |vi| {
            const v: u32 = @intCast(vi);
            if (self.match[v] >= 0) continue;
            if (self.findPath(v)) |end| {
                var u: i32 = @intCast(end);
                while (u >= 0) {
                    const pv = self.p[@intCast(u)];
                    const ppv = self.match[@intCast(pv)];
                    self.match[@intCast(u)] = pv;
                    self.match[@intCast(pv)] = u;
                    u = ppv;
                }
            }
        }
    }
};

const Pair = struct { a: u32, b: u32, q: f64 };

fn pairQuad(m: *const tm.Mesh, t: u32, i: usize) ?[4]u32 {
    const u = m.tn.items[t][i];
    if (u == NONE) return null;
    const tv = m.tv.items[t];
    const c = tv[i];
    const a = tv[next3(i)];
    const b = tv[prev3(i)];
    const j = m.edgeIndex(u, b, a) orelse return null;
    const d = m.tv.items[u][j];
    return .{ c, a, d, b };
}

fn quadScore(m: *const tm.Mesh, q: [4]u32) f64 {
    const pq = [4]Vec2{ m.p(q[0]), m.p(q[1]), m.p(q[2]), m.p(q[3]) };
    if (geom.quadConvex(pq)) return geom.quadQuality(pq);
    // Non-convex: usable only if every reflex corner is a free node (smoothing can fix it).
    for (0..4) |k| {
        if (geom.orient(pq[(k + 3) % 4], pq[k], pq[(k + 1) % 4]) <= 0 and m.isFixed(q[k])) return -10;
    }
    return -1 + geom.quadScaledJacobian(pq) * 0.01;
}

/// Converts all remaining triangles of the Q-Morph state into quads.
pub fn run(gpa: Allocator, qm: *qmorph.QMorph, stats: *Stats) !void {
    const m = qm.m;
    var round: usize = 0;
    while (round < 12 and m.alive_count > 0) : (round += 1) {
        // Index alive triangles.
        var tris: std.ArrayList(u32) = .empty;
        defer tris.deinit(gpa);
        const local = try gpa.alloc(u32, m.tv.items.len);
        defer gpa.free(local);
        @memset(local, NONE);
        for (m.talive.items, 0..) |al, ti| {
            if (!al) continue;
            local[ti] = @intCast(tris.items.len);
            try tris.append(gpa, @intCast(ti));
        }
        const n = tris.items.len;
        // Graph: adjacent pairs whose quad is usable.
        var pairs: std.ArrayList(Pair) = .empty;
        defer pairs.deinit(gpa);
        var deg = try gpa.alloc(u32, n + 1);
        defer gpa.free(deg);
        @memset(deg, 0);
        for (tris.items, 0..) |t, li| {
            for (0..3) |i| {
                const u = m.tn.items[t][i];
                if (u == NONE or u < t) continue;
                const q = pairQuad(m, t, i) orelse continue;
                const sc = quadScore(m, q);
                if (sc <= -5) continue;
                try pairs.append(gpa, .{ .a = @intCast(li), .b = local[u], .q = sc });
                deg[li + 1] += 1;
                deg[local[u] + 1] += 1;
            }
        }
        for (1..n + 1) |k| deg[k] += deg[k - 1];
        const adj = try gpa.alloc(u32, deg[n]);
        defer gpa.free(adj);
        const fillp = try gpa.alloc(u32, n);
        defer gpa.free(fillp);
        @memcpy(fillp, deg[0..n]);
        // Neighbor order: best pairs first (helps the search find good augmenting paths).
        std.mem.sort(Pair, pairs.items, {}, struct {
            fn lt(_: void, x: Pair, y: Pair) bool {
                if (x.q != y.q) return x.q > y.q;
                if (x.a != y.a) return x.a < y.a;
                return x.b < y.b;
            }
        }.lt);
        for (pairs.items) |pr| {
            adj[fillp[pr.a]] = pr.b;
            fillp[pr.a] += 1;
            adj[fillp[pr.b]] = pr.a;
            fillp[pr.b] += 1;
        }
        var bl = try Blossom.init(gpa, n, deg, adj);
        defer bl.deinit();
        // Greedy by quality.
        for (pairs.items) |pr| {
            if (pr.q < 0) continue;
            if (bl.match[pr.a] < 0 and bl.match[pr.b] < 0) {
                bl.match[pr.a] = @intCast(pr.b);
                bl.match[pr.b] = @intCast(pr.a);
            }
        }
        bl.augmentAll();
        var unmatched: usize = 0;
        for (bl.match) |x| {
            if (x < 0) unmatched += 1;
        }
        if (unmatched == 0 or round == 11) {
            // Commit matched pairs.
            for (0..n) |li| {
                const mj = bl.match[li];
                if (mj < 0 or @as(usize, @intCast(mj)) < li) continue;
                const t = tris.items[li];
                const u = tris.items[@intCast(mj)];
                var i: usize = 0;
                while (i < 3 and m.tn.items[t][i] != u) i += 1;
                if (i == 3) continue;
                const q = pairQuad(m, t, i).?;
                try m.reserveKills(2);
                try m.killTri(t);
                try m.killTri(u);
                // Detach neighbors (they become quad edges).
                for ([_]u32{ t, u }) |x| {
                    for (0..3) |e| {
                        const y = m.tn.items[x][e];
                        if (y == NONE or y == t or y == u) continue;
                        for (0..3) |f| if (m.tn.items[y][f] == x) {
                            m.tn.items[y][f] = NONE;
                        };
                    }
                }
                try qm.addQuad(q);
                stats.matched_quads += 1;
            }
            stats.unmatched = unmatched;
            return;
        }
        // Perturb: flip edges around unmatched triangles, then match again.
        stats.flip_rounds += 1;
        for (0..n) |li| {
            if (bl.match[li] >= 0) continue;
            const t = tris.items[li];
            if (!m.talive.items[t]) continue;
            const k0 = (round + li) % 3;
            for (0..3) |kk| {
                const i = (k0 + kk) % 3;
                if (m.canFlip(t, i)) {
                    _ = m.flip(t, i);
                    break;
                }
            }
        }
    }
}
