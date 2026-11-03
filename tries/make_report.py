"""Build a readable Markdown report for one StructureClaw benchmark run.

Inputs (all produced by ../run_bench.sh and ../ollama/nothink_proxy.py):
  bench_runs/<stamp>_<scenario>.meta.json   run window, model
  bench_runs/<stamp>_<scenario>.json        benchmark result (assertions)
  bench_runs/<stamp>_<scenario>.log         runner log
  bench_runs/proxy_dump/exchanges.jsonl     every LLM request/response

Output: tries/<stamp>_<scenario>/REPORT.md plus raw/ copies of the inputs.
The hand-written analysis lives in tries/notes/<scenario>.analysis.md and is
spliced into section 8 if present.

Usage: python -I -X utf8 tries/make_report.py [<stamp>_<scenario> ...]
       (no arguments: every run that has a .meta.json)
"""
import json
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "bench_runs"
TRIES = ROOT / "tries"
# custom_bench is a superset of the corpus (plus custom_tasks scenarios and truth).
BENCH = ROOT / "custom_bench" if (ROOT / "custom_bench").exists() else ROOT / "structureclaw" / "tests" / "llm-benchmark"
ANSI = re.compile(r"\x1b\[[0-9;]*m")

TOOLS_RU = {
    "detect_structure_type": "Определяет тип конструкции (балка, ферма, рама…) и выбирает «навык» (skill), который дальше ведёт задачу. Внутри делает отдельный LLM-вызов — «маршрутизатор».",
    "extract_draft_params": "Переводит текст задачи в структурированный черновик (engineeringDraft): геометрия, опоры, нагрузки, материалы. Внутри — отдельный LLM-вызов «экстрактор параметров». Сообщает, чего не хватает (criticalMissing).",
    "build_model": "Детерминированно (без LLM) собирает расчётную модель StructureModel v2 из черновика: узлы, элементы, сечения, загружения.",
    "validate_model": "Проверяет модель по схеме: связность, геометрия, нагрузки. Без LLM.",
    "run_analysis": "Запускает расчёт в выбранном движке (здесь OpenSees, статика). Возвращает перемещения, усилия, реакции.",
    "generate_report": "Собирает инженерный отчёт из результатов расчёта (шаблон, без LLM).",
    "ask_user_clarification": "Останавливает работу и задаёт пользователю уточняющий вопрос. В бенчмарке на этом прогон заканчивается.",
    "set_session_config": "Меняет настройки сессии: тип анализа, нормы, набор навыков.",
    "analyze_file": "Читает приложенный файл (CSV, Excel, PDF, DXF, изображение).",
}

METRICS_RU = {
    "execution": "Сценарий вообще отработал до конца (без падения и таймаута).",
    "structural_type": "Агент определил правильный тип конструкции (через detect_structure_type).",
    "skill_match": "Для работы выбран правильный навык (skill).",
    "has_model": "Существует расчётная модель с не меньшим, чем нужно, числом узлов и элементов.",
    "model_matches": "Модель совпадает с эталонной: геометрия, связи, опоры, сечения, нагрузки (допуск 5%).",
    "numerical_matches": "Результаты расчёта (перемещения, усилия, реакции) совпадают с замороженным эталонным прогоном OpenSees (допуск 1%).",
    "has_analysis": "Есть успешный результат расчёта.",
    "engine_match": "Расчёт выполнен именно тем движком, который просили (OpenSees).",
    "natural_language": "LLM-судья читает финальный ответ/отчёт и решает, выполнено ли текстовое требование задачи.",
    "has_interaction_questions": "Агент задал пользователю уместный уточняющий вопрос.",
    "no_bad_model": "Агент НЕ построил расчётную модель по небезопасным/неполным данным.",
    "should_not_analyze": "Агент НЕ запускал расчёт по небезопасным/неполным данным.",
    "toolCalls": "Справочно: сколько инструментов вызвал агент.",
    "inputTokens": "Справочно: входные токены основной модели.",
    "outputTokens": "Справочно: выходные токены основной модели.",
    "totalTokens": "Справочно: всего токенов.",
    "duration": "Справочно: длительность работы агента.",
}


# ---------------------------------------------------------------- helpers
def load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def parse_json_loose(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def clip(text, limit):
    text = "" if text is None else str(text)
    return text if len(text) <= limit else text[:limit] + f"\n… [обрезано, всего {len(text)} симв.]"


def code(text, lang="", limit=4000):
    # Four backticks: embedded prompts and agent reports contain ``` themselves.
    return f"````{lang}\n{clip(text, limit)}\n````"


def details(summary, body):
    return f"<details><summary>{summary}</summary>\n\n{body}\n\n</details>"


def pretty(obj, limit=4000):
    return code(json.dumps(obj, ensure_ascii=False, indent=2), "json", limit)


def mark(ok):
    return "✅" if ok else "❌"


def fmt_ts(epoch):
    return datetime.fromtimestamp(epoch).strftime("%H:%M:%S")


def num(v, digits=4):
    if v is None:
        return "—"
    return f"{v:.{digits}g}" if isinstance(v, (int, float)) else str(v)


# ---------------------------------------------------------------- data
def find_scenario(scenario_id):
    for path in (BENCH / "scenarios").rglob("*.json"):
        data = load_json(path)
        if data.get("id") == scenario_id:
            return data, path
    raise SystemExit(f"scenario {scenario_id} not found")


def ground_truth(gt_id):
    models = load_json(BENCH / "fixtures" / "ground-truth-models.json")
    model = next((m for m in models if m.get("id") == gt_id), None)
    solver = load_json(BENCH / "fixtures" / "opensees-ground-truth.json")["models"]
    truth = next((m for m in solver if m.get("modelId") == gt_id), None)
    return model, truth


def run_exchanges(meta):
    path = RUNS / "proxy_dump" / "exchanges.jsonl"
    rows = []
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if meta["t_start"] - 1 <= row["t_start"] <= meta["t_end"] + 1:
                rows.append(row)
    return sorted(rows, key=lambda r: r["t_start"])


def classify(row):
    req = row["request"] or {}
    if row["channel"] == "https":
        return "judge"
    if req.get("tools"):
        return "agent"
    first = str((req.get("messages") or [{}])[0].get("content", ""))
    if "路由器" in first or "router" in first.lower():
        return "router"
    if "参数提取" in first or "parameter extraction" in first.lower():
        return "extractor"
    return "nested"


def response_message(row):
    data = parse_json_loose(row["response"])
    if data and data.get("choices"):
        return data["choices"][0].get("message", {}), data.get("usage", {})
    # streamed (SSE) response: concatenate deltas
    content, usage = "", {}
    for line in row["response"].splitlines():
        if line.startswith("data: ") and line.strip() != "data: [DONE]":
            chunk = parse_json_loose(line[6:]) or {}
            for choice in chunk.get("choices") or []:
                content += choice.get("delta", {}).get("content") or ""
            usage = chunk.get("usage") or usage
    return {"content": content}, usage


def tool_results(agent_rows):
    results = {}
    for row in agent_rows:
        for msg in row["request"].get("messages", []):
            if msg.get("role") == "tool":
                results[msg.get("tool_call_id")] = msg.get("content")
    return results


def find_key(obj, key):
    if isinstance(obj, dict):
        if key in obj:
            return obj[key]
        for v in obj.values():
            found = find_key(v, key)
            if found is not None:
                return found
    elif isinstance(obj, list):
        for v in obj:
            found = find_key(v, key)
            if found is not None:
                return found
    return None


def judge_section(prompt, title):
    """Pull one 'Title: value' line out of the judge prompt."""
    m = re.search(rf"^{re.escape(title)}: (.*)$", prompt, re.M)
    return m.group(1) if m else None


# ---------------------------------------------------------------- report parts
def section_system(meta, result):
    run = result.get("run", {})
    models = run.get("models", {})
    rt = run.get("runtime", {})
    return f"""## 1. Что это за система и как устроен прогон

**StructureClaw** — open-source «AI-ассистент инженера-конструктора». Пользователь пишет задачу словами
(«посчитай раму…»), а LLM-агент сам доводит её до расчёта: определяет тип конструкции, извлекает
параметры, строит расчётную модель, запускает конечно-элементный решатель **OpenSees** и пишет отчёт.

Агент построен на **LangGraph** и работает циклом:

```
пользовательская задача
   └─► LLM (агент) решает, какой инструмент вызвать ──► инструмент выполняется ──► результат возвращается LLM
          ▲                                                                              │
          └──────────────────────────── следующий ход ◄──────────────────────────────────┘
   … пока LLM не ответит текстом без вызова инструмента (или не задаст вопрос пользователю)
```

Часть инструментов внутри себя тоже вызывает LLM (маршрутизатор типа конструкции, экстрактор
параметров) — в хронологии ниже они показаны как «вложенные вызовы». Модель, расчёт и отчёт строятся
детерминированным кодом, LLM только принимает решения и заполняет черновик параметров.

**StructureClaw-Bench** прогоняет агента на заранее подготовленном сценарии ровно **один раз**
(без повторов) и проверяет не текст, а **артефакты**: построенную модель, результаты решателя,
вызванные инструменты; текстовую часть ответа оценивает отдельный LLM-судья.

### Конфигурация этого прогона

| Параметр | Значение |
|---|---|
| Модель агента | `{models.get('primary', {}).get('model')}` ({'облако Ollama Cloud, 31B' if 'cloud' in str(models.get('primary', {}).get('model')) else 'локально, Ollama, Q4_K_M, 9B'}) |
| Модель судьи | `{models.get('judge', {}).get('model')}` (та же модель — важно для оценки `natural_language`) |
| Температура | {models.get('primary', {}).get('temperature')} |
| Режим «размышлений» (thinking) | выключен через локальный прокси (`ollama/nothink_proxy.py`): с ним один вложенный вызов шёл >2 мин и падал по таймауту 180 с |
| Решатель | OpenSees {rt.get('openSees', {}).get('engineVersion')} (`{rt.get('openSees', {}).get('runtimePackage')}`) |
| Ревизии | StructureClaw `{(run.get('revisions', {}).get('structureclaw', {}).get('revision') or '')[:8]}`, benchmark `{(run.get('revisions', {}).get('benchmark', {}).get('revision') or 'custom_bench (копия корпуса + свои сценарии)')[:44]}` (код StructureClaw не изменялся: dirty = {run.get('revisions', {}).get('structureclaw', {}).get('dirty')}) |
| Попыток | 1 (`maxRetries: 0`), таймаут сценария 30 мин |
"""


def section_given(scenario, notes, agent_rows):
    first = agent_rows[0]["request"] if agent_rows else {}
    msgs = first.get("messages", [])
    system_prompt = msgs[0]["content"] if msgs else ""
    user_msg = msgs[1]["content"] if len(msgs) > 1 else scenario.get("message", "")
    tools = first.get("tools", [])
    out = ["## 2. Что дано агенту", ""]

    turns = scenario.get("turns")
    task = scenario.get("message") or (turns[0]["message"] if turns else "")
    out += [
        "### 2.1. Текст задачи (как его получил агент)", "",
        f"**Оригинал** (язык сценария: `{scenario.get('locale')}`):", "", f"> {task}", "",
        f"**Перевод / смысл:** {notes.get('task_ru', '—')}", "",
    ]
    for i, turn in enumerate((turns or [])[1:], start=2):
        out += [f"**Ход {i} — сообщение пользователя (наставник):**", "", f"> {turn['message']}", ""]
    spec = scenario.get("engineeringSpecification")
    if spec:
        out += [
            "### 2.2. «Инженерная спецификация» — данные, которые выдаются сразу", "",
            "Бенчмарк добавляет к задаче блок `[工程说明]` / engineering specification: материалы, сечения,",
            "систему координат и сочетание нагрузок. Агенту прямо сказано, что это не заглушки и переспрашивать",
            "их не нужно, а геометрию, опоры и нагрузки он должен взять из текста задачи.", "",
            code(spec, "text", 3000), "",
        ]
    else:
        out += ["### 2.2. Инженерная спецификация", "",
                "Не выдаётся: в сценариях на уточнение у агента намеренно нет полного набора данных.", ""]
    out += [
        "Полное сообщение пользователя, которое ушло в модель:", "",
        details("показать", code(user_msg, "text", 4000)), "",
        "### 2.3. Системный промпт агента (суть)", "",
        "Системный промпт задаёт роль («ты — AI-ассистент StructureClaw»), список доступных навыков и",
        "**жёсткую процедуру работы** с инструментами:", "",
        "1. `detect_structure_type` (передать исходное сообщение без изменений) → дождаться ответа;",
        "2. `extract_draft_params`; если вернулся `criticalMissing` — `ask_user_clarification`;",
        "3. `build_model` → 4. `validate_model` → 5. `run_analysis`;",
        "6. (опционально) `run_code_check`; 7. `generate_report`.",
        "", "«Шаги 1–5 и 7 обязательны, не пропускай их». Отвечать пользователю — на языке сценария.", "",
        details(f"полный системный промпт ({len(system_prompt)} симв.)", code(system_prompt, "text", 12000)), "",
        "### 2.4. Инструменты, которые видит модель", "",
        "| Инструмент | Что делает | Параметры |", "|---|---|---|",
    ]
    for tool in tools:
        fn = tool["function"]
        params = ", ".join(fn.get("parameters", {}).get("properties", {}).keys()) or "—"
        out.append(f"| `{fn['name']}` | {TOOLS_RU.get(fn['name'], fn.get('description', '')[:200])} | {params} |")
    out += ["", f"Всего инструментов: {len(tools)}. Навыки (skills) — это пакеты подсказок и кода под тип конструкции; "
            "инструменты — то, что модель может реально вызвать.", ""]
    return "\n".join(out)


def section_expected(scenario, notes, gt_model, gt_truth):
    out = ["## 3. Какой должен быть результат", "", notes.get("expected_ru", ""), ""]
    if gt_model:
        model = gt_model["model"]
        out += [f"### 3.1. Эталонная модель `{gt_model['id']}`", "",
                f"Описание эталона: «{gt_model.get('description', '')}».", "",
                "| Узел | x, м | z, м | Опора (ux, uy, uz, rx, ry, rz) |", "|---|---|---|---|"]
        for n in model.get("nodes", []):
            restr = n.get("restraints")
            out.append(f"| {n['id']} | {n['x']} | {n['z']} | {restr if restr else 'свободный'} |")
        out += ["", "| Элемент | Тип | Узлы | Сечение |", "|---|---|---|---|"]
        for e in model.get("elements", []):
            out.append(f"| {e['id']} | {e.get('type')} | {' → '.join(e['nodes'])} | {e.get('section')} |")
        loads = [ld for lc in model.get("load_cases", []) for ld in lc.get("loads", [])]
        out += ["", "Нагрузки эталона:", "", pretty(loads, 1500), ""]
    if gt_truth:
        ver = gt_truth.get("verification", {})
        analytical = [c for a in ver.get("analytical", []) if a.get("applicable") for c in a.get("checks", [])]
        out += ["### 3.2. Эталонные числа", "",
                f"Эталон посчитан OpenSees {ver.get('runCount')} раза с разными настройками решателя, "
                f"сравнено {ver.get('comparedNumbers')} чисел, расхождение {ver.get('maxRelativeDifference')}. "
                "Проверено равновесие (сумма реакций = сумма нагрузок)."]
        eq = (ver.get("equilibrium") or [{}])[0]
        if eq:
            out.append(f"Внешняя сила {eq.get('externalForce')} кН, реакции {[round(x, 6) for x in eq.get('reactionForce', [])]} кН.")
        if analytical:
            seen = set()
            out += ["", "Аналитическая (ручная) проверка эталона:", "", "| Величина | По формуле | OpenSees |", "|---|---|---|"]
            for c in analytical:
                if c["name"] in seen:
                    continue
                seen.add(c["name"])
                out.append(f"| {c['name']} | {num(c['expected'], 6)} | {num(c['actual'], 6)} |")
        out.append("")
    return "\n".join(out)


def section_golden(notes, metrics):
    by_metric = {m["metric"]: m for m in metrics}
    out = ["## 4. Золотые шаги и чекпоинты", "",
           "Бенчмарк не хранит «золотую траекторию» явно — она следует из процедуры в системном промпте и из",
           "списка проверок (assertions) сценария. Ниже — шаги, которые должен пройти правильный агент, и то,",
           "какой проверкой бенчмарка закрыт каждый шаг.", "",
           "| # | Шаг | Чекпоинт: что должно быть верно после шага | Как проверяется | Итог |", "|---|---|---|---|---|"]
    for i, step in enumerate(notes.get("golden", []), 1):
        checks = step.get("metrics", [])
        if checks:
            verdict = " ".join(f"{mark(by_metric[m]['pass'])} `{m}`" for m in checks if m in by_metric) or "—"
        else:
            verdict = "не проверяется бенчмарком"
        out.append(f"| {i} | {step['step']} | {step['checkpoint']} | {step['how']} | {verdict} |")
    return "\n".join(out) + "\n"


def section_timeline(rows, results):
    out = ["## 5. Как выполнялся прогон — хронология", "",
           "Каждая строка — один запрос к модели. «Ход агента» — основная модель выбирает следующий инструмент;",
           "«вложенный вызов» — LLM-запрос изнутри инструмента; «судья» — оценка ответа после работы агента.", ""]
    t0 = rows[0]["t_start"] if rows else 0
    agent_turn = 0
    for row in rows:
        kind = classify(row)
        msg, usage = response_message(row)
        dur = row["t_end"] - row["t_start"]
        stamp = f"+{row['t_start'] - t0:5.1f} с ({fmt_ts(row['t_start'])}), {dur:.1f} с"
        tok = f"токены: вход {usage.get('prompt_tokens', '?')}, выход {usage.get('completion_tokens', '?')}"
        if kind == "agent":
            agent_turn += 1
            calls = msg.get("tool_calls") or []
            names = ", ".join(f"`{c['function']['name']}`" for c in calls) or "— (ответ текстом)"
            out += [f"### Ход агента {agent_turn}: {names}", "", f"*{stamp}; {tok}*", ""]
            if msg.get("content"):
                out += ["Модель написала:", "", f"> {clip(msg['content'], 3000)}".replace("\n", "\n> "), ""]
            for c in calls:
                args = parse_json_loose(c["function"].get("arguments")) or c["function"].get("arguments")
                out += [f"**Вызов `{c['function']['name']}`** с аргументами:", "", pretty(args, 1500), ""]
                res = results.get(c.get("id"))
                if res is not None:
                    parsed = parse_json_loose(res)
                    body = pretty(parsed, 6000) if parsed is not None else code(res, "text", 6000)
                    out += [details(f"что вернул инструмент ({len(res)} симв.)", body), ""]
                else:
                    out += ["*Результат инструмента в запись не попал: после этого вызова агент больше не обращался к модели.*", ""]
            if row.get("disconnected"):
                out += [f"⚠️ клиент оборвал соединение: {row['disconnected']}", ""]
        elif kind in ("router", "extractor", "nested"):
            title = {"router": "маршрутизатор типа конструкции (внутри detect_structure_type)",
                     "extractor": "экстрактор параметров (внутри extract_draft_params)",
                     "nested": "вложенный вызов"}[kind]
            content = msg.get("content") or ""
            parsed = parse_json_loose(content)
            body = pretty(parsed, 5000) if parsed is not None else code(content, "text", 5000)
            prompt = (row["request"].get("messages") or [{}])[0].get("content", "")
            out += [f"#### ↳ Вложенный вызов: {title}", "", f"*{stamp}; {tok}*", "",
                    details(f"промпт ({len(prompt)} симв.)", code(prompt, "text", 8000)), "",
                    details("ответ модели", body), ""]
        elif kind == "judge":
            prompt = row["request"]["messages"][-1]["content"]
            criterion = judge_section(prompt, "Criterion") or ""
            out += ["### Оценка LLM-судьёй (после работы агента)", "", f"*{stamp}; {tok}*", "",
                    f"**Критерий:** {criterion}", "", "**Вердикт судьи:**", "", code(msg.get("content", ""), "json", 2000), "",
                    details(f"что видел судья ({len(prompt)} симв.)", code(prompt, "text", 30000)), ""]
    return "\n".join(out)


def section_numbers(gt_model, gt_truth, rows, results):
    if not gt_truth:
        return ""
    # Prefer the full analysis artifact the judge received (it has member forces);
    # the run_analysis tool reply shown to the agent is a compact summary.
    actual = None
    for row in rows:
        if classify(row) == "judge":
            line = judge_section(row["request"]["messages"][-1]["content"], "Analysis result")
            parsed = parse_json_loose(line) if line else None
            if parsed and find_key(parsed, "displacements"):
                actual = parsed
    if actual is None:
        for res in results.values():
            parsed = parse_json_loose(res)
            if parsed and find_key(parsed, "displacements"):
                actual = parsed
                break
    out = ["## 6. Числа: агент против эталона", ""]
    if actual is None:
        return "\n".join(out + ["Расчёт не выполнялся — сравнивать нечего.", ""])

    truth_disp = gt_truth["result"]["displacements"]
    truth_nodes = {n["id"]: (n["x"], n["z"]) for n in gt_model["model"]["nodes"]}
    act_disp = find_key(actual, "displacements")
    if isinstance(act_disp, dict) and isinstance(act_disp.get("values"), dict):
        act_disp = act_disp["values"]  # run_analysis wraps results as {totalCount, truncated, values}
    act_nodes = {}
    nodes_list = find_key(actual, "nodes")
    if isinstance(nodes_list, list):
        act_nodes = {n.get("id"): (n.get("x"), n.get("z")) for n in nodes_list if isinstance(n, dict)}
    if not act_nodes:
        for row in rows:
            if classify(row) == "judge":
                line = judge_section(row["request"]["messages"][-1]["content"], "Nodes")
                for n in parse_json_loose(line) or []:
                    act_nodes[n["id"]] = (n["x"], n["z"])

    def by_coord(xz):
        for nid, c in act_nodes.items():
            if c[0] is not None and abs(c[0] - xz[0]) < 1e-6 and abs(c[1] - xz[1]) < 1e-6:
                return nid
        return None

    out += ["Узлы сопоставлены по координатам (имена у агента и эталона разные). Перемещения в **мм**.", "",
            "| Узел эталона (x; z) | Узел агента | ux эталон | ux агент | uz эталон | uz агент |",
            "|---|---|---|---|---|---|"]
    for nid, xz in truth_nodes.items():
        aid = by_coord(xz)
        t, a = truth_disp.get(nid, {}), (act_disp or {}).get(aid, {}) if aid else {}
        mm = lambda v: f"{v * 1000:.4f}" if isinstance(v, (int, float)) else "—"
        out.append(f"| {nid} ({xz[0]}; {xz[1]}) | {aid or '—'} | {mm(t.get('ux'))} | {mm(a.get('ux'))} | {mm(t.get('uz'))} | {mm(a.get('uz'))} |")
    out += section_member_forces(gt_model, gt_truth, actual, act_nodes, rows)
    reactions = find_key(actual, "reactions")
    if reactions:
        out += ["", "Реакции у агента (кН, кН·м):", "", pretty(reactions, 1500)]
    return "\n".join(out) + "\n"


def hand_values(gt_id):
    """Hand-solution numbers recorded by custom_tasks/build_truth.py, keyed by quantity name."""
    path = ROOT / "custom_tasks" / "truth.json"
    if not path.exists():
        return {}
    by_id = {"ru-truss-7e97": "truss-7e97", "ru-frame-152-4": "frame-152-4"}
    entry = load_json(path).get(by_id.get(gt_id, ""), {})
    return {row["quantity"]: row["hand"] for row in entry.get("comparison", [])}


def section_member_forces(gt_model, gt_truth, actual, act_nodes, rows):
    truth_forces = gt_truth["result"].get("forces") or {}
    act_forces = find_key(actual, "forces") or {}
    if isinstance(act_forces, dict) and isinstance(act_forces.get("values"), dict):
        act_forces = act_forces["values"]
    if not truth_forces:
        return []
    coords = {n["id"]: (n["x"], n["z"]) for n in gt_model["model"]["nodes"]}
    act_elements = []
    for row in rows:
        if classify(row) == "judge":
            act_elements = parse_json_loose(judge_section(row["request"]["messages"][-1]["content"], "Elements") or "") or []
    hand = hand_values(gt_model["id"])

    def same(a, b):
        return a and b and a[0] is not None and abs(a[0] - b[0]) < 1e-6 and abs(a[1] - b[1]) < 1e-6

    def agent_element(e):
        c1, c2 = coords[e["nodes"][0]], coords[e["nodes"][1]]
        for ae in act_elements:
            a1, a2 = act_nodes.get(ae["nodes"][0]), act_nodes.get(ae["nodes"][-1])
            if same(a1, c1) and same(a2, c2):
                return ae["id"], False
            if same(a1, c2) and same(a2, c1):
                return ae["id"], True
        return None, False

    f = lambda v: f"{v:.4f}" if isinstance(v, (int, float)) else "—"
    is_truss = all(e.get("type") == "truss" for e in gt_model["model"]["elements"])
    out = ["", "### Усилия в стержнях: ручной расчёт ↔ эталон OpenSees ↔ агент", ""]
    if is_truss:
        out += ["Продольная сила N, кН (растяжение +).", "",
                "| Стержень | Ручной расчёт (PDF) | Эталон OpenSees | Агент |", "|---|---|---|---|"]
    else:
        out += ["Изгибающий момент на концах стержня по модулю, кН·м (знак зависит от локальных осей — сравниваем |M|).", "",
                "| Стержень, конец | Ручной расчёт (PDF) | Эталон OpenSees | Агент |", "|---|---|---|---|"]
    for e in gt_model["model"]["elements"]:
        tf = truth_forces.get(e["id"], {})
        aid, flipped = agent_element(e)
        af = act_forces.get(aid, {}) if aid else {}
        label = f"{e['id']}" + (f" (у агента {aid})" if aid and aid != e["id"] else "")
        if is_truss:
            out.append(f"| {label} | {f(hand.get('N ' + e['id']))} | {f(tf.get('axial'))} | {f(af.get('axial'))} |")
        else:
            for end, node in (("n1", e["nodes"][0]), ("n2", e["nodes"][1])):
                aend = {"n1": "n2", "n2": "n1"}[end] if flipped else end
                t = abs(tf.get(end, {}).get("M", float("nan")))
                a = af.get(aend, {}).get("M")
                hand_key = "|M| " + e["id"] + "@" + node
                out.append(f"| {label} @ {node} | {f(hand.get(hand_key))} | {f(t)} | {f(abs(a)) if isinstance(a, (int, float)) else '—'} |")
    if not act_elements:
        out += ["", "*Сопоставить стержни агента не удалось: в данных судьи нет списка элементов.*"]
    return out


def section_verdict(result, scenario_res):
    out = ["## 7. Итог проверки бенчмарком", "",
           f"**Вердикт: {'PASS ✅' if scenario_res.get('allPassed') else 'FAIL ❌'}** — "
           f"пройдено {scenario_res.get('passed')} из {scenario_res.get('total')} оцениваемых проверок; "
           f"длительность {scenario_res.get('durationMs', 0) / 1000:.1f} с.", "",
           "| Проверка | Что означает | Ожидалось | Получено | Итог |", "|---|---|---|---|---|"]
    for m in scenario_res.get("metrics", []):
        info = m["metric"] in ("toolCalls", "inputTokens", "outputTokens", "totalTokens", "duration")
        verdict = "ℹ️" if info else mark(m["pass"])
        exp = str(m.get("expected", "")).replace("|", "\\|")
        act = str(m.get("actual", "")).replace("|", "\\|").replace("\n", " ")
        out.append(f"| `{m['metric']}` | {METRICS_RU.get(m['metric'], '')} | {clip(exp, 300)} | {clip(act, 600)} | {verdict} |")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- main
def build(run_name):
    meta = load_json(RUNS / f"{run_name}.meta.json")
    result = load_json(RUNS / f"{run_name}.json")
    scenario, scenario_path = find_scenario(meta["scenario"])
    scenario_res = result["scenarios"][0]
    notes_path = TRIES / "notes" / f"{meta['scenario']}.json"
    notes = load_json(notes_path) if notes_path.exists() else {}
    # Per-run notes (same scenario on another model) override the scenario-level ones.
    run_notes = TRIES / "notes" / f"{run_name}.json"
    if run_notes.exists():
        notes = {**notes, **load_json(run_notes)}
    analysis_path = TRIES / "notes" / f"{run_name}.analysis.md"
    if not analysis_path.exists():
        analysis_path = TRIES / "notes" / f"{meta['scenario']}.analysis.md"

    assertions = scenario.get("expect", {}).get("assertions") or [
        a for t in scenario.get("turns", []) for a in t.get("assertions", [])]
    gt_id = next((a.get("groundTruthId") for a in assertions if a.get("groundTruthId")), None)
    gt_model, gt_truth = ground_truth(gt_id) if gt_id else (None, None)

    rows = run_exchanges(meta)
    agent_rows = [r for r in rows if classify(r) == "agent"]
    results = tool_results(agent_rows)

    out_dir = TRIES / run_name
    raw = out_dir / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    shutil.copy(RUNS / f"{run_name}.json", raw / "benchmark_result.json")
    shutil.copy(scenario_path, raw / "scenario.json")
    (raw / "runner.log").write_text(ANSI.sub("", (RUNS / f"{run_name}.log").read_text(encoding="utf-8")), encoding="utf-8")
    (raw / "llm_exchanges.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    header = f"""# Прогон `{meta['scenario']}` — {'PASS ✅' if scenario_res.get('allPassed') else 'FAIL ❌'}

| | |
|---|---|
| Сценарий | `{scenario['id']}` — {scenario.get('description', '')} |
| Семейство / сложность | `{scenario.get('taskFamily')}` / {scenario.get('difficulty')} |
| Дата прогона | {datetime.fromtimestamp(meta['t_start']).strftime('%Y-%m-%d %H:%M')} |
| Модель | `{meta['model']}` ({'через Ollama Cloud' if 'cloud' in meta['model'] else 'локально через Ollama'}) |
| Итог | {scenario_res.get('passed')} / {scenario_res.get('total')} проверок, {scenario_res.get('durationMs', 0) / 1000:.0f} с, {len(agent_rows)} ходов агента, {len(rows)} запросов к LLM всего |
| Сырые данные | [raw/](raw/) — сценарий, результат бенчмарка, лог runner'а, все запросы к LLM |

**Коротко:** {notes.get('summary_ru', '—')}
"""
    analysis = analysis_path.read_text(encoding="utf-8") if analysis_path.exists() else "*Разбор ещё не написан.*"
    parts = [
        header,
        section_system(meta, result),
        section_given(scenario, notes, agent_rows),
        section_expected(scenario, notes, gt_model, gt_truth),
        section_golden(notes, scenario_res.get("metrics", [])),
        section_timeline(rows, results),
        section_numbers(gt_model, gt_truth, rows, results),
        section_verdict(result, scenario_res),
        "## 8. Разбор: почему получилось именно так\n\n" + analysis,
    ]
    (out_dir / "REPORT.md").write_text("\n\n".join(p for p in parts if p), encoding="utf-8")
    return out_dir, scenario_res


def embed_report(name, text, keep_system):
    """Adapt one REPORT.md for ALL_RUNS.md: demote headings, fix relative links,
    optionally drop section 1 (identical in every report)."""
    out, fenced, skipping = [], False, False
    for line in text.splitlines():
        if line.startswith("````"):
            fenced = not fenced
        elif not fenced and line.startswith("#"):
            if line.startswith("## 1. "):
                skipping = not keep_system
            elif line.startswith("## "):
                skipping = False
            line = "#" + line
        if not skipping:
            out.append(line.replace("](raw/", f"]({name}/raw/"))
    return "\n".join(out)


def build_combined(names):
    rows, bodies = [], []
    for i, name in enumerate(names):
        res = load_json(RUNS / f"{name}.json")["scenarios"][0]
        meta = load_json(RUNS / f"{name}.meta.json")
        verdict = "PASS ✅" if res.get("allPassed") else "FAIL ❌"
        anchor = f"run-{i + 1}"
        rows.append(f"| {i + 1} | [`{meta['scenario']}`](#{anchor}) | {verdict} | {res.get('passed')}/{res.get('total')} | "
                    f"{res.get('durationMs', 0) / 1000:.0f} с | [отдельный файл]({name}/REPORT.md) |")
        text = (TRIES / name / "REPORT.md").read_text(encoding="utf-8")
        bodies.append(f'<a id="{anchor}"></a>\n\n' + embed_report(name, text, keep_system=(i == 0)))
    common = (TRIES / "notes" / "_common.md").read_text(encoding="utf-8") if (TRIES / "notes" / "_common.md").exists() else ""
    head = ["# Прогоны StructureClaw-Bench: сводный отчёт", "",
            "Все прогоны в одном файле. Раздел «Что это за система» приведён один раз — в первом прогоне,",
            "в остальных он совпадает и опущен. Каждый прогон также лежит отдельным файлом в своей папке.", "",
            "| # | Сценарий | Итог | Проверки | Время | |", "|---|---|---|---|---|---|", *rows, "", common]
    (TRIES / "ALL_RUNS.md").write_text("\n".join(head) + "\n\n---\n\n" + "\n\n---\n\n".join(bodies) + "\n", encoding="utf-8")


def main():
    names = sys.argv[1:] or sorted(p.name[: -len(".meta.json")] for p in RUNS.glob("*.meta.json"))
    index = ["# Прогоны StructureClaw-Bench", "", "Всё в одном файле: [ALL_RUNS.md](ALL_RUNS.md). "
             "Задачи из методички: [ZADACHI.md](ZADACHI.md). Поэтапная оценка и ревью: [REVIEW.md](REVIEW.md).", "",
             "| Прогон | Итог | Проверки | Время | Отчёт |", "|---|---|---|---|---|"]
    for name in names:
        out_dir, res = build(name)
        print("written", out_dir / "REPORT.md")
    reported = []
    for meta_path in sorted(RUNS.glob("*.meta.json")):
        name = meta_path.name[: -len(".meta.json")]
        if (TRIES / name / "REPORT.md").exists():
            reported.append(name)
            res = load_json(RUNS / f"{name}.json")["scenarios"][0]
            index.append(f"| `{name}` | {'PASS ✅' if res.get('allPassed') else 'FAIL ❌'} | {res.get('passed')}/{res.get('total')} | "
                         f"{res.get('durationMs', 0) / 1000:.0f} с | [REPORT.md]({name}/REPORT.md) |")
    (TRIES / "README.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    build_combined(reported)
    print("written", TRIES / "ALL_RUNS.md")


if __name__ == "__main__":
    main()
