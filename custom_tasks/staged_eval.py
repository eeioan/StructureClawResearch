"""Stage-by-stage scoring of an agent run on the truss task (ru-truss-7e97), with partial credit.

Each paper stage is checked twice where possible:
  * DRAFT — what the agent understood (engineeringDraft returned by extract_draft_params);
  * MODEL — what the tool actually built and solved (model/result the judge received).
If the draft is right and the model is wrong, the stage is blamed on the tool, not the agent.
Mismatches in computed numbers become "перепроверить вручную" flags for a human.

Usage: python -I -X utf8 custom_tasks/staged_eval.py <run_name> [<run_name> ...]
Writes tries/<run_name>/STAGES.md and prints a summary.
"""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRIES = ROOT / "tries"
TRUTH = json.loads((Path(__file__).with_name("truss_by_hand.json")).read_text(encoding="utf-8"))
TOL_XY = 0.05          # m
TOL_N = 0.01           # 1 %
CONTROL = ["D-J", "J-K", "D-K", "D-E", "E-K"]
LOADS = {"J": 36.0, "K": 56.0, "N": 46.0}
# What the LLM must get right at each stage (the semantic question behind the code check).
QUESTIONS = {
    "classification": "Это ферма (шарнирные узлы, только продольные усилия)?",
    "geometry": "Где стоят узлы? Как меняется высота прямолинейного верхнего пояса между 2h на опоре и 3h в коньке?",
    "topology": "Какие узлы соединены стержнями — все 25, без лишних?",
    "supports": "Где опоры и какого они типа — и нет ли лишних?",
    "loads": "Какая сила, в каком узле, куда направлена; сумма 138 кН?",
    "kinematics": "Определима ли ферма (C = 2У) — можно ли её считать?",
    "reactions": "Сходится ли равновесие: Σ R = Σ F, ΣM_A = 0?",
    "member_forces": "Какие усилия в контрольных стержнях, со знаком?",
    "answer": "Совпадает ли сказанное в ответе с расчётом и с условием — без выдумок?",
}
# Only the blind baseline run is credited: the task text exactly as a user would give it.
# Coached and self-check variants are our diagnostics — written after we had already found the weak
# spot — so they are scored by steps for analysis but never credited.
BASELINE_SCENARIO = "ru-truss-7e97"
# Coached variants: the hint arrives exactly at the vulnerable step (top-chord heights).
HINT_LEVELS = {"ru-truss-7e97-coach1": 1, "ru-truss-7e97-coach2": 2}
# Diagnostic ranking: the less task-specific knowledge we handed the model, the more its result is
# worth. Finding on its own that the right numbers did not reach the tool beats being told the number.
AUTONOMY = {
    "ru-truss-7e97": 1.0,              # blind run
    "ru-truss-7e97-selfcheck": 0.9,    # generic "show your formulas, check yourself" — not about this task
    "ru-truss-7e97-selfcheck2": 0.75,  # generic procedure that says where to look (draft vs own numbers)
    "ru-truss-7e97-coach1": 0.6,       # after a failure: names the weak spot, no numbers
    "ru-truss-7e97-coach2": 0.4,       # after a failure: gives the formula, i.e. the answer
}
# Doubt or a found discrepancy — not a passed check ("Проверка: ... равновесие соблюдено" does not count).
SELF_FLAG = re.compile(r"(несоответств|расхожден|discrepanc|не равн|≠|не совпада|рекомендуется проверить|требует проверки|сомнен|recheck|mismatch|inconsisten|does not match|doesn\'t match)", re.I)
# a question to the user written in plain text instead of an ask_user_clarification call
TEXT_QUESTION = re.compile(r"(\*\*Вопрос|^\s*Вопрос\s*:|\bQuestion\s*:|подтвердите|уточните,|please confirm|could you (?:please )?confirm)", re.I | re.M)
NOTICE = re.compile(r"(\bcorrection\b|исправлени|\bnoticed\b|заметил)", re.I)   # CP0 only: agent spotted a slip
WEIGHTS = {"classification": 5, "geometry": 15, "topology": 15, "supports": 5, "loads": 10,
           "kinematics": 5, "reactions": 10, "member_forces": 20, "answer": 15}

sys.path.insert(0, str(TRIES))
import make_report as mr  # noqa: E402  (reuses the exchange parsing helpers)


# ------------------------------------------------------------------ extraction of agent artifacts
def load_run(run):
    rows = [json.loads(l) for l in (TRIES / run / "raw" / "llm_exchanges.jsonl").read_text(encoding="utf-8").splitlines() if l]
    result = json.loads((TRIES / run / "raw" / "benchmark_result.json").read_text(encoding="utf-8"))["scenarios"][0]
    agent_rows = [r for r in rows if mr.classify(r) == "agent"]
    tools = mr.tool_results(agent_rows)
    # DRAFT = what the LLM extractor produced (llmDraftPatch), before the tool merges it into
    # nextState — the merge itself can lose data (it keeps one load out of several).
    draft, merged, attempts = None, None, []
    for row in agent_rows:
        for call in mr.response_message(row)[0].get("tool_calls") or []:
            if call["function"]["name"] == "extract_draft_params":
                parsed = mr.parse_json_loose(tools.get(call["id"]) or "") or {}
                patch = mr.find_key(parsed.get("llmDraftPatch"), "engineeringDraft") or parsed.get("llmDraftPatch")
                state = mr.find_key(parsed.get("nextState"), "engineeringDraft")
                attempts.append(patch or {})
                if patch:
                    # Field-wise, like the fixed StructureClaw merge: a later turn that resends only
                    # nodes keeps the earlier members; empty values never overwrite.
                    prev = draft or {}
                    draft = {**prev, **{k: v for k, v in patch.items() if v and k != "topology"}}
                    topo = {**(prev.get("topology") or {}),
                            **{k: v for k, v in (patch.get("topology") or {}).items() if v}}
                    if topo:
                        draft["topology"] = topo
                if state:
                    merged = state
    user_turns = []
    for row in agent_rows:
        last_user = [m for m in row["request"]["messages"] if m.get("role") == "user"][-1]["content"]
        if not user_turns or user_turns[-1] != last_user:
            user_turns.append(last_user)
    extract_messages, asked_questions = [], []
    for row in agent_rows:
        for call in mr.response_message(row)[0].get("tool_calls") or []:
            args = mr.parse_json_loose(call["function"].get("arguments")) or {}
            if call["function"]["name"] == "extract_draft_params":
                extract_messages.append(str(args.get("message", "")))
            if call["function"]["name"] == "ask_user_clarification":
                asked_questions.append(str(args.get("question", "")))
    finals = [msg["content"] for msg in (mr.response_message(row)[0] for row in agent_rows)
              if not msg.get("tool_calls") and msg.get("content")]
    final = finals[-1] if finals else ""
    judge = [r for r in rows if r["channel"] == "https"]
    prompt = judge[-1]["request"]["messages"][-1]["content"] if judge else ""
    model = {k: mr.parse_json_loose(mr.judge_section(prompt, k) or "") for k in ("Nodes", "Elements")}
    loads_line = mr.judge_section(prompt, "Loads") or ""
    model["Loads"] = [mr.parse_json_loose(part) for part in loads_line.split("; ") if part.strip()]
    analysis = mr.parse_json_loose(mr.judge_section(prompt, "Analysis result") or "")
    scenario = json.loads((TRIES / run / "raw" / "scenario.json").read_text(encoding="utf-8"))
    task_text = scenario.get("message") or scenario["turns"][0]["message"]
    return {"result": result, "draft": draft, "merged": merged, "attempts": attempts, "model": model,
            "analysis": analysis, "final": final, "finals": finals, "task_text": task_text,
            "scenario_id": scenario["id"], "hint_level": hint_level(scenario["id"], user_turns), "asked_questions": asked_questions,
            "extract_messages": extract_messages, "agent_texts": [m for m in (mr.response_message(r)[0].get("content") for r in agent_rows) if m]}


ANSWER_MARK = "Отвечаю на твой вопрос"


def hint_level(scenario_id, user_turns):
    if scenario_id in HINT_LEVELS:
        return HINT_LEVELS[scenario_id]
    # self-check scenarios: the formula comes only as an answer to the agent's own question
    return 2 if any(ANSWER_MARK in t for t in user_turns) else 0


def truth_xyz():
    return {k: tuple(v) for k, v in TRUTH["geometry"].items()}


def near(a, b):
    return abs(a[0] - b[0]) <= TOL_XY and abs(a[1] - b[1]) <= TOL_XY


def match_nodes(nodes, coord_of):
    """Map truth joint name -> agent node id by coordinates."""
    out = {}
    for name, xz in truth_xyz().items():
        for n in nodes or []:
            c = coord_of(n)
            if c and near(c, xz):
                out[name] = n.get("id")
                break
    return out


def model_coord(n):
    return (float(n.get("x", 0)), float(n.get("z", 0)))


def draft_coord(n):
    # In 2-D X-Z the vertical axis is z; count y-height as wrong (Gemma's first attempt did that).
    return (float(n.get("x", 0)), float(n.get("z", 0)))


def ratio(a, b):
    return a / b if b else 0.0


# ------------------------------------------------------------------ stages
def evaluate(run):
    art = load_run(run)
    metrics = {m["metric"]: m for m in art["result"]["metrics"]}
    stages, flags = [], []

    def stage(key, title, paper, code, sclaw, draft_score, model_score, note, blame=""):
        stages.append({"key": key, "title": title, "paper": paper, "code": code, "sclaw": sclaw,
                       "draft": draft_score, "model": model_score, "note": note, "blame": blame,
                       "points": WEIGHTS[key] * (model_score if model_score is not None else 0)})

    # 1. classification
    ok = metrics.get("structural_type", {}).get("pass", False)
    stage("classification", "Понять, что это ферма", "Прочитать схему: шарнирные узлы, нагрузки в узлах",
          "`ops.model('basic','-ndm',2,'-ndf',2)`, элементы `Truss`", "`detect_structure_type` → truss",
          None, 1.0 if ok else 0.0, "тип определён" if ok else "тип не определён")

    # 2. geometry
    d_nodes = ((art["draft"] or {}).get("topology") or {}).get("nodes")
    m_nodes = art["model"]["Nodes"]
    d_match = match_nodes(d_nodes, draft_coord) if d_nodes else {}
    m_match = match_nodes(m_nodes, model_coord)
    wrong = [n for n in truth_xyz() if n not in m_match]
    d_score = ratio(len(d_match), 14) if d_nodes else 0.0
    m_score = ratio(len(m_match), 14)
    if wrong:
        flags.append("Геометрия: в модели нет узлов на местах " + ", ".join(
            f"{n} (x = {truth_xyz()[n][0]:.1f}; z = {truth_xyz()[n][1]:.3f})" for n in wrong)
            + " — пересчитать высоты верхнего пояса: 2h + h·(1 − |x − 3l| / 3l).")
    stage("geometry", "Координаты 14 узлов", "Высота на опорах 2h = 6,4 м, в коньке 3h = 9,6 м, пояс прямой → z = 6,4 / 7,467 / 8,533 / 9,6",
          "`ops.node(tag, x, z)` × 14", "черновик: `engineeringDraft.topology.nodes`; модель: `build_model`",
          d_score, m_score, f"черновик {len(d_match)}/14, модель {len(m_match)}/14" + ("" if d_nodes else " (явной топологии в черновике нет)"),
          blame=blame_of(d_score if d_nodes else None, m_score))

    # 3. topology
    truth_bars = [tuple(b.split("-")) for b in TRUTH["bars"]]

    def bars_found(elements, node_map):
        inv = {v: k for k, v in node_map.items()}
        have = set()
        for e in elements or []:
            ends = [inv.get(n) for n in (e.get("nodes") or [])[:2]]
            if None not in ends and len(ends) == 2:
                have.add(frozenset(ends))
        return [b for b in truth_bars if frozenset(b) in have]

    d_members = ((art["draft"] or {}).get("topology") or {}).get("members")
    d_bars = bars_found(d_members, d_match) if d_members else []
    m_bars = bars_found(art["model"]["Elements"], m_match)
    stage("topology", "25 стержней", "Пояса 6 + 6, стойки 7, раскосы A–I, I–D, D–K, K–F, F–M, M–B",
          "`ops.element('Truss', k, i, j, A, mat)` × 25", "черновик: `topology.members`; модель: элементы",
          ratio(len(d_bars), 25) if d_members else None, ratio(len(m_bars), 25),
          f"черновик {len(d_bars)}/25, модель {len(m_bars)}/25 (считаются только стержни между верно поставленными узлами)",
          blame=blame_of(ratio(len(d_bars), 25) if d_members else None, ratio(len(m_bars), 25)))

    # 4. supports
    sup = 0
    for n in m_nodes or []:
        r = n.get("restraints") or []
        c = model_coord(n)
        if near(c, truth_xyz()["A"]) and r[:3] == [True, True, True]:
            sup += 1
        if near(c, truth_xyz()["B"]) and r[:3] == [False, True, True]:
            sup += 1
    # In 2-D X-Z, uy is always fixed; a support means ux or uz is restrained.
    extra = [n.get("id") for n in m_nodes or []
             if (r := n.get("restraints") or [False] * 3) and (r[0] or r[2])
             and not near(model_coord(n), truth_xyz()["A"]) and not near(model_coord(n), truth_xyz()["B"])]
    stage("supports", "Опоры A и B", "A — неподвижный шарнир, B — подвижный; других опор нет", "`ops.fix(A,1,1)`, `ops.fix(B,0,1)`",
          "модель: `restraints`", None, max(0.0, (sup - len(extra)) / 2),
          f"{sup}/2 опоры верны" + (f"; лишние опоры: {', '.join(map(str, extra))}" if extra else ""))

    # 5. loads
    def loads_ok(loads):
        return sum(1 for node, f in LOADS.items()
                   if any(str(l.get("target", "")).split()[-1:] == [node]
                          for l in loads if abs(float(l.get("magnitude", 0)) - f) < 1e-6))

    d_ok = loads_ok((art["draft"] or {}).get("loads") or [])
    s_loads = (art["merged"] or {}).get("loads") or []
    s_ok = loads_ok(s_loads)
    if d_ok == 3 and s_ok < 3:
        flags.append(f"Нагрузки потеряны инструментом: LLM извлекла все 3 силы, а после слияния в черновик "
                     f"(`extract_draft_params` → nextState) осталось {len(s_loads)}: "
                     + ", ".join(f"{l.get('magnitude')} кН ({l.get('target')})" for l in s_loads) + ".")
    m_loads = [l for l in art["model"]["Loads"] if l]
    m_sum = -sum(float(l.get("fz", 0)) for l in m_loads)
    m_ok = sum(1 for node, f in LOADS.items()
               if any(l.get("node") == m_match.get(node) and abs(-float(l.get("fz", 0)) - f) < 1e-6 for l in m_loads))
    extra = len(m_loads) - m_ok
    if abs(m_sum - 138) > 1e-6:
        flags.append(f"Нагрузки: Σ нагрузок в модели {m_sum:g} кН, по условию 36 + 56 + 46 = 138 кН.")
    # Loads that sit on the draft's own node names were carried over correctly; if they still miss
    # the true positions, the cause is the node geometry (model), not the load handling (tool).
    by_name = sum(1 for node, f in LOADS.items()
                  if any(l.get("node") == node and abs(-float(l.get("fz", 0)) - f) < 1e-6 for l in m_loads))
    loads_blame = "модель (узлы не на своих местах)" if by_name == 3 and m_ok < 3 else blame_of(d_ok / 3, max(0.0, (m_ok - extra) / 3))
    stage("loads", "Узловые нагрузки", "F1 = 36 в J, F4 = 56 в K, F2 = 46 в N; Σ = 138 кН",
          "`ops.load(J,0,-36)`, `ops.load(K,0,-56)`, `ops.load(N,0,-46)`", "черновик: `engineeringDraft.loads`; модель: нагрузки",
          d_ok / 3, max(0.0, (m_ok - extra) / 3),
          f"LLM-черновик {d_ok}/3 верны; после слияния осталось {s_ok}/3; модель {m_ok}/3 на верных местах "
          f"({by_name}/3 на узлах с верными именами), лишних {extra}, Σ = {m_sum:g} кН",
          blame=loads_blame)

    # 6. kinematics (from the built model)
    nn, ne = len(m_nodes or []), len(art["model"]["Elements"] or [])
    links = sum(sum(1 for i in (0, 2) if (n.get("restraints") or [False] * 3)[i]) for n in m_nodes or [])
    kin_ok = ne + links == 2 * nn
    stage("kinematics", "Кинематический анализ", "C = 2У: 25 + 3 = 2 · 14 → статически определима, неизменяема",
          "ранг матрицы равновесия = 28", "не проверяется (нет шага)", None, 1.0 if kin_ok else 0.5,
          f"модель агента: {ne} + {links} {'=' if kin_ok else '≠'} 2 · {nn}")

    # 7. reactions
    reac = (art["analysis"] or {}).get("data", art["analysis"] or {}).get("reactions") if art["analysis"] else None
    reac = reac.get("values", reac) if isinstance(reac, dict) else None
    ra = rb = None
    for nid, v in (reac or {}).items():
        c = next((model_coord(n) for n in m_nodes or [] if n.get("id") == nid), None)
        if c and near(c, truth_xyz()["A"]):
            ra = v.get("fz")
        if c and near(c, truth_xyz()["B"]):
            rb = v.get("fz")
    r_score = sum(1 for got, exp in ((ra, 52.0), (rb, 86.0)) if got is not None and abs(got - exp) <= TOL_N * exp) / 2
    if ra is not None and rb is not None and abs((ra + rb) - m_sum) < 1e-3 and abs(m_sum - 138) > 1e-6:
        flags.append(f"Реакции: V_A = {ra:.2f}, V_B = {rb:.2f} кН согласованы с моделью агента (Σ = {ra + rb:.0f}), "
                     "но не с условием: по ΣM_A = 0 должно быть V_B = 86, V_A = 52 кН — пересчитать вручную.")
    stage("reactions", "Опорные реакции", "ΣM_A = 0 → V_B = (36·8,4 + 56·12,6 + 46·25,2)/25,2 = 86; ΣY → V_A = 52",
          "`ops.nodeReaction(A,2)`", "`run_analysis` → reactions", None, r_score,
          f"V_A = {fmt(ra)}, V_B = {fmt(rb)} кН (надо 52 и 86)")

    # 8. member forces (control members, from the solver artifact)
    forces = (art["analysis"] or {}).get("data", art["analysis"] or {}).get("forces") if art["analysis"] else None
    forces = forces.get("values", forces) if isinstance(forces, dict) else {}
    inv_el = {}
    for e in art["model"]["Elements"] or []:
        ends = {k for k, v in m_match.items() if v in (e.get("nodes") or [])}
        if len(ends) == 2:
            inv_el[frozenset(ends)] = e["id"]
    hits, rows = 0, []
    for name in CONTROL:
        exp = TRUTH["forces"][name]
        eid = inv_el.get(frozenset(name.split("-")))
        got = (forces.get(eid) or {}).get("axial") if eid else None
        good = got is not None and abs(got - exp) <= max(TOL_N * abs(exp), 0.05)
        hits += good
        rows.append(f"{name}: {fmt(got)} (надо {exp:.2f})")
    stage("member_forces", "Усилия в контрольных стержнях", "Метод вырезания узлов / сечений: D–J = −36, J–K = −52,81, D–K = −3,27, D–E = 52,5, E–K = 0",
          "`ops.eleResponse(k,'axialForce')`", "`run_analysis` → forces", None, hits / len(CONTROL), "; ".join(rows))

    # 9. answer: honesty (text = own artifact) and correctness (text = truth)
    claimed = parse_claims(art["final"])
    honest = correct = 0
    for name, val in claimed.items():
        exp = TRUTH["forces"][name]
        eid = inv_el.get(frozenset(name.split("-")))
        art_val = (forces.get(eid) or {}).get("axial") if eid else None
        if art_val is not None and abs(val - art_val) <= max(0.01 * abs(art_val), 0.05):
            honest += 1
        if abs(val - exp) <= max(0.01 * abs(exp), 0.05):
            correct += 1
        else:
            flags.append(f"Ответ: {name} = {val:g} кН, ручной расчёт даёт {exp:.2f} кН — перепроверить на калькуляторе.")
    noticed = bool(re.search(r"(сумм|sum)[^.\n]{0,80}(реакц|reaction)[^.\n]{0,80}(≠|не равн|провер|differ|mismatch|due to|указывает)", art["final"], re.I))
    stage("answer", "Ответ: реакции и усилия со знаками", "Выписать V_A, V_B и N в D–J, J–K, D–K, D–E, E–K",
          "`print(...)`", "финальный текст агента", None, ratio(correct, len(CONTROL)),
          f"названо {len(claimed)}/5; совпадают со своим расчётом {honest}/{len(claimed) or 0}; верны {correct}/5"
          + ("; агент заметил, что Σ реакций ≠ Σ нагрузок" if noticed else ""))
    score = sum(s["points"] for s in stages)
    final_score, rule = credit_rule(score, art)
    autonomy = AUTONOMY.get(art["scenario_id"], 1.0)
    return {"run": run, "stages": stages, "flags": flags, "final_score": final_score, "rule": rule,
            "autonomy": autonomy, "autonomy_score": score * autonomy,
            "formulas": checkpoint_formulas(art), "reading": checkpoint_after_extract(art), "checkpoint": checkpoint_after_build(art),
            "score": sum(s["points"] for s in stages), "max": sum(WEIGHTS.values()),
            "benchmark": f"{art['result']['passed']}/{art['result']['total']}",
            "model": json.loads((TRIES / run / "raw" / "benchmark_result.json").read_text(encoding="utf-8"))["run"]["models"]["primary"]["model"]}


def credit_rule(score, art):
    """Credited score = the blind baseline run only. A diagnostic run (coach / self-check) keeps its
    step score for analysis and gets no credited score. In the baseline, honestly flagging or asking
    about a problem the agent could not fix earns +5, kept below a solved task."""
    if art["scenario_id"] != BASELINE_SCENARIO:
        kind = f"подсказка уровня {art['hint_level']}" if art["hint_level"] else "доработанный промпт"
        return None, f"диагностический режим ({kind}) — балл по шагам только для разбора, в зачёт не идёт"
    if score >= 99.9:
        return score, "решено вслепую — полный зачётный балл"
    self_flag = bool(art["asked_questions"]) or any(SELF_FLAG.search(a or "") or TEXT_QUESTION.search(a or "") for a in art["finals"])
    if self_flag:
        return min(99.0, score + 5), "не решено, но модель сама отметила проблему: +5 за самоконтроль"
    return score, "не решено, проблему не заметила"


JUDGE_URL = "http://localhost:18435/v1/chat/completions"   # nothink proxy -> Ollama
JUDGE_MODEL = "gemma4:31b-cloud"


def checkpoint_after_build(art):
    """Checkpoint right after build_model: does the built model carry what the LLM draft said?
    Code decides pass/fail; on a mismatch an LLM judge only writes a hint for the human."""
    draft = art["draft"] or {}
    d_nodes = (draft.get("topology") or {}).get("nodes") or []
    d_members = (draft.get("topology") or {}).get("members") or []
    d_loads = [l for l in draft.get("loads") or [] if l.get("kind") in ("point", "nodal")]
    m_nodes, m_elems = art["model"]["Nodes"] or [], art["model"]["Elements"] or []
    m_loads = [l for l in art["model"]["Loads"] if l]
    facts = {
        "draft": {"nodes": len(d_nodes), "members": len(d_members), "loads": [f"{l.get('magnitude')} kN @ {l.get('target')}" for l in d_loads],
                  "load_sum": sum(float(l.get("magnitude", 0)) for l in d_loads)},
        "model": {"nodes": len(m_nodes), "elements": len(m_elems), "loads": [f"{-float(l.get('fz', 0)):g} kN @ {l.get('node')}" for l in m_loads],
                  "load_sum": -sum(float(l.get("fz", 0)) for l in m_loads)},
        "task": {"nodes": 14, "members": 25, "loads": ["36 kN @ J", "56 kN @ K", "46 kN @ N"], "load_sum": 138},
    }
    problems = []
    if d_nodes and len(d_nodes) != len(m_nodes):
        problems.append(f"draft has {len(d_nodes)} nodes, model has {len(m_nodes)}")
    if d_members and len(d_members) != len(m_elems):
        problems.append(f"draft has {len(d_members)} members, model has {len(m_elems)}")
    if abs(facts["draft"]["load_sum"] - facts["model"]["load_sum"]) > 1e-6 or len(d_loads) != len(m_loads):
        problems.append(f"draft loads {facts['draft']['loads']} (Σ {facts['draft']['load_sum']:g}) != model loads {facts['model']['loads']} (Σ {facts['model']['load_sum']:g})")
    if abs(facts["model"]["load_sum"] - 138) > 1e-6:
        problems.append(f"model load sum {facts['model']['load_sum']:g} kN != task 138 kN")
    result = {"pass": not problems, "problems": problems, "facts": facts, "judge": None}
    if problems:
        result["judge"] = ask_judge(
            "You review one checkpoint of a structural-engineering agent run: right after the model was built.\n"
            "Facts (task = ground truth from the problem statement; draft = what the LLM extracted; model = what the tool built):\n"
            f"{json.dumps(facts, ensure_ascii=False, indent=1)}\n"
            f"Mismatches found by code: {json.dumps(problems, ensure_ascii=False)}\n\n"
            "First reason step by step, then decide. Return JSON with keys in this order:\n"
            '{"reasoning": "...", "where": "llm-draft | tool-build | both", '
            '"hint_ru": "1-2 sentences in Russian telling a human what exactly to recheck by hand"}')
    return result


def agent_heights(texts):
    """Top-chord heights the agent states in its own words, e.g. 'I: (4.2, 7.4667)' or 'I = 7.467'."""
    # A node may be stated several times (a slip, then a correction; or a quote of the tool's draft).
    # CP0 asks "did the agent derive it itself", so a correct value anywhere counts; else the first one.
    # Formats seen in the logs: "I: (4.2, 7.4667)", "$I(4,2; 7,4667)$", "**I, L**: z = … = 7.4667 м",
    # "Узел I (над C, x=4.2): z = … = 7.4667 м", "Nodes I, M (at x=…): z = … = 7.467 m", "$I, M: 7,4667$ м",
    # "$H=6.4$, $I=7.467$, …", "Z_I = 7,4667", "I: $\approx 7.467$". Member-force lines ("H–I: 0.0 кН") are skipped.
    truth = {n: truth_xyz()[n][1] for n in ("I", "J", "L", "M")}
    num = r"(\d+[.,]\d+)"
    tup = r"\(\s*\d+(?:[.,]\d+)?\s*[;,]\s*(?:0\s*[;,]\s*)?" + num + r"\s*\)"
    head = re.compile(r"^[\s*\-•$|]*(?:Узлы|Узел|Nodes|Node)?\s*\**\s*([IJLM](?:\s*,\s*[IJLM])*)\b\**\s*\$?\s*(\([^)]*\))?\s*\**\s*:(.*)$")
    stated = {n: [] for n in truth}
    for text in texts:
        for line in (text or "").splitlines():
            if re.search(r"кН|\bkN\b", line):
                continue
            m = head.match(line)
            labels, rest = (m.group(1), m.group(3)) if m else (None, None)
            if not m and re.match(r"^[\s*\-•]*(?:Узлы|Узел|Nodes|Node)\b", line) and ":" in line:
                # "Узлы **I** ($x=4,2$) и **M** ($x=21,0$): $z = … = 7,467$ м"
                prefix, rest = line.split(":", 1)
                labels = " ".join(re.findall(r"(?<![A-Za-z\\])[IJLM](?![A-Za-z])", re.sub(r"\([^)]*\)", "", prefix)))
            if labels:
                vals = (re.findall(tup, rest)[-1:] or re.findall(r"=\s*\$?\s*" + num, rest)[-1:]
                        or re.findall(r"(?:\\approx\s*)?" + num, rest)[:1])
                for node in re.findall(r"[IJLM]", labels):
                    stated[node] += [float(v.replace(",", ".")) for v in vals]
            for node, v in re.findall(r"(?<![–\-\w])([IJLM])\s*" + tup, line):
                stated[node].append(float(v.replace(",", ".")))
            for node, v in re.findall(r"(?<![–\-\w(])(?:[Zz]_?)?([IJLM])\s*=\s*" + num, line):
                stated[node].append(float(v.replace(",", ".")))
    found = {}
    for node, vals in stated.items():
        if vals:
            found[node] = next((v for v in vals if abs(v - truth[node]) <= TOL_XY), vals[0])
    return found


def checkpoint_formulas(art):
    """CP0 'formulas and hypotheses': did the agent derive the non-given values itself, are they right,
    does the tool's draft carry them, and did the agent cross-check or ask?"""
    truth = {n: round(truth_xyz()[n][1], 3) for n in ("I", "J", "L", "M")}
    own = agent_heights(art["agent_texts"])
    d_nodes = {str(n.get("id")): n for n in ((art["draft"] or {}).get("topology") or {}).get("nodes") or []}
    draft = {n: d_nodes[n].get("z") for n in truth if n in d_nodes}
    own_ok = bool(own) and all(abs(own.get(n, -1) - truth[n]) <= TOL_XY for n in truth if n in own) and len(own) >= 2
    draft_ok = len(draft) == 4 and all(abs(float(draft[n] or 0) - truth[n]) <= TOL_XY for n in truth)
    passed_own = any(any(f"{v:.2f}"[:4] in m.replace(",", ".") for v in own.values()) for m in art["extract_messages"]) if own else False
    noticed = any(SELF_FLAG.search(t or "") or NOTICE.search(t or "") for t in art["agent_texts"])
    if not own:
        verdict, blame = "агент не выписал выведенные высоты — проверить его рассуждение нельзя", "модель"
    elif not own_ok:
        verdict, blame = "агент сам посчитал высоты неверно", "модель"
    elif draft_ok:
        verdict, blame = "агент посчитал верно, и черновик совпадает с его расчётом", ""
    else:
        verdict = ("агент посчитал верно, но экстрактор инструмента записал в черновик другое, "
                   + ("а агент передал свои значения повторно" if passed_own
                      else "агент заметил расхождение, но не передал свои значения и не спросил — пошёл дальше" if noticed
                      else "а агент не сверил и пошёл дальше"))
        blame = "связка агент ↔ инструмент"
    return {"own": own, "truth": truth, "draft": draft, "own_ok": own_ok, "draft_ok": draft_ok,
            "passed_own": passed_own, "noticed": noticed, "asked": art["asked_questions"],
            "asked_text": [ln.strip() for t in art["agent_texts"] for ln in (t or "").splitlines() if TEXT_QUESTION.search(ln)], "verdict": verdict, "blame": blame}


def checkpoint_after_extract(art):
    """Checkpoint right after extract_draft_params ("reading the task"): does the LLM draft carry
    every input of the problem statement? Code decides per data group; the judge explains causes."""
    task = truth_xyz()
    draft = art["draft"] or {}
    d_nodes = {str(n.get("id")): n for n in (draft.get("topology") or {}).get("nodes") or []}
    groups = {}

    # 1. node coordinates (incl. top-chord heights) by node name
    wrong_nodes = []
    for name, (x, z) in task.items():
        n = d_nodes.get(name)
        if n is None:
            wrong_nodes.append({"node": name, "draft": None, "task": [round(x, 4), 0, round(z, 4)]})
        elif abs(float(n.get("x", 0)) - x) > TOL_XY or abs(float(n.get("z", 0)) - z) > TOL_XY or abs(float(n.get("y", 0))) > TOL_XY:
            wrong_nodes.append({"node": name, "draft": [n.get("x"), n.get("y"), n.get("z")], "task": [round(x, 4), 0, round(z, 4)]})
    groups["Узлы и координаты"] = {"pass": not wrong_nodes, "detail": f"{14 - len(wrong_nodes)}/14 узлов на месте", "wrong": wrong_nodes}
    tops = ["H", "I", "J", "K", "L", "M", "N"]
    d_heights = [d_nodes[t].get("z") if t in d_nodes else None for t in tops]
    t_heights = [round(task[t][1], 3) for t in tops]
    h_ok = all(h is not None and abs(float(h) - t) <= TOL_XY for h, t in zip(d_heights, t_heights))
    groups["Высоты верхнего пояса"] = {"pass": h_ok, "detail": f"черновик {d_heights} · условие {t_heights}"}

    # 2. members by end-node names
    t_bars = {frozenset(b.split("-")) for b in TRUTH["bars"]}
    d_bars = {frozenset(m.get("nodes", [])[:2]) for m in (draft.get("topology") or {}).get("members") or []}
    missing = sorted("-".join(sorted(b)) for b in t_bars - d_bars)
    extra = sorted("-".join(sorted(b)) for b in d_bars - t_bars)
    groups["Стержни"] = {"pass": not missing and not extra, "detail": f"{len(t_bars & d_bars)}/25 верно",
                         "wrong": {"missing": missing, "extra": extra}}

    # 3. supports
    def restr(name):
        return (d_nodes.get(name) or {}).get("restraints") or []
    extra_supports = sorted(n for n, node in d_nodes.items()
                            if n not in ("A", "B") and any((node.get("restraints") or [])[:3]))
    sup_ok = restr("A")[:3] == [True, True, True] and restr("B")[:3] == [False, True, True] and not extra_supports
    groups["Опоры"] = {"pass": sup_ok, "detail": f"A {restr('A')[:3]}, B {restr('B')[:3]} (надо A [T,T,T], B [F,T,T])"
                       + (f"; лишние опоры в узлах {', '.join(extra_supports)}" if extra_supports else "")}

    # 4. loads by node name and magnitude
    d_loads = {}
    for l in draft.get("loads") or []:
        node = str(l.get("target", "")).split()[-1:] or [""]
        d_loads[node[0]] = float(l.get("magnitude", 0))
    l_ok = d_loads == LOADS
    groups["Нагрузки"] = {"pass": l_ok, "detail": f"черновик {d_loads} · условие {LOADS}"}

    # 5. how many extraction attempts it took and what went wrong on the way
    notes = []
    for i, a in enumerate(art["attempts"], 1):
        nodes = (a.get("topology") or {}).get("nodes") or []
        if not nodes:
            notes.append(f"попытка {i}: явной топологии нет")
        elif any(abs(float(n.get("y", 0))) > TOL_XY for n in nodes):
            notes.append(f"попытка {i}: высоты записаны в координату y вместо z")
    groups["Попытки извлечения"] = {"pass": len(art["attempts"]) <= 1, "detail": f"{len(art['attempts'])} шт.; " + ("; ".join(notes) or "без ошибок")}

    result = {"pass": all(g["pass"] for k, g in groups.items() if k != "Попытки извлечения"), "groups": groups, "judge": None}
    if not result["pass"]:
        failed = {k: g for k, g in groups.items() if not g["pass"]}
        prompt = (
            "You review the 'reading the task' checkpoint of a structural-engineering agent: the LLM read a problem "
            "statement and produced a structured draft (nodes, members, supports, loads). Code compared the draft with "
            "the ground truth and found mismatches.\n\n"
            f"Problem statement (Russian):\n{art['task_text']}\n\n"
            f"Mismatches by data group (draft = LLM, task = ground truth):\n{json.dumps(failed, ensure_ascii=False, indent=1)}\n\n"
            "Explain the most likely cause of each mismatch (e.g. wrong interpolation formula, wrong axis, misread "
            "connectivity) and what the correct values are. First reason, then conclude. Return JSON with keys in this order:\n"
            '{"reasoning": "...", "causes_ru": ["one short cause per failed group, in Russian"], '
            '"hint_ru": "1-3 sentences in Russian: what exactly a human must recheck, with the correct numbers"}'
        )
        result["judge"] = ask_judge(prompt)
    return result


def ask_judge(prompt):
    import urllib.request
    body = {"model": JUDGE_MODEL, "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "user", "content": prompt}]}
    if os.environ.get("STAGED_EVAL_NO_JUDGE"):
        return None
    try:
        req = urllib.request.Request(JUDGE_URL, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        content = json.loads(urllib.request.urlopen(req, timeout=120).read())["choices"][0]["message"]["content"]
        return mr.parse_json_loose(content.strip().strip("`").removeprefix("json")) or {"raw": content}
    except Exception as exc:          # the judge is advisory; its failure must not hide the code verdict
        return {"error": str(exc)}


def blame_of(draft, model):
    if draft is None:
        return ""
    if draft >= 0.99 and model < 0.99:
        return "инструмент"
    if draft < 0.99:
        return "модель"
    return ""


def fmt(v):
    return "—" if v is None else f"{v:.2f}"


def parse_claims(text):
    """Find '<member> ... <number>' in the final answer for the five control members."""
    claims = {}
    for name in CONTROL:
        a, b = name.split("-")
        for line in text.splitlines():
            if not re.search(rf"(?<![A-Za-z]){a}\s*[–—-]?\s*{b}(?![A-Za-z])", line):
                continue
            rest = re.split(rf"{a}\s*[–—-]?\s*{b}", line, maxsplit=1)[1]
            rest = re.sub(r"\([^)]*\)", " ", rest)        # drop "(WD1)"-style element ids
            m = re.search(r"(?<![A-Za-z0-9_])([−-]?\d+(?:[.,]\d+)?)", rest)
            if m:
                claims[name] = float(m.group(1).replace("−", "-").replace(",", "."))
                break
    return claims


# ------------------------------------------------------------------ report
def render(ev):
    passed = ev["benchmark"].split("/")[0] == ev["benchmark"].split("/")[1]
    out = [f"# Поэтапная оценка: `{ev['run']}`", "",
           f"Модель: `{ev['model']}`. Бенчмарк (бинарный): {ev['benchmark']} → {'PASS' if passed else 'FAIL'}. "
           f"Поэтапно: {ev['score']:.1f} / {ev['max']}. **Зачётный балл: "
           + (f"{ev['final_score']:.1f} / {ev['max']}" if ev["final_score"] is not None else "—") + f"** — {ev['rule']}. "
           f"Балл самостоятельности: {ev['autonomy_score']:.1f} (по шагам × {ev['autonomy']:g}).", "",
           "| # | Этап | Смысловой вопрос к модели | Как на бумаге | Как в коде «с бумаги» | Где у StructureClaw | Черновик | Модель | Баллы | Чья ошибка | Детали |",
           "|---|---|---|---|---|---|---|---|---|---|---|"]
    for i, s in enumerate(ev["stages"], 1):
        d = "—" if s["draft"] is None else f"{100 * s['draft']:.0f} %"
        out.append(f"| {i} | {s['title']} | {QUESTIONS[s['key']]} | {s['paper']} | {s['code']} | {s['sclaw']} | {d} | {100 * s['model']:.0f} % | "
                   f"{s['points']:.1f}/{WEIGHTS[s['key']]} | {s['blame'] or '—'} | {s['note']} |")
    f = ev["formulas"]
    out += ["", "## Чекпоинт 0 — «Формулы и гипотезы»: что агент вывел сам и сверил ли с инструментом", "",
            f"**{f['verdict']}**" + (f" (ошибка: {f['blame']})" if f["blame"] else ""), "",
            "| Узел | Посчитал агент (в тексте) | Черновик инструмента | По условию |", "|---|---|---|---|"]
    out += [f"| {n} | {f['own'].get(n, '—')} | {f['draft'].get(n, '—')} | {f['truth'][n]} |" for n in f["truth"]]
    out += ["", f"Заметил ли агент расхождение с черновиком: {'да' if f['noticed'] else 'нет'}. "
            f"Передал ли свои значения в инструмент повторно: {'да' if f['passed_own'] else 'нет'}. "
            f"Спросил ли пользователя через `ask_user_clarification`: {'да — ' + '; '.join(q[:200] for q in f['asked']) if f['asked'] else 'нет'}. "
            f"Вопрос текстом в ответе (инструмент не вызван): {'да — ' + '; '.join(q[:200] for q in f['asked_text']) if f['asked_text'] else 'нет'}."]
    rd = ev["reading"]
    out += ["", "## Чекпоинт 1 — после `extract_draft_params`: чтение условия (черновик LLM ↔ условие)", "",
            f"**Решение кода: {'✅ все данные условия прочитаны верно' if rd['pass'] else '❌ данные условия прочитаны с ошибками'}**", "",
            "| Группа данных | Итог | Детали |", "|---|---|---|"]
    for name, g in rd["groups"].items():
        out.append(f"| {name} | {'✅' if g['pass'] else '❌'} | {g['detail']} |")
    wrong = rd["groups"]["Узлы и координаты"].get("wrong") or []
    if wrong:
        out += ["", "| Узел | В черновике (x, y, z) | По условию (x, y, z) |", "|---|---|---|"]
        out += [f"| {w['node']} | {w['draft']} | {w['task']} |" for w in wrong]
    if rd["judge"]:
        j = rd["judge"]
        out += ["", f"**Судья (`{JUDGE_MODEL}`, вердикт за кодом):**", ""]
        out += [f"- причина: {c}" for c in j.get("causes_ru") or []]
        out += ["", f"> {j.get('hint_ru') or j.get('error') or j.get('raw')}", "",
                mr.details("рассуждение судьи", str(j.get("reasoning", ""))) if j.get("reasoning") else ""]
    cp = ev["checkpoint"]
    out += ["", "## Чекпоинт 2 — после `build_model` (черновик LLM ↔ построенная модель)", "",
            f"**Решение кода: {'✅ модель соответствует черновику и условию' if cp['pass'] else '❌ расхождение'}**", ""]
    out += ["| | Узлы | Стержни | Нагрузки | Σ, кН |", "|---|---|---|---|---|"]
    for key, title in (("task", "Условие"), ("draft", "Черновик LLM"), ("model", "Модель (инструмент)")):
        f = cp["facts"][key]
        out.append(f"| {title} | {f.get('nodes')} | {f.get('members', f.get('elements'))} | {', '.join(f['loads'])} | {f['load_sum']:g} |")
    if cp["problems"]:
        out += ["", "Расхождения:", ""] + [f"- {p}" for p in cp["problems"]]
    if cp["judge"]:
        j = cp["judge"]
        out += ["", f"**Судья (`{JUDGE_MODEL}`, только подсказка, вердикт за кодом):** где ошибка — `{j.get('where', '?')}`", "",
                f"> {j.get('hint_ru') or j.get('error') or j.get('raw')}", "",
                mr.details("рассуждение судьи", str(j.get("reasoning", ""))) if j.get("reasoning") else ""]
    out += ["", "## Что перепроверить человеку", ""] + [f"- ⚠️ {f}" for f in ev["flags"]] + [""]
    return "\n".join(out)


def main():
    # --header-only: rewrite just the summary line of an existing STAGES.md and keep its judge
    # explanations (used when the scoring rule changes and the judge endpoint is not running).
    header_only = "--header-only" in sys.argv
    if header_only:
        os.environ["STAGED_EVAL_NO_JUDGE"] = "1"
    for run in [a for a in sys.argv[1:] if a != "--header-only"]:
        ev = evaluate(run)
        path = TRIES / run / "STAGES.md"
        if header_only and path.exists():
            lines = path.read_text(encoding="utf-8").split("\n")
            lines[2] = render(ev).split("\n")[2]
            path.write_text("\n".join(lines), encoding="utf-8")
        else:
            path.write_text(render(ev), encoding="utf-8")
        final = f"{ev['final_score']:.1f}" if ev["final_score"] is not None else "—"
        print(f"{run}: {ev['score']:.1f}/{ev['max']} -> credited {final}  benchmark {ev['benchmark']} | {ev['rule']}")
        for s in ev["stages"]:
            print(f"   {s['title'][:34]:34s} draft={s['draft']} model={s['model']:.2f} pts={s['points']:.1f} {s['blame']} | {s['note'][:110]}")
        for f in ev["flags"]:
            print("   FLAG", f[:150])


if __name__ == "__main__":
    main()
