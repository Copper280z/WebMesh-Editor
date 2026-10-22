//! Small 2D geometry helpers and element quality metrics.

const std = @import("std");
const pred = @import("predicates.zig");

pub const Vec2 = extern struct {
    x: f64,
    y: f64,

    pub inline fn init(x: f64, y: f64) Vec2 {
        return .{ .x = x, .y = y };
    }
    pub inline fn add(a: Vec2, b: Vec2) Vec2 {
        return .{ .x = a.x + b.x, .y = a.y + b.y };
    }
    pub inline fn sub(a: Vec2, b: Vec2) Vec2 {
        return .{ .x = a.x - b.x, .y = a.y - b.y };
    }
    pub inline fn scale(a: Vec2, s: f64) Vec2 {
        return .{ .x = a.x * s, .y = a.y * s };
    }
    pub inline fn dot(a: Vec2, b: Vec2) f64 {
        return a.x * b.x + a.y * b.y;
    }
    pub inline fn cross(a: Vec2, b: Vec2) f64 {
        return a.x * b.y - a.y * b.x;
    }
    pub inline fn len2(a: Vec2) f64 {
        return a.x * a.x + a.y * a.y;
    }
    pub inline fn len(a: Vec2) f64 {
        return @sqrt(a.x * a.x + a.y * a.y);
    }
    pub inline fn dist(a: Vec2, b: Vec2) f64 {
        return a.sub(b).len();
    }
    pub inline fn dist2(a: Vec2, b: Vec2) f64 {
        return a.sub(b).len2();
    }
    pub inline fn lerp(a: Vec2, b: Vec2, t: f64) Vec2 {
        return .{ .x = a.x + (b.x - a.x) * t, .y = a.y + (b.y - a.y) * t };
    }
    pub inline fn mid(a: Vec2, b: Vec2) Vec2 {
        return .{ .x = 0.5 * (a.x + b.x), .y = 0.5 * (a.y + b.y) };
    }
    /// Rotated by +90 degrees.
    pub inline fn perp(a: Vec2) Vec2 {
        return .{ .x = -a.y, .y = a.x };
    }
    pub fn normalized(a: Vec2) Vec2 {
        const l = a.len();
        if (l == 0) return a;
        return a.scale(1.0 / l);
    }
    pub fn rotate(a: Vec2, angle: f64) Vec2 {
        const c = @cos(angle);
        const s = @sin(angle);
        return .{ .x = a.x * c - a.y * s, .y = a.x * s + a.y * c };
    }
    pub inline fn eql(a: Vec2, b: Vec2) bool {
        return a.x == b.x and a.y == b.y;
    }
};

/// Sine and cosine by range reduction and Taylor polynomials. Plain arithmetic only, so the
/// result is bit-identical on every platform (unlike libm or compiler intrinsics).
pub fn sinCos(x_in: f64) [2]f64 {
    const two_pi = 2.0 * std.math.pi;
    var x = x_in - two_pi * @round(x_in / two_pi); // [-pi, pi]
    // Reduce to [-pi/4, pi/4] using quadrant symmetry.
    var q: i32 = @intFromFloat(@round(x / (0.5 * std.math.pi)));
    x -= @as(f64, @floatFromInt(q)) * (0.5 * std.math.pi);
    const x2 = x * x;
    const s = x * (1.0 - x2 / 6.0 * (1.0 - x2 / 20.0 * (1.0 - x2 / 42.0 * (1.0 - x2 / 72.0 * (1.0 - x2 / 110.0 * (1.0 - x2 / 156.0))))));
    const c = 1.0 - x2 / 2.0 * (1.0 - x2 / 12.0 * (1.0 - x2 / 30.0 * (1.0 - x2 / 56.0 * (1.0 - x2 / 90.0 * (1.0 - x2 / 132.0)))));
    q = @mod(q, 4);
    return switch (q) {
        0 => .{ s, c },
        1 => .{ c, -s },
        2 => .{ -s, -c },
        else => .{ -c, s },
    };
}

/// v rotated counterclockwise by `angle` (deterministic, see sinCos).
pub fn rotateDet(v: Vec2, angle: f64) Vec2 {
    const sc = sinCos(angle);
    return .{ .x = v.x * sc[1] - v.y * sc[0], .y = v.x * sc[0] + v.y * sc[1] };
}

/// Exact-sign orientation of (a, b, c): > 0 counterclockwise.
pub inline fn orient(a: Vec2, b: Vec2, c: Vec2) f64 {
    return pred.orient2d(a.x, a.y, b.x, b.y, c.x, c.y);
}

/// Exact-sign in-circle test: > 0 if d is inside the circumcircle of the CCW triangle (a, b, c).
pub inline fn inCircle(a: Vec2, b: Vec2, c: Vec2, d: Vec2) f64 {
    return pred.incircle(a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y);
}

/// Angle in [0, 2*pi) measured counterclockwise from u to v.
pub fn ccwAngle(u: Vec2, v: Vec2) f64 {
    var a = std.math.atan2(u.cross(v), u.dot(v));
    if (a < 0) a += 2.0 * std.math.pi;
    return a;
}

/// Unsigned angle in [0, pi] between u and v.
pub fn angleBetween(u: Vec2, v: Vec2) f64 {
    return @abs(std.math.atan2(u.cross(v), u.dot(v)));
}

pub fn triArea(a: Vec2, b: Vec2, c: Vec2) f64 {
    return 0.5 * b.sub(a).cross(c.sub(a));
}

pub fn circumcenter(a: Vec2, b: Vec2, c: Vec2) Vec2 {
    const bx = b.x - a.x;
    const by = b.y - a.y;
    const cx = c.x - a.x;
    const cy = c.y - a.y;
    const d = 2.0 * (bx * cy - by * cx);
    if (d == 0) return a.add(b).add(c).scale(1.0 / 3.0);
    const b2 = bx * bx + by * by;
    const c2 = cx * cx + cy * cy;
    return .{ .x = a.x + (cy * b2 - by * c2) / d, .y = a.y + (bx * c2 - cx * b2) / d };
}

pub fn circumradius(a: Vec2, b: Vec2, c: Vec2) f64 {
    const la = b.dist(c);
    const lb = a.dist(c);
    const lc = a.dist(b);
    const ar = @abs(triArea(a, b, c));
    if (ar == 0) return std.math.inf(f64);
    return la * lb * lc / (4.0 * ar);
}

/// Triangle shape quality in [0, 1]: 4*sqrt(3)*area / sum of squared edges (1 for equilateral).
pub fn triQuality(a: Vec2, b: Vec2, c: Vec2) f64 {
    const s = a.dist2(b) + b.dist2(c) + c.dist2(a);
    if (s == 0) return 0;
    return 4.0 * @sqrt(3.0) * triArea(a, b, c) / s;
}

pub fn polygonArea(pts: []const Vec2) f64 {
    var s: f64 = 0;
    for (pts, 0..) |p, i| {
        const q = pts[(i + 1) % pts.len];
        s += p.cross(q);
    }
    return 0.5 * s;
}

/// Scaled Jacobian of corner i of a quad (sine of the corner angle, negative if reflex/inverted).
pub fn quadCornerSJ(q: [4]Vec2, i: usize) f64 {
    const p = q[i];
    const e1 = q[(i + 1) % 4].sub(p);
    const e2 = q[(i + 3) % 4].sub(p);
    const l = e1.len() * e2.len();
    if (l == 0) return -1;
    return e1.cross(e2) / l;
}

/// Minimum corner scaled Jacobian (Verdict definition) of a quad.
pub fn quadScaledJacobian(q: [4]Vec2) f64 {
    var m: f64 = 1;
    for (0..4) |i| m = @min(m, quadCornerSJ(q, i));
    return m;
}

/// Interior corner angles in radians (reflex corners give angles above pi).
pub fn quadAngles(q: [4]Vec2) [4]f64 {
    var out: [4]f64 = undefined;
    for (0..4) |i| {
        const p = q[i];
        out[i] = ccwAngle(q[(i + 1) % 4].sub(p), q[(i + 3) % 4].sub(p));
    }
    return out;
}

/// True if every corner of the quad turns counterclockwise (strictly convex), using exact predicates.
pub fn quadConvex(q: [4]Vec2) bool {
    for (0..4) |i| {
        if (orient(q[(i + 3) % 4], q[i], q[(i + 1) % 4]) <= 0) return false;
    }
    return true;
}

/// Quad quality used for choices during meshing: min corner sine, penalized by aspect.
pub fn quadQuality(q: [4]Vec2) f64 {
    const sj = quadScaledJacobian(q);
    if (sj <= 0) return sj;
    var lmin: f64 = std.math.inf(f64);
    var lmax: f64 = 0;
    for (0..4) |i| {
        const l = q[i].dist(q[(i + 1) % 4]);
        lmin = @min(lmin, l);
        lmax = @max(lmax, l);
    }
    const aspect = if (lmax > 0) lmin / lmax else 0;
    return sj * (0.5 + 0.5 * aspect);
}

/// Closest point parameter of p on segment ab, clamped to [0, 1].
pub fn segmentParam(p: Vec2, a: Vec2, b: Vec2) f64 {
    const d = b.sub(a);
    const l2 = d.len2();
    if (l2 == 0) return 0;
    return std.math.clamp(p.sub(a).dot(d) / l2, 0.0, 1.0);
}

pub fn pointSegmentDist(p: Vec2, a: Vec2, b: Vec2) f64 {
    const t = segmentParam(p, a, b);
    return p.dist(a.lerp(b, t));
}

/// Proper intersection test of segments (p1,p2) and (q1,q2) using exact orientation.
/// Returns true if they cross at a point interior to both (touching at endpoints is false).
pub fn segmentsCross(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2) bool {
    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);
    return ((o1 > 0 and o2 < 0) or (o1 < 0 and o2 > 0)) and ((o3 > 0 and o4 < 0) or (o3 < 0 and o4 > 0));
}

/// True if segments (p1,p2) and (q1,q2) share any point (including touching and overlap).
pub fn segmentsIntersect(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2) bool {
    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);
    if (((o1 > 0 and o2 < 0) or (o1 < 0 and o2 > 0)) and ((o3 > 0 and o4 < 0) or (o3 < 0 and o4 > 0))) return true;
    if (o1 == 0 and onSegment(p1, p2, q1)) return true;
    if (o2 == 0 and onSegment(p1, p2, q2)) return true;
    if (o3 == 0 and onSegment(q1, q2, p1)) return true;
    if (o4 == 0 and onSegment(q1, q2, p2)) return true;
    return false;
}

fn onSegment(a: Vec2, b: Vec2, p: Vec2) bool {
    return @min(a.x, b.x) <= p.x and p.x <= @max(a.x, b.x) and @min(a.y, b.y) <= p.y and p.y <= @max(a.y, b.y);
}

test "quad metrics" {
    const sq = [4]Vec2{ .init(0, 0), .init(1, 0), .init(1, 1), .init(0, 1) };
    try std.testing.expectApproxEqAbs(@as(f64, 1.0), quadScaledJacobian(sq), 1e-12);
    try std.testing.expect(quadConvex(sq));
    const reflex = [4]Vec2{ .init(0, 0), .init(2, 0), .init(0.5, 0.5), .init(0, 2) };
    try std.testing.expect(!quadConvex(reflex));
    try std.testing.expect(quadScaledJacobian(reflex) < 0);
    const ang = quadAngles(sq);
    for (ang) |a| try std.testing.expectApproxEqAbs(std.math.pi / 2.0, a, 1e-12);
}
