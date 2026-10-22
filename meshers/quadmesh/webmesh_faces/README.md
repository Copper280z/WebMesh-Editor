# WebMesh test faces

Planar faces from real STEP parts (wheel, rover chassis, balancer chassis), in face-plane
coordinates (mm). Edges were sampled from the CAD tessellation.

Format: first line is the loop count; then, per loop, a point count followed by that many
`x y` lines. The first loop is the outer boundary; the rest are holes.

`mesh_loops.cpp` meshes one file and prints validity, quad count, quality, boundary edge
count and how many input points became mesh nodes:

    zig c++ -std=c++20 -O2 -I../include mesh_loops.cpp ../zig-out/lib/libquadmesh_core.a -o mesh_loops
    ./mesh_loops rover_chassis_face1.txt 4 out.svg

Results with the current code at target size 4:

| Face | Loops | Quads | Min scaled Jacobian | Valid |
|---|---|---|---|---|
| wheel_top | 4 | 6,016 | 0.45 | no: 2 element edges cross the boundary |
| rover_chassis_face1 | 27 | 23,441 | 0.36 | yes |
| rover_chassis_face2 | 27 | 47,692 | 0.33 | yes |
| rover_chassis_face61 | 16 | 12,357 | 0.25 | yes |
| balancer_chassis_face17 | 2 | 1,431 | 0.52 | yes |
| balancer_chassis_face19 | 8 | 5,798 | 0.36 | yes |
| balancer_chassis_face21 | 8 | 5,492 | 0.22 | yes |
