"""Stress test: a large drawing (not shipped). python3 make_big.py out.dxf"""
import sys, random, ezdxf
random.seed(1)
doc = ezdxf.new("R2010"); msp = doc.modelspace()
for i in range(40): doc.layers.add(f"L{i:02d}", color=1 + i % 250)
blk = doc.blocks.new("SYM")
for k in range(12): blk.add_line((0, 0), (100 * (k % 3), 100 * (k // 3)))
blk.add_circle((50, 50), 40); blk.add_text("A1", height=20).set_placement((10, 10))
for i in range(150000):
    x, y = random.uniform(0, 200000), random.uniform(0, 120000)
    msp.add_line((x, y), (x + random.uniform(-800, 800), y + random.uniform(-800, 800)), dxfattribs={"layer": f"L{i % 40:02d}"})
for i in range(15000):
    msp.add_circle((random.uniform(0, 200000), random.uniform(0, 120000)), random.uniform(20, 400), dxfattribs={"layer": f"L{i % 40:02d}"})
for i in range(8000):
    msp.add_text(f"T{i}", height=random.uniform(50, 300), dxfattribs={"layer": f"L{i % 40:02d}"}).set_placement((random.uniform(0, 200000), random.uniform(0, 120000)))
for i in range(5000):
    msp.add_blockref("SYM", (random.uniform(0, 200000), random.uniform(0, 120000)), dxfattribs={"layer": f"L{i % 40:02d}", "rotation": random.uniform(0, 360)})
doc.saveas(sys.argv[1]); print("ok")
