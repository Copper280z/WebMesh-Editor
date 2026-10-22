//! Mixed quad/triangle mesh with node-to-element adjacency, used after the
//! front has finished: leftover-triangle repair, topological cleanup and
//! smoothing all work on this structure. Triangles have elem[3] == NONE.

const std = @import("std");
const geom = @import("geom.zig");
const tm = @import("trimesh.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const NONE: u32 = tm.NONE;

pub const PolyMesh = struct {
    gpa: Allocator,
    pts: std.ArrayList(Vec2) = .empty,
    fixed: std.ArrayList(bool) = .empty,
    elems: std.ArrayList([4]u32) = .empty,
    alive: std.ArrayList(bool) = .empty,
    node_elems: std.ArrayList(std.ArrayList(u32)) = .empty,
    /// Edges that must stay (control loops and curves), keyed by ekey; null if none.
    constrained: ?*const std.AutoHashMap(u64, void) = null,

    pub fn init(gpa: Allocator) PolyMesh {
        return .{ .gpa = gpa };
    }

    pub fn deinit(self: *PolyMesh) void {
        const g = self.gpa;
        self.pts.deinit(g);
        self.fixed.deinit(g);
        self.elems.deinit(g);
        self.alive.deinit(g);
        for (self.node_elems.items) |*l| l.deinit(g);
        self.node_elems.deinit(g);
    }

    pub fn addNode(self: *PolyMesh, pos: Vec2, fixed: bool) !u32 {
        const id: u32 = @intCast(self.pts.items.len);
        try self.pts.append(self.gpa, pos);
        try self.fixed.append(self.gpa, fixed);
        try self.node_elems.append(self.gpa, .empty);
        return id;
    }

    pub inline fn isTri(e: [4]u32) bool {
        return e[3] == NONE;
    }

    pub inline fn nv(e: [4]u32) usize {
        return if (e[3] == NONE) 3 else 4;
    }

    pub fn addElem(self: *PolyMesh, e: [4]u32) !u32 {
        const id: u32 = @intCast(self.elems.items.len);
        try self.elems.append(self.gpa, e);
        try self.alive.append(self.gpa, true);
        for (0..nv(e)) |k| try self.node_elems.items[e[k]].append(self.gpa, id);
        return id;
    }

    pub fn killElem(self: *PolyMesh, id: u32) void {
        const e = self.elems.items[id];
        self.alive.items[id] = false;
        for (0..nv(e)) |k| {
            const l = &self.node_elems.items[e[k]];
            for (l.items, 0..) |x, i| if (x == id) {
                _ = l.orderedRemove(i);
                break;
            };
        }
    }

    /// Re-activates a killed element (used to undo a topological change).
    pub fn reviveElem(self: *PolyMesh, id: u32) !void {
        const e = self.elems.items[id];
        self.alive.items[id] = true;
        for (0..nv(e)) |k| try self.node_elems.items[e[k]].append(self.gpa, id);
    }

    pub fn isConstrained(self: *const PolyMesh, a: u32, b: u32) bool {
        const c = self.constrained orelse return false;
        return c.contains((@as(u64, @min(a, b)) << 32) | @max(a, b));
    }

    pub inline fn p(self: *const PolyMesh, v: u32) Vec2 {
        return self.pts.items[v];
    }

    pub fn quadPts(self: *const PolyMesh, e: [4]u32) [4]Vec2 {
        return .{ self.p(e[0]), self.p(e[1]), self.p(e[2]), self.p(e[3]) };
    }

    /// Element on the other side of the edge (a, b) from element `self_id`, or NONE.
    pub fn across(self: *const PolyMesh, self_id: u32, a: u32, b: u32) u32 {
        for (self.node_elems.items[a].items) |x| {
            if (x == self_id) continue;
            const e = self.elems.items[x];
            const n = nv(e);
            for (0..n) |k| {
                if (e[k] == b and e[(k + 1) % n] == a) return x;
                if (e[k] == a and e[(k + 1) % n] == b) return x;
            }
        }
        return NONE;
    }

    /// Number of elements containing both a and b as an edge.
    pub fn edgeUse(self: *const PolyMesh, a: u32, b: u32) usize {
        var c: usize = 0;
        for (self.node_elems.items[a].items) |x| {
            const e = self.elems.items[x];
            const n = nv(e);
            for (0..n) |k| {
                if ((e[k] == a and e[(k + 1) % n] == b) or (e[k] == b and e[(k + 1) % n] == a)) c += 1;
            }
        }
        return c;
    }

    pub fn triCount(self: *const PolyMesh) usize {
        var c: usize = 0;
        for (self.elems.items, 0..) |e, i| {
            if (self.alive.items[i] and isTri(e)) c += 1;
        }
        return c;
    }

    /// Minimum corner scaled Jacobian of the alive elements around node v
    /// (triangles count via the corner sine as well).
    pub fn minSJAround(self: *const PolyMesh, v: u32) f64 {
        var m: f64 = 1;
        for (self.node_elems.items[v].items) |x| m = @min(m, self.elemSJ(x));
        return m;
    }

    pub fn elemSJ(self: *const PolyMesh, x: u32) f64 {
        const e = self.elems.items[x];
        if (isTri(e)) {
            const a = self.p(e[0]);
            const b = self.p(e[1]);
            const c = self.p(e[2]);
            const ar = 2.0 * geom.triArea(a, b, c);
            const la = a.dist(b);
            const lb = b.dist(c);
            const lc = c.dist(a);
            const mx = @max(la * lc, @max(la * lb, lb * lc));
            if (mx == 0) return -1;
            return ar / mx * (2.0 / @sqrt(3.0));
        }
        return geom.quadScaledJacobian(self.quadPts(e));
    }

    pub fn elemValid(self: *const PolyMesh, x: u32) bool {
        const e = self.elems.items[x];
        if (isTri(e)) return geom.orient(self.p(e[0]), self.p(e[1]), self.p(e[2])) > 0;
        return geom.quadConvex(self.quadPts(e));
    }

    // ------------------------------------------------------------------
    // Leftover triangle repair

    /// Pairs leftover triangles into quads. A triangle is carried across quads toward the
    /// nearest other triangle (each step re-splits the pentagon formed by the triangle and
    /// the next quad), and the two are merged once adjacent. Returns the number of
    /// triangles that could not be paired.
    pub fn repairTriangles(self: *PolyMesh) !usize {
        var prev_par = std.ArrayList(u32).empty;
        defer prev_par.deinit(self.gpa);
        var queue = std.ArrayList(u32).empty;
        defer queue.deinit(self.gpa);
        var guard: usize = 0;
        var unpaired: usize = 0;
        var skip = std.ArrayList(u32).empty;
        defer skip.deinit(self.gpa);
        while (guard < 100000) : (guard += 1) {
            // First alive triangle not known to be unpairable.
            var t: u32 = NONE;
            for (self.elems.items, 0..) |e, i| {
                if (self.alive.items[i] and isTri(e) and std.mem.indexOfScalar(u32, skip.items, @intCast(i)) == null) {
                    t = @intCast(i);
                    break;
                }
            }
            if (t == NONE) break;
            // BFS over elements to the nearest other triangle.
            const ne = self.elems.items.len;
            try prev_par.resize(self.gpa, ne);
            @memset(prev_par.items, NONE);
            queue.clearRetainingCapacity();
            try queue.append(self.gpa, t);
            prev_par.items[t] = t;
            var target: u32 = NONE;
            var qh: usize = 0;
            while (qh < queue.items.len and target == NONE) : (qh += 1) {
                const x = queue.items[qh];
                const e = self.elems.items[x];
                const n = nv(e);
                for (0..n) |k| {
                    if (self.isConstrained(e[k], e[(k + 1) % n])) continue;
                    const y = self.across(x, e[k], e[(k + 1) % n]);
                    if (y == NONE or prev_par.items[y] != NONE) continue;
                    prev_par.items[y] = x;
                    if (isTri(self.elems.items[y])) {
                        target = y;
                        break;
                    }
                    try queue.append(self.gpa, y);
                }
            }
            if (target == NONE) {
                try skip.append(self.gpa, t);
                unpaired += 1;
                continue;
            }
            // Path t = e0, e1, ..., ek = target.
            var path = std.ArrayList(u32).empty;
            defer path.deinit(self.gpa);
            var cur = target;
            while (cur != t) : (cur = prev_par.items[cur]) try path.append(self.gpa, cur);
            try path.append(self.gpa, t);
            std.mem.reverse(u32, path.items);
            var tri = t;
            var k: usize = 1;
            while (k + 1 < path.items.len) : (k += 1) {
                const q = path.items[k];
                const nxt = path.items[k + 1];
                tri = try self.carry(tri, q, nxt) orelse break;
            }
            if (k + 1 < path.items.len) {
                try skip.append(self.gpa, t);
                unpaired += 1;
                continue;
            }
            try self.mergeTris(tri, target);
        }
        return unpaired;
    }

    fn sharedEdge(self: *const PolyMesh, x: u32, y: u32) ?[2]u32 {
        const e = self.elems.items[x];
        const n = nv(e);
        for (0..n) |k| {
            const a = e[k];
            const b = e[(k + 1) % n];
            if (self.across(x, a, b) == y) return .{ a, b };
        }
        return null;
    }

    /// Carries triangle `tri` across quad `q` so that the new triangle touches element `nxt`.
    fn carry(self: *PolyMesh, tri: u32, q: u32, nxt: u32) !?u32 {
        const se = self.sharedEdge(tri, q) orelse return null; // (s1, s2) in tri's CCW order
        const exit_e = self.sharedEdge(q, nxt) orelse return null;
        const te = self.elems.items[tri];
        const qe = self.elems.items[q];
        // Apex of the triangle.
        var apex: u32 = NONE;
        for (0..3) |k| if (te[k] != se[0] and te[k] != se[1]) {
            apex = te[k];
        };
        // Quad nodes from s1 around to s2: q has s2 -> s1; start at s1.
        var qi: usize = 0;
        while (qe[qi] != se[0]) qi += 1;
        const x = qe[(qi + 1) % 4];
        const y = qe[(qi + 2) % 4];
        // The triangle shares a second edge with the quad: their union is a triangle around
        // one interior node (s1 if apex == x, s2 if apex == y). Drop that node and carry on.
        if (apex == x or apex == y) {
            const inner = if (apex == x) se[0] else se[1];
            if (self.fixed.items[inner] or self.node_elems.items[inner].items.len != 2) return null;
            const tri_nodes = if (apex == x) [4]u32{ x, y, se[1], NONE } else [4]u32{ se[0], x, y, NONE };
            if (geom.orient(self.p(tri_nodes[0]), self.p(tri_nodes[1]), self.p(tri_nodes[2])) <= 0) return null;
            self.killElem(tri);
            self.killElem(q);
            return try self.addElem(tri_nodes);
        }
        const pent = [5]u32{ se[0], x, y, se[1], apex };
        // Candidate triangles: three consecutive pentagon nodes containing the exit edge.
        var best_score: f64 = -std.math.inf(f64);
        var best_start: usize = 0;
        for (0..5) |st| {
            const a = pent[st];
            const b = pent[(st + 1) % 5];
            const c = pent[(st + 2) % 5];
            const has = (a == exit_e[0] and b == exit_e[1]) or (b == exit_e[0] and c == exit_e[1]) or
                (a == exit_e[1] and b == exit_e[0]) or (b == exit_e[1] and c == exit_e[0]);
            if (!has) continue;
            const quad = [4]u32{ pent[(st + 2) % 5], pent[(st + 3) % 5], pent[(st + 4) % 5], pent[st] };
            const pq = self.quadPts(quad);
            var sc = geom.quadScaledJacobian(pq);
            if (geom.orient(self.p(a), self.p(b), self.p(c)) <= 0) sc -= 2;
            if (sc > best_score) {
                best_score = sc;
                best_start = st;
            }
        }
        if (best_score == -std.math.inf(f64)) return null;
        const st = best_start;
        const ntri = [4]u32{ pent[st], pent[(st + 1) % 5], pent[(st + 2) % 5], NONE };
        const nquad = [4]u32{ pent[(st + 2) % 5], pent[(st + 3) % 5], pent[(st + 4) % 5], pent[st] };
        self.killElem(tri);
        self.killElem(q);
        _ = try self.addElem(nquad);
        return try self.addElem(ntri);
    }

    fn mergeTris(self: *PolyMesh, t: u32, u: u32) !void {
        const se = self.sharedEdge(t, u) orelse return;
        const te = self.elems.items[t];
        const ue = self.elems.items[u];
        var x: u32 = NONE;
        var y: u32 = NONE;
        for (0..3) |k| {
            if (te[k] != se[0] and te[k] != se[1]) x = te[k];
            if (ue[k] != se[0] and ue[k] != se[1]) y = ue[k];
        }
        // t has a -> b (se), u has b -> a; quad (a, y, b, x).
        if (x == y or x == NONE or y == NONE) return;
        self.killElem(t);
        self.killElem(u);
        _ = try self.addElem(.{ se[0], y, se[1], x });
    }
};
