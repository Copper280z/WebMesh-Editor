# Paved quad mesher: sketch

A second face mesher for WebMesh swept hex, next to the quadtree mesher. It is meant to give the look analysts expect: rows of quads that follow every boundary and hole, mostly four quads per interior node, and size changes spread over several rows, with no grid pattern in the interior. It takes the same input and produces the same output as the quadtree mesher (see `REQUIREMENTS.md`), so WebMesh can use either.

## Choice of method

Q-Morph (Owen et al. 1999): build a triangle mesh first, then turn it into quads row by row with an advancing front, then clean up and smooth.

- It gives the paving look: rows that follow the boundary, from the boundary inward.
- It is much more robust than direct paving (Blacker and Stephenson 1991). The triangle mesh already fills the domain, so when fronts meet there are no intersections to detect; the remaining triangles say what is left.
- Fixed boundary nodes are natural. The triangulation uses them as given, and Q-Morph never adds a node to the boundary.
- It produces only quads when every front loop has an even number of edges. That holds if the total number of fixed boundary edges is even, which WebMesh's edge-count solver can guarantee.

Considered and set aside:

- **Blossom-Quad** (Remacle et al. 2012, used by Gmsh): pairs triangles by minimum-cost perfect matching. It is robust, but its rows are less regular. Here it serves as the fallback where the front stalls.
- **Direct paving**: same look, but fragile where fronts collide.
- **Cross-field and quad-layout methods**: best structure, but far more work. Not now.

## Pipeline

1. **Input.** Loops in face-plane coordinates (outer loops, holes and control loops), each split into runs that are either fixed (an ordered node list from WebMesh's edge mesh) or free (a polyline to be discretized here). There is a target size and optional per-loop sizes. The total number of boundary edges must be even, and free runs absorb the parity.
2. **Size field.** Near the boundary, the size is the local spacing of the boundary nodes. It then grows toward the target size by at most a factor g per element (default 1.2), so a Ø3 hole meshed with 12 elements blends out over a few rows. Evaluate it from the distance to the boundary, using a coarse background triangulation or a grid.
3. **Triangulation.** Build a constrained Delaunay triangulation (Bowyer-Watson) of the boundary nodes, with the boundary segments as constraints, recovered by edge flips and never split. Then insert points with frontal Delaunay (Rebay 1993): rows of nearly equilateral triangles of the local size, laid down from the boundary inward. Those rows make the next step regular.
4. **Q-Morph.**
   - Start with the front as the boundary edges, each loop oriented with the domain on its left.
   - Process the lowest row level first, then the edges whose end angles are smallest.
   - For each front edge, pick each side edge: use the neighboring front edge where the angle is small, otherwise the triangle edge nearest the angle bisector. Swap or split triangle edges when needed.
   - Recover the top edge by edge swaps, merge the triangles inside into one quad, and advance the front.
   - Smooth the new nodes locally after each quad.
   - Merge front edges that meet at a sharp angle (seams).
   - Insert transition elements where rows of different levels meet.
   - When fronts meet, split them so that every resulting loop keeps an even edge count.
   - Close a loop of 2, 4 or 6 edges with fixed templates.
5. **Fallback.** If the front stalls in a region (a narrow strip between close holes, for example), pair that region's remaining triangles with Blossom-Quad. Where no perfect pairing exists, insert a node or flip an edge. The rest of the mesh keeps its rows.
6. **Cleanup.** Make topology changes that bring interior nodes toward four quads each (Kinney 1997): remove doublets, swap quad edges where they reduce three- and five-quad node pairs, and collapse tiny quads. Boundary nodes are never moved or removed.
7. **Smoothing.** Apply length-weighted Laplacian smoothing with an angle-based correction (Zhou and Shimada 2000), then optimize the worst elements locally to raise the minimum scaled Jacobian. Untangle first if any quad is inverted. Fixed nodes stay fixed.
8. **Output.** Return quads, nodes with boundary provenance, and the validation and quality report. These are the same structures as the quadtree mesher's, with conformity, inversion and boundary-fidelity checks.

## Targets

On the seven test faces in this folder:

- The mesh is all quads and validates.
- The fixed boundary nodes are kept exactly.
- The element count is within 1.5 × area / h², plus the boundary rows.
- The minimum angle is at least 30°, except next to input corners sharper than 60° (there, at least half the corner angle).
- The scaled Jacobian is at least 0.5 for 95 % of quads and at least 0.3 for every quad.
- Fewer than 10 % of interior nodes have other than four quads.
- A face of about 5,000 quads takes under 1 s.
- The same input gives the same mesh.

## Where and in what order

Build it in C++20 in this repository as a second pipeline, reusing the geometry types, validator, quality metrics, IO and C ABI. Then the WebAssembly and Python builds required in `REQUIREMENTS.md` cover both meshers.

Milestones, each with tests:

1. Size field and triangulation: fixed boundary edges are kept exactly, and the triangles are of good quality.
2. Q-Morph on single-loop domains, convex and concave.
3. Holes, several fronts, front splits and merges, closure templates, and the parity rule.
4. Cleanup, smoothing and the Blossom fallback.
5. The seven test faces against the targets above, plus performance and determinism.

## References

- Owen, Staten, Canann, Saigal (1999). Q-Morph: an indirect approach to advancing front quad meshing. IJNME 44.
- Blacker, Stephenson (1991). Paving: a new approach to automated quadrilateral mesh generation. IJNME 32.
- Remacle et al. (2012). Blossom-Quad: a non-uniform quadrilateral mesh generator using a minimum-cost perfect-matching algorithm. IJNME 89.
- Rebay (1993). Efficient unstructured mesh generation by means of Delaunay triangulation and the Bowyer-Watson algorithm. JCP 106.
- Zhou, Shimada (2000). An angle-based approach to two-dimensional mesh smoothing. IMR.
- Kinney (1997). CleanUp: improving quadrilateral finite element meshes. IMR.
