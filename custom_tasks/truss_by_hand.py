"""Truss 7e97 (task 2.1) solved twice, the way a person would do it from the paper solution.

1. "On paper": geometry -> kinematic analysis -> reactions from ΣM / ΣY -> joint equilibrium
   (the method of joints, written as the 2·14 joint equations and solved at once).
2. "OpenSees written by hand from the paper": plain openseespy, no StructureClaw involved.

Every stage prints its intermediate result, so the stages can be used as benchmark checkpoints.
Run with StructureClaw's Python (has openseespy): ~/.structureclaw/.venv/Scripts/python.exe -I -X utf8 truss_by_hand.py
"""
import json
from pathlib import Path

import numpy as np

H, L = 3.2, 4.2
BOTTOM = ["A", "C", "D", "E", "F", "G", "B"]
TOP = ["H", "I", "J", "K", "L", "M", "N"]
LOADS = {"J": 36.0, "K": 56.0, "N": 46.0}   # kN, downward


def stage1_geometry():
    """Step 1 on paper: coordinates of all joints (top chord straight from 2h at the supports to 3h at K)."""
    xyz = {}
    for i, (b, t) in enumerate(zip(BOTTOM, TOP)):
        x = i * L
        xyz[b] = (x, 0.0)
        xyz[t] = (x, 2 * H + H * (1 - abs(x - 3 * L) / (3 * L)))
    return xyz


def stage2_topology():
    """Step 2 on paper: list the members (chords, posts, diagonals)."""
    bars = [(TOP[i], TOP[i + 1]) for i in range(6)]
    bars += [(BOTTOM[i], BOTTOM[i + 1]) for i in range(6)]
    bars += list(zip(BOTTOM, TOP))
    bars += [("A", "I"), ("I", "D"), ("D", "K"), ("K", "F"), ("F", "M"), ("M", "B")]
    return bars


def stage3_kinematics(xyz, bars):
    """Step 3: C = 2У check (bars + support links = 2 × joints) and full rank of the equilibrium matrix."""
    joints = list(xyz)
    unknowns = len(bars) + 3
    matrix = equilibrium_matrix(xyz, bars)
    return {"joints": len(joints), "bars": len(bars), "support_links": 3,
            "C_equals_2U": unknowns == 2 * len(joints), "rank": int(np.linalg.matrix_rank(matrix)),
            "geometrically_stable": int(np.linalg.matrix_rank(matrix)) == unknowns}


def stage4_reactions(xyz):
    """Step 4: ΣM_A = 0 -> V_B, ΣY = 0 -> V_A, ΣX = 0 -> H_A."""
    span = xyz["B"][0] - xyz["A"][0]
    v_b = sum(force * (xyz[node][0] - xyz["A"][0]) for node, force in LOADS.items()) / span
    v_a = sum(LOADS.values()) - v_b
    return {"V_A": v_a, "V_B": v_b, "H_A": 0.0, "sum_loads": sum(LOADS.values())}


def equilibrium_matrix(xyz, bars):
    """Rows: ΣX and ΣY at every joint. Columns: bar forces (tension +), then H_A, V_A, V_B."""
    joints = list(xyz)
    row = {j: 2 * k for k, j in enumerate(joints)}
    m = np.zeros((2 * len(joints), len(bars) + 3))
    for c, (a, b) in enumerate(bars):
        (xa, za), (xb, zb) = xyz[a], xyz[b]
        length = np.hypot(xb - xa, zb - za)
        cx, cz = (xb - xa) / length, (zb - za) / length
        m[row[a], c], m[row[a] + 1, c] = cx, cz        # bar pulls joint a towards b
        m[row[b], c], m[row[b] + 1, c] = -cx, -cz
    n = len(bars)
    m[row["A"], n] = 1.0       # H_A
    m[row["A"] + 1, n + 1] = 1.0   # V_A
    m[row["B"] + 1, n + 2] = 1.0   # V_B
    return m


def stage5_zero_bars(xyz, bars):
    """Step 5: zero-force members by inspection (unloaded joint with two non-collinear bars; or a bar
    meeting a straight line of two collinear bars at an unloaded joint). Done here by the classic rules."""
    zero = set()
    joints_bars = {j: [b for b in bars if j in b] for j in xyz}
    supported = {"A", "B"}
    for j, js in joints_bars.items():
        if j in LOADS or j in supported:
            continue
        if len(js) == 2:
            zero.update(js)
        if len(js) == 3:
            dirs = [unit(xyz, j, other(b, j)) for b in js]
            for k in range(3):
                p, q = dirs[(k + 1) % 3], dirs[(k + 2) % 3]
                if abs(p[0] * q[1] - p[1] * q[0]) < 1e-9:      # the other two are collinear
                    zero.add(js[k])
    return sorted("-".join(b) for b in zero)


def stage6_member_forces(xyz, bars):
    """Step 6: method of joints — all joint equations at once (equivalent to cutting joint by joint)."""
    m = equilibrium_matrix(xyz, bars)
    p = np.zeros(m.shape[0])
    joints = list(xyz)
    for node, force in LOADS.items():
        p[2 * joints.index(node) + 1] = force           # external load moved to the right-hand side
    x = np.linalg.solve(m[:, :], p) if m.shape[0] == m.shape[1] else np.linalg.lstsq(m, p, rcond=None)[0]
    forces = {"-".join(b): float(x[i]) for i, b in enumerate(bars)}
    residual = float(np.abs(m @ x - p).max())
    return forces, {"H_A": float(x[-3]), "V_A": float(x[-2]), "V_B": float(x[-1])}, residual


def other(bar, j):
    return bar[1] if bar[0] == j else bar[0]


def unit(xyz, a, b):
    (xa, za), (xb, zb) = xyz[a], xyz[b]
    length = np.hypot(xb - xa, zb - za)
    return ((xb - xa) / length, (zb - za) / length)


def opensees_from_paper(xyz, bars):
    """The same model typed into OpenSees by hand: 2-D, 2 DOF per node, truss elements."""
    import openseespy.opensees as ops
    ops.wipe()
    ops.model("basic", "-ndm", 2, "-ndf", 2)
    tag = {j: k + 1 for k, j in enumerate(xyz)}
    for j, (x, z) in xyz.items():
        ops.node(tag[j], x, z)
    ops.fix(tag["A"], 1, 1)          # pinned
    ops.fix(tag["B"], 0, 1)          # roller
    ops.uniaxialMaterial("Elastic", 1, 206e6)            # kN/m²
    for k, (a, b) in enumerate(bars, start=1):
        ops.element("Truss", k, tag[a], tag[b], 0.005, 1)
    ops.timeSeries("Linear", 1)
    ops.pattern("Plain", 1, 1)
    for node, force in LOADS.items():
        ops.load(tag[node], 0.0, -force)
    for cmd in (("constraints", "Plain"), ("numberer", "RCM"), ("system", "BandGeneral"), ("algorithm", "Linear")):
        getattr(ops, cmd[0])(cmd[1])
    ops.integrator("LoadControl", 1.0)
    ops.analysis("Static")
    ops.analyze(1)
    ops.reactions()
    forces = {"-".join(b): ops.eleResponse(k, "axialForce")[0] for k, b in enumerate(bars, start=1)}
    reactions = {"V_A": ops.nodeReaction(tag["A"], 2), "V_B": ops.nodeReaction(tag["B"], 2)}
    return forces, reactions


def main():
    xyz = stage1_geometry()
    bars = stage2_topology()
    kin = stage3_kinematics(xyz, bars)
    reac = stage4_reactions(xyz)
    zero = stage5_zero_bars(xyz, bars)
    forces, reac_joints, residual = stage6_member_forces(xyz, bars)
    os_forces, os_reac = opensees_from_paper(xyz, bars)

    print("1. geometry (top chord z):", {t: round(xyz[t][1], 4) for t in TOP})
    print("2. topology:", len(bars), "bars")
    print("3. kinematics:", kin)
    print("4. reactions (ΣM, ΣY):", {k: round(v, 4) for k, v in reac.items()})
    print("5. zero bars by inspection:", zero)
    print("6. joints method: residual", f"{residual:.1e}", "| reactions", {k: round(v, 4) for k, v in reac_joints.items()})
    worst = max(abs(forces[k] - os_forces[k]) for k in forces)
    print("   method of joints vs OpenSees-from-paper: max |ΔN| =", f"{worst:.2e}", "kN")
    print("   OpenSees reactions:", {k: round(v, 4) for k, v in os_reac.items()})
    for k in ("D-J", "J-K", "D-K", "D-E", "E-K"):
        print(f"   N {k}: joints {forces[k]:9.4f}  OpenSees {os_forces[k]:9.4f}")
    Path(__file__).with_name("truss_by_hand.json").write_text(json.dumps({
        "geometry": xyz, "bars": ["-".join(b) for b in bars], "kinematics": kin, "reactions": reac,
        "zero_bars": zero, "forces": forces, "opensees_forces": os_forces}, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
