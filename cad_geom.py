"""OpenCASCADE geometry kernel behind the calls the CAD layer makes.

WebMesh's CAD code (preparation, sheets, shell meshing, mapped-hex data) was
written against a small, tag-based subset of the Gmsh API: entities are
(dimension, tag) pairs, ``gmsh.model.*`` answers geometry queries and
``gmsh.model.occ.*`` edits the shape. This module provides that subset directly
on OpenCASCADE through its Python binding (OCP), so the core needs no Gmsh.

* Entities are bound shapes. Sub-shapes (faces of a solid, edges of a face,
  vertices of an edge) are bound with their parent. Tags are the position in
  ``TopExp.MapShapes`` order, so a freshly read file is numbered
  deterministically (the same numbers Gmsh gives), and an entity an operation
  leaves unchanged keeps its tag through that operation.
* ``occ.*`` works on the live shape; ``model.*`` answers queries about the
  snapshot taken by the last ``occ.synchronize()``, as Gmsh does.
* Face orientation follows OpenCASCADE: ``getNormal`` points out of a solid, and
  boundary signs are the oriented senses of edges in a face's wires.
* Edges that OpenCASCADE marks INTERNAL (a sheet junction that stops inside a
  face) are not part of a face's loops or adjacencies, as in Gmsh;
  ``model.getInternalEdges`` lists them directly.

Gmsh itself is not imported here. It is an optional meshing plugin (see
cad_gmsh_plugin.py).
"""

from __future__ import annotations

import heapq
import math
from pathlib import Path

import numpy as np

try:
    from OCP.BRep import BRep_Builder, BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
    from OCP.BRepAlgoAPI import BRepAlgoAPI_BuilderAlgo, BRepAlgoAPI_Common, BRepAlgoAPI_Cut, BRepAlgoAPI_Defeaturing, BRepAlgoAPI_Fuse
    from OCP.BRepBndLib import BRepBndLib
    from OCP.BRepBuilderAPI import (BRepBuilderAPI_Copy, BRepBuilderAPI_GTransform, BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace,
                                    BRepBuilderAPI_MakeVertex, BRepBuilderAPI_MakeWire, BRepBuilderAPI_NurbsConvert, BRepBuilderAPI_Transform)
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.BRepGProp import BRepGProp
    from OCP.BRepLProp import BRepLProp_CLProps, BRepLProp_SLProps
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRepPrimAPI import (BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism,
                                 BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeTorus)
    from OCP.BRepTools import BRepTools, BRepTools_WireExplorer
    from OCP.Extrema import Extrema_ExtPC
    from OCP.GC import GC_MakeArcOfCircle
    from OCP.GProp import GProp_GProps
    from OCP.GeomAbs import GeomAbs_BSplineCurve, GeomAbs_BSplineSurface, GeomAbs_BezierCurve, GeomAbs_BezierSurface
    from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Ellipse, GeomAbs_Hyperbola, GeomAbs_Line
    from OCP.GeomAbs import GeomAbs_Parabola, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_SurfaceOfExtrusion, GeomAbs_SurfaceOfRevolution
    from OCP.GeomAbs import GeomAbs_Torus
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.IGESControl import IGESControl_Reader
    from OCP.ShapeAnalysis import ShapeAnalysis_Surface
    from OCP.ShapeFix import ShapeFix_Face, ShapeFix_FixSmallFace, ShapeFix_Shape
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    from OCP.TopAbs import (TopAbs_COMPOUND, TopAbs_COMPSOLID, TopAbs_EDGE, TopAbs_FACE, TopAbs_FORWARD, TopAbs_IN, TopAbs_ON, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX, TopAbs_WIRE)
    from OCP.TopExp import TopExp
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopTools import TopTools_FormatVersion_CURRENT
    from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Iterator, TopoDS_Shape
    from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as _ShapeMap
    from OCP.collections import List_TopoDS_Shape as _ShapeList
    from OCP.Bnd import Bnd_Box
    from OCP.gp import gp_Ax1, gp_Ax2, gp_Circ, gp_Dir, gp_GTrsf, gp_Mat, gp_Pln, gp_Pnt, gp_Pnt2d, gp_Trsf, gp_Vec, gp_XYZ
except ImportError as error:  # pragma: no cover - exercised when OCP is missing
    raise ImportError("WebMesh's CAD core needs OpenCASCADE's Python binding: python3 -m pip install cadquery-ocp") from error

def _quiet():
    """OpenCASCADE's readers and writers print transfer statistics; keep only failures."""
    from OCP.Message import Message, Message_Gravity
    for printer in Message.DefaultMessenger_s().Printers():
        printer.SetTraceLevel(Message_Gravity.Message_Fail)


_quiet()
_KIND = {0: TopAbs_VERTEX, 1: TopAbs_EDGE, 2: TopAbs_FACE, 3: TopAbs_SOLID}
_DIM = {TopAbs_VERTEX: 0, TopAbs_EDGE: 1, TopAbs_FACE: 2, TopAbs_SOLID: 3}
_SURFACE_NAMES = {GeomAbs_Plane: "Plane", GeomAbs_Cylinder: "Cylinder", GeomAbs_Cone: "Cone", GeomAbs_Sphere: "Sphere",
                  GeomAbs_Torus: "Torus", GeomAbs_BezierSurface: "BezierSurface", GeomAbs_BSplineSurface: "BSplineSurface",
                  GeomAbs_SurfaceOfRevolution: "SurfaceOfRevolution", GeomAbs_SurfaceOfExtrusion: "SurfaceOfExtrusion"}
_CURVE_NAMES = {GeomAbs_Line: "Line", GeomAbs_Circle: "Circle", GeomAbs_Ellipse: "Ellipse", GeomAbs_Hyperbola: "Hyperbola",
                GeomAbs_Parabola: "Parabola", GeomAbs_BezierCurve: "Bezier", GeomAbs_BSplineCurve: "BSpline"}
CONFUSION = 1e-7  # OpenCASCADE's linear tolerance (Precision::Confusion)


def available():
    """True when the OCP binding loaded (this module could be imported at all)."""
    return True


# --------------------------------------------------------------------------
# Shape helpers


def _dim(shape):
    return _DIM.get(shape.ShapeType())


def _children(shape):
    out = []
    iterator = TopoDS_Iterator(shape)
    while iterator.More():
        out.append(iterator.Value())
        iterator.Next()
    return out


def _subshapes(shape, dim):
    """Unique sub-shapes of one dimension, in TopExp.MapShapes order (which is also Gmsh's tag order)."""
    found = _ShapeMap()
    TopExp.MapShapes_s(shape, _KIND[dim], found)
    return [found.FindKey(i) for i in range(1, found.Extent() + 1)]


def _direct(shape, internal=False):
    """The entities one dimension below a shape, through any shells, wires and compounds in between.

    A face OpenCASCADE keeps INTERNAL to a solid (a cut that does not divide it)
    or an edge INTERNAL to a face (a junction that stops partway across) lies
    inside the shape without bounding it. Those are left out unless `internal`.
    """
    out = []

    def walk(item):
        for child in _children(item):
            if child.ShapeType() in (TopAbs_COMPOUND, TopAbs_COMPSOLID, TopAbs_SHELL, TopAbs_WIRE):
                walk(child)
            elif internal or child.Orientation() in (TopAbs_FORWARD, TopAbs_REVERSED):
                out.append(child)
    walk(shape)
    return out


def _pieces(shape):
    """The vertices, edges, faces and solids a result shape consists of, compounds and shells opened up."""
    kind = shape.ShapeType()
    if kind in _DIM:
        return [shape]
    out = []
    for child in _children(shape):
        out.extend(_pieces(child))
    return out


def _compound(shapes):
    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    for shape in shapes:
        builder.Add(compound, shape)
    return compound


def _point(x, y=None, z=None):
    if y is None:
        x, y, z = x
    return gp_Pnt(float(x), float(y), float(z))


def _xyz(p):
    return [p.X(), p.Y(), p.Z()]


def _flat(values):
    return np.asarray(values, dtype=float).ravel()


def _pairs(values, width):
    flat = _flat(values)
    if len(flat) % width:
        raise ValueError(f"Expected a multiple of {width} coordinates.")
    return flat.reshape(-1, width)


def _tuple_tags(items):
    return [(int(d), int(t)) for d, t in items]


class ShapeIndex:
    """Shapes found again by identity (same TShape and location, orientation ignored)."""

    def __init__(self):
        self.buckets = {}

    def get(self, shape):
        for other, tag in self.buckets.get(hash(shape), ()):
            if other.IsSame(shape):
                return tag
        return None

    def put(self, shape, tag):
        self.buckets.setdefault(hash(shape), []).append((shape, tag))

    def drop(self, shape):
        key = hash(shape)
        items = [(other, tag) for other, tag in self.buckets.get(key, ()) if not other.IsSame(shape)]
        if items:
            self.buckets[key] = items
        else:
            self.buckets.pop(key, None)


class Registry:
    """The bound entities of the model: shapes per dimension by tag, found again by identity."""

    def __init__(self):
        self.shapes = [{} for _ in range(4)]
        self.index = [ShapeIndex() for _ in range(4)]
        self.wires = {}
        self.ceiling = [0, 0, 0, 0]
        self.version = 0
        self._parents = None

    def find(self, shape):
        dim = _dim(shape)
        return None if dim is None else self.index[dim].get(shape)

    def bind(self, shape, want=-1):
        dim = _dim(shape)
        tag = self.index[dim].get(shape)
        if tag is not None:
            return tag
        if shape.Orientation() not in (TopAbs_FORWARD, TopAbs_REVERSED):
            # Held INTERNAL by its parent, it becomes an entity of its own, which must have a sense of its own.
            shape = shape.Oriented(TopAbs_FORWARD)
        if want is not None and want > 0 and want not in self.shapes[dim]:
            tag = int(want)
        else:
            tag = self.ceiling[dim] + 1
        self.ceiling[dim] = max(self.ceiling[dim], tag)
        self.shapes[dim][tag] = shape
        self.index[dim].put(shape, tag)
        self.version += 1
        return tag

    def bind_closure(self, shape, want=-1):
        """Bind a shape and everything below it, in tag order; returns the shape's own tag."""
        dim = _dim(shape)
        for lower in range(dim):
            for sub in _subshapes(shape, lower):
                self.bind(sub)
        return self.bind(shape, want)

    def unbind(self, dim, tag):
        shape = self.shapes[dim].pop(tag, None)
        if shape is None:
            return
        self.index[dim].drop(shape)
        if tag == self.ceiling[dim]:
            self.ceiling[dim] = max(self.shapes[dim], default=0)
        self.version += 1

    def parents(self, proper=True):
        """{(dim, tag): number of bound entities one dimension up that contain it}.

        With `proper`, only entities that it bounds count; otherwise also those that
        hold it INTERNAL (a cut face inside a solid, a junction edge inside a face).
        """
        if self._parents is None or self._parents[0] != self.version:
            proper_counts, all_counts = {}, {}
            for dim in (1, 2, 3):
                lower = self.index[dim - 1]
                for shape in self.shapes[dim].values():
                    held, bounding = set(), set()
                    for child in _direct(shape, internal=True):
                        tag = lower.get(child)
                        if tag is not None:
                            held.add(tag)
                            if child.Orientation() in (TopAbs_FORWARD, TopAbs_REVERSED):
                                bounding.add(tag)
                    for tag in held:
                        all_counts[(dim - 1, tag)] = all_counts.get((dim - 1, tag), 0) + 1
                    for tag in bounding:
                        proper_counts[(dim - 1, tag)] = proper_counts.get((dim - 1, tag), 0) + 1
            self._parents = (self.version, proper_counts, all_counts)
        return self._parents[1 if proper else 2]

    def children(self, dim, tag):
        """(dim - 1, tag) of everything a bound entity holds, INTERNAL parts included."""
        if not dim:
            return set()
        lower = self.index[dim - 1]
        return {(dim - 1, t) for t in (lower.get(c) for c in _direct(self.shapes[dim][tag], internal=True)) if t is not None}

    def remove_many(self, entities, recursive=False, protect=frozenset()):
        """Unbind entities, highest dimension first; with `recursive`, also what lies below them that nothing else contains.

        An entity another bound entity still contains cannot be removed on its own
        (as in Gmsh, that includes the INTERNAL faces of a solid).
        """
        counts = dict(self.parents(proper=False))
        heap = [(-int(d), int(t)) for d, t in entities]
        heapq.heapify(heap)
        seen = set()
        while heap:
            negative, tag = heapq.heappop(heap)
            dim = -negative
            if (dim, tag) in seen or tag not in self.shapes[dim] or (dim, tag) in protect:
                continue
            seen.add((dim, tag))
            if counts.get((dim, tag)):
                continue
            children = self.children(dim, tag)
            self.unbind(dim, tag)
            for child in children:
                counts[child] = counts.get(child, 1) - 1
                if recursive:
                    heapq.heappush(heap, (-child[0], child[1]))

    def remove(self, dim, tag, recursive=False, protect=frozenset()):
        self.remove_many([(dim, tag)], recursive, protect)

    def top_level(self):
        """Entities no other bound entity contains, as (dim, tag), highest dimension first."""
        parents = self.parents()
        return [(dim, tag) for dim in (3, 2, 1, 0) for tag in sorted(self.shapes[dim]) if not parents.get((dim, tag))]

    def entities(self, dim=-1):
        dims = (0, 1, 2, 3) if dim < 0 else (dim,)
        return [(d, t) for d in dims for t in sorted(self.shapes[d])]


# --------------------------------------------------------------------------
# Face structure


def face_wires(face, lookup):
    """Wires of a face as lists of (edge tag, sense, edge shape) in connected order.

    The sense is +1 for an edge walked along its curve in the face's boundary
    and -1 against it (a seam appears twice, once each way). Edges OpenCASCADE
    marks INTERNAL or EXTERNAL are returned separately.
    """
    wires, internal = [], []
    # Senses are measured against the face's natural orientation (the one du x dv gives),
    # so a REVERSED face does not flip them: the face lies to the left of each edge walked that way.
    natural = -1 if face.Orientation() == TopAbs_REVERSED else 1
    for wire in _children(face):
        if wire.ShapeType() != TopAbs_WIRE:
            continue
        edges = []
        try:
            explorer = BRepTools_WireExplorer(TopoDS.Wire(wire), TopoDS.Face(face))
            while explorer.More():
                edges.append(explorer.Current())
                explorer.Next()
            walked = len(edges)
        except Exception:
            walked = 0
        everything = [e for e in _children(wire) if e.ShapeType() == TopAbs_EDGE]
        listed = [e for e in everything if e.Orientation() in (TopAbs_FORWARD, TopAbs_REVERSED)]
        if walked != len(listed):
            edges = listed  # an open or broken wire: keep the stored order
        internal.extend(e for e in everything if e.Orientation() not in (TopAbs_FORWARD, TopAbs_REVERSED))
        row = []
        for edge in edges:
            tag = lookup(edge)
            if tag is not None:
                row.append((tag, natural * (1 if edge.Orientation() == TopAbs_FORWARD else -1), edge))
        if row:
            wires.append(row)
    return wires, internal


def edge_vertices(edge):
    """(first, last) vertices of an edge along its curve, whatever its orientation."""
    from OCP.TopoDS import TopoDS_Vertex
    first, last = TopoDS_Vertex(), TopoDS_Vertex()
    TopExp.Vertices_s(TopoDS.Edge(edge), first, last, False)
    return first, last


# --------------------------------------------------------------------------
# The synchronized model


class Snapshot:
    """The model as of the last synchronize(): shapes by tag and everything derived from them."""

    def __init__(self, registry):
        self.shapes = [dict(items) for items in registry.shapes]
        self._index = [None] * 4
        self._wires = {}
        self._up = None
        self.cache = {}

    def index(self, dim):
        if self._index[dim] is None:
            index = ShapeIndex()
            for tag, shape in self.shapes[dim].items():
                index.put(shape, tag)
            self._index[dim] = index
        return self._index[dim]

    def shape(self, dim, tag):
        try:
            return self.shapes[dim][int(tag)]
        except (KeyError, IndexError):
            raise ValueError(f"Unknown model entity of dimension {dim} with tag {tag}") from None

    def wires(self, tag):
        if tag not in self._wires:
            self._wires[tag] = face_wires(self.shape(2, tag), self.index(1).get)
        return self._wires[tag]

    def down(self, dim, tag):
        """Tags one dimension below, in boundary order (a face lists each wire's edges in turn, a seam twice)."""
        key = ("down", dim, tag)
        if key not in self.cache:
            shape = self.shape(dim, tag)
            if dim == 1:
                first, last = edge_vertices(shape)
                found = [self.index(0).get(v) for v in (first, last) if not v.IsNull()]
                self.cache[key] = [t for t in found if t is not None]
            elif dim == 2:
                self.cache[key] = [t for wire in self.wires(tag)[0] for t, _, _ in wire]
            elif dim == 3:
                self.cache[key] = sorted({self.index(2).get(f) for f in _direct(shape)} - {None})
            else:
                self.cache[key] = []
        return self.cache[key]

    def up(self, dim, tag):
        """Sorted tags of the entities one dimension up that contain this one."""
        if self._up is None:
            up = {}
            for parent_dim in (1, 2, 3):
                for parent in self.shapes[parent_dim]:
                    for child in set(self.down(parent_dim, parent)):
                        up.setdefault((parent_dim - 1, child), set()).add(parent)
            self._up = up
        return sorted(self._up.get((dim, tag), ()))


class Model:
    """gmsh.model: queries about the synchronized shape."""

    def __init__(self, kernel):
        self.kernel = kernel
        self.snapshot = Snapshot(kernel.registry)
        self.occ = Occ(kernel)

    def add(self, name):
        """A new, empty model (the kernel holds one at a time)."""
        self.kernel.clear()

    # -- entities
    def getEntities(self, dim=-1):
        dims = (0, 1, 2, 3) if dim < 0 else (dim,)
        return [(d, t) for d in dims for t in sorted(self.snapshot.shapes[d])]

    def getType(self, dim, tag):
        shape = self.snapshot.shape(dim, tag)
        if dim == 3:
            return "Volume"
        if dim == 0:
            return "Point"
        key = ("type", dim, tag)
        cache = self.snapshot.cache
        if key not in cache:
            if dim == 2:
                cache[key] = _SURFACE_NAMES.get(self._surface(tag).GetType(), "Unknown")
            elif BRep_Tool.Degenerated_s(TopoDS.Edge(shape)):
                cache[key] = "Unknown"
            else:
                cache[key] = _CURVE_NAMES.get(self._curve(tag).GetType(), "Unknown")
        return cache[key]

    def _surface(self, tag):
        cache = self.snapshot.cache
        key = ("surface", tag)
        if key not in cache:
            cache[key] = BRepAdaptor_Surface(TopoDS.Face(self.snapshot.shape(2, tag)), False)
        return cache[key]

    def _curve(self, tag):
        cache = self.snapshot.cache
        key = ("curve", tag)
        if key not in cache:
            cache[key] = BRepAdaptor_Curve(TopoDS.Edge(self.snapshot.shape(1, tag)))
        return cache[key]

    def _degenerate(self, tag):
        return BRep_Tool.Degenerated_s(TopoDS.Edge(self.snapshot.shape(1, tag)))

    def _vertex_point(self, tag):
        return BRep_Tool.Pnt_s(TopoDS.Vertex(self.snapshot.shape(0, tag)))

    def getBoundingBox(self, dim, tag):
        """(xmin, ymin, zmin, xmax, ymax, zmax), padded by the shapes' tolerances as OpenCASCADE does."""
        if dim < 0:
            boxes = [self.getBoundingBox(d, t) for d, t in self.getEntities() if d == 3 or not self.snapshot.up(d, t)]
            if not boxes:
                return (0.0, 0.0, 0.0, 0.0, 0.0, 0.0)
            return tuple(min(b[i] for b in boxes) if i < 3 else max(b[i] for b in boxes) for i in range(6))
        key = ("box", dim, tag)
        cache = self.snapshot.cache
        if key not in cache:
            box = Bnd_Box()
            BRepBndLib.Add_s(self.snapshot.shape(dim, tag), box, False)
            lo, hi = box.CornerMin(), box.CornerMax()
            cache[key] = (lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z())
        return cache[key]

    def getAdjacencies(self, dim, tag):
        """(entities one dimension up, entities one dimension down) as tag arrays."""
        self.snapshot.shape(dim, tag)
        up = self.snapshot.up(dim, tag) if dim < 3 else []
        down = self.snapshot.down(dim, tag) if dim > 0 else []
        return np.array(up, dtype=np.int32), np.array(down, dtype=np.int32)

    def getBoundary(self, dimTags, combined=True, oriented=True, recursive=False):
        """Boundary entities of dimTags with their senses; a shared boundary traversed both ways cancels."""
        out = []
        for dim, tag in _tuple_tags(dimTags):
            counts = {}
            for sense, child in self._boundary_of(dim, tag):
                counts[child] = counts.get(child, 0) + sense
            out.append(counts)
        if combined:
            merged = {}
            for counts in out:
                for child, sense in counts.items():
                    merged[child] = merged.get(child, 0) + sense
            out = [merged]
        result = []
        for counts in out:
            for (child_dim, child), sense in sorted(counts.items()):
                if sense:
                    result.append((child_dim, (1 if sense > 0 else -1) * child if oriented and child_dim else child))
        if recursive and result:
            return self.getBoundary(result, combined, oriented, False)
        return result

    def _boundary_of(self, dim, tag):
        """[(sense, (child dim, child tag))] for one entity: a solid's faces, a face's edges, an edge's vertices."""
        shape = self.snapshot.shape(dim, tag)
        if dim == 3:
            index = self.snapshot.index(2)
            return [(1 if f.Orientation() == TopAbs_FORWARD else -1, (2, index.get(f))) for f in _direct(shape) if index.get(f) is not None]
        if dim == 2:
            return [(sense, (1, edge)) for wire in self.snapshot.wires(tag)[0] for edge, sense, _ in wire]
        if dim == 1:
            first, last = edge_vertices(shape)
            ends = [self.snapshot.index(0).get(v) for v in (first, last)]
            return [(1, (0, v)) for v in ends if v is not None] if ends[0] != ends[1] else []
        return []

    def getInternalEdges(self, face):
        """Edges lying inside a face without bounding it: junctions that stop partway across."""
        _, internal = self.snapshot.wires(int(face))
        found = {self.snapshot.index(1).get(e) for e in internal}
        return sorted(t for t in found if t is not None)

    # -- evaluation
    def getParametrizationBounds(self, dim, tag):
        key = ("bounds", dim, tag)
        cache = self.snapshot.cache
        if key not in cache:
            if dim == 1:
                if self._degenerate(tag):
                    lo, hi = BRep_Tool.Range_s(TopoDS.Edge(self.snapshot.shape(1, tag)))
                else:
                    curve = self._curve(tag)
                    lo, hi = curve.FirstParameter(), curve.LastParameter()
                cache[key] = (np.array([lo]), np.array([hi]))
            elif dim == 2:
                umin, umax, vmin, vmax = BRepTools.UVBounds_s(TopoDS.Face(self.snapshot.shape(2, tag)))
                cache[key] = (np.array([umin, vmin]), np.array([umax, vmax]))
            else:
                raise ValueError("Only curves and surfaces are parametrized.")
        return cache[key]

    def getValue(self, dim, tag, parametricCoord):
        if dim == 0:
            return np.array(_xyz(self._vertex_point(tag)))
        if dim == 1:
            params = _flat(parametricCoord)
            if self._degenerate(tag):
                first, _ = edge_vertices(self.snapshot.shape(1, tag))
                point = _xyz(BRep_Tool.Pnt_s(TopoDS.Vertex(first)))
                return np.tile(point, len(params))
            curve = self._curve(tag)
            return np.array([c for t in params for c in _xyz(curve.Value(float(t)))])
        if dim == 2:
            surface = self._surface(tag)
            return np.array([c for u, v in _pairs(parametricCoord, 2) for c in _xyz(surface.Value(float(u), float(v)))])
        raise ValueError("Only points, curves and surfaces can be evaluated.")

    def getDerivative(self, dim, tag, parametricCoord):
        """d/dt of a curve per parameter; (d/du, d/dv) of a surface per (u, v)."""
        out = []
        if dim == 1:
            if self._degenerate(tag):
                return np.zeros(3 * len(_flat(parametricCoord)))
            curve, point, vector = self._curve(tag), gp_Pnt(), gp_Vec()
            for t in _flat(parametricCoord):
                curve.D1(float(t), point, vector)
                out.extend([vector.X(), vector.Y(), vector.Z()])
        elif dim == 2:
            surface, point, du, dv = self._surface(tag), gp_Pnt(), gp_Vec(), gp_Vec()
            for u, v in _pairs(parametricCoord, 2):
                surface.D1(float(u), float(v), point, du, dv)
                out.extend([du.X(), du.Y(), du.Z(), dv.X(), dv.Y(), dv.Z()])
        else:
            raise ValueError("Only curves and surfaces have derivatives.")
        return np.array(out)

    def getNormal(self, tag, parametricCoord):
        """Unit normals of a face; they follow its orientation, so they point out of a solid it bounds."""
        face = self.snapshot.shape(2, tag)
        flip = -1.0 if face.Orientation() == TopAbs_REVERSED else 1.0
        surface, point, du, dv = self._surface(tag), gp_Pnt(), gp_Vec(), gp_Vec()
        lower, upper = self.getParametrizationBounds(2, tag)
        out = []
        for u, v in _pairs(parametricCoord, 2):
            u, v = float(u), float(v)
            surface.D1(u, v, point, du, dv)
            normal = np.cross([du.X(), du.Y(), du.Z()], [dv.X(), dv.Y(), dv.Z()])
            size = float(np.linalg.norm(normal))
            if size < 1e-14:
                # A pole or an apex: step a little way into the face.
                for step in (1e-6, 1e-4):
                    uu = u + step * (upper[0] - lower[0]) * (1 if u < (lower[0] + upper[0]) / 2 else -1)
                    vv = v + step * (upper[1] - lower[1]) * (1 if v < (lower[1] + upper[1]) / 2 else -1)
                    surface.D1(uu, vv, point, du, dv)
                    normal = np.cross([du.X(), du.Y(), du.Z()], [dv.X(), dv.Y(), dv.Z()])
                    size = float(np.linalg.norm(normal))
                    if size >= 1e-14:
                        break
            if size < 1e-14:
                raise ValueError(f"Face {tag} has no defined normal at ({u:g}, {v:g}).")
            out.extend(flip * normal / size)
        return np.array(out)

    def getCurvature(self, dim, tag, parametricCoord):
        """Curvature of a curve per parameter, or the mean curvature of a surface per (u, v)."""
        if dim == 1:
            curve = self._curve(tag)
            out = []
            for t in _flat(parametricCoord):
                props = BRepLProp_CLProps(curve, float(t), 2, CONFUSION)
                out.append(props.Curvature() if props.IsTangentDefined() else 0.0)
            return np.array(out)
        k_max, k_min, _, _ = self.getPrincipalCurvatures(tag, parametricCoord)
        return (k_max + k_min) / 2

    def getPrincipalCurvatures(self, tag, parametricCoord):
        """(max curvature, min curvature, its direction, its direction) per (u, v), signed about the surface's own normal."""
        surface = self._surface(tag)
        k_max, k_min, d_max, d_min = [], [], [], []
        for u, v in _pairs(parametricCoord, 2):
            props = BRepLProp_SLProps(surface, float(u), float(v), 2, CONFUSION)
            first, second = gp_Dir(1, 0, 0), gp_Dir(0, 1, 0)
            if props.IsCurvatureDefined():
                k_max.append(props.MaxCurvature())
                k_min.append(props.MinCurvature())
                if not props.IsUmbilic():
                    props.CurvatureDirections(first, second)
                elif props.IsNormalDefined():
                    normal = props.Normal()
                    first = gp_Dir(normal.Crossed(gp_Dir(1, 0, 0) if abs(normal.X()) < 0.9 else gp_Dir(0, 1, 0)))
                    second = gp_Dir(normal.Crossed(first))
            else:
                k_max.append(0.0)
                k_min.append(0.0)
            d_max.extend(_xyz(first))
            d_min.extend(_xyz(second))
        return np.array(k_max), np.array(k_min), np.array(d_max), np.array(d_min)

    def _projector(self, tag):
        cache = self.snapshot.cache
        key = ("projector", tag)
        if key not in cache:
            face = TopoDS.Face(self.snapshot.shape(2, tag))
            surface = BRep_Tool.Surface_s(face)
            cache[key] = ShapeAnalysis_Surface(surface)
        return cache[key]

    def _periodic(self, tag):
        """[(parameter index, period, lower bound of the face)] for each periodic parameter of the face's surface."""
        surface = self._surface(tag)
        lower, _ = self.getParametrizationBounds(2, tag)
        out = []
        if surface.IsUPeriodic():
            out.append((0, surface.UPeriod(), lower[0]))
        if surface.IsVPeriodic():
            out.append((1, surface.VPeriod(), lower[1]))
        return out

    def _project(self, tag, point):
        """(u, v) of the nearest point of the face's whole surface, a periodic parameter wrapped into the face's own span."""
        uv = self._projector(tag).ValueOfUV(_point(point), 1e-9)
        u, v = uv.X(), uv.Y()
        values = [u, v]
        for index, period, lower in self._periodic(tag):
            values[index] -= period * math.floor((values[index] - lower + 1e-9) / period)
        return values

    def getParametrization(self, dim, tag, coord):
        """Parameters of the points nearest to `coord` on the whole curve or surface.

        Unlike Gmsh, a point past the face's own parameter range gets its true
        surface parameters instead of an arbitrary place on the face.
        """
        points = _pairs(coord, 3)
        if dim == 2:
            return np.array([c for p in points for c in self._project(tag, p)])
        if dim == 1:
            lo, hi = (float(v[0]) for v in self.getParametrizationBounds(1, tag))
            curve, out = self._curve(tag), []
            for p in points:
                target = _point(p)
                # Nearest of the interior extrema and the two ends.
                best = min((curve.Value(t).SquareDistance(target), t) for t in (lo, hi))
                extrema = Extrema_ExtPC(target, curve, lo, hi, 1e-10)
                if extrema.IsDone():
                    for number in range(1, extrema.NbExt() + 1):
                        best = min(best, (extrema.SquareDistance(number), extrema.Point(number).Parameter()))
                out.append(best[1])
            return np.array(out)
        raise ValueError("Only curves and surfaces are parametrized.")

    def getClosestPoint(self, dim, tag, coord):
        """(nearest points, their parameters) on the whole surface (not only the trimmed face) or curve."""
        if dim != 2:
            parameters = self.getParametrization(dim, tag, coord)
            return self.getValue(dim, tag, parameters), parameters
        parameters = self.getParametrization(2, tag, coord)
        return self.getValue(2, tag, parameters), parameters

    def isInside(self, dim, tag, coord, parametric=False):
        """Whether a point (or parameter pair) lies in the entity, its boundary included."""
        if dim == 3:
            classifier = self.snapshot.cache.get(("solid", tag))
            if classifier is None:
                classifier = BRepClass3d_SolidClassifier(self.snapshot.shape(3, tag))
                self.snapshot.cache[("solid", tag)] = classifier
            out = []
            for p in _pairs(coord, 3):
                classifier.Perform(_point(p), CONFUSION)
                out.append(classifier.State() in (TopAbs_IN, TopAbs_ON))
            return int(all(out)) if len(out) == 1 else int(all(out))
        if dim == 2:
            face = TopoDS.Face(self.snapshot.shape(2, tag))
            classifier = BRepClass_FaceClassifier()
            for u, v in (_pairs(coord, 2) if parametric else [self._project(tag, p) for p in _pairs(coord, 3)]):
                classifier.Perform(face, gp_Pnt2d(float(u), float(v)), 1e-9)
                if classifier.State() not in (TopAbs_IN, TopAbs_ON):
                    return 0
            return 1
        raise ValueError("Only solids and faces can classify points.")

    def addDiscreteEntity(self, *args, **kwargs):
        raise NotImplementedError("Discrete (mesh) entities need the Gmsh plugin.")


# --------------------------------------------------------------------------
# Edits to the live shape


class Occ:
    """gmsh.model.occ: build and change the shape. Queries here see the shape as it is now."""

    def __init__(self, kernel):
        self.kernel = kernel
        self.registry = kernel.registry

    def synchronize(self):
        self.kernel.model.snapshot = Snapshot(self.registry)

    def getEntities(self, dim=-1):
        return self.registry.entities(dim)

    def _shape(self, dim, tag):
        try:
            return self.registry.shapes[int(dim)][int(tag)]
        except (KeyError, IndexError):
            raise ValueError(f"Unknown OpenCASCADE entity of dimension {dim} with tag {tag}") from None

    def getMass(self, dim, tag):
        shape = self._shape(dim, tag)
        if dim == 0:
            return 0.0
        props = GProp_GProps()
        (BRepGProp.LinearProperties_s, BRepGProp.SurfaceProperties_s, BRepGProp.VolumeProperties_s)[dim - 1](shape, props)
        return float(props.Mass())

    def getCenterOfMass(self, dim, tag):
        shape = self._shape(dim, tag)
        if dim == 0:
            return tuple(_xyz(BRep_Tool.Pnt_s(TopoDS.Vertex(shape))))
        props = GProp_GProps()
        (BRepGProp.LinearProperties_s, BRepGProp.SurfaceProperties_s, BRepGProp.VolumeProperties_s)[dim - 1](shape, props)
        return tuple(_xyz(props.CentreOfMass()))

    def getBoundingBox(self, dim, tag):
        box = Bnd_Box()
        BRepBndLib.Add_s(self._shape(dim, tag), box, False)
        lo, hi = box.CornerMin(), box.CornerMax()
        return (lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z())

    def getCurveLoops(self, surfaceTag):
        """(loop tags, [edge tags of each loop]) of a face: unsigned, in connected order, a seam twice."""
        wires, _ = face_wires(self._shape(2, surfaceTag), self.registry.index[1].get)
        return np.arange(1, len(wires) + 1, dtype=np.int32), [np.array([t for t, _, _ in wire], dtype=np.int32) for wire in wires]

    # -- new shapes
    def _add(self, shape, tag=-1):
        return self.registry.bind_closure(shape, tag)

    def addPoint(self, x, y, z, meshSize=0.0, tag=-1):
        return self._add(BRepBuilderAPI_MakeVertex(_point(x, y, z)).Vertex(), tag)

    def addLine(self, startTag, endTag, tag=-1):
        a, b = TopoDS.Vertex(self._shape(0, startTag)), TopoDS.Vertex(self._shape(0, endTag))
        return self._add(BRepBuilderAPI_MakeEdge(a, b).Edge(), tag)

    def addCircle(self, x, y, z, r, tag=-1, angle1=0.0, angle2=2 * math.pi, zAxis=(), xAxis=()):
        direction = gp_Dir(*[float(v) for v in zAxis]) if len(zAxis) == 3 else gp_Dir(0, 0, 1)
        placement = gp_Ax2(_point(x, y, z), direction, gp_Dir(*[float(v) for v in xAxis])) if len(xAxis) == 3 else gp_Ax2(_point(x, y, z), direction)
        return self._add(BRepBuilderAPI_MakeEdge(gp_Circ(placement, float(r)), float(angle1), float(angle2)).Edge(), tag)

    def addCircleArc(self, startTag, centerTag, endTag, tag=-1, nx=0.0, ny=0.0, nz=0.0, center=True):
        start, end = TopoDS.Vertex(self._shape(0, startTag)), TopoDS.Vertex(self._shape(0, endTag))
        a, c, b = BRep_Tool.Pnt_s(start), BRep_Tool.Pnt_s(TopoDS.Vertex(self._shape(0, centerTag))), BRep_Tool.Pnt_s(end)
        arc = GC_MakeArcOfCircle(a, _point(*_mid_on_arc(a, c, b)), b)
        return self._add(BRepBuilderAPI_MakeEdge(arc.Value(), start, end).Edge(), tag)

    def addCurveLoop(self, curveTags, tag=-1):
        wire = BRepBuilderAPI_MakeWire()
        for signed in curveTags:
            edge = self._shape(1, abs(int(signed)))
            wire.Add(TopoDS.Edge(edge.Reversed() if int(signed) < 0 else edge))
        if not wire.IsDone():
            raise ValueError("The curves do not form a connected loop.")
        number = int(tag) if tag and tag > 0 else max(self.registry.wires, default=0) + 1
        self.registry.wires[number] = wire.Wire()
        return number

    def addPlaneSurface(self, wireTags, tag=-1):
        wires = [self.registry.wires[int(t)] for t in wireTags]
        maker = BRepBuilderAPI_MakeFace(wires[0], True)
        if not maker.IsDone():
            raise ValueError("The curve loop does not bound a plane.")
        for hole in wires[1:]:
            maker.Add(hole)
        fixer = ShapeFix_Face(maker.Face())
        fixer.Perform()
        return self._add(fixer.Face(), tag)

    def addRectangle(self, x, y, z, dx, dy, tag=-1, roundedRadius=0.0):
        x0, y0 = (x + min(dx, 0), y + min(dy, 0))
        face = BRepBuilderAPI_MakeFace(gp_Pln(_point(x, y, z), gp_Dir(0, 0, 1)), min(0.0, dx), max(0.0, dx), min(0.0, dy), max(0.0, dy)).Face()
        del x0, y0
        return self._add(face, tag)

    def addBox(self, x, y, z, dx, dy, dz, tag=-1):
        corner = _point(x + min(dx, 0), y + min(dy, 0), z + min(dz, 0))
        return self._add(BRepPrimAPI_MakeBox(corner, abs(float(dx)), abs(float(dy)), abs(float(dz))).Shape(), tag)

    def addCylinder(self, x, y, z, dx, dy, dz, r, tag=-1, angle=2 * math.pi):
        height = math.sqrt(dx * dx + dy * dy + dz * dz)
        axis = gp_Ax2(_point(x, y, z), gp_Dir(dx, dy, dz))
        return self._add(BRepPrimAPI_MakeCylinder(axis, float(r), height, float(angle)).Shape(), tag)

    def addCone(self, x, y, z, dx, dy, dz, r1, r2, tag=-1, angle=2 * math.pi):
        height = math.sqrt(dx * dx + dy * dy + dz * dz)
        axis = gp_Ax2(_point(x, y, z), gp_Dir(dx, dy, dz))
        return self._add(BRepPrimAPI_MakeCone(axis, float(r1), float(r2), height, float(angle)).Shape(), tag)

    def addSphere(self, xc, yc, zc, radius, tag=-1, angle1=-math.pi / 2, angle2=math.pi / 2, angle3=2 * math.pi):
        return self._add(BRepPrimAPI_MakeSphere(gp_Ax2(_point(xc, yc, zc), gp_Dir(0, 0, 1)), float(radius), float(angle1), float(angle2), float(angle3)).Shape(), tag)

    def addTorus(self, x, y, z, r1, r2, tag=-1, angle=2 * math.pi, zAxis=()):
        direction = gp_Dir(*[float(v) for v in zAxis]) if len(zAxis) == 3 else gp_Dir(0, 0, 1)
        return self._add(BRepPrimAPI_MakeTorus(gp_Ax2(_point(x, y, z), direction), float(r1), float(r2), float(angle)).Shape(), tag)

    # -- copying, moving, removing
    def copy(self, dimTags):
        out = []
        for dim, tag in _tuple_tags(dimTags):
            copy = BRepBuilderAPI_Copy(self._shape(dim, tag), True, False).Shape()
            out.append((dim, self._add(copy)))
        return out

    def remove(self, dimTags, recursive=False):
        self.registry.remove_many(_tuple_tags(dimTags), recursive)

    def _replace(self, dimTags, make):
        """Replace each entity by a transformed version of it under the same tag."""
        shapes = [(dim, tag, make(self._shape(dim, tag))) for dim, tag in _tuple_tags(dimTags)]
        self.registry.remove_many([(dim, tag) for dim, tag, _ in shapes], recursive=True)
        for dim, tag, moved in shapes:
            self.registry.bind_closure(moved, tag)

    def translate(self, dimTags, dx, dy, dz):
        transform = gp_Trsf()
        transform.SetTranslation(gp_Vec(float(dx), float(dy), float(dz)))
        self._replace(dimTags, lambda s: BRepBuilderAPI_Transform(s, transform, True).Shape())

    def rotate(self, dimTags, x, y, z, ax, ay, az, angle):
        transform = gp_Trsf()
        transform.SetRotation(gp_Ax1(_point(x, y, z), gp_Dir(ax, ay, az)), float(angle))
        self._replace(dimTags, lambda s: BRepBuilderAPI_Transform(s, transform, True).Shape())

    def dilate(self, dimTags, x, y, z, a, b, c):
        if a == b == c:
            transform = gp_Trsf()
            transform.SetScale(_point(x, y, z), float(a))
            self._replace(dimTags, lambda s: BRepBuilderAPI_Transform(s, transform, True).Shape())
            return
        self.affineTransform(dimTags, [a, 0, 0, x * (1 - a), 0, b, 0, y * (1 - b), 0, 0, c, z * (1 - c)])

    def affineTransform(self, dimTags, affineTransform):
        """Apply a 3 x 4 matrix (row-major, translation last in each row); a general map turns surfaces into B-splines."""
        m = [float(v) for v in affineTransform]
        transform = gp_GTrsf()
        transform.SetVectorialPart(gp_Mat(m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]))
        transform.SetTranslationPart(gp_XYZ(m[3], m[7], m[11]))
        self._replace(dimTags, lambda s: BRepBuilderAPI_GTransform(s, transform, True).Shape())

    def convertToNURBS(self, dimTags):
        self._replace(dimTags, lambda s: BRepBuilderAPI_NurbsConvert(s, True).Shape())

    def extrude(self, dimTags, dx, dy, dz, numElements=(), heights=(), recombine=False):
        """Sweep entities along a vector; returns, for each, its far end, the swept body, then the sides."""
        out = []
        for dim, tag in _tuple_tags(dimTags):
            base = self._shape(dim, tag)
            prism = BRepPrimAPI_MakePrism(base, gp_Vec(float(dx), float(dy), float(dz)), False, True)
            far, body = prism.LastShape(), prism.Shape()
            tags = [self._add(far), self._add(body)]
            out.extend([(dim, tags[0]), (dim + 1, tags[1])])
            for sub in _subshapes(base, dim - 1) if dim else [base]:
                for side in prism.Generated(sub):
                    side_tag = self.registry.find(side)
                    if side_tag is not None and (_dim(side), side_tag) not in out:
                        out.append((_dim(side), side_tag))
        return out

    # -- booleans
    def _run(self, name, make, objectDimTags, toolDimTags, removeObject, removeTool, unify=False):
        objects = [self._shape(d, t) for d, t in _tuple_tags(objectDimTags)]
        tools = [self._shape(d, t) for d, t in _tuple_tags(toolDimTags)]
        if not objects:
            raise ValueError(f"The {name} needs at least one object.")
        operation = make(objects, tools)
        operation.Build()
        if not operation.IsDone() or operation.Shape().IsNull():
            raise ValueError(f"OpenCASCADE could not complete the {name}. The geometry may overlap itself or touch only at a point.")
        result = operation.Shape()

        def images(s):
            """What an input became: its modified parts, itself when untouched, nothing when consumed."""
            changed = list(operation.Modified(s))
            return changed if changed else ([] if operation.IsDeleted(s) else [s])
        mapped = [images(s) for s in objects + tools]
        if unify:
            # A fuse merges coplanar faces and collinear edges the interfaces left behind.
            unifier = ShapeUpgrade_UnifySameDomain(result, True, True, True)
            unifier.Build()
            chain = unifier.History()
            result = unifier.Shape()

            def unified(shapes):
                out = []
                for piece in shapes:
                    if chain.IsRemoved(piece):
                        continue
                    again = list(chain.Modified(piece))
                    out.extend(again if again else [piece])
                return out
            mapped = [unified(m) for m in mapped]
        pieces = _pieces(result)
        if unify:
            # Solids a fuse joins are reported as consumed; they became the result piece they overlap.
            for number, (source, found) in enumerate(zip(objects + tools, mapped)):
                if not found and operation.IsDeleted(source) and _dim(source) is not None:
                    mapped[number] = [p for p in pieces if _dim(p) == _dim(source) and _boxes_meet(source, p)]
        # Take the inputs away first, keeping whatever the result still uses, so the new shapes can reuse their numbers.
        protect = set()
        for piece in pieces:
            for dim in range(_dim(piece) + 1):
                for sub in _subshapes(piece, dim):
                    tag = self.registry.find(sub)
                    if tag is not None:
                        protect.add((dim, tag))
        gone = [item for item, drop in zip(_tuple_tags(objectDimTags) + _tuple_tags(toolDimTags), [removeObject] * len(objects) + [removeTool] * len(tools)) if drop]
        self.registry.remove_many(gone, recursive=True, protect=protect)
        out = []
        for piece in pieces:
            out.append((_dim(piece), self._add(piece)))
        out_map = []
        for images_of in mapped:
            row = []
            for image in images_of:
                tag = self.registry.find(image)
                if tag is not None and (_dim(image), tag) not in row:
                    row.append((_dim(image), tag))
            out_map.append(row)
        seen = []
        for item in out:
            if item not in seen:
                seen.append(item)
        return seen, out_map

    @staticmethod
    def _arguments(shapes):
        arguments = _ShapeList()
        for shape in shapes:
            arguments.Append(shape)
        return arguments

    def _boolean(self, kind):
        def make(objects, tools):
            operation = kind()
            operation.SetArguments(self._arguments(objects))
            operation.SetTools(self._arguments(tools))
            operation.SetRunParallel(False)
            operation.SetNonDestructive(True)
            operation.SetToFillHistory(True)
            return operation
        return make

    def fragment(self, objectDimTags, toolDimTags, tag=-1, removeObject=True, removeTool=True):
        def make(objects, tools):
            operation = BRepAlgoAPI_BuilderAlgo()
            operation.SetArguments(self._arguments(objects + tools))
            operation.SetRunParallel(False)
            operation.SetNonDestructive(True)
            operation.SetToFillHistory(True)
            return operation
        return self._run("fragment", make, objectDimTags, toolDimTags, removeObject, removeTool)

    def fuse(self, objectDimTags, toolDimTags, tag=-1, removeObject=True, removeTool=True):
        return self._run("fuse", self._boolean(BRepAlgoAPI_Fuse), objectDimTags, toolDimTags, removeObject, removeTool, unify=True)

    def cut(self, objectDimTags, toolDimTags, tag=-1, removeObject=True, removeTool=True):
        return self._run("cut", self._boolean(BRepAlgoAPI_Cut), objectDimTags, toolDimTags, removeObject, removeTool)

    def intersect(self, objectDimTags, toolDimTags, tag=-1, removeObject=True, removeTool=True):
        return self._run("intersection", self._boolean(BRepAlgoAPI_Common), objectDimTags, toolDimTags, removeObject, removeTool)

    def defeature(self, volumeTags, surfaceTags, removeVolume=True):
        """Remove faces from solids, growing the neighbors over them; returns the new solids ([] when it fails)."""
        volumes = [self._shape(3, t) for t in volumeTags]
        faces = [self._shape(2, t) for t in surfaceTags]
        operation = BRepAlgoAPI_Defeaturing()
        operation.SetShape(_compound(volumes))
        operation.AddFacesToRemove(self._arguments(faces))
        operation.SetRunParallel(False)
        operation.SetToFillHistory(False)
        operation.Build()
        if not operation.IsDone() or operation.Shape().IsNull():
            return []
        pieces = [p for p in _pieces(operation.Shape()) if _dim(p) == 3]
        protect = set()
        for piece in pieces:
            for dim in range(4):
                if dim <= _dim(piece):
                    for sub in _subshapes(piece, dim):
                        tag = self.registry.find(sub)
                        if tag is not None:
                            protect.add((dim, tag))
        if removeVolume:
            self.registry.remove_many([(3, int(tag)) for tag in volumeTags], recursive=True, protect=protect)
        return [(3, self._add(piece)) for piece in pieces]

    def healShapes(self, dimTags=(), tolerance=1e-8, fixDegenerated=True, fixSmallEdges=True, fixSmallFaces=True, sewFaces=True, makeSolids=True):
        """Repair shapes (a clean one comes back equal); the repaired shapes replace the originals."""
        targets = _tuple_tags(dimTags) or [(d, t) for d, t in self.registry.top_level()]
        out = []
        shapes = [self._shape(d, t) for d, t in targets]
        healed = _heal(_compound(shapes), tolerance, fixDegenerated, fixSmallEdges, fixSmallFaces, sewFaces, makeSolids)
        pieces = _pieces(healed)
        protect = set()
        for piece in pieces:
            for dim in range(_dim(piece) + 1):
                for sub in _subshapes(piece, dim):
                    tag = self.registry.find(sub)
                    if tag is not None:
                        protect.add((dim, tag))
        self.registry.remove_many(targets, recursive=True, protect=protect)
        for piece in pieces:
            out.append((_dim(piece), self._add(piece)))
        return out

    # -- files
    def importShapes(self, fileName, highestDimOnly=True, format=""):
        return self.kernel.read(str(fileName), highestDimOnly)


def _boxes_meet(a, b):
    box_a, box_b = Bnd_Box(), Bnd_Box()
    BRepBndLib.Add_s(a, box_a, False)
    BRepBndLib.Add_s(b, box_b, False)
    return not box_a.IsOut(box_b)


def _mid_on_arc(a, c, b):
    """A point halfway round the arc from a to b about c (the shorter way)."""
    va, vb = np.array(_xyz(a)) - np.array(_xyz(c)), np.array(_xyz(b)) - np.array(_xyz(c))
    middle = va / (np.linalg.norm(va) or 1) + vb / (np.linalg.norm(vb) or 1)
    middle = middle / (np.linalg.norm(middle) or 1) * np.linalg.norm(va)
    return tuple(np.array(_xyz(c)) + middle)


def _heal(shape, tolerance, degenerated, small_edges, small_faces, sew, make_solids):
    """ShapeFix, then (optionally) the small-face fixer and sewing, on a copy: the result is a new shape."""
    fixer = ShapeFix_Shape(shape)
    fixer.SetPrecision(float(tolerance))
    fixer.SetMaxTolerance(float(tolerance))
    fixer.Perform()
    shape = fixer.Shape()
    if small_faces:
        small = ShapeFix_FixSmallFace()
        small.Init(shape)
        small.SetPrecision(float(tolerance))
        small.Perform()
        shape = small.FixShape()
    return shape


# --------------------------------------------------------------------------
# The module


class _Option:
    def __init__(self):
        self.numbers, self.strings = {}, {}

    def setNumber(self, name, value):
        self.numbers[name] = float(value)

    def getNumber(self, name):
        return self.numbers.get(name, 0.0)

    def setString(self, name, value):
        self.strings[name] = str(value)

    def getString(self, name):
        return self.strings.get(name, "")


class _Logger:
    def __init__(self):
        self.lines = []

    def start(self):
        self.lines = []

    def stop(self):
        pass

    def get(self):
        return list(self.lines)

    def write(self, message, level="info"):
        self.lines.append(f"{level.capitalize():8s}: {message}")

    def getLastError(self):
        errors = [line for line in self.lines if line.startswith("Error")]
        return errors[-1] if errors else ""


class Kernel:
    """The module object: what ``import gmsh`` provides, for the geometry subset."""

    def __init__(self):
        self.registry = Registry()
        self.option = _Option()
        self.logger = _Logger()
        self.model = Model(self)

    def initialize(self, argv=(), readConfigFiles=True, run=False, interruptible=True):
        self.clear()

    def finalize(self):
        self.clear()

    def clear(self):
        self.registry = Registry()
        self.model = Model(self)

    # -- files
    def read(self, path, highest_dim_only=True):
        """Read a STEP, IGES or BREP file and bind its shapes; returns the top-level (dim, tag) pairs."""
        suffix = Path(path).suffix.lower()
        if suffix in {".step", ".stp"}:
            reader = STEPControl_Reader()
        elif suffix in {".iges", ".igs"}:
            reader = IGESControl_Reader()
        elif suffix == ".brep":
            reader = None
        else:
            raise ValueError(f"Cannot read {suffix or 'this'} geometry. Use STEP, IGES or BREP.")
        if reader is None:
            shape = TopoDS_Shape()
            if not BRepTools.Read_s(shape, path, BRep_Builder()):
                raise ValueError("The BREP file could not be read.")
        else:
            if reader.ReadFile(path) != IFSelect_RetDone:
                raise ValueError("The CAD file could not be read. Check that it is a valid STEP or IGES file.")
            reader.TransferRoots()
            shape = reader.OneShape()
            if shape.IsNull():
                raise ValueError("The CAD file contains no solids or surfaces.")
        if not BRepCheck_Analyzer(shape).IsValid():
            fixer = ShapeFix_Shape(shape)
            fixer.Perform()
            if BRepCheck_Analyzer(fixer.Shape()).IsValid():
                shape = fixer.Shape()
        found = _pieces(shape)
        if highest_dim_only and found:
            top = max(_dim(p) for p in found)
            found = [p for p in found if _dim(p) == top]
        for dim in range(4):
            for sub in _subshapes(shape, dim):
                self.registry.bind(sub)
        self.logger.write(f"Importing shapes from {Path(path).name}")
        return [(_dim(p), self.registry.find(p)) for p in found]

    def write(self, path):
        """Write the top-level entities as BREP or STEP (a flat file of what the model holds)."""
        top = self.registry.top_level()
        compound = _compound([self.registry.shapes[d][t] for d, t in top])
        suffix = Path(path).suffix.lower()
        if suffix == ".brep":
            if not BRepTools.Write_s(compound, str(path), False, False, TopTools_FormatVersion_CURRENT):
                raise ValueError("The BREP file could not be written.")
        elif suffix in {".step", ".stp"}:
            writer = STEPControl_Writer()
            writer.Transfer(compound, STEPControl_AsIs)
            if writer.Write(str(path)) != IFSelect_RetDone:
                raise ValueError("The STEP file could not be written.")
        else:
            raise ValueError(f"Cannot write {suffix or 'this'} geometry. Use BREP or STEP.")

    def merge(self, path):
        if Path(path).suffix.lower() in {".stl", ".msh"}:
            raise ValueError("STL and mesh files need the Gmsh plugin.")
        self.read(str(path), False)
        self.model.occ.synchronize()

    # -- display tessellation
    def tessellate(self, faces, linear, angular):
        """{face tag: flat triangle coordinates, nine per triangle, wound so the normal points out}.

        Triangles come from OpenCASCADE's incremental mesher. They are for the
        viewport only; the triangulation is removed from the shapes again.
        """
        shapes = {tag: self.model.snapshot.shape(2, tag) for tag in faces}
        if not shapes:
            return {}
        compound = _compound(list(shapes.values()))
        BRepMesh_IncrementalMesh(compound, float(linear), False, float(angular), False)
        out = {}
        try:
            for tag, face in shapes.items():
                location = TopLoc_Location()
                triangulation = BRep_Tool.Triangulation_s(TopoDS.Face(face), location)
                triangles = []
                if triangulation is not None:
                    transform = location.Transformation()
                    nodes = [triangulation.Node(i).Transformed(transform) for i in range(1, triangulation.NbNodes() + 1)]
                    flip = face.Orientation() == TopAbs_REVERSED
                    for i in range(1, triangulation.NbTriangles() + 1):
                        a, b, c = triangulation.Triangle(i).Get()
                        if flip:
                            b, c = c, b
                        for n in (a, b, c):
                            point = nodes[n - 1]
                            triangles.extend((point.X(), point.Y(), point.Z()))
                out[tag] = triangles
        finally:
            BRepTools.Clean_s(compound)
        return out


def module():
    """A fresh kernel, the OpenCASCADE counterpart of ``import gmsh``."""
    return Kernel()
