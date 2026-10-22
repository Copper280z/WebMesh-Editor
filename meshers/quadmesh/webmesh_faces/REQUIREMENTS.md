# Quadmesh requirements for WebMesh swept hex

WebMesh Studio will hex-mesh 2.5D solids by quad-meshing one face and sweeping it through the solid. Faces are meshed edge-first: every CAD edge gets one node distribution that every face touching it must use, so neighboring solids conform. quadmesh is to be that face mesher. These are the additions it needs, in priority order. The test faces are in this folder; their format and current results are in `README.md`.

## Must have

1. **Fixed boundary nodes.** Accept an ordered node list for any boundary run (a whole loop or a range of it, on outer loops, holes and control loops). Along a fixed run, the mesh's boundary edges are exactly the consecutive node pairs; no node is added, moved or dropped. Runs that are not fixed keep today's behavior. Spacing may be non-uniform. If the fixed counts make an all-quad mesh impossible (an odd total of boundary edges with no free run to absorb it), fail with a clear error.
   - Done when: a 40 × 20 plate with a Ø10 hole and boundary nodes every 2 mm (76 nodes) meshes with exactly those 76 boundary nodes, validates, and has minimum scaled Jacobian ≥ 0.3.
   - Today: 274 boundary nodes; only the 20 sharp corners are kept, even with chord tolerance 0.
2. **Boundary provenance.** For each boundary node: loop index, segment index and parameter, or its index in a fixed run. For each boundary edge: loop and segment. Today nodes carry only an `on_boundary` flag.
3. **FE sizing around small holes and arcs.** A setting for elements per full circle (default about 12, at least 8) that may override the curvature cap, and grading that returns to the target size within a few elements of a small feature.
   - Done when: `rover_chassis_face1` at size 4 gives at most twice area / size² (about 4,300 quads), and a Ø3 hole in a 60 × 40 plate at size 4 gets 12 boundary nodes.
   - Today: 23,441 quads on that face; a Ø3 hole gets 24–48 boundary nodes and adds about 600 quads.
4. **Robust on CAD input.** Tolerate tangent arcs, edges under 0.1 mm left by defeaturing, and finely sampled arcs (treated as smooth curves, not many sharp corners). Document the input sampling WebMesh should use.
   - Done when: all seven supplied faces validate. Today `wheel_top` fails (2 element edges cross the boundary), and a 16-sided hole is treated as 16 sharp features.
5. **Quality floor.** On the supplied faces: minimum angle ≥ 20° and minimum scaled Jacobian ≥ 0.3 (today 0.22–0.52, minimum angle down to 14.5°). Quad quality becomes hex quality after sweeping.
6. **Embeddable.** A C ABI exposing all of the above (per-loop sizing, fixed runs, elements per circle, feature angle, chord tolerance, provenance, validation issues as text). Builds as WebAssembly (Emscripten) with a small JS wrapper, and as a shared library callable from Python through ctypes; standard library only. Implement or remove the ignored `enable_smoothing` flag.
7. **Deterministic and fast.** Same input gives the same mesh; a face of about 5,000 quads meshes in under 1 s. Both hold today; keep them.

## Nice to have

- Optional smoothing that never moves fixed or boundary nodes.
- Per-quad quality in the output.
