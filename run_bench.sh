#!/usr/bin/env bash
# Run one StructureClaw benchmark scenario against a local Ollama model.
# Usage: ./run_bench.sh <scenario-id> [model]
set -euo pipefail

SCENARIO="${1:?scenario id required}"
MODEL="${2:-qwen3.5:9b}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$ROOT/bench_runs"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR/llm_logs"

# Ollama exposes an OpenAI-compatible API; the key is a placeholder (Ollama ignores it).
# Requests go through ollama/nothink_proxy.py (port 18435), which turns off Qwen
# thinking: with it on, a single nested routing call takes 2+ minutes and hits
# StructureClaw's 180 s timeout. Start it first: python ollama/nothink_proxy.py
export LLM_BASE_URL="${LLM_BASE_URL:-http://localhost:18435/v1}"
# The judge only accepts HTTPS, so it goes through the proxy's TLS port.
export LLM_JUDGE_BASE_URL="${LLM_JUDGE_BASE_URL:-https://localhost:18436/v1}"
export NODE_EXTRA_CA_CERTS="$ROOT/ollama/localhost-cert.pem"
export LLM_API_KEY="ollama"
export LLM_MODEL="$MODEL"
# The natural_language judge falls back to the same model.
export LLM_BENCHMARK_PROVIDER_REQUEST_TIMEOUT_MS=600000

# Run window (epoch seconds) lets tries/make_report.py pick this run's
# exchanges out of the proxy dump.
T_START="$(date +%s.%N)"

# Custom scenarios (custom_tasks/) live in custom_bench/, a copy of the benchmark
# corpus; its runner is pointed at our StructureClaw checkout via SCLAW_ROOT.
if [ -f "$ROOT/custom_tasks/scenarios/$SCENARIO.json" ]; then
  RUNNER=("$ROOT/custom_bench/runner.cjs")
  export SCLAW_ROOT="$ROOT/structureclaw"
else
  RUNNER=(tests/runner.mjs llm-benchmark)
fi

cd "$ROOT/structureclaw"
# The runner exits 1 when the scenario fails; keep going so the meta file is still written.
STATUS=0
node "${RUNNER[@]}" \
  --scenario "$SCENARIO" \
  --case-timeout-ms 1800000 \
  --output "$OUT_DIR/${STAMP}_${SCENARIO}.json" \
  2>&1 | tee "$OUT_DIR/${STAMP}_${SCENARIO}.log" || STATUS=$?

cat > "$OUT_DIR/${STAMP}_${SCENARIO}.meta.json" <<EOF
{"scenario": "$SCENARIO", "model": "$MODEL", "stamp": "$STAMP", "t_start": $T_START, "t_end": $(date +%s.%N)}
EOF
exit "$STATUS"
