const fs = require("node:fs");
const path = require("node:path");

const resultRoot = path.resolve(
  process.argv[2]
  || path.join(__dirname, "..", "..", "results", "openclaw-r123-20260729"),
);
const batches = [
  ["r1-interactive-paratera", 50],
  ["r1-multimodal-paratera", 50],
  ["r2-standard-paratera", 100],
  ["r2-interactive-mine", 50],
  ["r2-multimodal-mine", 50],
  ["r3-standard-paratera", 100],
  ["r3-interactive-paratera", 50],
  ["r3-multimodal-paratera", 50],
];

const rows = batches.map(([id, planned]) => {
  const resultPath = path.join(resultRoot, `${id}.json`);
  let result = null;
  try {
    result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch {
    // A checkpoint can be briefly unreadable while its writer replaces it.
  }
  const scenarios = Array.isArray(result?.scenarios) ? result.scenarios : [];
  const retryableInfrastructure = scenarios.filter((scenario) =>
    (scenario.metrics || []).some((metric) => (
      metric.metric === "execution"
      && /^OpenClaw exited with code 1:/i.test(String(metric.actual || ""))
    ))).length;
  const timeouts = scenarios.filter((scenario) =>
    (scenario.metrics || []).some((metric) => (
      metric.metric === "execution"
      && /timed out/i.test(String(metric.actual || ""))
    ))).length;
  return {
    id,
    completed: Number(result?.run?.completedScenarioCount || 0),
    planned,
    passed: Number(result?.passed || 0),
    failed: Number(result?.failed || 0),
    finished: result?.run?.completed === true,
    retryableInfrastructure,
    timeouts,
  };
});

const total = rows.reduce((sum, row) => sum + row.completed, 0);
const finished = rows.filter((row) => row.finished).length;
const retryableInfrastructure = rows.reduce(
  (sum, row) => sum + row.retryableInfrastructure,
  0,
);
const timeouts = rows.reduce((sum, row) => sum + row.timeouts, 0);
const retryRoot = path.join(resultRoot, "retries");
const retryFiles = fs.existsSync(retryRoot)
  ? fs.readdirSync(retryRoot).filter((name) => name.endsWith(".json"))
  : [];
const finishedRetries = retryFiles.filter((name) => {
  try {
    const result = JSON.parse(fs.readFileSync(path.join(retryRoot, name), "utf8"));
    return result.run?.completed === true;
  } catch {
    return false;
  }
}).length;

process.stdout.write(
  `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} `
  + `TOTAL=${total}/500 BATCHES=${finished}/8 `
  + `INFRA=${retryableInfrastructure} TIMEOUTS=${timeouts} `
  + `RETRIES=${finishedRetries}/8\n`,
);
for (const row of rows) {
  process.stdout.write(
    `${row.id} ${row.completed}/${row.planned} `
    + `pass=${row.passed} fail=${row.failed} finished=${row.finished}\n`,
  );
}
