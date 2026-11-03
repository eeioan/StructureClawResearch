# Benchmark Specification

[中文](SPEC_CN.md)

## Execution contract

The runner treats the corpus as read-only. It may read StructureClaw build
artifacts and settings from `SCLAW_ROOT`, but it must not derive agent input
from expected outputs or ground truth. Results are written only to an explicit
output path.

Every scenario has one attempt (`maxRetries: 0`). A multi-turn scenario shares
one conversation and evaluates each turn against that turn's assertions.
Scenario timeouts are execution failures, not model-quality failures.

## Assertions

| Assertion | Requirement |
| --- | --- |
| `structural_type` | Runtime structural type matches the expected type. |
| `skill_match` | Routing matches the declared primary skill or allowed alias. |
| `has_model` | A valid computable model exists and satisfies declared minimums. |
| `model_matches` | Geometry, topology, restraints, assignments, and loads match frozen engineering truth within explicit tolerances. |
| `has_analysis` | A successful analysis artifact exists. |
| `engine_match` | The requested analysis skill and engine were used. |
| `numerical_matches` | Solver responses match frozen same-engine truth within explicit tolerances. |
| `has_report` | A typed, trace-grounded report artifact exists. |
| `report_numerical_consistency` | Report values match the current analysis artifact. |
| `has_interaction_questions` | The agent requests relevant missing or corrected input. |
| `should_not_analyze` | No analysis is invoked for unsafe or under-specified input. |
| `no_bad_model` | No computable model is produced for unsafe or under-specified input. |
| `analysis_or_interaction` | Either a valid analysis completes or an appropriate clarification is requested. |
| `natural_language` | The configured judge accepts the response using only supplied execution evidence. |

Unknown assertion types are corpus configuration errors. Missing execution
evidence never passes by assumption.

## Tolerances and truth

Scenario JSON is authoritative for explicit tolerances. Frozen truth records
identify their source models, engines, load combinations, units, and provenance.
Entity identifiers may differ only when a one-to-one engineering mapping
preserves the declared relationships.

## Result identity

A reproducible result identifies the StructureClaw revision, benchmark revision,
scenario and attachment hashes, evaluation hash, runtime configuration hash,
model roles, analysis runtimes, start time, and completion state.
