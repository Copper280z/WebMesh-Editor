"""Move four RR mounting holes on the rover's prepared analysis sheets by +30 Y.
The original solid stays reference geometry; all other analysis surfaces are unchanged.
"""
from pathlib import Path
import sys,json,gzip,base64
ROOT=Path(__file__).resolve().parents[4];sys.path.insert(0,str(ROOT))
import cad_geom as G, cad_kernel as K
from OCP.BRepTools import BRepTools, BRepTools_ReShape
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_Transform
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Trsf,gp_Vec
out=Path(sys.argv[1] if len(sys.argv)>1 else '/tmp/selective-cad');out.mkdir(exist_ok=True)
p=json.loads(gzip.decompress((ROOT/'docs/design/validation/project-workspace/rover-remesh.webmesh.gz').read_bytes()))
d=next(e['data'] for e in p['cadParts']['entries'] if 'rover' in e['data']['filename'])
(out/'original.brep').write_bytes(base64.b64decode(d['prepared']['content']))
k=K.geometry_module();k.initialize();K.load(k,out/'original.brep')
before=K.topology(k);before['sheets']=d['prepared']['sheets']
(out/'before.json').write_text(json.dumps(before))
# Preserve the outer boundary and every nonselected inner wire exactly.
rr={521,522,524,525};face=k.registry.shapes[2][177].Oriented(G.TopAbs_FORWARD);shift=gp_Trsf();shift.SetTranslation(gp_Vec(0,30,0));moved=[]
for wire in G._children(face):
 edges=G._subshapes(wire,1)
 if any(k.registry.shapes[1][e].IsSame(edges[0]) for e in rr) if len(edges)==1 else False:
  w=TopoDS.Wire(BRepBuilderAPI_Transform(wire,shift,True).Shape());moved.append(w)
assert len(moved)==4
reshaper=BRepTools_ReShape()
for fid in [177,179]:
 original=k.registry.shapes[2][fid];f=TopoDS.Face(original.Oriented(G.TopAbs_FORWARD));outer=BRepTools.OuterWire_s(f)
 builder=BRepBuilderAPI_MakeFace(G.BRep_Tool.Surface_s(f),outer,True)
 for wire in G._children(f):
  if wire.IsSame(outer):continue
  edges=G._subshapes(wire,1)
  if len(edges)==1 and any(k.registry.shapes[1][e].IsSame(edges[0]) for e in rr):continue
  builder.Add(TopoDS.Wire(wire))
 for wire in moved:
  b=G.Bnd_Box();G.BRepBndLib.Add_s(wire,b);y=(b.CornerMin().Y()+b.CornerMax().Y())/2
  if (fid==177 and y<-43.5) or (fid==179 and y>-43.5):builder.Add(wire)
 fixer=G.ShapeFix_Face(builder.Face());fixer.Perform();revised=fixer.Face();revised.Orientation(original.Orientation());assert G.BRepCheck_Analyzer(revised).IsValid(), fid
 reshaper.Replace(original,revised)
compound=G._compound([k.registry.shapes[dim][tag] for dim,tag in k.registry.top_level()]);revised=reshaper.Apply(compound)
G.BRepTools.Write_s(revised,str(out/'moved-rr.brep'))
k2=K.geometry_module();k2.initialize();K.load(k2,out/'moved-rr.brep');after=K.topology(k2)
(out/'after.json').write_text(json.dumps(after))
print('Wrote',out,'faces',len(after['faces']),'edges',len(after['edges']))
