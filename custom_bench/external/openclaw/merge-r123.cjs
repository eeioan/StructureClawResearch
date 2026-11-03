const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { buildSummary } = require("../../lib/report.cjs");

const OPENCLAW_VERSION = "2026.6.33";
const MODEL_NAME = "glm-5.2";
const benchmarkRoot = path.resolve(__dirname, "..", "..");
const resultRoot = path.resolve(
  process.argv[2]
  || path.join(benchmarkRoot, "results", "openclaw-r123-20260729"),
);
const outputPath = path.resolve(
  process.argv[3]
  || path.join(resultRoot, "openclaw-r123-merged.json"),
);
const standardRepeatOnePath = path.join(
  benchmarkRoot,
  "results",
  "openclaw-standard-glm-5.2-paratera.json",
);
const batchSpecs = [
  ["r1-interactive-paratera.json", 1, 50],
  ["r1-multimodal-paratera.json", 1, 50],
  ["r2-standard-paratera.json", 2, 100],
  ["r2-interactive-mine.json", 2, 50],
  ["r2-multimodal-mine.json", 2, 50],
  ["r3-standard-paratera.json", 3, 100],
  ["r3-interactive-paratera.json", 3, 50],
  ["r3-multimodal-paratera.json", 3, 50],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function executionFailure(scenario) {
  return (scenario.metrics || []).find((metric) => (
    metric.metric === "execution" && metric.pass !== true
  ));
}

function isRetryableInfrastructureFailure(scenario) {
  return /^OpenClaw exited with code 1:/i.test(
    String(executionFailure(scenario)?.actual || ""),
  );
}

function scenarioKey(scenario) {
  return `${scenario.repeatId}:${scenario.scenarioId}`;
}

function loadCompletedRun(filePath, repeatId, expectedCount, providerOverride) {
  const result = readJson(filePath);
  assert(result.run?.completed === true, `${path.basename(filePath)} is incomplete`);
  assert(
    result.run?.openClaw?.version === OPENCLAW_VERSION,
    `${path.basename(filePath)} does not use OpenClaw ${OPENCLAW_VERSION}`,
  );
  assert(
    result.run?.completedScenarioCount === expectedCount,
    `${path.basename(filePath)} completed count is not ${expectedCount}`,
  );
  assert(
    result.scenarios?.length === expectedCount,
    `${path.basename(filePath)} scenario count is not ${expectedCount}`,
  );
  if (result.run.repeatId !== undefined) {
    assert(
      result.run.repeatId === repeatId,
      `${path.basename(filePath)} has repeat ${result.run.repeatId}, expected ${repeatId}`,
    );
  }

  const provider = providerOverride || result.run.provider;
  assert(provider, `${path.basename(filePath)} has no provider identity`);
  for (const scenario of result.scenarios) {
    assert(
      scenario.executionProfile?.openClawVersion === OPENCLAW_VERSION,
      `${scenario.scenarioId} does not use OpenClaw ${OPENCLAW_VERSION}`,
    );
    const modelName = String(scenario.executionProfile?.model || "")
      .split("/")
      .at(-1)
      .toLowerCase();
    assert(modelName === MODEL_NAME, `${scenario.scenarioId} does not use ${MODEL_NAME}`);
    assert(
      (scenario.executionProfile?.modelFallbacks || []).length === 0,
      `${scenario.scenarioId} used a model fallback`,
    );
  }
  return {
    source: {
      file: path.basename(filePath),
      sha256: sha256(filePath),
      repeatId,
      provider,
      scenarioCount: expectedCount,
    },
    scenarios: result.scenarios.map((scenario) => {
      const scenarioProvider = provider
        || scenario.provider
        || scenario.executionProfile?.provider;
      return {
        ...scenario,
        repeatId,
        provider: scenarioProvider,
        executionProfile: {
          ...scenario.executionProfile,
          provider: scenarioProvider,
        },
      };
    }),
  };
}

const repeatOneStandard = loadCompletedRun(
  standardRepeatOnePath,
  1,
  100,
  "paratera",
);
const loadedBatches = batchSpecs.map(([fileName, repeatId, expectedCount]) =>
  loadCompletedRun(
    path.join(resultRoot, fileName),
    repeatId,
    expectedCount,
  ));
const sourceRuns = [repeatOneStandard, ...loadedBatches];
const originalScenarios = sourceRuns.flatMap((run) => run.scenarios);

assert(originalScenarios.length === 600, "source runs do not contain 600 scenarios");
const originalByKey = new Map();
for (const scenario of originalScenarios) {
  const key = scenarioKey(scenario);
  assert(!originalByKey.has(key), `duplicate source scenario ${key}`);
  originalByKey.set(key, scenario);
}

const originalInfrastructureFailures = originalScenarios.filter(
  isRetryableInfrastructureFailure,
);
assert(
  originalInfrastructureFailures.length === 8,
  `expected 8 retryable infrastructure failures, found ${originalInfrastructureFailures.length}`,
);

const retryRoot = path.join(resultRoot, "retries");
const retryPaths = fs.readdirSync(retryRoot)
  .filter((fileName) => fileName.endsWith(".json"))
  .sort()
  .map((fileName) => path.join(retryRoot, fileName));
assert(retryPaths.length === 8, `expected 8 retry files, found ${retryPaths.length}`);

const replacements = [];
for (const retryPath of retryPaths) {
  const retryRun = loadCompletedRun(retryPath, 2, 1);
  const retryScenario = retryRun.scenarios[0];
  const key = scenarioKey(retryScenario);
  const original = originalByKey.get(key);
  assert(original, `retry ${path.basename(retryPath)} has no source scenario`);
  assert(
    isRetryableInfrastructureFailure(original),
    `retry ${path.basename(retryPath)} does not replace an infrastructure failure`,
  );
  assert(
    !isRetryableInfrastructureFailure(retryScenario),
    `retry ${path.basename(retryPath)} still has an infrastructure failure`,
  );

  const replacement = {
    ...retryScenario,
    infrastructureReplacement: {
      reason: "provider stream terminated before a complete OpenClaw result",
      originalProvider: original.provider,
      retryProvider: retryScenario.provider,
      retrySource: path.basename(retryPath),
      retrySourceSha256: retryRun.source.sha256,
    },
  };
  originalByKey.set(key, replacement);
  replacements.push({
    scenarioId: retryScenario.scenarioId,
    repeatId: retryScenario.repeatId,
    originalProvider: original.provider,
    retryProvider: retryScenario.provider,
    retrySource: path.basename(retryPath),
    retrySourceSha256: retryRun.source.sha256,
  });
}

const scenarios = [...originalByKey.values()].sort((left, right) => (
  left.repeatId - right.repeatId
  || left.scenarioId.localeCompare(right.scenarioId)
));
assert(scenarios.length === 600, "merged result does not contain 600 scenarios");
assert(
  scenarios.every((scenario) => !isRetryableInfrastructureFailure(scenario)),
  "merged result still contains a retryable infrastructure failure",
);

const idsByRepeat = new Map();
for (const repeatId of [1, 2, 3]) {
  const ids = scenarios
    .filter((scenario) => scenario.repeatId === repeatId)
    .map((scenario) => scenario.scenarioId);
  assert(ids.length === 200, `repeat ${repeatId} does not contain 200 scenarios`);
  idsByRepeat.set(repeatId, new Set(ids));
}
const repeatOneIds = idsByRepeat.get(1);
for (const repeatId of [2, 3]) {
  const ids = idsByRepeat.get(repeatId);
  assert(
    ids.size === repeatOneIds.size
      && [...repeatOneIds].every((scenarioId) => ids.has(scenarioId)),
    `repeat ${repeatId} scenario set differs from repeat 1`,
  );
}

const summary = buildSummary(scenarios);
const timestamp = new Date().toISOString();
const record = {
  timestamp,
  run: {
    harness: "OpenClaw + StructureClaw tool environment + GLM-5.2",
    modelFamily: "GLM-5.2",
    repeatIds: [1, 2, 3],
    providerLanes: ["paratera", "mine"],
    openClaw: {
      version: OPENCLAW_VERSION,
      package: `openclaw@${OPENCLAW_VERSION}`,
    },
    plannedScenarioCount: 600,
    completedScenarioCount: scenarios.length,
    completed: true,
    finishedAt: timestamp,
    validity: {
      phase: "development",
      paperEligible: false,
      reason: "merged development runs; formal-job metadata is not present",
    },
    sourceRuns: sourceRuns.map((run) => run.source),
    infrastructureReplacementCount: replacements.length,
  },
  ...summary,
  infrastructureReplacements: replacements,
  scenarios,
};

fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(
  `Merged ${record.totalScenarios} scenarios with ${replacements.length} `
  + `infrastructure replacements into ${outputPath}\n`,
);
