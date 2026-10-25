# Prepared flexure hex-meshing regression

These fixtures come from the current state (revision 27, cursor 25 of 26 retained CAD states) in the user's `flexure_hexmesh_defect.webmesh`, supplied on 25 October 2026. The original STEP is `flexure.step` in the repository. The user's project file is left untouched and untracked.

- `prepared.brep.gz`: the exact prepared BREP, gzip compressed.
- `prepared.json.gz`: the saved kernel topology and display preview, gzip compressed JSON. This lets classifier and finite-element geometry tests run without a CAD server.

The original classifier reports 99/121 mappable solids. The corrected classifier reports 111/121, with 12 curved-tangency warnings. Solids 49, 50, 64 and 65 still have five-sided end faces. Solids 4, 6, 87 and 88 contain the two interrupted blind bores; solids 7 and 86 contain their end caps. The bottom bore faces from the report are 35 and 453.

Regressions exercise the unchanged saved topology, the actual preparation kernel, face-picked corner splitting, material-volume preservation, HEX8/HEX20 mesh generation and Undo. See `tests/flexure-hex.test.cjs` and the prepared-flexure case in `tests/cad-hex-workflow.test.cjs`.
