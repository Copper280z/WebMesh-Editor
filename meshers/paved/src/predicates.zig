//! Robust geometric predicates after Shewchuk (1997), "Adaptive Precision
//! Floating-Point Arithmetic and Fast Robust Geometric Predicates".
//!
//! `orient2d` is the full adaptive version (stages A to D). `incircle` uses the
//! stage-A error filter and falls back to an exact expansion evaluation, which
//! is rarely reached in practice. Both return a value whose sign is exact.

const std = @import("std");

const epsilon: f64 = 1.1102230246251565e-16; // 2^-53
const splitter: f64 = 134217729.0; // 2^27 + 1
const resulterrbound: f64 = (3.0 + 8.0 * epsilon) * epsilon;
const ccwerrboundA: f64 = (3.0 + 16.0 * epsilon) * epsilon;
const ccwerrboundB: f64 = (2.0 + 12.0 * epsilon) * epsilon;
const ccwerrboundC: f64 = (9.0 + 64.0 * epsilon) * epsilon * epsilon;
const iccerrboundA: f64 = (10.0 + 96.0 * epsilon) * epsilon;

const Pair = struct { hi: f64, lo: f64 };

inline fn fastTwoSum(a: f64, b: f64) Pair {
    const x = a + b;
    const bvirt = x - a;
    return .{ .hi = x, .lo = b - bvirt };
}

inline fn twoSum(a: f64, b: f64) Pair {
    const x = a + b;
    const bvirt = x - a;
    const avirt = x - bvirt;
    const bround = b - bvirt;
    const around = a - avirt;
    return .{ .hi = x, .lo = around + bround };
}

inline fn twoDiffTail(a: f64, b: f64, x: f64) f64 {
    const bvirt = a - x;
    const avirt = x + bvirt;
    const bround = bvirt - b;
    const around = a - avirt;
    return around + bround;
}

inline fn twoDiff(a: f64, b: f64) Pair {
    const x = a - b;
    return .{ .hi = x, .lo = twoDiffTail(a, b, x) };
}

inline fn split(a: f64) Pair {
    const c = splitter * a;
    const abig = c - a;
    const ahi = c - abig;
    return .{ .hi = ahi, .lo = a - ahi };
}

inline fn twoProduct(a: f64, b: f64) Pair {
    const x = a * b;
    const as = split(a);
    const bs = split(b);
    const err1 = x - (as.hi * bs.hi);
    const err2 = err1 - (as.lo * bs.hi);
    const err3 = err2 - (as.hi * bs.lo);
    return .{ .hi = x, .lo = (as.lo * bs.lo) - err3 };
}

inline fn twoProductPresplit(a: f64, b: f64, bs: Pair) Pair {
    const x = a * b;
    const as = split(a);
    const err1 = x - (as.hi * bs.hi);
    const err2 = err1 - (as.lo * bs.hi);
    const err3 = err2 - (as.hi * bs.lo);
    return .{ .hi = x, .lo = (as.lo * bs.lo) - err3 };
}

/// (a1 + a0) - (b1 + b0) as a four-component expansion x[0..4] (increasing magnitude).
inline fn twoTwoDiff(a1: f64, a0: f64, b1: f64, b0: f64) [4]f64 {
    // Two_One_Diff(a1, a0, b0) -> (j, r0, x0)
    const d0 = twoDiff(a0, b0);
    const s0 = twoSum(a1, d0.hi);
    // Two_One_Diff(j, r0, b1) -> (x3, x2, x1)
    const d1 = twoDiff(s0.lo, b1);
    const s1 = twoSum(s0.hi, d1.hi);
    return .{ d0.lo, d1.lo, s1.lo, s1.hi };
}

/// Sum of two nonoverlapping expansions with zero elimination. Returns the length of h.
fn fastExpansionSumZeroElim(e: []const f64, f: []const f64, h: []f64) usize {
    var eindex: usize = 0;
    var findex: usize = 0;
    var enow = e[0];
    var fnow = f[0];
    var q: f64 = undefined;
    if ((fnow > enow) == (fnow > -enow)) {
        q = enow;
        eindex += 1;
        if (eindex < e.len) enow = e[eindex];
    } else {
        q = fnow;
        findex += 1;
        if (findex < f.len) fnow = f[findex];
    }
    var hindex: usize = 0;
    if (eindex < e.len and findex < f.len) {
        var r: Pair = undefined;
        if ((fnow > enow) == (fnow > -enow)) {
            r = fastTwoSum(enow, q);
            eindex += 1;
            if (eindex < e.len) enow = e[eindex];
        } else {
            r = fastTwoSum(fnow, q);
            findex += 1;
            if (findex < f.len) fnow = f[findex];
        }
        q = r.hi;
        if (r.lo != 0.0) {
            h[hindex] = r.lo;
            hindex += 1;
        }
        while (eindex < e.len and findex < f.len) {
            if ((fnow > enow) == (fnow > -enow)) {
                r = twoSum(q, enow);
                eindex += 1;
                if (eindex < e.len) enow = e[eindex];
            } else {
                r = twoSum(q, fnow);
                findex += 1;
                if (findex < f.len) fnow = f[findex];
            }
            q = r.hi;
            if (r.lo != 0.0) {
                h[hindex] = r.lo;
                hindex += 1;
            }
        }
    }
    while (eindex < e.len) {
        const r = twoSum(q, enow);
        eindex += 1;
        if (eindex < e.len) enow = e[eindex];
        q = r.hi;
        if (r.lo != 0.0) {
            h[hindex] = r.lo;
            hindex += 1;
        }
    }
    while (findex < f.len) {
        const r = twoSum(q, fnow);
        findex += 1;
        if (findex < f.len) fnow = f[findex];
        q = r.hi;
        if (r.lo != 0.0) {
            h[hindex] = r.lo;
            hindex += 1;
        }
    }
    if (q != 0.0 or hindex == 0) {
        h[hindex] = q;
        hindex += 1;
    }
    return hindex;
}

/// e * b with zero elimination. Returns the length of h (at most 2 * e.len).
fn scaleExpansionZeroElim(e: []const f64, b: f64, h: []f64) usize {
    const bs = split(b);
    var p = twoProductPresplit(e[0], b, bs);
    var q = p.hi;
    var hindex: usize = 0;
    if (p.lo != 0.0) {
        h[hindex] = p.lo;
        hindex += 1;
    }
    var i: usize = 1;
    while (i < e.len) : (i += 1) {
        p = twoProductPresplit(e[i], b, bs);
        const s = twoSum(q, p.lo);
        if (s.lo != 0.0) {
            h[hindex] = s.lo;
            hindex += 1;
        }
        const t = fastTwoSum(p.hi, s.hi);
        q = t.hi;
        if (t.lo != 0.0) {
            h[hindex] = t.lo;
            hindex += 1;
        }
    }
    if (q != 0.0 or hindex == 0) {
        h[hindex] = q;
        hindex += 1;
    }
    return hindex;
}

fn estimate(e: []const f64) f64 {
    var q: f64 = 0;
    for (e) |x| q += x;
    return q;
}

/// Positive if a, b, c are in counterclockwise order, negative if clockwise,
/// zero if collinear. The sign is exact.
pub fn orient2d(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64) f64 {
    const detleft = (ax - cx) * (by - cy);
    const detright = (ay - cy) * (bx - cx);
    const det = detleft - detright;
    var detsum: f64 = undefined;
    if (detleft > 0.0) {
        if (detright <= 0.0) return det;
        detsum = detleft + detright;
    } else if (detleft < 0.0) {
        if (detright >= 0.0) return det;
        detsum = -detleft - detright;
    } else {
        return det;
    }
    const errbound = ccwerrboundA * detsum;
    if (det >= errbound or -det >= errbound) return det;
    return orient2dAdapt(ax, ay, bx, by, cx, cy, detsum);
}

fn orient2dAdapt(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, detsum: f64) f64 {
    const acx = ax - cx;
    const bcx = bx - cx;
    const acy = ay - cy;
    const bcy = by - cy;
    const dl = twoProduct(acx, bcy);
    const dr = twoProduct(acy, bcx);
    const bexp = twoTwoDiff(dl.hi, dl.lo, dr.hi, dr.lo);
    var det = estimate(&bexp);
    var errbound = ccwerrboundB * detsum;
    if (det >= errbound or -det >= errbound) return det;

    const acxtail = twoDiffTail(ax, cx, acx);
    const bcxtail = twoDiffTail(bx, cx, bcx);
    const acytail = twoDiffTail(ay, cy, acy);
    const bcytail = twoDiffTail(by, cy, bcy);
    if (acxtail == 0.0 and acytail == 0.0 and bcxtail == 0.0 and bcytail == 0.0) return det;

    errbound = ccwerrboundC * detsum + resulterrbound * @abs(det);
    det += (acx * bcytail + bcy * acxtail) - (acy * bcxtail + bcx * acytail);
    if (det >= errbound or -det >= errbound) return det;

    var c1: [8]f64 = undefined;
    var c2: [12]f64 = undefined;
    var d: [16]f64 = undefined;
    var s = twoProduct(acxtail, bcy);
    var t = twoProduct(acytail, bcx);
    var u = twoTwoDiff(s.hi, s.lo, t.hi, t.lo);
    const c1len = fastExpansionSumZeroElim(&bexp, &u, &c1);
    s = twoProduct(acx, bcytail);
    t = twoProduct(acy, bcxtail);
    u = twoTwoDiff(s.hi, s.lo, t.hi, t.lo);
    const c2len = fastExpansionSumZeroElim(c1[0..c1len], &u, &c2);
    s = twoProduct(acxtail, bcytail);
    t = twoProduct(acytail, bcxtail);
    u = twoTwoDiff(s.hi, s.lo, t.hi, t.lo);
    const dlen = fastExpansionSumZeroElim(c2[0..c2len], &u, &d);
    return d[dlen - 1];
}

/// Positive if d lies inside the circle through a, b, c (counterclockwise),
/// negative if outside, zero if cocircular. The sign is exact.
pub fn incircle(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) f64 {
    const adx = ax - dx;
    const bdx = bx - dx;
    const cdx = cx - dx;
    const ady = ay - dy;
    const bdy = by - dy;
    const cdy = cy - dy;
    const bdxcdy = bdx * cdy;
    const cdxbdy = cdx * bdy;
    const alift = adx * adx + ady * ady;
    const cdxady = cdx * ady;
    const adxcdy = adx * cdy;
    const blift = bdx * bdx + bdy * bdy;
    const adxbdy = adx * bdy;
    const bdxady = bdx * ady;
    const clift = cdx * cdx + cdy * cdy;
    const det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
    const permanent = (@abs(bdxcdy) + @abs(cdxbdy)) * alift +
        (@abs(cdxady) + @abs(adxcdy)) * blift +
        (@abs(adxbdy) + @abs(bdxady)) * clift;
    const errbound = iccerrboundA * permanent;
    if (det > errbound or -det > errbound) return det;
    return incircleExact(ax, ay, bx, by, cx, cy, dx, dy);
}

/// Product of two expansions; `scratch` must hold 2 * e.len values and `out` the full product.
fn mulExpansion(e: []const f64, f: []const f64, out: []f64, tmp_a: []f64, scratch: []f64) usize {
    var len: usize = 1;
    out[0] = 0.0;
    for (f) |fi| {
        const sl = scaleExpansionZeroElim(e, fi, scratch);
        const nl = fastExpansionSumZeroElim(out[0..len], scratch[0..sl], tmp_a);
        @memcpy(out[0..nl], tmp_a[0..nl]);
        len = nl;
    }
    return len;
}

fn incircleExact(ax: f64, ay: f64, bx: f64, by: f64, cx: f64, cy: f64, dx: f64, dy: f64) f64 {
    const adx = twoDiff(ax, dx);
    const ady = twoDiff(ay, dy);
    const bdx = twoDiff(bx, dx);
    const bdy = twoDiff(by, dy);
    const cdx = twoDiff(cx, dx);
    const cdy = twoDiff(cy, dy);
    const ax2 = [2]f64{ adx.lo, adx.hi };
    const ay2 = [2]f64{ ady.lo, ady.hi };
    const bx2 = [2]f64{ bdx.lo, bdx.hi };
    const by2 = [2]f64{ bdy.lo, bdy.hi };
    const cx2 = [2]f64{ cdx.lo, cdx.hi };
    const cy2 = [2]f64{ cdy.lo, cdy.hi };

    var scratch: [64]f64 = undefined;
    var tmp: [1100]f64 = undefined;

    // Lifted terms (x^2 + y^2) and 2x2 minors, each at most 16 components.
    var lifts: [3][16]f64 = undefined;
    var lift_len: [3]usize = undefined;
    var minors: [3][16]f64 = undefined;
    var minor_len: [3]usize = undefined;
    const xs = [3][2]f64{ ax2, bx2, cx2 };
    const ys = [3][2]f64{ ay2, by2, cy2 };
    var k: usize = 0;
    while (k < 3) : (k += 1) {
        var p: [8]f64 = undefined;
        var q: [8]f64 = undefined;
        const pl = mulExpansion(&xs[k], &xs[k], &p, &tmp, &scratch);
        const ql = mulExpansion(&ys[k], &ys[k], &q, &tmp, &scratch);
        lift_len[k] = fastExpansionSumZeroElim(p[0..pl], q[0..ql], &lifts[k]);
        // minor for k uses the other two points: (i, j) = (k+1, k+2)
        const i = (k + 1) % 3;
        const j = (k + 2) % 3;
        const ml = mulExpansion(&xs[i], &ys[j], &p, &tmp, &scratch);
        const nl = mulExpansion(&xs[j], &ys[i], &q, &tmp, &scratch);
        var negq: [8]f64 = undefined;
        for (q[0..nl], 0..) |v, idx| negq[idx] = -v;
        minor_len[k] = fastExpansionSumZeroElim(p[0..ml], negq[0..nl], &minors[k]);
    }
    var acc: [1600]f64 = undefined;
    var acc_len: usize = 1;
    acc[0] = 0.0;
    var term: [520]f64 = undefined;
    var sum: [1600]f64 = undefined;
    k = 0;
    while (k < 3) : (k += 1) {
        const tl = mulExpansion(lifts[k][0..lift_len[k]], minors[k][0..minor_len[k]], &term, &tmp, &scratch);
        const sl = fastExpansionSumZeroElim(acc[0..acc_len], term[0..tl], &sum);
        @memcpy(acc[0..sl], sum[0..sl]);
        acc_len = sl;
    }
    return acc[acc_len - 1];
}

test "orient2d basic and near-degenerate" {
    try std.testing.expect(orient2d(0, 0, 1, 0, 0, 1) > 0);
    try std.testing.expect(orient2d(0, 0, 0, 1, 1, 0) < 0);
    try std.testing.expect(orient2d(0, 0, 1, 1, 2, 2) == 0);
    // Points on a line with coordinates that are not exactly representable.
    const x0: f64 = 0.1;
    const y0: f64 = 0.1;
    var i: usize = 0;
    var zero_count: usize = 0;
    while (i < 200) : (i += 1) {
        const t = @as(f64, @floatFromInt(i)) * 1e-17;
        const r = orient2d(x0 + t, y0, 12.0, 12.0, 24.0, 24.0);
        if (r == 0) zero_count += 1;
        // Sign must be consistent with exact arithmetic: point (x0+t, y0) with t > 0
        // lies to the right of the diagonal (or on it when x0+t rounds to x0).
        if (x0 + t > x0) try std.testing.expect(r < 0);
        if (x0 + t == x0) try std.testing.expect(r == 0);
    }
    try std.testing.expect(zero_count > 0);
}

test "incircle basic and exact cocircular" {
    try std.testing.expect(incircle(0, 0, 1, 0, 0, 1, 0.5, 0.5) > 0);
    try std.testing.expect(incircle(0, 0, 1, 0, 0, 1, 2, 2) < 0);
    try std.testing.expect(incircle(0, 0, 1, 0, 1, 1, 0, 1) == 0);
    // Cocircular points with large offsets exercise the exact fallback.
    const o: f64 = 1e8;
    try std.testing.expect(incircle(o, o, o + 1, o, o + 1, o + 1, o, o + 1) == 0);
    try std.testing.expect(incircle(o, o, o + 1, o, o + 1, o + 1, o + 0.5, o + 1.0000001) > 0);
    try std.testing.expect(incircle(o, o, o + 1, o, o + 1, o + 1, o + 0.5, o + 1.5) < 0);
}
