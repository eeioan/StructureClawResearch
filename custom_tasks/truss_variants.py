"""Truss 7e97 through StructureClaw's own OpenSees runtime in four variants, to separate the
error sources: correct model; correct geometry + loads as the tool builds them; agent (gemma)
geometry + correct loads; agent (gemma) model as built.

Run: ~/.structureclaw/.venv/Scripts/python.exe -I -X utf8 custom_tasks/truss_variants.py
"""
import copy
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sclaw_opensees  # noqa: E402

truth = json.loads((HERE / "truth.json").read_text(encoding="utf-8"))["truss-7e97"]
base = truth["model"]
TRUE_LOADS = [{"type": "nodal", "node": "J", "fz": -36}, {"type": "nodal", "node": "K", "fz": -56},
              {"type": "nodal", "node": "N", "fz": -46}]


def with_loads(model, loads):
    m = copy.deepcopy(model)
    m["load_cases"] = [{"id": "LC1", "type": "other", "loads": loads}]
    return m


def gemma_model():
    run = HERE.parent / "tries" / "20261026-045511_ru-truss-7e97" / "raw" / "llm_exchanges.jsonl"
    rows = [json.loads(l) for l in run.read_text(encoding="utf-8").splitlines() if l]
    prompt = [r for r in rows if r["channel"] == "https"][-1]["request"]["messages"][-1]["content"]
    line = lambda t: re.search(rf"^{t}: (.*)$", prompt, re.M).group(1)
    m = copy.deepcopy(base)
    m["nodes"] = json.loads(line("Nodes"))
    m["elements"] = json.loads(line("Elements"))
    loads = [json.loads(p) for p in line("Loads").split("; ")]
    return m, [{"type": "nodal", "node": l["node"], "fz": l["fz"]} for l in loads]


def solve(model):
    r = sclaw_opensees.solve(model, "ULS")
    return r.get("data", r)


def by_xz(model, x, z):
    return next(n["id"] for n in model["nodes"] if abs(n["x"] - x) < 1e-6 and abs(n["z"] - z) < 1e-6)


def report(title, model, res):
    reac = res["reactions"]
    a, b = by_xz(model, 0, 0), by_xz(model, 25.2, 0)
    loads = -sum(l.get("fz", 0) for l in model["load_cases"][0]["loads"])
    row = [title, f"{loads:g}", f"{reac[a]['fz']:.2f}", f"{reac[b]['fz']:.2f}"]
    for na, nb in (("D", "J"), ("J", "K"), ("D", "K"), ("D", "E"), ("E", "K")):
        coord = {n["id"]: (n["x"], n["z"]) for n in base["nodes"]}
        try:
            ia, ib = by_xz(model, *coord[na]), by_xz(model, *coord[nb])
            eid = next(e["id"] for e in model["elements"] if set(e["nodes"]) == {ia, ib})
            row.append(f"{res['forces'][eid]['axial']:.2f}")
        except StopIteration:
            row.append("нет стержня")
    return row


g_model, g_loads = gemma_model()
top_inner = ["I", "J", "K", "L", "M"]
variants = [
    ("1. Правильная модель (как в методичке)", with_loads(base, TRUE_LOADS)),
    ("2. Правильная геометрия, нагрузки как у инструмента (46 кН в I…M)", with_loads(base, [{"type": "nodal", "node": n, "fz": -46} for n in top_inner])),
    ("3. Геометрия Gemma, правильные нагрузки", with_loads(g_model, [{"type": "nodal", "node": by_xz(g_model, x, z), "fz": f}
                                                                     for x, z, f in ((8.4, 8.8, -36), (12.6, 9.6, -56), (25.2, 6.4, -46))])),
    ("4. Модель Gemma как построена (агент)", with_loads(g_model, g_loads)),
]
header = ["Вариант", "Σ нагрузок", "V_A", "V_B", "D–J", "J–K", "D–K", "D–E", "E–K"]
rows = [report(t, m, solve(m)) for t, m in variants]
print("| " + " | ".join(header) + " |"); print("|" + "---|" * len(header))
for r in rows:
    print("| " + " | ".join(r) + " |")
print("| Ручной расчёт (PDF) | 138 | 52 | 86 | −36 | −52,81 | −3,27 | 52,5 | 0 |")
