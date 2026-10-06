"""Builds samples/floorplan.dxf, the built-in sample drawing (needs ezdxf)."""
import sys
import ezdxf
from ezdxf.enums import TextEntityAlignment as A

doc = ezdxf.new("R2010", setup=True, units=4)  # millimetres
msp = doc.modelspace()
for name, color in [("A-WALL", 7), ("A-WALL-PATT", 252), ("A-DOOR", 2), ("A-GLAZ", 4), ("A-FURN", 8), ("A-FIXT", 6),
                    ("A-ANNO-TEXT", 3), ("A-ANNO-DIMS", 1), ("A-GRID", 253), ("A-TTLB", 7)]:
    doc.layers.add(name, color=color)

ds = doc.dimstyles.duplicate_entry("EZDXF", "PLAN")
ds.dxf.dimtxt = 2.5; ds.dxf.dimasz = 2.5; ds.dxf.dimscale = 60; ds.dxf.dimexo = 1.5; ds.dxf.dimexe = 1.25
ds.dxf.dimgap = 1; ds.dxf.dimdec = 0; ds.dxf.dimlfac = 1; ds.dxf.dimtad = 1; ds.dxf.dimblk = "ARCHTICK"

W, H, T = 12000, 9000, 250          # outer size and wall thickness
def rect(x0, y0, x1, y1, layer, **kw):
    return msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": layer, **kw})

# --- Walls (outer ring + interior walls) with ANSI31 hatch ---
outer = [(0, 0), (W, 0), (W, H), (0, H)]
inner = [(T, T), (W - T, T), (W - T, H - T), (T, H - T)]
msp.add_lwpolyline(outer, close=True, dxfattribs={"layer": "A-WALL"})
msp.add_lwpolyline(inner, close=True, dxfattribs={"layer": "A-WALL"})
h = msp.add_hatch(dxfattribs={"layer": "A-WALL-PATT"})
h.set_pattern_fill("ANSI31", scale=25)
h.paths.add_polyline_path(outer, is_closed=True); h.paths.add_polyline_path(inner, is_closed=True)
t2 = 120
interior = [(5200, T, 5200 + t2, 5200), (T, 5200, 3600, 5200 + t2), (4500, 5200, W - T, 5200 + t2), (8400, 5200 + t2, 8400 + t2, H - T)]
for x0, y0, x1, y1 in interior:
    rect(x0, y0, x1, y1, "A-WALL")
    hh = msp.add_hatch(color=252, dxfattribs={"layer": "A-WALL-PATT"}); hh.paths.add_polyline_path([(x0, y0), (x1, y0), (x1, y1), (x0, y1)])

# --- Blocks ---
door = doc.blocks.new("DOOR-900")
door.add_line((0, 0), (0, 900)); door.add_arc((0, 0), 900, 0, 90); door.add_line((0, 0), (40, 0))
win = doc.blocks.new("WIN-1500")
for y in (0, 80, 170, 250): win.add_line((0, y), (1500, y), dxfattribs={"color": 0})
win.add_line((0, 0), (0, 250)); win.add_line((1500, 0), (1500, 250))
bed = doc.blocks.new("BED-Q")
bed.add_lwpolyline([(0, 0), (1600, 0), (1600, 2000), (0, 2000)], close=True)
bed.add_lwpolyline([(150, 1600), (750, 1600), (750, 1900), (150, 1900)], close=True)
bed.add_lwpolyline([(850, 1600), (1450, 1600), (1450, 1900), (850, 1900)], close=True)
bed.add_line((0, 1450), (1600, 1450))
sofa = doc.blocks.new("SOFA-3")
sofa.add_lwpolyline([(0, 0), (2200, 0), (2200, 900), (0, 900)], close=True)
sofa.add_lwpolyline([(200, 0), (2000, 0), (2000, 700), (200, 700)], close=True)
for x in (200, 800, 1400): sofa.add_line((x, 0), (x, 700))
table = doc.blocks.new("TABLE-4")
table.add_circle((0, 0), 550)
for a in (0, 90, 180, 270):
    import math
    cx, cy = 820 * math.cos(math.radians(a)), 820 * math.sin(math.radians(a))
    table.add_lwpolyline([(cx - 220, cy - 220), (cx + 220, cy - 220), (cx + 220, cy + 220), (cx - 220, cy + 220)], close=True, dxfattribs={"color": 0})
toilet = doc.blocks.new("WC")
toilet.add_lwpolyline([(0, 0), (500, 0), (500, 180), (0, 180)], close=True)
toilet.add_ellipse((250, 450), major_axis=(0, 270), ratio=0.72)
tub = doc.blocks.new("TUB")
tub.add_lwpolyline([(0, 0), (1700, 0), (1700, 750), (0, 750)], close=True)
tub.add_lwpolyline([(80, 80, 0, 0, 0.0), (1620, 80), (1620, 670), (80, 670)], close=True)
tub.add_circle((1450, 375), 35)

def ins(name, x, y, layer, rot=0, sx=1, sy=1):
    msp.add_blockref(name, (x, y), dxfattribs={"layer": layer, "rotation": rot, "xscale": sx, "yscale": sy})

ins("DOOR-900", 1500, 0 + T, "A-DOOR")                         # front door
ins("DOOR-900", 5200 + t2, 3800, "A-DOOR", rot=0, sx=1)        # living -> bedroom
ins("DOOR-900", 2400, 5200 + t2, "A-DOOR", rot=0, sy=1)        # hall -> bath
ins("DOOR-900", 9400, 5200, "A-DOOR", rot=180, sx=-1)          # kitchen -> study
for x in (800, 3300): ins("WIN-1500", x, H - T, "A-GLAZ")
for x in (6200, 9300): ins("WIN-1500", x, 0, "A-GLAZ")
ins("WIN-1500", W - T, 1600, "A-GLAZ", rot=90, sy=-1)
ins("WIN-1500", 0 + T, 1800, "A-GLAZ", rot=90)
ins("BED-Q", 8600, 1000, "A-FURN")
ins("SOFA-3", 1200, 3600, "A-FURN", rot=0)
ins("TABLE-4", 3300, 1800, "A-FURN")
ins("WC", 600, H - T, "A-FIXT", rot=-90)
ins("TUB", 3500, H - T - 750, "A-FIXT")
# kitchen counter + sink + hob
msp.add_lwpolyline([(5600, H - T), (5600, H - T - 650), (8200, H - T - 650), (8200, H - T)], dxfattribs={"layer": "A-FIXT"})
rect(6000, H - T - 560, 6800, H - T - 120, "A-FIXT")
for cx, cy in ((7300, H - T - 220), (7700, H - T - 220), (7300, H - T - 520), (7700, H - T - 520)):
    msp.add_circle((cx, cy), 110, dxfattribs={"layer": "A-FIXT"})
# study desk with an arc-ended top (bulge)
msp.add_lwpolyline([(9000, H - T - 700, 0), (11000, H - T - 700, 0.4), (11000, H - T - 100, 0), (9000, H - T - 100, 0)], format="xyb", close=True, dxfattribs={"layer": "A-FURN"})
# a curved planter (spline) and a column (solid fill)
msp.add_spline([(-1800, 600), (-1300, 2600), (-1700, 4800), (-1100, 7400)], dxfattribs={"layer": "A-FURN", "color": 3})
sh = msp.add_hatch(color=7, dxfattribs={"layer": "A-WALL"}); sh.paths.add_polyline_path([(5200, 5200), (5520, 5200), (5520, 5520), (5200, 5520)])

# --- Grid ---
doc.linetypes.add("DASHED2", pattern=[15, 10, -5], description="Dashed")
for i, x in enumerate((0, 5260, W)):
    msp.add_line((x, -2600), (x, H + 800), dxfattribs={"layer": "A-GRID"})
    msp.add_circle((x, -3000), 400, dxfattribs={"layer": "A-GRID"})
    msp.add_text(str(i + 1), height=350, dxfattribs={"layer": "A-GRID"}).set_placement((x, -3000), align=A.MIDDLE_CENTER)

# --- Room labels ---
for name, area, x, y in [("LIVING", "22.4 m²", 2700, 2700), ("BEDROOM", "21.1 m²", 8600, 3600), ("BATH", "8.6 m²", 2100, 7200),
                         ("KITCHEN", "14.1 m²", 6900, 7000), ("STUDY", "9.4 m²", 10200, 6500)]:
    msp.add_text(name, height=280, dxfattribs={"layer": "A-ANNO-TEXT", "style": "OpenSans"}).set_placement((x, y), align=A.MIDDLE_CENTER)
    msp.add_text(area, height=180, dxfattribs={"layer": "A-ANNO-TEXT"}).set_placement((x, y - 380), align=A.MIDDLE_CENTER)
msp.add_mtext("Ground floor plan\\PScale 1:60 · all dimensions in mm", dxfattribs={"layer": "A-ANNO-TEXT", "char_height": 220, "insert": (0, H + 1500), "attachment_point": 7})

# --- Dimensions ---
for p1, p2, base, angle in [((0, 0), (W, 0), (0, -1500), 0), ((0, 0), (5260, 0), (0, -900), 0), ((5260, 0), (W, 0), (0, -900), 0),
                            ((W, 0), (W, H), (W + 1200, 0), 90), ((W, 0), (W, 5260), (W + 600, 0), 90)]:
    d = msp.add_linear_dim(base=base, p1=p1, p2=p2, angle=angle, dimstyle="PLAN", dxfattribs={"layer": "A-ANNO-DIMS"})
    d.render()
r = msp.add_radius_dim(center=(3300, 1800), radius=550, angle=45, dimstyle="PLAN", dxfattribs={"layer": "A-ANNO-DIMS"}); r.render()

# --- Title block ---
tb = (14600, -3600, 19600, -1200)
rect(*tb, "A-TTLB")
msp.add_line((14600, -2400), (19600, -2400), dxfattribs={"layer": "A-TTLB"})
msp.add_text("SAMPLE HOUSE", height=380, dxfattribs={"layer": "A-TTLB"}).set_placement((14800, -1900), align=A.LEFT)
msp.add_text("Drawing A-101 · Rev 2", height=220, dxfattribs={"layer": "A-TTLB"}).set_placement((14800, -3000), align=A.LEFT)
msp.add_text("DWG-Field sample", height=180, dxfattribs={"layer": "A-TTLB", "rotation": 0}).set_placement((19400, -3400), align=A.RIGHT)

doc.saveas(sys.argv[1] if len(sys.argv) > 1 else "samples/floorplan.dxf")
print("ok")
