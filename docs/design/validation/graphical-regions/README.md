# Graphical selection and mesh-region acceptance

23 October 2026 · local browser at port 8793 · milestone 11

`repaired.webmesh` is the saved browser-authored project, including the exact deck, three retained runs, ownership and CAD draft. The final run is **Graphically repaired mounting region**, revision 31. It was reopened successfully after saving. The project is the existing small mixed-mesh workflow fixture, not a new rover analysis or a convergence study.

## Manual browser workflow

1. Reopened milestone 10's project. In **Model setup → Selections & repair**, created **Picked solid mounting nodes**, scoped the detached picker to **Solid root**, and used **Face nodes**. Click selected four nodes; Shift-click added an adjacent facet for six nodes; Control-click subtracted its four nodes. Added them again and reviewed a zero-card region transaction.
2. Reused that region in **Root translations**, retaining support SID 1 and its local frame. The review showed six GRID CD updates and one support-card update.
3. Created **Picked shell inspection region** using **Elements → Box** on **Shell web**. The selection contained seven elements: 345, 350, 355, 359, 365, 369 and 378. Used this region in an analysis-exclusion object; its inspector reported seven excluded elements. Removed that exclusion before solving, retaining the named region.
4. Reopened Solid root's meshing settings and changed sizing group C from four to six. The proposed solid changed from 48 HEX8/105 nodes to 72 HEX8/147 nodes. The explicit node region correctly required repair; the shell element region remained valid.
5. Picked replacement facets directly on the pending solid. The old region `[944,945,949,950,954,955]` became `[1084,1085,1091,1092,1098,1099]`. Review included 405 card changes, with the regenerated embedded interface, support and payload/battery distributions.
6. Discarded the complete review. The CAD region still reported 48 committed elements and a separate 72-element proposal. Repeated graphical repair and applied one transaction. Undo restored the old region IDs; redo restored the new region IDs.
7. Saved/reopened, then solved both existing load cases in MYSTRAN. Saved/reopened again with the new run and both named mesh regions intact. The final project contains 72 solids, 50 original web shells and 12 embedded shells; all elements participate in analysis.

8. On the reopened project, typed nonexistent GRID 999999. The picker reported missing membership and Review rejected the region. Returning to the inventory preserved the six saved nodes.

Screenshots: [pending replacement](../../images/proposed-region-picking.png) and [reopened region](../../images/graphical-regions-final.png).

## Numerical evidence

MYSTRAN completed with epsilon estimates `9.806656e-13` and `-6.181949e-16`. The exact input hash is `b28b0e54c85189e596d9d0818a6fc6a2e95ae7f3175dd16afbacc808a0e91bff`.

The existing product balance diagnostic reports **failed**. Its component-wise tolerance uses a minimum scale of one, so small cancellation residuals in nominally zero resultants exceed that threshold. Maximum reported residuals are approximately `1.31e-5 N` and `5.29e-4 N mm`. This result is retained unchanged, not relabeled as a product pass. The small solver epsilon and independent check are consistent with finite printed precision; they do not establish a solver defect.

Run:

```sh
python3 docs/design/validation/graphical-regions/verify.py
```

The verifier checks the saved membership/support binding, ensures no elements remain excluded, verifies the solver input/result hashes, independently integrates structural and concentrated mass, rotates printed local reactions, and checks all six resultants for both cases. Explicit absolute tolerances are `1e-4 N` and `1e-3 N mm`. It reproduces [equilibrium.json](equilibrium.json), which includes the unchanged stricter product diagnostic.
