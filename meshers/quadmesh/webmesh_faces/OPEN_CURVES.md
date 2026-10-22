# Open control curves (ABI 0.3)

WebMesh shell models have junctions that end inside a face. A triangular brace standing on a floor meets the floor along a line that starts at the floor's edge, or nowhere, and stops in its middle. The floor's mesh must have mesh edges exactly along that line, at nodes WebMesh gives (they are shared with the brace's mesh), with quads on both sides. Closed control loops cannot express this. Open curves can; until then WebMesh has to cut the whole face along the line.

Both face meshers (quadmesh's quadtree and recombination paths, and the paved Q-Morph mesher) implement the same addition, so WebMesh can use either.

## C ABI

- A new loop role: `MQ_LOOP_CURVE = 3` in `mq_loop_role_t`. `mq_abi_version()` returns 0.3 (`3 << 12`) or later when curves are supported.
- A curve is added with `mq_domain_add_loop(ctx, domain, MQ_LOOP_CURVE, points, n, &loop)`, with n ≥ 2, after the outer loops (like holes and control loops). Its points run from one end to the other; the last point does not connect back to the first, so it has n − 1 segments.
- Its nodes are fixed with `mq_domain_add_fixed_run(ctx, domain, loop, 0, 0.0, n - 2, 1.0, nodes, count, 0, &run)`: an open run over the whole curve, first point to last. As on loops, a fixed run's nodes are kept exactly, and consecutive nodes are joined by one mesh edge. WebMesh always fixes the whole curve, with its points as the nodes.
- A curve without a fixed run may be discretized like a free loop run, ends included. WebMesh does not use this; it may be left unsupported (then refuse it with a clear error).

## Geometry rules

- A curve lies in the meshed region: inside the outer loop and outside every hole. Its interior points are strictly inside.
- Each end is either inside the region (a free end) or on another loop or curve. An end on another loop or curve coincides, within the absolute tolerance, with one of that loop's or curve's nodes (a vertex of its fixed run). WebMesh guarantees this: a junction ends at a CAD vertex, and the CAD edge it touches is split there.
- Curves do not cross each other, any loop or themselves, except at such shared nodes. Several curves may meet at one node, and a curve may end on a node of another curve.
- Breaking a rule fails with `MQ_STATUS_UNSUPPORTED_INPUT` and a message naming the curve and what it crosses, or which end is off its node.

## Result

- Every curve segment between consecutive nodes is one mesh edge, shared by two quads, one on each side. A free end is a node with quads all around it.
- A node shared by a curve and a loop, or by several curves, is one mesh node.
- Provenance: curve nodes are reported by `mq_mesh_copy_boundary_nodes` like loop nodes: `loop` is the curve's index, and `fixed_run` and `fixed_node` give its position in the run. A shared node is reported once for each loop or curve it belongs to (WebMesh maps every record to the same node). `mq_mesh_copy_boundary_edges` reports each curve segment once, with `loop` set to the curve.
- Validation covers curves: their fixed nodes are kept, each curve segment is an edge of exactly two quads, and no quad crosses a curve.
- Parity: a curve adds its segment count to the front on both of its sides, so it never changes the parity an all-quad mesh needs. A mesher that keeps every other boundary node (quadmesh's recombination path) needs every curve's segment count to be even, as for loops; WebMesh gives even counts to that mesher, and an odd one fails with a clear error.

## Python binding

`bindings/python/quadmesh.py`: loops take `role="curve"`; its fixed run is `{"nodes": points, "start": (0, 0), "end": (n - 2, 1), "closed": False}`.

## Test faces

`curves/*.json`: `{"description", "target_size", "elements_per_circle", "loops": [{"role": "outer" | "hole" | "curve", "points": [[x, y], ...]}]}`, in mm. Every loop and curve is fixed: its points are its nodes. Outer loops are counter-clockwise and holes clockwise. Every segment count is even.

| Face | What it checks |
|---|---|
| `tee.json` | A curve from a boundary node to a free end in the middle: the rover's braces on its floor. |
| `floating.json` | A curve with both ends free. |
| `hole_and_boundary.json` | A curve from a hole's node to a boundary node, and one from the boundary to a free end beside the hole. |
| `plus.json` | Four curves meeting at one shared node: two walls crossing on a floor. |
| `invalid_crossing.json` | Two curves crossing between their nodes: must fail, naming them. |
| `rover_floor.json` | The rover chassis floor midsurface (size 5) with the four brace junctions, as WebMesh sends it (added once WebMesh exports it). |

Done when each valid face meshes all-quad with every given node kept, each curve segment shared by exactly two quads, minimum scaled Jacobian at least 0.3 and minimum angle at least 20° (next to a free end at least 15°), and the invalid face fails with its message. A face of about 5,000 quads still meshes in under a second, and the same input gives the same mesh.
