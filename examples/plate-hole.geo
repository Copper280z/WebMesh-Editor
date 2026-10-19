// Reproducible CAD plate with a central opening and four bolt holes.
// Regenerate the accompanying STEP file with: gmsh plate-hole.geo -0
// In WebMesh, upload plate-hole.step and choose tetrahedra, target size 6–10.
// First and second order are supported. This CAD is not a transfinite hex block;
// a hex request must report incompatibility instead of silently returning tets.
SetFactory("OpenCASCADE");
Box(1) = {0, 0, 0, 80, 50, 8};
Cylinder(2) = {40, 25, -1, 0, 0, 10, 8};
Cylinder(3) = {10, 10, -1, 0, 0, 10, 3};
Cylinder(4) = {70, 10, -1, 0, 0, 10, 3};
Cylinder(5) = {70, 40, -1, 0, 0, 10, 3};
Cylinder(6) = {10, 40, -1, 0, 0, 10, 3};
BooleanDifference(7) = { Volume{1}; Delete; } { Volume{2:6}; Delete; };
Save "plate-hole.step";
