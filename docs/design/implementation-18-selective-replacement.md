# Milestone 18 — selective CAD replacement and named patterns

## Plan and acceptance

Preserve verified unchanged geometry and mesh identities during source replacement. Review named hole patterns as groups, with unique exact matches accepted automatically and moved/ambiguous candidates left for an explicit decision. Never infer identity from entity numbers or node counts.

The guided workflow composes public actions: define a named pattern, compare CAD anchors, retain unchanged mesh coverage, remesh changed shell faces against retained boundaries, and repair a pattern. Kept cards keep their owners, IDs and roles. Changed coverage is visibly pending and blocks analysis. Unsupported provenance, edited connectivity or uncertain correspondence falls back to explicit remeshing.

1. Add persisted hole-pattern anchors and translation candidates; expose pattern authoring and grouped replacement review.
2. Retain exact solid mesh regions and exact shell faces, including within an existing mesh owner. Preserve unchanged edge membership for attachments. Keep pending face coverage as an explicit repair object.
3. Add reviewed shell patch remeshing. Reuse nodes only on matched CAD boundaries with a complete coordinate correspondence; reject incompatible boundary discretization. Preserve untouched elements, sections and explicit selections.
4. Extend replacement/draft persistence, undo and repair routing. Save/reopen must retain pending patches and named match decisions.
5. Exercise an actual CAD revision moving the rover rear-right four-hole pattern by 30 mm. Verify unchanged FL/FR/RL attachment cards, explicit RR repair, retained overrides, connected structural topology, MYSTRAN output and browser postprocessing. Save reproducible fixtures and independent checks.

## Boundaries

This increment does not automatically replay arbitrary CAD preparation or infer split/merge rules. A replacement must contain the intended analysis surfaces (or the analyst must recreate them). Patch preservation requires supported shell face/edge classification and unchanged boundary geometry. Coordinate proximity alone is never sufficient evidence for attaching a new mesh to an old boundary.

## Outcome

Implemented on `codex/project-core-foundation`.

- `cad-patterns.js` defines and matches complete circular-hole groups. The mounting inspector saves named pattern anchors; replacement review lists exact/moved candidates and old/new boundary previews. Moved candidates are always an explicit decision. Stale revision-local edge numbers are not preselected during repair.
- `cad-selective-mesh.js` retains unique exact geometry with matching boundary anchors. Solid owners require complete unchanged volume boundaries. Shell owners retain classified unchanged faces, shared boundary GRIDs, solver IDs and ownership roles. Edited connectivity, uncertain provenance or unmatched changed-face targets use conservative whole-region remeshing.
- Pending patches are explicit repair objects. Solve stays blocked until coverage and dependent selections are repaired. Patch generation checks every changed face, current source identity, boundary discretization and a bijective coordinate correspondence on each matched CAD edge. Existing sections and uniform per-face offsets are retained; varying per-face offsets use conservative replacement. New interior nodes/elements receive fresh reservations.
- Named-region repair composes the existing attachment and assembly actions and resumes only dependencies whose inputs resolve. Project saves retain replacement decisions, pending coverage, per-part drafts and historical CAD revisions. Runtime replacement undo/redo is exercised; reopening still does not imply a persistent unified FE/CAD undo timeline.

### Validation

The [browser-authored rover evidence](validation/selective-replacement/README.md) moves four RR holes by +30 mm Y in prepared analysis sheets. Eleven faces and all FL/FR/RL connection cards remain unchanged. The two changed faces generate 637 quads (minimum scaled Jacobian 0.566); the RR repair review restores exactly four motor cards and preserves its K1 override. Save/reopen is checked before and after repair, plus replacement undo/redo.

MYSTRAN completes gravity and gravity-plus-lateral cases. Independent checks confirm one connected assembly, unchanged retained cards, material/mass preservation, all-node displacement and all-shell stress coverage, and immutable run integrity. Numerical indicators and force balance pass. Moment Y residuals of 0.111565 and 0.096986 N mm exceed the existing strict tolerances, so the run inspector correctly flags balance. This unresolved investigation is kept outside version control under `solver-bug-reports/mystran-rr-moment-balance-2026-10-25/`; no tolerance was loosened and no external solver code was changed.

`npm test`: 549 tests pass. The regression covers a real rover patch, unchanged motor identities, a nonempty RR override, source/coverage/boundary guards, hand-card dangling references, exact solid retention, ambiguity and save validation.

### Still open

General rotations/tilted pattern planes, arcs/split circular loops, feature split/merge, arbitrary preparation replay and partial solid patch remeshing. This fixture revises the analytical sheets, not the retained reference solid. Existing explicit shaft/wheel placements remain fixed; moving the whole motor assembly is a separate placement action.
