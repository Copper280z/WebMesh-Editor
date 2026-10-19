// Reproducible six-sided CAD fixture. Units are arbitrary and consistent.
// Regenerate the accompanying STEP file with: gmsh block.geo -0
// In WebMesh, upload block.step, choose structured hex, and use 6 divisions.
// GEO programs themselves are intentionally not accepted by the local bridge.
SetFactory("OpenCASCADE");
Box(1) = {0, 0, 0, 100, 60, 20};
Save "block.step";
