# StructureClaw Benchmark

[中文](README_CN.md)

The public, reproducible benchmark runner and corpus for
[StructureClaw](https://github.com/structureclaw/structureclaw).

The benchmark contains 150 bilingual structural-engineering scenarios:

| Task family | Scenarios | Purpose |
| --- | ---: | --- |
| `standard_workflow` | 50 | Clear request → model → analysis → optional report |
| `interactive_robustness` | 50 | Missing, invalid, ambiguous, conflicting, or multi-turn input |
| `multimodal_reverse_engineering` | 50 | Image and DXF reconstruction |

Each family contains 25 English and 25 Chinese scenarios.

## Public scope

This repository contains only what is required to inspect and run the
benchmark:

- declarative scenarios and typed assertions;
- static images, drawings, engineering models, and frozen numerical truth;
- the runner and its scoring implementation;
- corpus and result schemas.

## Layout

```text
benchmark.json       Corpus identity, versions, and expected counts
schemas/             Scenario and result contracts
scenarios/           One JSON file per scenario, grouped by task family
fixtures/            Frozen public inputs and ground truth
lib/                 Runtime scoring and corpus validation
runner.cjs           Public benchmark entry point
SPEC.md              Normative scoring contract
```

## Run

From a StructureClaw checkout with the backend already built:

```bash
node tests/runner.mjs llm-benchmark
node tests/runner.mjs llm-benchmark --scenario std-beam-6m-gt-repeat
node tests/runner.mjs llm-benchmark --family standard_workflow
```

Standalone:

```bash
export SCLAW_ROOT=/path/to/structureclaw
export LLM_API_KEY=...

npm install
npm run validate
npm run benchmark -- --scenario std-beam-6m-gt-repeat
```

The runner also accepts `--mode`, `--output`, and `--case-timeout-ms`. Benchmark
outputs are written only when an output path is supplied.

## Reproducibility

Published results should record the StructureClaw revision, benchmark revision,
scenario and attachment hashes, evaluation hash, runtime configuration hash,
model identities, and analysis runtime versions. Existing scenario IDs and
scoring semantics are immutable within a published benchmark version.

See [SPEC.md](SPEC.md) for assertion semantics and evidence requirements.

## License

MIT
