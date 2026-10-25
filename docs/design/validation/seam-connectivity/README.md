# Rover patch seam regression and modal comparison

The user's diagnosis was correct. The initial selective-replacement mesh had no shared nodes along the bottom of faces 177 and 179 against floor face 184. Adjacent wall and gusset junctions also shared only corner nodes. The earlier one-component connectivity check did not detect these cracks and was insufficient acceptance evidence.

## Cause and correction

`cad_shell.py` exported membership only for globally free mesh edges. Internal CAD seams therefore disappeared from the mesh's provenance. `cad-selective-mesh.js` pinned only the available edge memberships, allocating new nodes on the omitted seams.

The mesher now exports internal CAD edge memberships too. Selective remeshing identifies every changed/retained CAD junction, pins its discretization, reuses its nodes, and checks actual element-edge sharing before application. Fake or incomplete edge metadata cannot pass this check. Older pending projects recover supported straight coordinate-aligned seams from a unique complete retained element-edge chain; curved/tilted seams without provenance require a complete remesh. This is not a global proximity merge.

The browser reopened the original pending checkpoint, restored **17** boundary count constraints (previously 12), generated the same 748-local-node/637-quad patch, and reused **209** committed nodes (previously 153). It added 539 GRIDs instead of 595. RR mounting repair still restored exactly four motor cards; other motors and retained face cards stayed unchanged.

## Numerical proof

Both SOL 103 decks use the same shell geometry, materials, properties, masses, supports, and motor stiffness. The verifier compares every shell's coordinates and the relevant cards. Both request 12 supported modes with `EIGRL,1,0.,,12`; this is not a free-free rigid-body-mode test. The defective assembly was still connected at corners, so a zero-frequency mode was not required to reveal the problem.

| Check | Defective patch | Repaired patch |
|---|---:|---:|
| Active GRIDs | 9,449 | 9,393 |
| Active CQUAD4s | 8,459 | 8,459 |
| Shared bottom-seam nodes | 0 of 29 | 29 of 29 |
| Shared bottom-seam segments | 0 of 28 | 28 of 28 |
| First frequency | 22.62124 Hz | 25.61400 Hz |
| Second frequency | 25.02954 Hz | 27.49557 Hz |
| Third frequency | 38.82053 Hz | 45.19662 Hz |
| First-mode seam jump / peak translation | 0.79218 | 0 |
| Third-mode seam jump / peak translation | 1.32189 | 0 |

The seam jump compares the modal translation vectors at geometrically coincident wall/floor nodes. Eigenvector amplitudes are arbitrary, so the reported jump is divided by the largest translation magnitude in that mode. The repaired model uses the same GRID on both sides and has zero jump in every extracted mode. Frequency changes alone would not prove connectivity; the node/segment counts and displacement discontinuities do.

MYSTRAN terminates normally for both decks, with no translational AUTOSPC DOFs. Both retain warnings about an ignored input field and the finite-eigenvalue limit of the mass matrix; the latter limit is far above the 12 requested modes. Shell drilling rotations are still subject to the original AUTOSPC setting. These are workflow checks, not a converged design certification.

The repaired browser SOL 101 run also passes the existing force/moment balance criteria. Gravity peak displacement is **0.087216 mm**, versus **0.290992 mm** in the defective model. Gravity peak shell von Mises is **4.05153 MPa**. The lateral combination gives **0.158331 mm** and **4.50795 MPa**. The earlier failed moment-balance status is resolved with this connectivity correction; its untracked investigation is marked as a WebMesh defect, not an established solver bug.

## Reproduction and retained evidence

Use the dependencies in root `setup.md` and the installed MYSTRAN executable.

```sh
node docs/design/validation/seam-connectivity/verify.cjs
node docs/design/validation/selective-replacement/verify.cjs
node --test tests/cad-selective-replacement.test.cjs
python3 -m unittest discover -s tests -p test_cad_shell.py
```

`broken-modal.bdf.gz` and `fixed-modal.bdf.gz` are the exact SOL 103 inputs. Unpack each into a separate scratch directory as `model.bdf`, then run `~/Documents/vibe-tran/MYSTRAN/Binaries/mystran model.bdf`. Matching F06/log files and all 12 frequency/jump comparisons are retained here. `broken-patch.json.gz` preserves the former native-mesher response as a rejection regression.

The corrected full project and static output replace the defective final acceptance files in `../selective-replacement/`. Its `pending.webmesh.gz` intentionally remains the old checkpoint to exercise provenance recovery. `verify.cjs` there compares every inter-face seam's actual shared segment count with the original chassis, in addition to ownership, retained-card, mass, result-coverage and run-integrity checks.

Browser validation covers native patch generation, reviewed application, RR repair, MYSTRAN static solve, gravity deformation, modal F06 import, mode selection and animation controls. The importer correctly labels these externally run modal results as manually imported; native modal run authoring remains separate work. `repaired-gravity.png` shows the repaired static result; `repaired-mode-3.png` shows the imported third mode. The `broken-rover-*.png` images preserve the superseded defective static views. Regression suite: **550 JavaScript tests and 14 shell Python tests pass**.

Already completed defective meshes are not silently welded on load. Reopen the pending checkpoint and regenerate the patch, or remesh the affected complete region. New patch application blocks the missing-seam condition.
