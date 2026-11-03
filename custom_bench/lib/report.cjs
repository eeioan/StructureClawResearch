function formatMetric(m) {
  const icon = m.pass ? "\u2713" : "\u2717";
  return `  ${icon} ${String(m.metric).padEnd(18)} expected: ${String(m.expected).padEnd(30)} actual: ${String(m.actual)}`;
}

function formatTurnMetric(m) {
  const icon = m.pass ? "\u2713" : "\u2717";
  return `    ${icon} ${String(m.metric).padEnd(16)} ${String(m.actual)}`;
}

function metricNumber(metric) {
  if (!metric) return null;
  const value = Number.parseFloat(String(metric.actual));
  return Number.isFinite(value) ? value : null;
}

function findMetric(result, name) {
  return (result.metrics || []).find((metric) => metric.metric === name) || null;
}

const INFORMATIONAL_METRICS = new Set([
  "duration",
  "toolCalls",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "visionInputTokens",
  "visionOutputTokens",
  "visionTotalTokens",
]);
const ROUTING_ONLY_METRICS = new Set(["structural_type", "skill_match"]);

function commonCoreMetrics(metrics) {
  return (metrics || []).filter((metric) => (
    !INFORMATIONAL_METRICS.has(metric.metric)
    && !ROUTING_ONLY_METRICS.has(metric.metric)
  ));
}

function commonCorePass(result) {
  const metrics = commonCoreMetrics(result.metrics);
  return metrics.length > 0 && metrics.every((metric) => metric.pass === true);
}

function commonCorePassAt1(result) {
  const firstRound = result.retries?.rounds?.[0];
  if (!firstRound?.metrics) return commonCorePass(result);
  const metrics = commonCoreMetrics(firstRound.metrics);
  return metrics.length > 0 && metrics.every((metric) => metric.pass === true);
}

function toolCallCount(result) {
  const direct = metricNumber(findMetric(result, "toolCalls"));
  if (direct !== null) return direct;
  if (!Array.isArray(result.turnResults)) return null;
  let total = 0;
  let found = false;
  for (const turn of result.turnResults) {
    const value = metricNumber(findMetric(turn.evaluation || {}, "toolCalls"));
    if (value !== null) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function tokenCount(result, name) {
  const direct = metricNumber(findMetric(result, name));
  if (direct !== null) return direct;
  if (!Array.isArray(result.turnResults)) return null;
  const cumulativeValues = result.turnResults
    .map((turn) => metricNumber(findMetric(turn.evaluation || {}, name)))
    .filter((value) => value !== null);
  return cumulativeValues.length > 0 ? Math.max(...cumulativeValues) : null;
}

function passAt1(result) {
  if (typeof result.retries?.passAt1 === "boolean") return result.retries.passAt1;
  return result.allPassed === true && (result.retries?.attempts || 1) <= 1;
}

function retriesUsed(result) {
  if (typeof result.retries?.retriesUsed === "number") return result.retries.retriesUsed;
  return Math.max(0, (result.retries?.attempts || 1) - 1);
}

function average(values) {
  const valid = values.filter((value) => typeof value === "number" && Number.isFinite(value));
  if (valid.length === 0) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function summarizeResults(results) {
  const total = results.length;
  const passAt1Count = results.filter(passAt1).length;
  const passAtNCount = results.filter((result) => result.allPassed).length;
  const commonCorePassAt1Count = results.filter(commonCorePassAt1).length;
  const commonCorePassCount = results.filter(commonCorePass).length;
  const toolCalls = results.map(toolCallCount);
  const totalTokens = results.map((result) => tokenCount(result, "totalTokens"));
  const visionTotalTokens = results.map((result) => tokenCount(result, "visionTotalTokens"));
  const totalDurationMs = results.reduce((sum, result) => sum + result.durationMs, 0);
  const solverQueueWaitMs = results.reduce(
    (sum, result) => sum + Number(result.executionProfile?.solverGate?.solverQueueWaitMs || 0),
    0,
  );
  const solverExecutionMs = results.reduce(
    (sum, result) => sum + Number(result.executionProfile?.solverGate?.solverExecutionMs || 0),
    0,
  );
  const solverCooldownMs = results.reduce(
    (sum, result) => sum + Number(result.executionProfile?.solverGate?.cooldownMs || 0),
    0,
  );
  const totalEffectiveDurationMs = Math.max(
    0,
    totalDurationMs - solverQueueWaitMs - solverCooldownMs,
  );
  return {
    total,
    passAt1: passAt1Count,
    passAtN: passAtNCount,
    passed: passAtNCount,
    failed: total - passAtNCount,
    passAt1Rate: total > 0 ? passAt1Count / total : 0,
    passAtNRate: total > 0 ? passAtNCount / total : 0,
    commonCorePassAt1: commonCorePassAt1Count,
    commonCorePassed: commonCorePassCount,
    commonCoreFailed: total - commonCorePassCount,
    commonCorePassAt1Rate: total > 0 ? commonCorePassAt1Count / total : 0,
    commonCorePassRate: total > 0 ? commonCorePassCount / total : 0,
    averageRetries: average(results.map(retriesUsed)) || 0,
    averageToolCalls: average(toolCalls),
    averageTotalTokens: average(totalTokens),
    totalTokens: totalTokens
      .filter((value) => value !== null)
      .reduce((sum, value) => sum + value, 0),
    averageVisionTotalTokens: average(visionTotalTokens),
    visionTotalTokens: visionTotalTokens
      .filter((value) => value !== null)
      .reduce((sum, value) => sum + value, 0),
    averageDurationMs: total > 0 ? totalDurationMs / total : 0,
    totalDurationMs,
    averageEffectiveDurationMs: total > 0 ? totalEffectiveDurationMs / total : 0,
    totalEffectiveDurationMs,
    solverQueueWaitMs,
    solverExecutionMs,
    solverCooldownMs,
  };
}

function printScenarioResult(scenario, evaluation) {
  const status = evaluation.allPassed ? "PASS" : "FAIL";
  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`${status}  ${scenario.id}\n`);
  if (scenario.description) {
    process.stdout.write(`     ${scenario.description}\n`);
  }

  if (evaluation.turnResults && Array.isArray(evaluation.turnResults)) {
    const turns = scenario.turns || [];
    for (const { turnIndex, evaluation: turnEval } of evaluation.turnResults) {
      const turnMsg = turns[turnIndex]?.message || "(turn)";
      const preview = turnMsg.length > 40 ? turnMsg.slice(0, 40) + "..." : turnMsg;
      process.stdout.write(`\n  Turn ${turnIndex + 1}: "${preview}"\n`);
      for (const m of turnEval.metrics) {
        if (m.metric === "duration") continue;
        if (m.metric === "toolCalls" && m.pass) continue;
        process.stdout.write(formatTurnMetric(m) + "\n");
      }
    }
    process.stdout.write(`\n`);
    for (const m of evaluation.metrics) {
      if (m.metric === "duration") {
        process.stdout.write(formatMetric(m) + "\n");
      }
    }
  } else {
    process.stdout.write(`\n`);
    for (const m of evaluation.metrics) {
      process.stdout.write(formatMetric(m) + "\n");
    }
  }
  process.stdout.write(`${"=".repeat(60)}\n`);
  if (evaluation.retries && evaluation.retries.attempts > 1) {
    const { attempts, maxRetries, rounds } = evaluation.retries;
    const roundSummary = rounds.map((r) => `attempt ${r.attempt}: ${r.allPassed ? 'PASS' : 'FAIL'}`).join(', ');
    process.stdout.write(`  Retries: ${attempts - 1}/${maxRetries} (${roundSummary})\n`);
  }
}

function printSummary(results) {
  const summary = summarizeResults(results);

  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`Benchmark Results: ${formatRate(summary.passed, summary.total)} pass`);
  if (summary.failed > 0) {
    process.stdout.write(`, ${summary.failed} failed`);
  }
  process.stdout.write(`\n`);
  process.stdout.write(`Pass@1: ${formatRate(summary.passAt1, summary.total)}\n`);
  if (summary.averageToolCalls !== null) {
    process.stdout.write(`Average tool calls: ${summary.averageToolCalls.toFixed(1)}\n`);
  }
  if (summary.averageTotalTokens !== null) {
    process.stdout.write(`Average primary-model tokens: ${summary.averageTotalTokens.toFixed(1)}\n`);
  }
  if (summary.averageVisionTotalTokens !== null) {
    process.stdout.write(`Average vision-model tokens: ${summary.averageVisionTotalTokens.toFixed(1)}\n`);
  }
  process.stdout.write(`Average duration: ${(summary.averageDurationMs / 1000).toFixed(1)}s\n`);
  if (summary.failed > 0) {
    const failedIds = results.filter((r) => !r.allPassed).map((r) => r.scenarioId);
    process.stdout.write(`Failed: ${failedIds.join(", ")}\n`);
  }
  process.stdout.write(`Total time: ${(summary.totalDurationMs / 1000).toFixed(1)}s\n`);
  printGroupedSummary(results, "taskFamily");
  printGroupedSummary(results, "mode");
  printGroupedSummary(results, "split");
  printGroupedSummary(results, "category");
  printGroupedSummary(results, "inputCompleteness");
  printGroupedSummary(results, "benchmarkStructureType");
  printGroupedSummary(results, "analysisEngineTarget");
  printMetricSummary(results);
  process.stdout.write(`${"=".repeat(60)}\n\n`);
}

function formatRate(passed, total) {
  if (total === 0) return "n/a";
  return `${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`;
}

function groupBy(results, key) {
  const groups = new Map();
  for (const result of results) {
    const value = result[key] || "(unset)";
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(result);
  }
  return [...groups.entries()].sort(([left], [right]) => String(left).localeCompare(String(right)));
}

function printGroupedSummary(results, key) {
  const groups = groupBy(results, key);
  if (groups.length <= 1) return;
  process.stdout.write(`\nBy ${key}:\n`);
  for (const [value, group] of groups) {
    const summary = summarizeResults(group);
    process.stdout.write(
      `  ${String(value).padEnd(32)} ` +
      `Pass@1 ${formatRate(summary.passAt1, summary.total).padEnd(16)} ` +
      `Pass ${formatRate(summary.passed, summary.total).padEnd(16)}` +
      (key === "mode"
        ? ` Common-Core ${formatRate(summary.commonCorePassed, summary.total).padEnd(16)}`
        : "") +
      "\n",
    );
  }
}

function printMetricSummary(results) {
  const counters = new Map();
  for (const result of results) {
    for (const metric of result.metrics || []) {
      if ([
        "duration",
        "toolCalls",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "visionInputTokens",
        "visionOutputTokens",
        "visionTotalTokens",
      ].includes(metric.metric)) continue;
      const key = metric.metric;
      if (!counters.has(key)) counters.set(key, { passed: 0, total: 0 });
      const entry = counters.get(key);
      entry.total += 1;
      if (metric.pass) entry.passed += 1;
    }
  }
  const entries = [...counters.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) return;
  process.stdout.write(`\nBy metric:\n`);
  for (const [metric, entry] of entries) {
    process.stdout.write(`  ${metric.padEnd(32)} ${formatRate(entry.passed, entry.total)}\n`);
  }
}

function buildSummary(results) {
  const by = {};
  for (const key of ["taskFamily", "mode", "split", "category", "inputModality", "inputCompleteness", "benchmarkStructureType", "structureType", "analysisEngineTarget"]) {
    by[key] = Object.fromEntries(groupBy(results, key).map(([value, group]) => [value, summarizeResults(group)]));
  }

  const metrics = {};
  for (const result of results) {
    for (const metric of result.metrics || []) {
      if ([
        "duration",
        "toolCalls",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "visionInputTokens",
        "visionOutputTokens",
        "visionTotalTokens",
      ].includes(metric.metric)) continue;
      metrics[metric.metric] ||= { total: 0, passed: 0, failed: 0 };
      metrics[metric.metric].total += 1;
      if (metric.pass) metrics[metric.metric].passed += 1;
      else metrics[metric.metric].failed += 1;
    }
  }

  const summary = summarizeResults(results);
  return {
    totalScenarios: summary.total,
    passAt1: summary.passAt1,
    passAtN: summary.passAtN,
    passed: summary.passed,
    failed: summary.failed,
    passAt1Rate: summary.passAt1Rate,
    passAtNRate: summary.passAtNRate,
    commonCorePassAt1: summary.commonCorePassAt1,
    commonCorePassed: summary.commonCorePassed,
    commonCoreFailed: summary.commonCoreFailed,
    commonCorePassAt1Rate: summary.commonCorePassAt1Rate,
    commonCorePassRate: summary.commonCorePassRate,
    averageRetries: summary.averageRetries,
    averageToolCalls: summary.averageToolCalls,
    averageTotalTokens: summary.averageTotalTokens,
    totalTokens: summary.totalTokens,
    averageVisionTotalTokens: summary.averageVisionTotalTokens,
    visionTotalTokens: summary.visionTotalTokens,
    averageDurationMs: summary.averageDurationMs,
    totalDurationMs: summary.totalDurationMs,
    averageEffectiveDurationMs: summary.averageEffectiveDurationMs,
    totalEffectiveDurationMs: summary.totalEffectiveDurationMs,
    solverQueueWaitMs: summary.solverQueueWaitMs,
    solverExecutionMs: summary.solverExecutionMs,
    solverCooldownMs: summary.solverCooldownMs,
    by,
    metrics,
  };
}

function writeJsonOutput(outputPath, results, options = {}) {
  const fs = require("node:fs");
  const summary = buildSummary(results);
  const completed = options.completed === true
    && results.length === options.runMetadata?.plannedScenarioCount;
  const phase = options.runMetadata?.protocol?.phase || "development";
  const targeted = options.runMetadata?.protocol?.targeted === true;
  const requiredFingerprintKeys = [
    "scenarioHash",
    "attachmentHash",
    "promptAndToolHash",
    "evaluationHash",
    "runtimeConfigHash",
  ];
  const formalMetadataComplete = [1, 2, 3].includes(options.runMetadata?.repeatId)
    && requiredFingerprintKeys.every((key) => options.runMetadata?.fingerprints?.[key])
    && Boolean(options.runMetadata?.protocol?.formalJobId)
    && /^[a-f0-9]{64}$/i.test(
      options.runMetadata?.protocol?.formalMatrixSha256 || "",
    );
  const paperEligible = phase === "formal"
    && completed
    && !targeted
    && formalMetadataComplete;
  const record = {
    timestamp: new Date().toISOString(),
    run: options.runMetadata
      ? {
          ...options.runMetadata,
          completedScenarioCount: results.length,
          completed,
          finishedAt: options.completed === true ? new Date().toISOString() : null,
          validity: {
            phase,
            paperEligible,
            reason: phase !== "formal"
              ? "development run; not eligible for paper results"
              : !completed
                ? "formal run is incomplete"
                : targeted
                  ? "targeted runs are not eligible for paper results"
                  : !formalMetadataComplete
                    ? "formal run is missing repeat or fingerprint metadata"
                    : "eligible",
          },
        }
      : undefined,
    ...summary,
    scenarios: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(record, null, 2) + "\n");
  if (!options.quiet) {
    process.stdout.write(`Results written to ${outputPath}\n`);
  }
}

module.exports = {
  buildSummary,
  commonCorePass,
  commonCorePassAt1,
  printScenarioResult,
  printSummary,
  writeJsonOutput,
};
