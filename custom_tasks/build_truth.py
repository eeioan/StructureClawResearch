"""Ground-truth models for two university problems, solved with StructureClaw's OpenSees.

Writes custom_tasks/truth.json: for each problem the StructureModel v2, the
OpenSees result (two runs, checked identical), equilibrium, and a comparison
with the hand solution from Zadachi/*.pdf.

Run with StructureClaw's Python: ~/.structureclaw/.venv/Scripts/python.exe -I -X utf8 build_truth.py
"""
import hashlib
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sclaw_opensees  # noqa: E402

COORD_2D = {"semantics": "global-z-up", "version": 1, "dimension": "2d", "plane": "xz",
            "dof_order": ["ux", "uy", "uz", "rx", "ry", "rz"]}
FIXED = [True, True, True, True, True, True]
PINNED = [True, True, True, False, False, False]    # ux, uz fixed (uy fixed: planar)
ROLLER = [False, True, True, False, False, False]   # uz fixed only


def model(nodes, elements, materials, sections, loads, description):
    return {
        "schema_version": "2.0.0",
        "unit_system": "SI",
        "coordinate_system": COORD_2D,
        "nodes": nodes,
        "elements": elements,
        "materials": materials,
        "sections": sections,
        "load_cases": [{"id": "LC1", "type": "other", "loads": loads}],
        "load_combinations": [{"id": "ULS", "factors": {"LC1": 1}}],
        "metadata": {"source": "ground-truth", "frameDimension": "2d", "coordinateSemantics": "global-z-up",
                     "coordinateContractVersion": 1, "description": description},
    }


# --------------------------------------------------------------------- truss (7e97…pdf, 2.1)
def truss():
    h, l = 3.2, 4.2
    xs = [i * l for i in range(7)]
    bottom = ["A", "C", "D", "E", "F", "G", "B"]
    top = ["H", "I", "J", "K", "L", "M", "N"]
    # top chord: 2h at the supports, 3h at the ridge K, straight in between
    top_z = [2 * h + h * (1 - abs(x - 3 * l) / (3 * l)) for x in xs]
    nodes = [{"id": n, "x": round(x, 6), "y": 0, "z": 0} for n, x in zip(bottom, xs)]
    nodes += [{"id": n, "x": round(x, 6), "y": 0, "z": round(z, 6)} for n, x, z in zip(top, xs, top_z)]
    nodes[0]["restraints"] = PINNED          # A
    nodes[6]["restraints"] = ROLLER          # B
    bars = []
    bars += [(top[i], top[i + 1]) for i in range(6)]              # top chord
    bars += [(bottom[i], bottom[i + 1]) for i in range(6)]        # bottom chord
    bars += [(bottom[i], top[i]) for i in range(7)]               # posts
    bars += [("A", "I"), ("I", "D"), ("D", "K"), ("K", "F"), ("F", "M"), ("M", "B")]  # diagonals
    elements = [{"id": f"{a}-{b}", "type": "truss", "nodes": [a, b], "material": "1", "section": "1"}
                for a, b in bars]
    loads = [{"type": "nodal", "node": "J", "fz": -36}, {"type": "nodal", "node": "K", "fz": -56},
             {"type": "nodal", "node": "N", "fz": -46}]
    hand = {  # from the solution sheet (kN); sign: + tension
        "reactions": {"A": 52, "B": 86},
        "forces": {"H-I": 0, "I-J": -52.81, "J-K": -52.81, "K-L": -40.63, "L-M": -40.63, "M-N": 0,
                   "A-C": 29.25, "C-D": 29.25, "D-E": 52.5, "E-F": 52.5, "F-G": 22.5, "G-B": 22.5,
                   "A-H": 0, "C-I": 0, "D-J": -36, "E-K": 0, "F-L": 0, "G-M": 0, "B-N": -46,
                   "A-I": -59.66, "I-D": 44.75, "D-K": -3.27, "K-F": -32.75, "F-M": 34.42, "M-B": -45.89},
    }
    m = model(nodes, elements,
              # StructureClaw's truss builder hard-codes this material and section (it ignores the
              # specification), so the scenario uses exactly these values; member forces do not depend on them.
              [{"id": "1", "name": "steel", "E": 205000, "nu": 0.3, "rho": 7850, "fy": 345}],
              [{"id": "1", "name": "TRUSS_ROD", "type": "rod", "properties": {"A": 0.01}}],
              loads, "Ферма 6 панелей, l = 4,2 м, h = 3,2 м; F1 = 36, F4 = 56, F2 = 46 кН")
    return m, hand


# --------------------------------------------------------------------- frame (152.4.pdf)
def frame():
    # Columns 5 m, spans 4 + 6 m, I_beam / I_col = 3. The right column is pinned to the beam and,
    # together with the horizontal link, acts as an immovable hinged support: it carries no bending
    # (hand solution: Z1, Z2 only, beam BC with a hinged far end). Modelled as a pin at C1.
    # Large areas make members practically inextensible, as assumed in the hand solution.
    nodes = [
        {"id": "A0", "x": 0, "y": 0, "z": 0, "restraints": FIXED},
        {"id": "B0", "x": 4, "y": 0, "z": 0, "restraints": FIXED},
        {"id": "A1", "x": 0, "y": 0, "z": 5},
        {"id": "Bm", "x": 4, "y": 0, "z": 2.5},
        {"id": "B1", "x": 4, "y": 0, "z": 5},
        {"id": "C1", "x": 10, "y": 0, "z": 5, "restraints": PINNED},
    ]
    elements = [
        {"id": "CA", "type": "column", "nodes": ["A0", "A1"], "material": "1", "section": "COL"},
        {"id": "CB1", "type": "column", "nodes": ["B0", "Bm"], "material": "1", "section": "COL"},
        {"id": "CB2", "type": "column", "nodes": ["Bm", "B1"], "material": "1", "section": "COL"},
        {"id": "AB", "type": "beam", "nodes": ["A1", "B1"], "material": "1", "section": "BEAM"},
        {"id": "BC", "type": "beam", "nodes": ["B1", "C1"], "material": "1", "section": "BEAM"},
    ]
    loads = [{"type": "distributed", "element": "AB", "wz": -5, "wy": 0, "reference_frame": "global"},
             {"type": "nodal", "node": "Bm", "fx": -3}]
    hand = {  # |M| at member ends from the final diagram, kN·m
        "moments": {"CA@A0": 0.9507, "CA@A1": 1.9014, "AB@A1": 1.9014, "AB@B1": 5.5016,
                    "BC@B1": 2.3651, "CB2@B1": 3.1364, "CB2@Bm": 1.5596, "CB1@B0": 1.2443},
        "rotations_times_i": {"Z1 (A1)": 0.4754, "Z2 (B1)": -0.3154},
    }
    m = model(nodes, elements,
              [{"id": "1", "name": "steel", "E": 206000, "nu": 0.3, "rho": 7850}],
              [{"id": "COL", "name": "I1", "type": "beam", "properties": {"A": 1.0, "Iy": 1e-4, "Iz": 1e-4, "J": 1e-4, "G": 79000}},
               {"id": "BEAM", "name": "I2", "type": "beam", "properties": {"A": 1.0, "Iy": 3e-4, "Iz": 3e-4, "J": 1e-4, "G": 79000}}],
              loads, "Рама 3 колонны 5 м, пролёты 4 + 6 м, I2/I1 = 3, q = 5 кН/м, F = 3 кН")
    return m, hand


def sha256(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def strip(res):
    return res.get("data", res)


def main():
    out = {}
    for key, (m, hand) in {"truss-7e97": truss(), "frame-152-4": frame()}.items():
        runs = [strip(sclaw_opensees.solve(m, "ULS")) for _ in range(2)]
        assert json.dumps(runs[0], sort_keys=True, default=str) == json.dumps(runs[1], sort_keys=True, default=str), key
        res = runs[0]
        print(f"\n===== {key}: {len(m['nodes'])} nodes, {len(m['elements'])} elements, mode {res.get('analysisMode')}")
        reac = res["reactions"]
        total = sum(v.get("fz", 0) for v in reac.values())
        print("reactions:", {k: {kk: round(vv, 4) for kk, vv in v.items()} for k, v in reac.items()}, "sum fz =", round(total, 6))
        cmp_rows = []
        if key.startswith("truss"):
            for nid, exp in hand["reactions"].items():
                cmp_rows.append((f"R_{nid}", exp, reac[nid]["fz"]))
            for eid, exp in hand["forces"].items():
                cmp_rows.append((f"N {eid}", exp, res["forces"][eid]["axial"]))
        else:
            for tag, exp in hand["moments"].items():
                eid, nid = tag.split("@")
                end = "n1" if m_end(m, eid) == nid else "n2"
                cmp_rows.append((f"|M| {tag}", exp, abs(res["forces"][eid][end]["M"])))
            ei_col = 206000e3 * 1e-4
            i = ei_col / 5
            cmp_rows.append(("Z1·i (A1)", hand["rotations_times_i"]["Z1 (A1)"], -res["displacements"]["A1"]["ry"] * i))
            cmp_rows.append(("Z2·i (B1)", hand["rotations_times_i"]["Z2 (B1)"], -res["displacements"]["B1"]["ry"] * i))
        worst = 0.0
        for name, exp, act in cmp_rows:
            diff = abs(act - exp)
            rel = diff / max(abs(exp), 1e-9) if abs(exp) > 1e-6 else diff
            worst = max(worst, rel if abs(exp) > 1e-6 else 0)
            print(f"  {name:12s} hand {exp:9.4f}  OpenSees {act:9.4f}  {'OK' if diff < max(0.01 * abs(exp), 0.02) else '<<< DIFF'}")
        print(f"  worst relative difference vs hand: {worst * 100:.3f} %")
        out[key] = {"model": m, "hand": hand, "result": res, "inputSha256": sha256(m),
                    "comparison": [{"quantity": n, "hand": e, "opensees": a} for n, e, a in cmp_rows]}
    (HERE / "truth.json").write_text(json.dumps(out, ensure_ascii=False, indent=1, default=str), encoding="utf-8")


def m_end(m, eid):
    return next(e for e in m["elements"] if e["id"] == eid)["nodes"][0]


if __name__ == "__main__":
    main()
