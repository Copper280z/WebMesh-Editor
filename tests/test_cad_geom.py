"""The OpenCASCADE geometry kernel (cad_geom): tags, orientation, booleans, queries and files.

These run without Gmsh. The conventions checked here are the ones the CAD layer
relies on: a deterministic numbering, normals out of solids, boundary senses,
tags that survive an operation which leaves an entity alone, and the way an
INTERNAL face or edge is treated as an entity of its own.
"""

import math
import os
from pathlib import Path
import tempfile
import unittest

import numpy as np

# OpenCASCADE's two builds (OCP's and Gmsh's) must not meet in one process: with the Gmsh
# backend selected these tests stay out of it.
try:
    import cad_kernel
    if cad_kernel.backend() != "occ":
        raise ImportError("the OpenCASCADE backend is not selected")
    import cad_geom
except ImportError:
    cad_geom = None

ROOT = Path(__file__).resolve().parents[1]


def kernel():
    k = cad_geom.module()
    k.initialize()
    return k


def uv_middle(k, face):
    """Parameters of a point on the face, as near its middle as the face allows (a face may have a hole there)."""
    lower, upper = k.model.getParametrizationBounds(2, face)
    for a in (0.5, 0.3, 0.7, 0.15, 0.85):
        for b in (0.5, 0.3, 0.7, 0.15, 0.85):
            uv = [float(lower[0] + (upper[0] - lower[0]) * a), float(lower[1] + (upper[1] - lower[1]) * b)]
            if k.model.isInside(2, face, uv, True):
                return uv
    raise AssertionError(f"face {face} has no interior sample")


@unittest.skipUnless(cad_geom, "OpenCASCADE's Python binding (OCP) is not installed")
class NumberingTests(unittest.TestCase):
    def test_a_box_is_numbered_the_way_gmsh_numbers_it(self):
        k = kernel()
        k.model.occ.addBox(0, 0, 0, 2, 3, 4)
        k.model.occ.synchronize()
        m = k.model
        self.assertEqual([len(m.getEntities(d)) for d in range(4)], [8, 12, 6, 1])
        # Face 1 is the x = 0 face, then x = 2, y = 0, y = 3, z = 0, z = 4.
        centers = [k.model.occ.getCenterOfMass(2, t) for _, t in m.getEntities(2)]
        np.testing.assert_allclose(centers, [[0, 1.5, 2], [2, 1.5, 2], [1, 0, 2], [1, 3, 2], [1, 1.5, 0], [1, 1.5, 4]], atol=1e-9)
        self.assertEqual(sorted(map(int, m.getAdjacencies(3, 1)[1])), [1, 2, 3, 4, 5, 6])

    def test_reading_a_file_numbers_it_by_traversal_order_every_time(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "part.brep"
            k = kernel()
            o = k.model.occ
            o.cut([(3, o.addBox(0, 0, 0, 40, 40, 10))], [(3, o.addCylinder(20, 20, -1, 0, 0, 12, 5))])
            o.synchronize()
            k.write(str(path))
            first, second = kernel(), kernel()
            for each in (first, second):
                each.model.occ.importShapes(str(path), highestDimOnly=False)
                each.model.occ.synchronize()
            for dim in range(4):
                self.assertEqual(first.model.getEntities(dim), second.model.getEntities(dim))
            for _, face in first.model.getEntities(2):
                np.testing.assert_allclose(first.model.occ.getCenterOfMass(2, face), second.model.occ.getCenterOfMass(2, face))

    def test_model_queries_see_the_shape_as_of_the_last_synchronize(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.addBox(0, 0, 0, 1, 1, 1)
        self.assertEqual(m.getEntities(3), [])
        self.assertEqual(o.getEntities(3), [(3, 1)])
        o.synchronize()
        o.addBox(5, 0, 0, 1, 1, 1)
        self.assertEqual(m.getEntities(3), [(3, 1)])
        o.synchronize()
        self.assertEqual(m.getEntities(3), [(3, 1), (3, 2)])


@unittest.skipUnless(cad_geom, "OpenCASCADE's Python binding (OCP) is not installed")
class OrientationTests(unittest.TestCase):
    def test_normals_point_out_of_every_face_of_a_solid(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.cut([(3, o.addBox(0, 0, 0, 20, 20, 10))], [(3, o.addCylinder(10, 10, -1, 0, 0, 12, 4))])
        o.synchronize()
        for _, face in m.getEntities(2):
            uv = uv_middle(k, face)
            point = np.array(m.getValue(2, face, uv))
            normal = np.array(m.getNormal(face, uv))
            self.assertAlmostEqual(float(np.linalg.norm(normal)), 1.0, places=9)
            # Out of the solid: probing a little way along the normal leaves it, and the opposite way stays inside.
            self.assertFalse(m.isInside(3, 1, list(point + 1e-3 * normal)), face)
            self.assertTrue(m.isInside(3, 1, list(point - 1e-3 * normal)), face)

    def test_boundary_senses_match_gmsh_for_a_box(self):
        k = kernel()
        k.model.occ.addBox(0, 0, 0, 2, 3, 4)
        k.model.occ.synchronize()
        m = k.model
        self.assertEqual(m.getBoundary([(3, 1)]), [(2, -1), (2, 2), (2, -3), (2, 4), (2, -5), (2, 6)])
        self.assertEqual(m.getBoundary([(3, 1)], oriented=False), [(2, t) for t in range(1, 7)])
        # Senses are about the face's natural orientation, so the x = 0 face and the x = 2 face agree edge by edge.
        self.assertEqual(m.getBoundary([(2, 1)]), [(1, -1), (1, -2), (1, 3), (1, 4)])
        self.assertEqual(m.getBoundary([(2, 2)]), [(1, -5), (1, -6), (1, 7), (1, 8)])

    def test_a_seam_is_listed_twice_in_a_loop_but_cancels_in_the_boundary(self):
        k = kernel()
        k.model.occ.addCylinder(0, 0, 0, 0, 0, 5, 2)
        k.model.occ.synchronize()
        m = k.model
        side = next(t for _, t in m.getEntities(2) if m.getType(2, t) == "Cylinder")
        (loop,) = k.model.occ.getCurveLoops(side)[1]
        seams = [t for t in set(map(int, loop)) if list(map(int, loop)).count(t) == 2]
        self.assertEqual(len(seams), 1)
        self.assertEqual(sorted(abs(t) for _, t in m.getBoundary([(2, side)])), sorted(set(map(int, loop)) - set(seams)))
        self.assertEqual(sorted(map(int, m.getAdjacencies(2, side)[1])), sorted(map(int, loop)))

    def test_edges_run_along_their_curve_from_the_first_vertex_to_the_last(self):
        k = kernel()
        k.model.occ.addCylinder(0, 0, 0, 0, 0, 5, 2)
        k.model.occ.synchronize()
        m = k.model
        for _, edge in m.getEntities(1):
            lower, upper = m.getParametrizationBounds(1, edge)
            ends = np.array(m.getValue(1, edge, [lower[0], upper[0]])).reshape(2, 3)
            vertices = list(map(int, m.getAdjacencies(1, edge)[1]))
            np.testing.assert_allclose([m.getValue(0, v, []) for v in vertices], ends, atol=1e-9)

    def test_principal_curvatures_of_a_cylinder(self):
        k = kernel()
        k.model.occ.addCylinder(0, 0, 0, 0, 0, 5, 2)
        k.model.occ.synchronize()
        m = k.model
        side = next(t for _, t in m.getEntities(2) if m.getType(2, t) == "Cylinder")
        high, low, direction_high, direction_low = m.getPrincipalCurvatures(side, [1.0, 1.0])
        self.assertAlmostEqual(abs(float(low[0])), 0.5, places=9)
        self.assertAlmostEqual(float(high[0]), 0.0, places=9)
        np.testing.assert_allclose(np.abs(direction_high), [0, 0, 1], atol=1e-9)  # the straight direction is the axis


@unittest.skipUnless(cad_geom, "OpenCASCADE's Python binding (OCP) is not installed")
class OperationTests(unittest.TestCase):
    def test_fragment_keeps_the_tags_of_what_it_leaves_alone(self):
        k = kernel()
        o, m = k.model.occ, k.model
        a, b = o.addBox(0, 0, 0, 10, 10, 10), o.addBox(30, 0, 0, 10, 10, 10)
        o.synchronize()
        faces_before = {t: o.getCenterOfMass(2, t) for _, t in m.getEntities(2)}
        points = [o.addPoint(*c) for c in ((5, -5, -5), (5, 15, -5), (5, 15, 15), (5, -5, 15))]
        plane = o.addPlaneSurface([o.addCurveLoop([o.addLine(points[i], points[(i + 1) % 4]) for i in range(4)])])
        out, mapping = o.fragment([(3, a), (3, b)], [(2, plane)])
        o.synchronize()
        # The far box is untouched: same solid, same faces, same tags.
        self.assertEqual(mapping[1], [(3, b)])
        for tag, center in faces_before.items():
            if center[0] > 20:
                np.testing.assert_allclose(o.getCenterOfMass(2, tag), center)
        self.assertEqual(len(mapping[0]), 2, "the near box is cut into two solids")
        self.assertEqual(len([1 for item in mapping[2] if item[0] == 2]), len(mapping[2]))
        self.assertEqual(len(m.getEntities(3)), 3)

    def test_a_cut_that_does_not_divide_a_solid_leaves_its_face_free_and_unremovable(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.cut([(3, o.addBox(0, 0, 0, 40, 40, 10))], [(3, o.addBox(10, 10, -1, 20, 20, 12))])
        points = [o.addPoint(*c) for c in ((20, -1, -1), (20, -1, 11), (20, 11, 11), (20, 11, -1))]
        plane = o.addPlaneSurface([o.addCurveLoop([o.addLine(points[i], points[(i + 1) % 4]) for i in range(4)])])
        o.fragment(o.getEntities(3), [(2, plane)])
        o.synchronize()
        self.assertEqual(len(m.getEntities(3)), 1, "the frame stays one piece")
        free = [t for _, t in m.getEntities(2) if not len(m.getAdjacencies(2, t)[0])]
        inside = [t for t in free if abs(o.getMass(2, t) - 100) < 1e-9]
        self.assertEqual(len(inside), 1, "the part of the plane across the wall is a free face")
        self.assertEqual(len(m.getCurveLoops(inside[0])[1]) if hasattr(m, "getCurveLoops") else len(o.getCurveLoops(inside[0])[1]), 1)
        self.assertEqual(len(o.getCurveLoops(inside[0])[1][0]), 4, "with its four edges, not a degenerate loop")
        o.remove([(2, inside[0])])
        o.synchronize()
        self.assertIn((2, inside[0]), m.getEntities(2), "the solid still holds it, so it cannot be dropped alone")

    def test_fuse_unifies_coplanar_faces_and_maps_consumed_solids_to_the_result(self):
        k = kernel()
        o, m = k.model.occ, k.model
        a, b = o.addBox(0, 0, 0, 10, 10, 10), o.addBox(10, 0, 0, 10, 10, 10)
        out, mapping = o.fuse([(3, a)], [(3, b)])
        o.synchronize()
        self.assertEqual([item for item in out if item[0] == 3], [(3, 1)])
        self.assertEqual(len(m.getEntities(2)), 6, "the faces either side of the interface are one")
        self.assertEqual(mapping, [[(3, 1)], [(3, 1)]])
        self.assertAlmostEqual(o.getMass(3, 1), 2000.0, places=6)

    def test_fusing_faces_maps_each_to_the_merged_face(self):
        k = kernel()
        o = k.model.occ
        a, b = o.addRectangle(0, 0, 0, 10, 10), o.addRectangle(0, 10, 0, 10, 10)
        _, mapping = o.fuse([(2, a)], [(2, b)])
        self.assertEqual([len(group) for group in mapping], [1, 1])
        self.assertEqual(mapping[0], mapping[1])

    def test_removing_a_solid_leaves_its_faces_unless_the_removal_is_recursive(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.addBox(0, 0, 0, 1, 1, 1)
        o.addBox(5, 0, 0, 1, 1, 1)
        o.remove([(3, 1)])
        o.synchronize()
        self.assertEqual((len(m.getEntities(3)), len(m.getEntities(2)), len(m.getEntities(1)), len(m.getEntities(0))), (1, 12, 24, 16))
        o.remove([(3, 2)], recursive=True)
        o.synchronize()
        self.assertEqual((len(m.getEntities(3)), len(m.getEntities(2))), (0, 6), "the first box's faces remain")
        o.remove(o.getEntities(2), recursive=True)
        o.synchronize()
        self.assertEqual([len(m.getEntities(d)) for d in range(4)], [0, 0, 0, 0])

    def test_translate_dilate_and_copy_keep_their_tags_or_make_new_ones(self):
        k = kernel()
        o, m = k.model.occ, k.model
        box = o.addBox(0, 0, 0, 1, 2, 3)
        copy = o.copy([(3, box)])
        o.translate(copy, 10, 0, 0)
        o.dilate(copy, 10, 0, 0, 2, 2, 2)
        o.synchronize()
        self.assertEqual(copy, [(3, 2)])
        self.assertAlmostEqual(o.getMass(3, 2), 48.0, places=6)
        self.assertAlmostEqual(o.getMass(3, 1), 6.0, places=6)
        b = m.getBoundingBox(3, 2)
        self.assertAlmostEqual(b[0], 10.0, places=6)
        self.assertAlmostEqual(b[3], 12.0, places=6)
        o.affineTransform([(3, 1)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 5, 0])
        o.synchronize()
        self.assertAlmostEqual(o.getMass(3, 1), 30.0, places=6)

    def test_extrude_returns_the_far_face_the_body_and_the_sides(self):
        k = kernel()
        o = k.model.occ
        face = o.addRectangle(0, 0, 0, 2, 3)
        out = o.extrude([(2, face)], 0, 0, 4)
        self.assertEqual([d for d, _ in out], [2, 3, 2, 2, 2, 2])
        self.assertAlmostEqual(o.getMass(3, out[1][1]), 24.0, places=9)
        circle = o.addCircle(0, 0, 0, 1)
        surface = [e for e in o.extrude([(1, circle)], 0, 0, 2) if e[0] == 2]
        self.assertEqual(len(surface), 1)
        self.assertAlmostEqual(o.getMass(2, surface[0][1]), 4 * math.pi, places=6)

    def test_defeature_removes_a_hole_and_returns_the_new_solid(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.cut([(3, o.addBox(0, 0, 0, 20, 20, 5))], [(3, o.addCylinder(10, 10, -1, 0, 0, 7, 3))])
        o.synchronize()
        bore = [t for _, t in m.getEntities(2) if m.getType(2, t) == "Cylinder"]
        before = o.getMass(3, 1)
        result = o.defeature([1], bore, removeVolume=True)
        o.synchronize()
        self.assertEqual(len(result), 1)
        self.assertGreater(o.getMass(3, result[0][1]), before)
        self.assertAlmostEqual(o.getMass(3, result[0][1]), 20 * 20 * 5, places=6)
        self.assertEqual(len(m.getEntities(3)), 1)

    def test_a_failed_boolean_says_so(self):
        k = kernel()
        o = k.model.occ
        with self.assertRaises(ValueError):
            o.cut([], [(3, o.addBox(0, 0, 0, 1, 1, 1))])


@unittest.skipUnless(cad_geom, "OpenCASCADE's Python binding (OCP) is not installed")
class QueryTests(unittest.TestCase):
    def test_a_point_off_a_face_gets_its_true_surface_parameters_not_an_arbitrary_place(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.addRectangle(0, 0, 0, 10, 10)
        o.synchronize()
        lower, upper = m.getParametrizationBounds(2, 1)
        inside = m.getParametrization(2, 1, [3, 4, 0])
        outside = m.getParametrization(2, 1, [30, 40, 0])
        np.testing.assert_allclose(m.getValue(2, 1, list(inside)), [3, 4, 0], atol=1e-9)
        np.testing.assert_allclose(m.getValue(2, 1, list(outside)), [30, 40, 0], atol=1e-9)
        self.assertTrue(m.isInside(2, 1, list(inside), True))
        self.assertFalse(m.isInside(2, 1, list(outside), True))
        points, parameters = m.getClosestPoint(2, 1, [30, 40, 7])
        np.testing.assert_allclose(points, [30, 40, 0], atol=1e-9)

    def test_periodic_parameters_wrap_into_the_faces_own_span(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.addCylinder(0, 0, 0, 0, 0, 5, 2)
        o.synchronize()
        side = next(t for _, t in m.getEntities(2) if m.getType(2, t) == "Cylinder")
        for angle in (0.1, 2.0, 4.0, 6.2):
            u, v = m.getParametrization(2, side, [2 * math.cos(angle), 2 * math.sin(angle), 1.5])
            self.assertAlmostEqual(float(u), angle, places=7)
            self.assertAlmostEqual(float(v), 1.5, places=9)

    def test_a_point_near_a_curve_gets_the_parameter_of_its_nearest_point(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.addCylinder(0, 0, 0, 0, 0, 5, 2)
        o.synchronize()
        for _, edge in m.getEntities(1):
            lower, upper = m.getParametrizationBounds(1, edge)
            parameters = [float(lower[0] + (upper[0] - lower[0]) * f) for f in (0.2, 0.5, 0.9)]
            points = m.getValue(1, edge, parameters)
            np.testing.assert_allclose(m.getParametrization(1, edge, list(points)), parameters, atol=1e-7)
            nearest, _ = m.getClosestPoint(1, edge, list(np.array(points) + 0.01))
            self.assertEqual(len(nearest), 9)

    def test_point_classification_includes_the_boundary(self):
        k = kernel()
        k.model.occ.addBox(0, 0, 0, 2, 2, 2)
        k.model.occ.synchronize()
        m = k.model
        self.assertEqual([m.isInside(3, 1, p) for p in ([1, 1, 1], [2, 1, 1], [3, 1, 1], [1, 1, -0.5])], [1, 1, 0, 0])

    def test_bounding_boxes_are_padded_by_the_tolerance_like_gmsh(self):
        k = kernel()
        k.model.occ.addBox(0, 0, 0, 2, 3, 4)
        k.model.occ.synchronize()
        np.testing.assert_allclose(k.model.getBoundingBox(-1, -1), [-1e-7, -1e-7, -1e-7, 2 + 1e-7, 3 + 1e-7, 4 + 1e-7], atol=1e-12)

    def test_mass_and_center_of_mass(self):
        k = kernel()
        o = k.model.occ
        o.addBox(0, 0, 0, 2, 3, 4)
        self.assertAlmostEqual(o.getMass(3, 1), 24.0, places=9)
        np.testing.assert_allclose(o.getCenterOfMass(3, 1), [1, 1.5, 2], atol=1e-9)
        self.assertAlmostEqual(sum(o.getMass(2, t) for _, t in o.getEntities(2)), 2 * (6 + 8 + 12), places=9)

    def test_surface_and_curve_types_are_named_by_what_they_are(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.addCylinder(0, 0, 0, 0, 0, 5, 2)
        o.addCone(10, 0, 0, 0, 0, 5, 3, 1)
        o.addSphere(30, 0, 0, 2)
        o.addTorus(50, 0, 0, 5, 1)
        o.synchronize()
        surfaces = sorted({m.getType(2, t) for _, t in m.getEntities(2)})
        self.assertEqual(surfaces, ["Cone", "Cylinder", "Plane", "Sphere", "Torus"])
        self.assertTrue({"Circle", "Line"} <= {m.getType(1, t) for _, t in m.getEntities(1)})
        self.assertEqual(m.getType(3, 1), "Volume")

    def test_junction_edges_that_stop_inside_a_face_are_internal_and_not_in_its_loops(self):
        k = kernel()
        o, m = k.model.occ, k.model
        floor = o.addRectangle(0, 0, 0, 100, 60)
        points = [o.addPoint(*c) for c in ((48, 0, 0), (48, 32, 0), (48, 32, 40), (48, 0, 40))]
        wall = o.addPlaneSurface([o.addCurveLoop([o.addLine(points[i], points[(i + 1) % 4]) for i in range(4)])])
        o.fragment([(2, floor)], [(2, wall)])
        o.synchronize()
        floor_face = next(t for _, t in m.getEntities(2) if abs(o.getMass(2, t) - 6000) < 1e-6)
        internal = m.getInternalEdges(floor_face)
        self.assertEqual(len(internal), 1)
        self.assertNotIn(internal[0], list(map(int, o.getCurveLoops(floor_face)[1][0])))
        self.assertNotIn(floor_face, list(map(int, m.getAdjacencies(1, internal[0])[0])))
        wall_face = next(t for _, t in m.getEntities(2) if t != floor_face and abs(o.getMass(2, t) - 32 * 40) < 1e-6)
        self.assertIn(wall_face, list(map(int, m.getAdjacencies(1, internal[0])[0])))
        self.assertEqual(len(o.getCurveLoops(floor_face)[1]), 1)

    def test_tessellation_is_wound_outward_and_encloses_the_volume(self):
        k = kernel()
        o, m = k.model.occ, k.model
        o.cut([(3, o.addBox(0, 0, 0, 20, 20, 10))], [(3, o.addCylinder(10, 10, -1, 0, 0, 12, 4))])
        o.synchronize()
        triangles = k.tessellate([t for _, t in m.getEntities(2)], 0.01, 2 * math.pi / 48)
        self.assertEqual(set(triangles), {t for _, t in m.getEntities(2)})
        volume = 0.0
        for flat in triangles.values():
            p = np.array(flat).reshape(-1, 3, 3)
            volume += float(np.sum(np.einsum("ij,ij->i", p[:, 0], np.cross(p[:, 1], p[:, 2]))) / 6)
        self.assertAlmostEqual(volume, 20 * 20 * 10 - math.pi * 16 * 10, delta=0.01 * 20 * 20 * 10 * 0.01)
        # The hole's wall is split into at least 48 segments around the circle.
        hole = next(t for _, t in m.getEntities(2) if m.getType(2, t) == "Cylinder")
        self.assertGreaterEqual(len(triangles[hole]) // 9, 96)


@unittest.skipUnless(cad_geom, "OpenCASCADE's Python binding (OCP) is not installed")
class FileTests(unittest.TestCase):
    def test_brep_and_step_round_trips_keep_solids_and_free_faces(self):
        with tempfile.TemporaryDirectory() as folder:
            k = kernel()
            o = k.model.occ
            o.addBox(0, 0, 0, 2, 3, 4)
            o.addRectangle(10, 0, 0, 5, 5)
            o.synchronize()
            for name in ("part.brep", "part.step"):
                path = Path(folder) / name
                k.write(str(path))
                again = kernel()
                again.model.occ.importShapes(str(path), highestDimOnly=False)
                again.model.occ.synchronize()
                self.assertEqual([len(again.model.getEntities(d)) for d in range(4)], [12, 16, 7, 1], name)
                self.assertAlmostEqual(again.model.occ.getMass(3, 1), 24.0, places=6)

    def test_highest_dimension_only_skips_the_free_faces(self):
        with tempfile.TemporaryDirectory() as folder:
            k = kernel()
            o = k.model.occ
            o.addBox(0, 0, 0, 1, 1, 1)
            o.addRectangle(10, 0, 0, 5, 5)
            o.synchronize()
            k.write(str(Path(folder) / "mixed.brep"))
            again = kernel()
            found = again.model.occ.importShapes(str(Path(folder) / "mixed.brep"), highestDimOnly=True)
            self.assertEqual([d for d, _ in found], [3])

    def test_example_files_import_with_the_numbers_gmsh_gave_them(self):
        k = kernel()
        k.model.occ.importShapes(str(ROOT / "examples/plate-hole.step"), highestDimOnly=False)
        k.model.occ.synchronize()
        self.assertEqual([len(k.model.getEntities(d)) for d in range(4)], [18, 27, 11, 1])

    def test_unreadable_geometry_is_refused_clearly(self):
        with tempfile.TemporaryDirectory() as folder:
            bad = Path(folder) / "bad.step"
            bad.write_text("not a step file")
            with self.assertRaises(ValueError):
                kernel().model.occ.importShapes(str(bad))
            with self.assertRaises(ValueError):
                kernel().model.occ.importShapes(str(Path(folder) / "model.stl"))


if __name__ == "__main__":
    unittest.main()
