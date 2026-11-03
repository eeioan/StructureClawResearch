"""Run StructureClaw's own OpenSees static runtime on a StructureModel v2 dict.

Must be executed with StructureClaw's Python env (~/.structureclaw/.venv).
"""
import sys
from pathlib import Path

SCLAW = Path(__file__).resolve().parent.parent / "structureclaw" / "backend" / "src"
for p in (SCLAW / "agent-skills" / "analysis" / "opensees-static",
          SCLAW / "agent-skills" / "analysis" / "runtime",
          SCLAW / "skill-shared" / "python"):
    sys.path.insert(0, str(p))

from runtime import run_analysis  # noqa: E402  (opensees-static/runtime.py)
from structure_protocol.structure_model_v2 import StructureModelV2  # noqa: E402


def solve(model_dict, combination_id):
    model = StructureModelV2.model_validate(model_dict)
    return run_analysis(model, {"loadCombinationId": combination_id})
