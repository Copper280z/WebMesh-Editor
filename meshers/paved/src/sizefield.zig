//! Graded size field.
//!
//! Each source i (a boundary point) has a size h_i and a growth slope k_i. The
//! field is h(x) = min(H, min_i h_i + k_i * |x - p_i|), where H is the target
//! size. A slope k = g - 1 makes element sizes grow by at most a factor g from
//! one element to the next (geometric growth h, h g, h g^2, ... sits exactly on
//! that line). Around holes the paving rows grow naturally by 2*pi/N per row
//! (N elements per circle); sources there may carry that larger slope.
//!
//! Evaluation is exact (not interpolated): sources are bucketed in a uniform
//! grid that is searched ring by ring until no closer ring can improve the
//! minimum.

const std = @import("std");
const geom = @import("geom.zig");
const Vec2 = geom.Vec2;
const Allocator = std.mem.Allocator;

pub const Source = struct {
    p: Vec2,
    h: f64,
    k: f64,
};

pub const SizeField = struct {
    sources: []Source,
    h_max: f64,
    h_min: f64,
    k_min: f64,
    origin: Vec2,
    cell: f64,
    nx: usize,
    ny: usize,
    cell_start: []u32,
    cell_items: []u32,

    pub fn init(gpa: Allocator, sources_in: []const Source, h_max: f64) !SizeField {
        const sources = try gpa.dupe(Source, sources_in);
        errdefer gpa.free(sources);
        var lo = Vec2.init(std.math.inf(f64), std.math.inf(f64));
        var hi = Vec2.init(-std.math.inf(f64), -std.math.inf(f64));
        var h_min: f64 = h_max;
        var k_min: f64 = std.math.inf(f64);
        for (sources) |s| {
            lo.x = @min(lo.x, s.p.x);
            lo.y = @min(lo.y, s.p.y);
            hi.x = @max(hi.x, s.p.x);
            hi.y = @max(hi.y, s.p.y);
            h_min = @min(h_min, s.h);
            k_min = @min(k_min, s.k);
        }
        if (sources.len == 0) {
            lo = .init(0, 0);
            hi = .init(1, 1);
            k_min = 1;
        }
        const ext = @max(hi.x - lo.x, hi.y - lo.y);
        // Cell size: about the target size, but keep the grid at most ~256 per side.
        var cell = @max(h_max, ext / 256.0);
        if (!(cell > 0)) cell = 1;
        const nx: usize = @intFromFloat(@floor((hi.x - lo.x) / cell) + 1);
        const ny: usize = @intFromFloat(@floor((hi.y - lo.y) / cell) + 1);
        const ncell = nx * ny;
        const cell_start = try gpa.alloc(u32, ncell + 1);
        errdefer gpa.free(cell_start);
        @memset(cell_start, 0);
        const cell_items = try gpa.alloc(u32, sources.len);
        errdefer gpa.free(cell_items);
        var self = SizeField{
            .sources = sources,
            .h_max = h_max,
            .h_min = h_min,
            .k_min = @max(k_min, 1e-6),
            .origin = lo,
            .cell = cell,
            .nx = nx,
            .ny = ny,
            .cell_start = cell_start,
            .cell_items = cell_items,
        };
        for (sources) |s| {
            const c = self.cellOf(s.p);
            cell_start[c[1] * nx + c[0] + 1] += 1;
        }
        for (1..ncell + 1) |i| cell_start[i] += cell_start[i - 1];
        const fill = try gpa.alloc(u32, ncell);
        defer gpa.free(fill);
        @memcpy(fill, cell_start[0..ncell]);
        for (sources, 0..) |s, i| {
            const c = self.cellOf(s.p);
            const idx = c[1] * nx + c[0];
            cell_items[fill[idx]] = @intCast(i);
            fill[idx] += 1;
        }
        return self;
    }

    pub fn deinit(self: *SizeField, gpa: Allocator) void {
        gpa.free(self.sources);
        gpa.free(self.cell_start);
        gpa.free(self.cell_items);
    }

    fn cellOf(self: *const SizeField, p: Vec2) [2]usize {
        const fx = (p.x - self.origin.x) / self.cell;
        const fy = (p.y - self.origin.y) / self.cell;
        const cx: usize = if (fx <= 0) 0 else @min(self.nx - 1, @as(usize, @intFromFloat(@floor(fx))));
        const cy: usize = if (fy <= 0) 0 else @min(self.ny - 1, @as(usize, @intFromFloat(@floor(fy))));
        return .{ cx, cy };
    }

    /// Size at point p.
    pub fn eval(self: *const SizeField, p: Vec2) f64 {
        var best = self.h_max;
        if (self.sources.len == 0) return best;
        // Distance from p to the grid box (p may lie outside it).
        const gx0 = self.origin.x;
        const gy0 = self.origin.y;
        const gx1 = gx0 + self.cell * @as(f64, @floatFromInt(self.nx));
        const gy1 = gy0 + self.cell * @as(f64, @floatFromInt(self.ny));
        const ox = @max(0.0, @max(gx0 - p.x, p.x - gx1));
        const oy = @max(0.0, @max(gy0 - p.y, p.y - gy1));
        const outside = @sqrt(ox * ox + oy * oy);
        const c = self.cellOf(p);
        const cx: isize = @intCast(c[0]);
        const cy: isize = @intCast(c[1]);
        const nxi: isize = @intCast(self.nx);
        const nyi: isize = @intCast(self.ny);
        const max_ring: isize = @max(nxi, nyi);
        var r: isize = 0;
        while (r <= max_ring) : (r += 1) {
            const ring_dist = @max(outside, @as(f64, @floatFromInt(@max(r - 1, 0))) * self.cell);
            if (self.h_min + self.k_min * ring_dist >= best) break;
            var y = cy - r;
            while (y <= cy + r) : (y += 1) {
                if (y < 0 or y >= nyi) continue;
                const on_edge_row = (y == cy - r or y == cy + r);
                var x = cx - r;
                while (x <= cx + r) {
                    if (x >= 0 and x < nxi) {
                        const idx: usize = @intCast(y * nxi + x);
                        const s0 = self.cell_start[idx];
                        const s1 = self.cell_start[idx + 1];
                        for (self.cell_items[s0..s1]) |si| {
                            const s = self.sources[si];
                            const v = s.h + s.k * p.dist(s.p);
                            if (v < best) best = v;
                        }
                    }
                    if (on_edge_row or r == 0) x += 1 else x += 2 * r;
                }
            }
        }
        return best;
    }
};

test "size field grading" {
    const gpa = std.testing.allocator;
    const src = [_]Source{
        .{ .p = .init(0, 0), .h = 1, .k = 0.2 },
        .{ .p = .init(100, 0), .h = 2, .k = 0.2 },
    };
    var f = try SizeField.init(gpa, &src, 4);
    defer f.deinit(gpa);
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), f.eval(.init(0, 0)), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 2.0), f.eval(.init(5, 0)), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 4.0), f.eval(.init(50, 0)), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 2.2), f.eval(.init(99, 0)), 1e-12);
    try std.testing.expectApproxEqAbs(@as(f64, 2.0), f.eval(.init(-5, 0)), 1e-12);
}
