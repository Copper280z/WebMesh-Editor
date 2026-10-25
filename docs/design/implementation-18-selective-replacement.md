# Milestone 18 — selective CAD replacement and named patterns

## Plan and acceptance

Preserve verified unchanged geometry and mesh identities during source replacement. Review named hole patterns as groups, with unique exact matches accepted automatically and moved/ambiguous candidates left for an explicit decision. Never infer identity from entity numbers or node counts.

The guided workflow composes public actions: define a named pattern, compare CAD anchors, retain unchanged mesh coverage, remesh changed shell faces against retained boundaries, and repair a pattern. Kept cards keep their owners, IDs and roles. Changed coverage is visibly pending and blocks analysis. Unsupported provenance, edited connectivity or uncertain correspondence falls back to explicit remeshing.

1. Add persisted hole-pattern anchors and translation candidates; expose pattern authoring and grouped replacement review.
2. Retain exact solid mesh regions and exact shell faces, including within an existing mesh owner. Preserve unchanged edge membership for attachments. Keep pending face coverage as an explicit repair object.
3. Add reviewed shell patch remeshing. Reuse nodes only on matched CAD boundaries with a complete coordinate correspondence; reject incompatible boundary discretization. Preserve untouched elements, sections and explicit selections.
4. Extend replacement/draft persistence, undo and repair routing. Save/reopen must retain pending patches and named match decisions.
5. Exercise an actual CAD revision moving the rover rear-right four-hole pattern by 30 mm. Verify unchanged FL/FR/RL attachment cards, explicit RR repair, retained overrides, every shared seam segment, MYSTRAN static and modal output, and browser postprocessing. Save reproducible fixtures and independent checks.

## Boundaries

This increment does not automatically replay arbitrary CAD preparation or infer split/merge rules. A replacement must contain the intended analysis surfaces (or the analyst must recreate them). Patch preservation requires supported shell face/edge classification and unchanged boundary geometry. Coordinate proximity alone is never sufficient evidence for attaching a new mesh to an old boundary.

## Outcome

Implemented on `codex/project-core-foundation`.

- `cad-patterns.js` defines and matches complete circular-hole groups. The mounting inspector saves named pattern anchors; replacement review lists exact/moved candidates and old/new boundary previews. Moved candidates are always an explicit decision. Stale revision-local edge numbers are not preselected during repair.
- `cad-selective-mesh.js` retains unique exact geometry with matching boundary anchors. Solid owners require complete unchanged volume boundaries. Shell owners retain classified unchanged faces, shared boundary GRIDs, solver IDs and ownership roles. Edited connectivity, uncertain provenance or unmatched changed-face targets use conservative whole-region remeshing.
- Pending patches are explicit repair objects. Solve stays blocked until coverage and dependent selections are repaired. Patch generation checks every changed face, current source identity, boundary discretization, a bijective coordinate correspondence on each matched CAD edge, and actual replacement element-edge sharing along every retained seam. Internal CAD edge provenance is saved even on closed shells. Older pending projects can recover coordinate-aligned straight seams from a complete retained element-edge chain; unsupported provenance requires a complete remesh. Existing sections and uniform per-face offsets are retained; varying per-face offsets use conservative replacement. New interior nodes/elements receive fresh reservations.
- Named-region repair composes the existing attachment and assembly actions and resumes only dependencies whose inputs resolve. Project saves retain replacement decisions, pending coverage, per-part drafts and historical CAD revisions. Runtime replacement undo/redo is exercised; reopening still does not imply a persistent unified FE/CAD undo timeline.

### Validation

The [browser-authored rover evidence](validation/selective-replacement/README.md) moves four RR holes by +30 mm Y in prepared analysis sheets. Eleven faces and all FL/FR/RL connection cards remain unchanged. The two changed faces generate 637 quads (minimum scaled Jacobian 0.566); the RR repair review restores exactly four motor cards and preserves its K1 override. Save/reopen is checked before and after repair, plus replacement undo/redo.

The initial acceptance was wrong: its one-component graph check missed open wall–floor and wall–gusset seams connected only at corners. The user identified the defect in the deformation screenshot. Internal CAD edge membership had been filtered out as though only free edges mattered, allowing the patch to create 56 duplicate nodes. That bug and the acceptance checks are corrected; see the [seam and modal comparison](validation/seam-connectivity/README.md).

The corrected browser-authored project has 9,393 active GRIDs and 8,459 quads. All original inter-face seam segment counts are preserved, including the 29 shared bottom-seam nodes and 28 segments. MYSTRAN completes both static cases with the existing force/moment balance criteria passing. Peak gravity displacement is 0.087216 mm, versus 0.290992 mm in the cracked model. No balance tolerance or external solver code changed.

Identical-geometry SOL 103 comparisons extract 12 supported modes. Mode 1 changes from 22.62124 to 25.61400 Hz; the original seam displacement jump is 79.2% of peak modal translation, while all repaired modes have zero jump at shared seam nodes. The manual F06 importer displays modal frequencies and deformation; this does not add a native modal case authoring workflow.

`npm test`: 550 tests pass. Shell Python tests: 14 pass. Regressions reject the original broken patch and falsified boundary metadata, retain untouched identities, recover the legacy pending checkpoint, and refuse unprovable seam chains. The untracked solver investigation has been corrected to identify the WebMesh mesh defect; its earlier deck is not valid acceptance evidence.

### Still open

General rotations/tilted pattern planes, arcs/split circular loops, feature split/merge, arbitrary preparation replay and partial solid patch remeshing. This fixture revises the analytical sheets, not the retained reference solid. Existing explicit shaft/wheel placements remain fixed; moving the whole motor assembly is a separate placement action.
