"""Install the custom scenarios and their ground truth into ../custom_bench (a copy of
structureclaw-benchmark), leaving the original submodule untouched.

Usage: python -I -X utf8 custom_tasks/install.py   (after build_truth.py)
"""
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent / "custom_bench"
SOLVER = {"name": "OpenSeesPy", "packageVersion": "3.7.1.2", "runtimePackage": "openseespywin",
          "runtimePackageVersion": "3.8.0.0", "version": "3.8.0"}
IDS = {"truss-7e97": "ru-truss-7e97", "frame-152-4": "ru-frame-152-4"}


def main():
    truth = json.loads((HERE / "truth.json").read_text(encoding="utf-8"))
    gm_path = BENCH / "fixtures" / "ground-truth-models.json"
    os_path = BENCH / "fixtures" / "opensees-ground-truth.json"
    models = [m for m in json.loads(gm_path.read_text(encoding="utf-8")) if m["id"] not in IDS.values()]
    solver_truth = json.loads(os_path.read_text(encoding="utf-8"))
    solver_truth["models"] = [m for m in solver_truth["models"] if m["modelId"] not in IDS.values()]

    for key, gt_id in IDS.items():
        entry = truth[key]
        models.append({"id": gt_id, "inferredType": "truss" if "truss" in key else "frame",
                       "description": entry["model"]["metadata"]["description"], "model": entry["model"]})
        solver_truth["models"].append({
            "modelId": gt_id, "inputSha256": entry["inputSha256"], "solver": SOLVER,
            "analysisSelection": {"factors": {"LC1": 1}, "loadCombinationId": "ULS"},
            "verification": {"runCount": 2, "note": "StructureClaw opensees-static runtime, two identical runs; "
                             "cross-checked against the hand solution (see custom_tasks/truth.json)",
                             "handComparison": entry["comparison"]},
            "result": entry["result"],
        })
    gm_path.write_text(json.dumps(models, ensure_ascii=False, indent=2), encoding="utf-8")
    os_path.write_text(json.dumps(solver_truth, ensure_ascii=False, indent=2), encoding="utf-8")

    # Every scenario (incl. coached multi-turn variants) goes into its task-family folder.
    for path in sorted((HERE / "scenarios").glob("*.json")):
        family = json.loads(path.read_text(encoding="utf-8"))["taskFamily"]
        shutil.copy(path, BENCH / "scenarios" / family / path.name)
        print("installed", path.stem, "->", family)


if __name__ == "__main__":
    main()
