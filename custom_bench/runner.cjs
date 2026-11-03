const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");

const { evaluateScenario } = require("./lib/evaluate.cjs");
const { printScenarioResult, printSummary, writeJsonOutput } = require("./lib/report.cjs");
const { buildRunFingerprints } = require("./lib/run-fingerprint.cjs");
const { installSolverGate } = require("./lib/solver-gate.cjs");

// Resolve the System-Under-Test root (the structureclaw main repo).
// Priority: SCLAW_ROOT env > parent-of-parent (works when this repo is checked
// out as a submodule under <main>/tests/llm-benchmark).
const BENCH_ROOT = __dirname;
const WORK_ROOT = process.env.SCLAW_BENCHMARK_WORK_ROOT
  ? path.resolve(process.env.SCLAW_BENCHMARK_WORK_ROOT)
  : BENCH_ROOT;
const SCLAW_ROOT = process.env.SCLAW_ROOT
  || path.resolve(BENCH_ROOT, "../..");

const BENCHMARK_MODES = ["auto", "oracle-specialist", "generic-only"];
const EXECUTION_MODES = ["web-stream", "full"];
const DEFAULT_CASE_TIMEOUT_MS = 15 * 60 * 1000;
const SUPERVISED_HARD_TIMEOUT_GRACE_MS = 3 * 60 * 1000;
const DEFAULT_PROVIDER_RATE_LIMIT_RERUNS = 5;
const DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS = 30 * 1000;
const DEFAULT_PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS = 2 * 60 * 1000;
const DEFAULT_BENCHMARK_MAX_TOKENS = 16_384;
const BENCHMARK_UTILITY_SKILL_IDS = [
  "validation-structure-model",
  "report-export-builtin",
];
const BENCHMARK_TOOL_ALLOWLIST = new Set([
  "detect_structure_type",
  "extract_draft_params",
  "build_model",
  "validate_model",
  "run_analysis",
  "generate_report",
  "ask_user_clarification",
  "set_session_config",
  "analyze_file",
]);
const VISION_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
if (process.env.YJK_CLOSE_AFTER_RUN === undefined) {
  process.env.YJK_CLOSE_AFTER_RUN = "1";
}
const IMAGE_MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

const DEFAULT_MODES_BY_TASK_FAMILY = {
  standard_workflow: BENCHMARK_MODES,
  interactive_robustness: ["auto"],
  multimodal_reverse_engineering: BENCHMARK_MODES,
};
const ANALYSIS_ENGINE_BY_SKILL = {
  "opensees-static": "builtin-opensees",
  "pkpm-static": "builtin-pkpm",
  "yjk-static": "builtin-yjk",
};

const LEGACY_TASK_FAMILY = {
  "static-analysis": "standard_workflow",
  "error-recovery": "interactive_robustness",
  multimodal: "multimodal_reverse_engineering",
  "reverse-engineering": "multimodal_reverse_engineering",
};

const BENCHMARK_STRUCTURE_TYPE = {
  beam: "beam",
  column: "column",
  "concrete-frame": "concrete-frame",
  "double-span-beam": "continuous-beam",
  frame: "steel-frame",
  generic: "generic",
  "portal-frame": "portal-frame",
  truss: "truss",
};

function deriveBenchmarkStructureType(structureType) {
  return BENCHMARK_STRUCTURE_TYPE[structureType] || structureType || null;
}

function deriveInputModality(scenario) {
  const attachments = Array.isArray(scenario.attachments)
    ? scenario.attachments
    : Array.isArray(scenario.turns)
      ? scenario.turns.flatMap((turn) => Array.isArray(turn.attachments) ? turn.attachments : [])
      : [];
  if (attachments.length === 0) return "text";
  if (attachments.some((item) => String(item.mimeType || "").includes("dxf"))) return "dxf";
  if (attachments.some((item) => String(item.mimeType || "").startsWith("image/"))) return "image";
  return "file";
}

function inferEvaluationFocus(assertions = []) {
  const focus = new Set();
  for (const assertion of assertions) {
    switch (assertion?.type) {
      case "structural_type":
      case "skill_match":
        focus.add("routing");
        break;
      case "has_model":
        focus.add("modeling");
        break;
      case "model_matches":
        focus.add("modeling");
        focus.add("model_match");
        break;
      case "numerical_matches":
        focus.add("analysis");
        focus.add("numerical_match");
        break;
      case "has_analysis":
      case "engine_match":
        focus.add("analysis");
        if (assertion?.type === "engine_match") focus.add("engine_match");
        break;
      case "has_interaction_questions":
      case "should_not_analyze":
      case "safe_non_execution":
      case "no_bad_model":
        focus.add("interaction");
        break;
      case "has_report":
        focus.add("report");
        break;
      case "natural_language":
        focus.add("semantic");
        break;
      default:
        break;
    }
  }
  return [...focus];
}

function collectScenarioAssertions(scenario) {
  if (Array.isArray(scenario.expect?.assertions)) {
    return scenario.expect.assertions;
  }
  if (Array.isArray(scenario.turns)) {
    return scenario.turns.flatMap((turn) => Array.isArray(turn.assertions) ? turn.assertions : []);
  }
  return [];
}

function normalizeScenarioMetadata(scenario) {
  const taskFamily = scenario.taskFamily || LEGACY_TASK_FAMILY[scenario.category] || "standard_workflow";
  const inputModality = scenario.inputModality || deriveInputModality(scenario);
  const skillTarget = scenario.skillTarget || scenario.expect?.skills?.primary || null;
  const structureType = scenario.structureType || skillTarget || null;
  const benchmarkStructureType = scenario.benchmarkStructureType || deriveBenchmarkStructureType(structureType);
  const split = scenario.split || (taskFamily === "multimodal_reverse_engineering" ? "auxiliary" : "core");
  const difficulty = scenario.difficulty || (taskFamily === "standard_workflow" ? "L1" : "L2");
  const analysisSkillTarget = scenario.analysisSkillTarget || "opensees-static";
  const analysisEngineTarget = scenario.analysisEngineTarget
    || ANALYSIS_ENGINE_BY_SKILL[analysisSkillTarget]
    || null;
  const evaluationFocus = Array.isArray(scenario.evaluationFocus) && scenario.evaluationFocus.length > 0
    ? scenario.evaluationFocus
    : inferEvaluationFocus(collectScenarioAssertions(scenario));
  if (taskFamily === "interactive_robustness" && !evaluationFocus.includes("interaction")) {
    evaluationFocus.push("interaction");
  }

  return {
    ...scenario,
    split,
    taskFamily,
    inputModality,
    structureType,
    benchmarkStructureType,
    difficulty,
    skillTarget,
    analysisSkillTarget,
    analysisEngineTarget,
    evaluationFocus,
  };
}

function resolveSutRoot(explicit) {
  const root = explicit || SCLAW_ROOT;
  const marker = path.join(root, "backend", "package.json");
  if (!fs.existsSync(marker)) {
    throw new Error(
      `SCLAW_ROOT does not look like a structureclaw checkout: ${root}\n` +
      `Set SCLAW_ROOT env var to the structureclaw repo root.`,
    );
  }
  return root;
}

function collectScenarioFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectScenarioFiles(fullPath);
    if (entry.isFile() && entry.name.endsWith(".json")) return [fullPath];
    return [];
  });
}

function scenarioListFromPayload(parsed, file) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") return [parsed];
  throw new Error(
    `Scenario file must contain a scenario object or an array: ${path.relative(BENCH_ROOT, file)}`,
  );
}

async function importBackendModules(sutRoot) {
  const runtimePath = path.join(sutRoot, "backend", "dist", "agent-runtime", "index.js");
  const servicePath = path.join(sutRoot, "backend", "dist", "agent-langgraph", "agent-service.js");

  const runtimeMod = await import(pathToFileURL(runtimePath).href);
  const serviceMod = await import(`${pathToFileURL(servicePath).href}?bench=${Date.now()}`);

  return {
    AgentSkillRuntime: runtimeMod.AgentSkillRuntime,
    LangGraphAgentService: serviceMod.LangGraphAgentService,
  };
}

function loadScenarios(options) {
  const scenariosDir = path.join(BENCH_ROOT, "scenarios");
  const files = collectScenarioFiles(scenariosDir);
  let all = [];
  for (const file of files) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    all.push(...scenarioListFromPayload(parsed, file).map(normalizeScenarioMetadata));
  }
  if (options.scenarioId) {
    all = all.filter((s) => s.id === options.scenarioId);
  }
  if (options.taskFamily) {
    all = all.filter((s) => s.taskFamily === options.taskFamily);
  }
  if (options.split) {
    all = all.filter((s) => s.split === options.split);
  }
  return all;
}

function orderScenarios(scenarios, seed) {
  if (!seed || scenarios.length < 2) return [...scenarios];
  const digest = createHash("sha256").update(String(seed)).digest();
  const offset = digest.readUInt32BE(0) % scenarios.length;
  return [...scenarios.slice(offset), ...scenarios.slice(0, offset)];
}

function parseBenchmarkOptions(args) {
  let scenarioId;
  let outputPath;
  let sutRoot;
  let mode = "auto";
  let execution = "web-stream";
  let caseTimeoutMs = Number(process.env.LLM_BENCHMARK_CASE_TIMEOUT_MS || DEFAULT_CASE_TIMEOUT_MS);
  let taskFamily;
  let split;
  let supervise = false;
  let formal = false;
  let repeatId = null;
  let scenarioOrderSeed = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scenario" && args[i + 1]) {
      scenarioId = args[++i];
    } else if (args[i] === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (args[i] === "--sut-root" && args[i + 1]) {
      sutRoot = args[++i];
    } else if (args[i] === "--mode" && args[i + 1]) {
      mode = args[++i];
    } else if (args[i] === "--execution" && args[i + 1]) {
      execution = args[++i];
    } else if (args[i] === "--case-timeout-ms" && args[i + 1]) {
      caseTimeoutMs = Number(args[++i]);
    } else if (args[i] === "--repeat-id" && args[i + 1]) {
      repeatId = Number(args[++i]);
    } else if (args[i] === "--scenario-order-seed" && args[i + 1]) {
      scenarioOrderSeed = args[++i];
    } else if ((args[i] === "--family" || args[i] === "--task-family") && args[i + 1]) {
      taskFamily = args[++i];
    } else if (args[i] === "--split" && args[i + 1]) {
      split = args[++i];
    } else if (args[i] === "--supervise") {
      supervise = true;
    } else if (args[i] === "--formal") {
      formal = true;
    }
  }
  if (mode !== "all" && !BENCHMARK_MODES.includes(mode)) {
    throw new Error(`Unsupported benchmark mode: ${mode}. Use one of: ${BENCHMARK_MODES.join(", ")}, all`);
  }
  if (!EXECUTION_MODES.includes(execution)) {
    throw new Error(`Unsupported execution mode: ${execution}. Use one of: ${EXECUTION_MODES.join(", ")}`);
  }
  if (!Number.isFinite(caseTimeoutMs) || caseTimeoutMs <= 0) {
    throw new Error("--case-timeout-ms must be a positive number");
  }
  return {
    scenarioId,
    outputPath,
    sutRoot,
    mode,
    execution,
    caseTimeoutMs,
    taskFamily,
    split,
    supervise,
    formal,
    repeatId,
    scenarioOrderSeed,
  };
}

function safeEndpoint(value) {
  if (!value) return null;
  try {
    const endpoint = new URL(value);
    endpoint.username = "";
    endpoint.password = "";
    endpoint.search = "";
    endpoint.hash = "";
    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return "(invalid URL)";
  }
}

function gitMetadata(root) {
  const runGit = (args) => spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  const revision = runGit(["rev-parse", "HEAD"]);
  const status = runGit(["status", "--porcelain"]);
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : null,
    dirty: status.status === 0 ? status.stdout.trim().length > 0 : null,
  };
}

function formalRunViolations(options, scenarios, revisions) {
  if (!options.formal) return [];
  const violations = [];
  if (options.scenarioId) {
    violations.push("formal runs cannot select a single scenario");
  }
  if (!options.outputPath) {
    violations.push("formal runs require --output");
  }
  if (!options.supervise) {
    violations.push("formal runs require --supervise");
  }
  if (![1, 2, 3].includes(options.repeatId)) {
    violations.push("formal runs require --repeat-id 1, 2, or 3");
  }
  if (!process.env.SCLAW_BENCHMARK_RUNTIME_ID) {
    violations.push("formal runs require an isolated SCLAW_BENCHMARK_RUNTIME_ID");
  }
  if (!["per-engine", "global"].includes(process.env.SCLAW_BENCHMARK_SOLVER_GATE || "")) {
    violations.push("formal runs require the benchmark solver gate");
  }
  if (!process.env.SCLAW_BENCHMARK_FORMAL_JOB_ID) {
    violations.push("formal runs require SCLAW_BENCHMARK_FORMAL_JOB_ID");
  }
  if (!/^[a-f0-9]{64}$/i.test(process.env.SCLAW_BENCHMARK_FORMAL_MATRIX_SHA256 || "")) {
    violations.push("formal runs require SCLAW_BENCHMARK_FORMAL_MATRIX_SHA256");
  }
  const yjkCooldownMs = Number(process.env.SCLAW_BENCHMARK_YJK_COOLDOWN_MS);
  if (!Number.isSafeInteger(yjkCooldownMs) || yjkCooldownMs <= 0) {
    violations.push("formal runs require a positive YJK solver cooldown");
  }
  if (scenarios.some((scenario) => Number(scenario.maxRetries || 0) !== 0)) {
    violations.push("formal runs require maxRetries=0 for every scenario");
  }
  for (const [name, revision] of Object.entries(revisions)) {
    if (!revision?.revision) {
      violations.push(`${name} revision is unavailable`);
    } else if (revision.dirty !== false) {
      violations.push(`${name} worktree must be clean`);
    }
  }
  return violations;
}

function assertFormalRunEligibility(options, sutRoot, scenarios) {
  if (!options.formal) return;
  const revisions = {
    structureclaw: gitMetadata(sutRoot),
    benchmark: gitMetadata(BENCH_ROOT),
  };
  const violations = formalRunViolations(options, scenarios, revisions);
  if (violations.length > 0) {
    throw new Error(
      "Formal benchmark run rejected:\n"
      + violations.map((violation) => `- ${violation}`).join("\n"),
    );
  }
}

function configuredCommercialVersions() {
  const versions = {
    yjkVersion: process.env.YJK_VERSION || null,
    pkpmVersion: process.env.PKPM_VERSION || null,
  };
  const dataDir = process.env.SCLAW_DATA_DIR;
  if ((!versions.yjkVersion || !versions.pkpmVersion) && dataDir) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
      versions.yjkVersion ||= settings.yjk?.version || null;
      const cyclePath = settings.pkpm?.cyclePath;
      if (!versions.pkpmVersion && typeof cyclePath === "string" && cyclePath.trim()) {
        versions.pkpmVersion = path.basename(path.dirname(path.dirname(cyclePath))) || null;
      }
    } catch {
      // Runtime settings are optional; explicit environment values remain authoritative.
    }
  }
  return versions;
}

function configuredAnalysisPython(sutRoot) {
  const dataDir = process.env.SCLAW_DATA_DIR;
  if (dataDir) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"));
      if (typeof settings.analysis?.pythonBin === "string" && settings.analysis.pythonBin.trim()) {
        return settings.analysis.pythonBin.trim();
      }
    } catch {
      // Runtime settings are optional; fall through to the standard analysis runtime.
    }
  }
  if (process.env.SCLAW_ANALYSIS_PYTHON) return process.env.SCLAW_ANALYSIS_PYTHON;
  const executable = process.platform === "win32" ? "python.exe" : "python";
  const candidates = [
    path.join(sutRoot, "backend", ".venv", process.platform === "win32" ? "Scripts" : "bin", executable),
    process.env.USERPROFILE
      ? path.join(
          process.env.USERPROFILE,
          ".structureclaw",
          ".venv",
          process.platform === "win32" ? "Scripts" : "bin",
          executable,
        )
      : null,
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function detectOpenSeesRuntime(sutRoot, run = spawnSync) {
  const pythonBin = configuredAnalysisPython(sutRoot);
  if (!pythonBin) return null;
  const script = [
    "import importlib.metadata as metadata, json, sys",
    "import openseespy.opensees as ops",
    "runtime = 'openseespywin' if sys.platform == 'win32' else 'openseespylinux'",
    "def version(name):",
    "    try:",
    "        return metadata.version(name)",
    "    except metadata.PackageNotFoundError:",
    "        return None",
    "print(json.dumps({'packageVersion': version('openseespy'), 'runtimePackage': runtime, "
      + "'runtimePackageVersion': version(runtime), 'engineVersion': str(ops.version())}))",
  ].join("\n");
  const probe = run(pythonBin, ["-c", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (probe.status !== 0) return null;
  try {
    const payload = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
    return {
      packageVersion: payload.packageVersion || null,
      runtimePackage: payload.runtimePackage || null,
      runtimePackageVersion: payload.runtimePackageVersion || null,
      engineVersion: payload.engineVersion || null,
    };
  } catch {
    return null;
  }
}

function buildRunMetadata(options, sutRoot, scenarios) {
  const configuredProviderTimeout = Number(process.env.LLM_BENCHMARK_PROVIDER_REQUEST_TIMEOUT_MS);
  const providerRequestTimeoutMs = Number.isFinite(configuredProviderTimeout)
    && configuredProviderTimeout > 0
    ? configuredProviderTimeout
    : options.caseTimeoutMs;
  const commercialVersions = configuredCommercialVersions();
  const openSees = process.env.SCLAW_BENCHMARK_SUPERVISED_CHILD === "1"
    ? null
    : detectOpenSeesRuntime(sutRoot);
  const metadata = {
    schemaVersion: "structureclaw-benchmark-run/v3",
    runId: process.env.LLM_BENCHMARK_RUN_ID || randomUUID(),
    repeatId: options.repeatId || null,
    startedAt: new Date().toISOString(),
    plannedScenarioCount: scenarios.length,
    selection: {
      scenarioId: options.scenarioId || null,
      taskFamily: options.taskFamily || null,
      split: options.split || null,
      mode: options.mode,
      execution: options.execution,
      supervised: options.supervise,
      caseTimeoutMs: options.caseTimeoutMs,
      repeatId: options.repeatId || null,
      scenarioOrderSeed: options.scenarioOrderSeed || null,
    },
    models: {
      primary: {
        configId: process.env.LLM_BENCHMARK_PRIMARY_CONFIG_ID || null,
        model: process.env.LLM_MODEL || null,
        endpoint: safeEndpoint(process.env.LLM_BASE_URL),
        temperature: 0,
        maxTokens: benchmarkMaxTokens(),
        providerMaxRetries: 0,
        timeoutMs: providerRequestTimeoutMs,
      },
      judge: {
        configId: process.env.LLM_BENCHMARK_JUDGE_CONFIG_ID || null,
        model: process.env.LLM_JUDGE_MODEL || process.env.LLM_MODEL || null,
        endpoint: safeEndpoint(process.env.LLM_JUDGE_BASE_URL || process.env.LLM_BASE_URL),
        temperature: 0,
        maxTokens: 4096,
        maxAttempts: 3,
        timeoutMs: 120000,
      },
      vision: process.env.LLM_VISION_MODEL
        ? {
            configId: process.env.LLM_BENCHMARK_VISION_CONFIG_ID || null,
            model: process.env.LLM_VISION_MODEL,
            endpoint: safeEndpoint(process.env.LLM_VISION_BASE_URL),
            temperature: process.env.LLM_VISION_OMIT_TEMPERATURE === "1"
              ? null
              : process.env.LLM_VISION_TEMPERATURE === undefined
                || process.env.LLM_VISION_TEMPERATURE === ""
                ? 0
                : Number(process.env.LLM_VISION_TEMPERATURE),
            maxTokens: benchmarkMaxTokens(),
            providerMaxRetries: 0,
            timeoutMs: providerRequestTimeoutMs,
          }
        : null,
    },
    revisions: {
      structureclaw: gitMetadata(sutRoot),
      benchmark: gitMetadata(BENCH_ROOT),
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      yjkVersion: commercialVersions.yjkVersion,
      pkpmVersion: commercialVersions.pkpmVersion,
      openSees,
      llmRoutingAndExtractionOnly: process.env.SCLAW_BENCHMARK_LLM_ONLY === "1",
      runtimeId: process.env.SCLAW_BENCHMARK_RUNTIME_ID || null,
      backendPrebuilt: process.env.SCLAW_BENCHMARK_BACKEND_PREBUILT === "1",
    },
    measurement: {
      duration: "vision preprocessing plus agent execution; excludes judge evaluation and setup",
      primaryTokens: "provider usage attached to checkpointed agent and benchmark nested-call messages; includes nested routing and parameter extraction",
      visionTokens: "provider usage from benchmark vision preprocessing, reported separately",
      judgeTokens: "excluded from agent-efficiency metrics",
      totalApiCostAvailable: false,
    },
    protocol: {
      phase: options.formal ? "formal" : "development",
      targeted: Boolean(options.scenarioId),
      commonCoreComparison: true,
      automaticModelRetries: 0,
      solverGate: process.env.SCLAW_BENCHMARK_SOLVER_GATE || "off",
      yjkCooldownMs: Number(process.env.SCLAW_BENCHMARK_YJK_COOLDOWN_MS || 0),
      formalJobId: process.env.SCLAW_BENCHMARK_FORMAL_JOB_ID || null,
      formalMatrixSha256: process.env.SCLAW_BENCHMARK_FORMAL_MATRIX_SHA256 || null,
    },
  };
  const inheritedFingerprints = process.env.SCLAW_BENCHMARK_FINGERPRINTS_JSON;
  if (inheritedFingerprints) {
    metadata.fingerprints = JSON.parse(inheritedFingerprints);
  } else {
    metadata.fingerprints = buildRunFingerprints({
      sutRoot,
      benchRoot: BENCH_ROOT,
      scenarios,
      runtimeConfig: {
        selection: metadata.selection,
        models: metadata.models,
        runtime: metadata.runtime,
        protocol: metadata.protocol,
      },
    });
  }
  return metadata;
}

function benchmarkMaxTokens() {
  const configured = Number(process.env.SCLAW_BENCHMARK_MAX_TOKENS);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_BENCHMARK_MAX_TOKENS;
}

function buildFeedbackFromEvaluation(evaluation, locale = "zh") {
  const isEn = locale === "en";
  const failed = (evaluation.metrics || []).filter(
    (m) => !m.pass && m.metric !== "duration" && m.metric !== "toolCalls",
  );
  if (failed.length === 0) return "";
  const details = failed.map(
    (m) => isEn
      ? `${m.metric} check failed: expected ${m.expected}, got ${m.actual}`
      : `${m.metric} 检查失败：期望 ${m.expected}，实际得到 ${m.actual}`,
  ).join(isEn ? "; " : "；");
  return isEn
    ? `Previous attempt failed: ${details}. Please fix these issues.`
    : `上次尝试失败：${details}。请修正以上问题。`;
}

function resolveAttachmentPaths(scenario) {
  const resolve = (attachments) => {
    if (!attachments) return attachments;
    return attachments.map((a) => {
      if (path.isAbsolute(a.relPath)) return a;
      // Strip legacy "tests/llm-benchmark/" prefix if present, then resolve
      // relative to this benchmark repo root.
      const rel = a.relPath.replace(/^tests\/llm-benchmark\//, "");
      return { ...a, relPath: path.resolve(BENCH_ROOT, rel) };
    });
  };
  const resolved = {
    ...scenario,
    attachments: resolve(scenario.attachments),
  };
  if (Array.isArray(scenario.turns)) {
    resolved.turns = scenario.turns.map((t) => ({ ...t, attachments: resolve(t.attachments) }));
  }
  return resolved;
}

function attachSolverGateProfile(evaluation, solverGate) {
  if (!evaluation || !solverGate) return evaluation;
  const events = solverGate.snapshot();
  const solverQueueWaitMs = events.reduce(
    (total, event) => total + Number(event.queueWaitMs || 0),
    0,
  );
  const solverExecutionMs = events.reduce(
    (total, event) => total + Number(event.solverExecutionMs || 0),
    0,
  );
  const cooldownMs = events.reduce(
    (total, event) => total + Number(event.cooldownMs || 0),
    0,
  );
  evaluation.executionProfile = {
    ...(evaluation.executionProfile || {}),
    solverGate: {
      enabled: solverGate.enabled,
      mode: solverGate.mode,
      events,
      solverQueueWaitMs,
      solverExecutionMs,
      cooldownMs,
    },
    effectiveDurationMs: Math.max(
      0,
      Number(evaluation.durationMs || 0) - solverQueueWaitMs - cooldownMs,
    ),
  };
  return evaluation;
}

function runtimeUploadRoot() {
  const dataDir = process.env.SCLAW_DATA_DIR;
  if (!dataDir) {
    throw new Error("SCLAW_DATA_DIR is required for benchmark attachment uploads");
  }
  return path.join(dataDir, ".uploads");
}

function safeAttachmentName(value, fallback) {
  const raw = String(value || fallback || "attachment").replace(/[^A-Za-z0-9._-]/g, "-");
  return raw && raw !== "." && raw !== ".." ? raw : "attachment";
}

function isImageAttachment(attachment) {
  const mimeType = String(attachment?.mimeType || "");
  if (mimeType.startsWith("image/")) return true;
  const ext = path.extname(String(attachment?.relPath || attachment?.originalName || "")).toLowerCase();
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_BY_EXT, ext);
}

function imageMimeType(attachment, filePath) {
  const mimeType = String(attachment?.mimeType || "");
  if (mimeType.startsWith("image/")) return mimeType;
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()] || "image/png";
}

function filterImageAttachments(attachments) {
  if (!Array.isArray(attachments)) return attachments;
  return attachments.filter((attachment) => !isImageAttachment(attachment));
}

function attachmentPathForVision(attachment) {
  const relPath = String(attachment?.relPath || "");
  if (path.isAbsolute(relPath)) return relPath;
  if (relPath.startsWith(".uploads/") || relPath.startsWith(".uploads\\")) {
    const dataDir = process.env.SCLAW_DATA_DIR;
    if (!dataDir) {
      throw new Error("SCLAW_DATA_DIR is required to resolve runtime upload attachments");
    }
    return path.resolve(dataDir, relPath);
  }
  return path.resolve(BENCH_ROOT, relPath.replace(/^tests\/llm-benchmark\//, ""));
}

function visionConfig() {
  const model = process.env.LLM_VISION_MODEL;
  const baseUrl = process.env.LLM_VISION_BASE_URL;
  const apiKey = process.env.LLM_VISION_API_KEY;
  const temperatureText = process.env.LLM_VISION_TEMPERATURE;
  const omitTemperature = process.env.LLM_VISION_OMIT_TEMPERATURE === "1";
  if (!model && !baseUrl && !apiKey) return null;
  if (!model || !baseUrl || !apiKey) {
    throw new Error("LLM_VISION_MODEL, LLM_VISION_BASE_URL, and LLM_VISION_API_KEY must be set together");
  }
  const temperature = omitTemperature
    ? null
    : temperatureText === undefined || temperatureText === ""
    ? 0
    : Number(temperatureText);
  if (temperature !== null && !Number.isFinite(temperature)) {
    throw new Error("LLM_VISION_TEMPERATURE must be a finite number when set");
  }
  return { model, baseUrl, apiKey, temperature, maxTokens: benchmarkMaxTokens() };
}

function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return /\/v\d+$/i.test(trimmed)
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;
}

async function fetchWithAbortSignal(url, init, signal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(abortReason(signal));
  const normalizedTimeoutMs = Number(timeoutMs);
  const timeout = Number.isFinite(normalizedTimeoutMs) && normalizedTimeoutMs > 0
    ? setTimeout(() => {
        controller.abort(new Error(`provider request timed out after ${normalizedTimeoutMs}ms`));
      }, normalizedTimeoutMs)
    : null;
  if (timeout && typeof timeout.unref === "function") timeout.unref();
  try {
    if (signal) {
      if (signal.aborted) throw abortReason(signal);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

function contentTextFromOpenAiMessage(message) {
  const content = message?.content;
  let contentText = "";
  if (typeof content === "string") contentText = content.trim();
  if (Array.isArray(content)) {
    contentText = content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  if (contentText) return contentText;
  const reasoning = message?.reasoning_content || message?.provider_specific_fields?.reasoning_content;
  return typeof reasoning === "string" ? reasoning.trim() : "";
}

function parseVisionSummary(message, finishReason) {
  const contentText = contentTextFromOpenAiMessage(message);
  const diagnostic = `finishReason=${finishReason || "unknown"}, contentLength=${contentText.length}`;
  let parsed;
  try {
    parsed = JSON.parse(contentText);
  } catch {
    throw new Error(`VISION_MODEL_INVALID_OUTPUT: invalid JSON; ${diagnostic}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`VISION_MODEL_INVALID_OUTPUT: schema requires an object; ${diagnostic}`);
  }
  if (
    !(typeof parsed.structuralType === "string" || parsed.structuralType === null)
    || !(typeof parsed.coordinateSystem === "string" || parsed.coordinateSystem === null)
  ) {
    throw new Error(
      `VISION_MODEL_INVALID_OUTPUT: schema requires string|null structuralType and coordinateSystem; ${diagnostic}`,
    );
  }
  const arrayFields = [
    "nodes",
    "members",
    "geometry",
    "loads",
    "supports",
    "materialsOrSections",
    "missingOrUnclear",
    "notes",
  ];
  if (arrayFields.some((field) => !Array.isArray(parsed[field]))) {
    throw new Error(`VISION_MODEL_INVALID_OUTPUT: schema requires all declared array fields; ${diagnostic}`);
  }
  return JSON.stringify({
    structuralType: parsed.structuralType,
    coordinateSystem: parsed.coordinateSystem,
    ...Object.fromEntries(arrayFields.map((field) => [field, parsed[field]])),
  });
}

function buildVisionPrompt(locale) {
  const base = locale === "en"
    ? [
      "You are the vision parser for a structural engineering benchmark.",
      "Extract only information visible in the image. Do not invent missing dimensions, loads, material grades, or supports.",
      "Enumerate every visible structural node or joint and every visible member connectivity by endpoint. Use drawing labels when present; otherwise assign stable local labels such as N1 and N2.",
      "For each support, report its node and constrained and free degrees of freedom when the symbol or annotation makes them visible. Distinguish supports from analysis nodes, dimension subdivisions, and ordinary joints.",
      "For trusses, preserve the complete visible chord, vertical, and diagonal topology. If a member endpoint or crossing is occluded or ambiguous, record that in missingOrUnclear instead of inferring it.",
      "If the drawing gives an area pressure and a tributary width used to derive an applied line load, report the derived line load exactly once. Keep the pressure and tributary width as source annotations in notes, not as an additional applied load, unless the drawing explicitly applies both.",
      "Return compact JSON only, without markdown fences.",
      "Schema: {\"structuralType\": string|null, \"coordinateSystem\": string|null, \"nodes\": string[], \"members\": string[], \"geometry\": string[], \"loads\": string[], \"supports\": string[], \"materialsOrSections\": string[], \"missingOrUnclear\": string[], \"notes\": string[]}.",
    ]
    : [
      "你是结构工程 benchmark 的图片解析器。",
      "只提取图片中可见的文字、标注和几何关系；不要臆测缺失的尺寸、荷载、材料等级或边界条件。",
      "逐一列出每个可见结构节点或连接点，并按端点列出每根可见构件的连接关系。优先使用图中节点编号；没有编号时使用 N1、N2 等稳定的局部编号。",
      "对每个支座列出所在节点；当符号或标注足够明确时，同时列出受约束和自由的自由度。区分支座、分析节点、尺寸分段点和普通连接点。",
      "对于桁架，完整保留图中可见的上下弦、竖杆和斜杆拓扑；若构件端点或交叉处被遮挡或含糊，应写入 missingOrUnclear，不能自行推断。",
      "若图中给出面荷载及用于折算的受荷宽度，应只把折算后的线荷载作为一次实际施加荷载；面荷载和受荷宽度仅作为 notes 中的计算依据，除非图纸明确要求两者分别叠加。",
      "只返回紧凑 JSON，不要使用 markdown 代码块。",
      "Schema: {\"structuralType\": string|null, \"coordinateSystem\": string|null, \"nodes\": string[], \"members\": string[], \"geometry\": string[], \"loads\": string[], \"supports\": string[], \"materialsOrSections\": string[], \"missingOrUnclear\": string[], \"notes\": string[]}.",
    ];
  return base.join("\n");
}

async function parseImageAttachmentWithVision(attachment, locale, signal, imageIndex) {
  const cfg = visionConfig();
  if (!cfg) {
    throw new Error("Image benchmark scenario requires LLM_VISION_MODEL/BASE_URL/API_KEY");
  }

  const filePath = attachmentPathForVision(attachment);
  const stat = fs.statSync(filePath);
  if (stat.size > VISION_MAX_IMAGE_BYTES) {
    throw new Error(`Image attachment is too large for benchmark vision parsing: ${attachment.originalName || filePath}`);
  }
  const dataUri = `data:${imageMimeType(attachment, filePath)};base64,${fs.readFileSync(filePath).toString("base64")}`;
  const body = {
    model: cfg.model,
    ...(cfg.temperature === null ? {} : { temperature: cfg.temperature }),
    max_tokens: cfg.maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUri } },
          { type: "text", text: buildVisionPrompt(locale) },
        ],
      },
    ],
  };
  const response = await fetchWithAbortSignal(
    chatCompletionsUrl(cfg.baseUrl),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    signal,
    process.env.LLM_BENCHMARK_PROVIDER_REQUEST_TIMEOUT_MS,
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Vision API returned HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Vision API returned non-JSON response: ${text.slice(0, 300)}`);
  }
  const summary = parseVisionSummary(
    parsed.choices?.[0]?.message,
    parsed.choices?.[0]?.finish_reason,
  );
  const usage = parsed.usage && typeof parsed.usage === "object"
    ? {
        inputTokens: Number(parsed.usage.prompt_tokens),
        outputTokens: Number(parsed.usage.completion_tokens),
        totalTokens: Number(parsed.usage.total_tokens),
      }
    : null;
  return {
    imageIndex,
    model: cfg.model,
    summary,
    usage,
  };
}

async function buildVisionSummaries(attachments, locale, signal) {
  const imageAttachments = Array.isArray(attachments) ? attachments.filter(isImageAttachment) : [];
  const summaries = [];
  for (let index = 0; index < imageAttachments.length; index++) {
    summaries.push(await parseImageAttachmentWithVision(imageAttachments[index], locale, signal, index + 1));
  }
  return summaries;
}

function appendVisionUsageMetrics(evaluation, summaries) {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, available: false };
  for (const item of summaries) {
    const input = Number(item.usage?.inputTokens);
    const output = Number(item.usage?.outputTokens);
    const total = Number(item.usage?.totalTokens);
    const hasInput = Number.isFinite(input) && input >= 0;
    const hasOutput = Number.isFinite(output) && output >= 0;
    const hasTotal = Number.isFinite(total) && total >= 0;
    if (!hasInput && !hasOutput && !hasTotal) continue;
    usage.inputTokens += hasInput ? input : 0;
    usage.outputTokens += hasOutput ? output : 0;
    usage.totalTokens += hasTotal ? total : (hasInput ? input : 0) + (hasOutput ? output : 0);
    usage.available = true;
  }
  if (!usage.available) return evaluation;
  evaluation.metrics.push(
    {
      metric: "visionInputTokens",
      pass: true,
      expected: "(info, lower is better)",
      actual: String(usage.inputTokens),
    },
    {
      metric: "visionOutputTokens",
      pass: true,
      expected: "(info, lower is better)",
      actual: String(usage.outputTokens),
    },
    {
      metric: "visionTotalTokens",
      pass: true,
      expected: "(info, lower is better)",
      actual: String(usage.totalTokens),
    },
  );
  return evaluation;
}

function engineeringSpecificationText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function attachVisionSummariesToMessage(message, summaries, locale, engineeringSpecification = "") {
  const specification = engineeringSpecificationText(engineeringSpecification);
  if (summaries.length === 0 && !specification) return message;

  const sections = [];
  if (summaries.length > 0) {
    const header = locale === "en"
      ? "[Benchmark vision attachment summaries]"
      : "[Benchmark 多模态附件解析结果]";
    const instruction = locale === "en"
      ? "The following information was extracted from the attached images before the agent run. Do not call analyze_file for these image attachments again. Preserve explicit node coordinates and member connectivity exactly in downstream tool calls; do not introduce conflicting story or bay counts when paraphrasing an internally consistent topology."
      : "以下信息已在 agent 运行前从附件图片中提取。不要再对这些图片附件调用 analyze_file。后续工具调用必须准确保留明确给出的节点坐标和构件连接关系；当拓扑内部一致时，不要在转述中引入与其冲突的层数或跨数。";
    const blocks = summaries.map((item) => [
      `#${item.imageIndex}`,
      item.summary,
    ].join("\n"));
    sections.push(`${header}\n${instruction}\n\n${blocks.join("\n\n")}`);
  }

  const taskHeader = locale === "en" ? "[User task]" : "[用户任务]";
  sections.push(`${taskHeader}\n${message}`);
  if (specification) {
    const header = locale === "en" ? "[Engineering specification]" : "[工程说明]";
    sections.push(`${header}\n${specification}`);
  }
  return sections.join("\n\n");
}

function copyAttachmentsToRuntimeUploads(attachments, conversationId) {
  if (!attachments) return attachments;
  const uploadDir = path.join(runtimeUploadRoot(), conversationId);
  fs.mkdirSync(uploadDir, { recursive: true });
  return attachments.map((attachment, index) => {
    const sourcePath = path.isAbsolute(attachment.relPath)
      ? attachment.relPath
      : path.resolve(BENCH_ROOT, attachment.relPath.replace(/^tests\/llm-benchmark\//, ""));
    const extension = path.extname(sourcePath).toLowerCase();
    const originalName = safeAttachmentName(`attachment-${index + 1}${extension}`, `attachment-${index + 1}`);
    const storedName = originalName;
    fs.copyFileSync(sourcePath, path.join(uploadDir, storedName));
    return {
      ...attachment,
      fileId: `${conversationId}-file-${index}`,
      originalName,
      relPath: path.join(".uploads", conversationId, storedName).replace(/\\/g, "/"),
    };
  });
}

function prepareScenarioAttachmentsForRun(scenario, conversationId) {
  const prepared = {
    ...scenario,
    attachments: copyAttachmentsToRuntimeUploads(scenario.attachments, conversationId),
  };
  if (Array.isArray(scenario.turns)) {
    prepared.turns = scenario.turns.map((turn) => ({
      ...turn,
      attachments: copyAttachmentsToRuntimeUploads(turn.attachments, conversationId),
    }));
  }
  return prepared;
}

function normalizeScenario(scenario) {
  if (scenario.turns) {
    return { ...scenario, _multiTurn: true };
  }
  return {
    ...scenario,
    _multiTurn: false,
    turns: [
      {
        message: scenario.message,
        assertions: scenario.expect?.assertions,
        attachments: scenario.attachments,
      },
    ],
  };
}

function safeConversationIdPart(value) {
  return String(value || "scenario").replace(/[^A-Za-z0-9_-]/g, "-");
}

function benchmarkConversationId() {
  return `bench-${randomUUID()}`;
}

function modesForScenario(scenario) {
  if (Array.isArray(scenario.benchmarkModes) && scenario.benchmarkModes.length > 0) {
    return scenario.benchmarkModes.filter((mode) => BENCHMARK_MODES.includes(mode));
  }
  return DEFAULT_MODES_BY_TASK_FAMILY[scenario.taskFamily] || ["auto"];
}

function resolveScenarioRuns(scenarios, options) {
  return scenarios.flatMap((scenario) => {
    const supportedModes = modesForScenario(scenario);
    const modes = options.mode === "all" ? supportedModes : supportedModes.filter((mode) => mode === options.mode);
    return modes.map((mode) => applyBenchmarkMode(scenario, mode));
  });
}

function assertionsForMode(assertions, mode) {
  if (!Array.isArray(assertions)) return assertions;
  if (mode === "auto") return assertions;
  return assertions
    .filter((assertion) => assertion?.type !== "skill_match" && assertion?.type !== "structural_type")
    .map((assertion) => ({ ...assertion }));
}

function applyBenchmarkMode(scenario, mode) {
  const analysisSkillTarget = scenario.analysisSkillTarget || "opensees-static";
  const scopedSkillIds = mode === "oracle-specialist"
    ? [scenario.skillTarget, analysisSkillTarget].filter(Boolean)
    : mode === "generic-only"
      ? ["generic", analysisSkillTarget]
      : undefined;
  const clone = {
    ...scenario,
    baseScenarioId: scenario.id,
    mode,
    scopedSkillIds,
    id: `${scenario.id}#${mode}`,
  };
  if (Array.isArray(scenario.turns)) {
    clone.turns = scenario.turns.map((turn) => ({
      ...turn,
      assertions: assertionsForMode(turn.assertions, mode),
    }));
  }
  if (scenario.expect?.assertions) {
    clone.expect = {
      ...scenario.expect,
      assertions: assertionsForMode(scenario.expect.assertions, mode),
    };
  }
  return clone;
}

async function buildBenchmarkCapabilityContext(runtime, LangGraphAgentService) {
  const manifests = await runtime.listSkillManifests();
  const protocol = LangGraphAgentService.getProtocol();
  const enabledToolIds = selectBenchmarkToolIds(protocol.tools);
  return { manifests, enabledToolIds };
}

function selectBenchmarkToolIds(toolDefinitions) {
  return toolDefinitions
    .filter((toolDef) => toolDef.defaultEnabled && BENCHMARK_TOOL_ALLOWLIST.has(toolDef.name))
    .map((toolDef) => toolDef.name);
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

function resolveBenchmarkSkillIds(scenario, manifests) {
  const availableSkillIds = new Set(manifests.map((manifest) => manifest.id));
  const structureSkillIds = manifests
    .filter((manifest) => manifest.domain === "structure-type")
    .map((manifest) => manifest.id);
  const analysisSkillTarget = scenario.analysisSkillTarget || "opensees-static";
  const utilitySkillIds = BENCHMARK_UTILITY_SKILL_IDS.filter((skillId) => availableSkillIds.has(skillId));

  const structureScope = scenario.mode === "oracle-specialist"
    ? [scenario.skillTarget || scenario.structureType]
    : scenario.mode === "generic-only"
      ? ["generic"]
      : structureSkillIds;

  return uniqueStrings([
    ...structureScope,
    analysisSkillTarget,
    ...utilitySkillIds,
  ]).filter((skillId) => availableSkillIds.has(skillId));
}

function buildTurnContext({ scenario, turn, turnIndex, benchmarkContext, skillIds }) {
  const attachments = turn.attachments !== undefined
    ? turn.attachments
    : turnIndex === 0 ? scenario.attachments : undefined;
  return {
    locale: scenario.locale || "zh",
    skillIds,
    enabledToolIds: benchmarkContext.enabledToolIds,
    attachments,
    restrictFileAccessToAttachments: true,
  };
}

async function runAgentWebTurn(service, input, options = {}) {
  const stream = options.resume
    ? service.resumeStream(input.conversationId, input.message)
    : service.runStream(input);
  const iterator = stream[Symbol.asyncIterator]();
  let resumeRequired = false;
  try {
    while (true) {
      const next = await raceWithSignal(iterator.next(), input.signal);
      if (next.done) break;
      if (next.value?.type === "error") {
        throw new Error(next.value.error || "agent stream failed");
      }
      const infrastructureError = findBenchmarkInfrastructureMarker(next.value);
      if (infrastructureError) {
        throw new Error(infrastructureError);
      }
      if (next.value?.type === "interaction_update" && next.value?.content?.resumeRequired === true) {
        resumeRequired = true;
      }
      // Drain the stream exactly like the browser does; evaluation reads the
      // final graph state from the checkpoint below.
    }
  } catch (err) {
    if (typeof iterator.return === "function") {
      await iterator.return().catch(() => {});
    }
    throw err;
  }
  const snapshot = await raceWithSignal(service.getConversationSessionSnapshot(
    input.conversationId,
    input.context?.locale || "zh",
  ), input.signal);
  if (!snapshot?.state) {
    throw new Error("web-stream execution did not produce a checkpoint state");
  }
  return { state: snapshot.state, resumeRequired };
}

async function runAgentLikeWeb(service, input) {
  const result = await runAgentWebTurn(service, input);
  return result.state;
}

async function runAgentForBenchmark(service, input, execution, options = {}) {
  if (execution === "full") {
    return {
      state: await raceWithSignal(service.runFull(input), input.signal),
      resumeRequired: false,
    };
  }
  return runAgentWebTurn(service, input, options);
}

function findBenchmarkInfrastructureMarker(value) {
  const marker = /LLM_(?:PARAM_EXTRACTOR|STRUCTURAL_ROUTER)_INFRASTRUCTURE_ERROR|ANALYSIS_WORKER_INFRASTRUCTURE_ERROR|(?:YJK|PKPM) analysis timed out after \d+s/i;
  const pending = [value];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (marker.test(current)) return current;
      continue;
    }
    if (!current || typeof current !== "object" || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
    } else {
      pending.push(...Object.values(current));
    }
  }
  return null;
}

function countClarificationCalls(state) {
  const messages = Array.isArray(state?.messages) ? state.messages : [];
  return messages.reduce((count, msg) => {
    const toolCalls = msg.tool_calls || msg.kwargs?.tool_calls;
    return count + (Array.isArray(toolCalls)
      ? toolCalls.filter((tc) => (tc.name || tc.function?.name) === "ask_user_clarification").length
      : 0);
  }, 0);
}

function findBenchmarkInfrastructureError(state) {
  return findBenchmarkInfrastructureMarker(state?.messages);
}

function findBenchmarkPolicyViolation(state) {
  const pending = [state?.messages];
  const visited = new Set();
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith("{") && trimmed.endsWith("}"))
        || (trimmed.startsWith("[") && trimmed.endsWith("]"))
      ) {
        try {
          pending.push(JSON.parse(trimmed));
        } catch {
          // Ordinary model text can resemble JSON without being a tool payload.
        }
      }
      continue;
    }
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (value.routingSource === "explicit-keyword" || value.routingSource === "generic-fallback") {
      return `routingSource=${value.routingSource}`;
    }
    if (value.extractionMode === "deterministic") {
      return "extractionMode=deterministic";
    }
    pending.push(...Object.values(value));
  }
  return null;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  if (signal?.reason) return new Error(String(signal.reason));
  return new Error("operation aborted");
}

function raceWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function createCaseTimeout(timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`case timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  if (typeof timeout.unref === "function") {
    timeout.unref();
  }
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
    timedOut: () => controller.signal.aborted,
  };
}

function mergeTurnResults(scenario, turnResults, totalDurationMs) {
  const allMetrics = [];
  let allPassed = true;
  let passed = 0;
  let total = 0;

  for (const { evaluation } of turnResults) {
    const coreMetrics = evaluation.metrics.filter(
      (m) => ![
        "toolCalls",
        "inputTokens",
        "outputTokens",
        "totalTokens",
        "visionInputTokens",
        "visionOutputTokens",
        "visionTotalTokens",
        "duration",
      ].includes(m.metric),
    );
    allMetrics.push(...coreMetrics);
    passed += coreMetrics.filter((m) => m.pass).length;
    total += coreMetrics.length;
    if (!evaluation.allPassed) allPassed = false;
  }

  for (const metricName of ["toolCalls", "inputTokens", "outputTokens", "totalTokens"]) {
    const values = turnResults
      .map(({ evaluation }) => evaluation.metrics.find((metric) => metric.metric === metricName)?.actual)
      .map(Number)
      .filter((value) => Number.isFinite(value));
    if (values.length > 0) {
      allMetrics.push({
        metric: metricName,
        pass: true,
        expected: "(info, lower is better)",
        actual: String(Math.max(...values)),
      });
    }
  }

  for (const metricName of ["visionInputTokens", "visionOutputTokens", "visionTotalTokens"]) {
    const values = turnResults
      .map(({ evaluation }) => evaluation.metrics.find((metric) => metric.metric === metricName)?.actual)
      .map(Number)
      .filter((value) => Number.isFinite(value));
    if (values.length > 0) {
      allMetrics.push({
        metric: metricName,
        pass: true,
        expected: "(info, lower is better)",
        actual: String(values.reduce((sum, value) => sum + value, 0)),
      });
    }
  }

  allMetrics.push({
    metric: "duration",
    pass: true,
    expected: "(info)",
    actual: `${(totalDurationMs / 1000).toFixed(1)}s`,
  });

  return {
    scenarioId: scenario.id,
    baseScenarioId: scenario.baseScenarioId || scenario.id,
    description: scenario.description || "",
    split: scenario.split || "core",
    taskFamily: scenario.taskFamily || "standard_workflow",
    inputModality: scenario.inputModality || "text",
    inputCompleteness: scenario.inputContract?.completeness || null,
    structureType: scenario.structureType || null,
    benchmarkStructureType: scenario.benchmarkStructureType || null,
    difficulty: scenario.difficulty || null,
    skillTarget: scenario.skillTarget || null,
    category: scenario.category || null,
    tags: Array.isArray(scenario.tags) ? scenario.tags : [],
    locale: scenario.locale || null,
    analysisSkillTarget: scenario.analysisSkillTarget || null,
    analysisEngineTarget: scenario.analysisEngineTarget || null,
    mode: scenario.mode || "auto",
    evaluationFocus: Array.isArray(scenario.evaluationFocus) ? scenario.evaluationFocus : [],
    passed,
    total,
    allPassed,
    metrics: allMetrics,
    durationMs: totalDurationMs,
    turnResults: turnResults.map((r) => ({ turnIndex: r.turnIndex, evaluation: r.evaluation })),
  };
}

function supervisedOutputPath(outputPath, scenario) {
  const safeId = safeConversationIdPart(scenario.id);
  const dir = outputPath
    ? `${path.resolve(WORK_ROOT, outputPath)}.cases`
    : path.join(WORK_ROOT, "results", "supervised-cases");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safeId}.json`);
}

function childArgsForScenario(options, sutRoot, scenario, outputPath) {
  return [
    __filename,
    "--scenario", scenario.baseScenarioId || scenario.id,
    "--mode", scenario.mode || "auto",
    "--execution", options.execution,
    "--case-timeout-ms", String(options.caseTimeoutMs),
    "--sut-root", sutRoot,
    "--output", outputPath,
  ];
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore best-effort cleanup failures.
    }
  }
}

function failedSupervisedEvaluation(scenario, actual, durationMs, options) {
  return {
    scenarioId: scenario.id,
    baseScenarioId: scenario.baseScenarioId || scenario.id,
    description: scenario.description || "",
    split: scenario.split || "core",
    taskFamily: scenario.taskFamily || "standard_workflow",
    inputModality: scenario.inputModality || "text",
    inputCompleteness: scenario.inputContract?.completeness || null,
    structureType: scenario.structureType || null,
    benchmarkStructureType: scenario.benchmarkStructureType || null,
    difficulty: scenario.difficulty || null,
    skillTarget: scenario.skillTarget || null,
    category: scenario.category || null,
    tags: Array.isArray(scenario.tags) ? scenario.tags : [],
    locale: scenario.locale || null,
    analysisSkillTarget: scenario.analysisSkillTarget || null,
    analysisEngineTarget: scenario.analysisEngineTarget || null,
    mode: scenario.mode || "auto",
    evaluationFocus: Array.isArray(scenario.evaluationFocus) ? scenario.evaluationFocus : [],
    passed: 0,
    total: 1,
    allPassed: false,
    metrics: [{
      metric: "execution",
      pass: false,
      expected: options.supervise === false ? "case completes" : "supervised case completes",
      actual,
    }],
    durationMs,
    executionProfile: {
      execution: options.execution,
      mode: scenario.mode || "auto",
      skillIds: [],
      enabledToolIds: [],
      sourceDataDir: process.env.SCLAW_BENCHMARK_SOURCE_DATA_DIR || null,
      runtimeDataDir: process.env.SCLAW_DATA_DIR || null,
      visionModel: process.env.LLM_VISION_MODEL || null,
      analysisSkillTarget: scenario.analysisSkillTarget || "opensees-static",
      caseTimeoutMs: options.caseTimeoutMs,
      yjkCloseAfterRun: process.env.YJK_CLOSE_AFTER_RUN || null,
      supervised: options.supervise !== false,
    },
  };
}

function classifyInfrastructureEvaluation(evaluation) {
  const failedMetrics = (evaluation?.metrics || []).filter((metric) => metric?.pass === false);
  const executionFailure = failedMetrics.find((metric) => metric.metric === "execution");
  if (!executionFailure) return null;
  const actualText = String(executionFailure.actual || "");
  if (
    /(?:HTTP|status(?:\s+code)?|MODEL_RATE_LIMIT)[_:\s-]*429\b/i.test(actualText)
    || /\b429\s+status(?:\s+code)?\b/i.test(actualText)
    || /(?:rate\s*limit|rate[-_\s]?limited|访问量过大)/i.test(actualText)
  ) {
    return { kind: "provider-rate-limit", retryable: true };
  }
  if (
    /(?:HTTP|status(?:\s+code)?|MODEL_HTTP_ERROR)[_:\s-]*(?:401|403|404)\b/i.test(actualText)
    || /\b(?:401|403|404)\s+status(?:\s+code)?\b/i.test(actualText)
    || /(?:invalid api key|authentication failed|model not found|API key is required)/i.test(actualText)
  ) {
    return { kind: "provider-configuration", retryable: false };
  }
  if (/LLM_JUDGE_INFRASTRUCTURE_ERROR/i.test(actualText)) {
    return { kind: "judge-infrastructure", retryable: true };
  }
  if (
    /(?:LLM_(?:PARAM_EXTRACTOR|STRUCTURAL_ROUTER)|VISION_MODEL)_INVALID_OUTPUT/i.test(actualText)
  ) {
    return null;
  }
  if (
    /LLM_(?:PARAM_EXTRACTOR|STRUCTURAL_ROUTER)_INFRASTRUCTURE_ERROR/i.test(actualText)
    ||
    /(?:HTTP|status(?:\s+code)?|MODEL_HTTP_ERROR)[_:\s-]*(?:500|502|503|504|524)\b/i.test(actualText)
    || /\b(?:500|502|503|504|524)\s+status(?:\s+code)?\b/i.test(actualText)
    || /(?:fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|network error|request timed out|TimeoutError|AbortError|timeout exceeded)/i.test(actualText)
  ) {
    return { kind: "provider-transient", retryable: true };
  }
  if (
    !/case(?: process)? timed out after \d+ms/i.test(String(executionFailure.actual || ""))
  ) {
    return { kind: "benchmark-execution", retryable: false };
  }
  return null;
}

function maxProviderRateLimitReruns() {
  const value = Number(process.env.LLM_BENCHMARK_RATE_LIMIT_RERUNS || DEFAULT_PROVIDER_RATE_LIMIT_RERUNS);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_PROVIDER_RATE_LIMIT_RERUNS;
}

function calculateProviderRateLimitBackoffMs(rerunNumber, baseMs, maxMs) {
  const safeRerun = Math.max(1, Math.floor(Number(rerunNumber) || 1));
  const safeBase = Math.max(0, Number(baseMs) || 0);
  const safeMax = Math.max(safeBase, Number(maxMs) || safeBase);
  return Math.min(safeMax, safeBase * (2 ** (safeRerun - 1)));
}

function providerRateLimitBackoffMs(rerunNumber) {
  const baseMs = Number(process.env.LLM_BENCHMARK_RATE_LIMIT_BACKOFF_MS || DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS);
  const maxMs = Number(process.env.LLM_BENCHMARK_RATE_LIMIT_MAX_BACKOFF_MS || DEFAULT_PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS);
  return calculateProviderRateLimitBackoffMs(rerunNumber, baseMs, maxMs);
}

function readSingleScenarioResult(outputPath) {
  if (!fs.existsSync(outputPath)) return null;
  const record = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  return Array.isArray(record.scenarios) ? record.scenarios[0] || null : null;
}

function runChildScenario(args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, args, {
      cwd,
      env: {
        ...process.env,
        SCLAW_BENCHMARK_SUPERVISED_CHILD: "1",
      },
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    if (typeof timeout.unref === "function") timeout.unref();
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut, durationMs: Date.now() - start });
    });
  });
}

async function runSupervisedBenchmark(options, sutRoot, scenarios, runMetadata) {
  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`LangGraph Agent Benchmark: ${scenarios.length} supervised scenario run(s)\n`);
  process.stdout.write(`Mode: ${options.mode}\n`);
  process.stdout.write(`Execution: ${options.execution}\n`);
  process.stdout.write(`Case timeout: ${options.caseTimeoutMs}ms\n`);
  process.stdout.write(`SUT root: ${sutRoot}\n`);
  process.stdout.write(`${"=".repeat(60)}\n`);

  const results = [];
  const hardTimeoutMs = Math.max(
    options.caseTimeoutMs + SUPERVISED_HARD_TIMEOUT_GRACE_MS,
    Math.ceil(options.caseTimeoutMs * 1.2),
  );
  for (const scenario of scenarios) {
    const caseOutput = supervisedOutputPath(options.outputPath, scenario);
    const infrastructureRerunLimit = maxProviderRateLimitReruns();
    let infrastructureReruns = 0;
    let childResult = null;
    let evaluation = null;
    while (true) {
      fs.rmSync(caseOutput, { force: true });
      process.stdout.write(`\nSupervised running: ${scenario.id}`);
      if (infrastructureReruns > 0) {
        process.stdout.write(` (infrastructure rerun ${infrastructureReruns}/${infrastructureRerunLimit})`);
      }
      process.stdout.write("\n");
      childResult = await runChildScenario(
        childArgsForScenario(options, sutRoot, scenario, caseOutput),
        hardTimeoutMs,
        sutRoot,
      );
      evaluation = readSingleScenarioResult(caseOutput);
      if (!evaluation) {
        const actual = childResult.timedOut
          ? `case process timed out after ${hardTimeoutMs}ms`
          : `case process exited without result (code=${childResult.code}, signal=${childResult.signal || "none"})`;
        evaluation = failedSupervisedEvaluation(scenario, actual, childResult.durationMs, options);
      }

      const infrastructureFailure = classifyInfrastructureEvaluation(evaluation);
      if (!infrastructureFailure) break;
      if (!infrastructureFailure.retryable) {
        throw new Error(
          `${infrastructureFailure.kind} failure for ${scenario.id}; aborting without counting this case: `
          + JSON.stringify(evaluation.metrics || []),
        );
      }

      fs.rmSync(caseOutput, { force: true });
      infrastructureReruns += 1;
      if (infrastructureReruns > infrastructureRerunLimit) {
        throw new Error(
          `${infrastructureFailure.kind} persisted for ${scenario.id} after `
          + `${infrastructureRerunLimit} rerun(s); aborting without counting this case.`,
        );
      }
      const backoffMs = providerRateLimitBackoffMs(infrastructureReruns);
      process.stdout.write(
        `  ${infrastructureFailure.kind} detected; discarding this attempt and retrying after `
        + `${(backoffMs / 1000).toFixed(1)}s.\n`,
      );
      if (backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
    evaluation.executionProfile = {
      ...(evaluation.executionProfile || {}),
      supervised: true,
      processExitCode: childResult.code,
      processSignal: childResult.signal || null,
      processTimedOut: childResult.timedOut,
      infrastructureReruns,
    };
    printScenarioResult(scenario, evaluation);
    results.push(evaluation);
    if (options.outputPath) {
      writeJsonOutput(options.outputPath, results, { quiet: true, runMetadata, completed: false });
    }
  }

  printSummary(results);
  if (options.outputPath) {
    writeJsonOutput(options.outputPath, results, { runMetadata, completed: true });
  }
  if (results.some((r) => !r.allPassed)) {
    process.exitCode = 1;
  }
}

async function runBenchmark(args) {
  const options = parseBenchmarkOptions(args);
  const sutRoot = resolveSutRoot(options.sutRoot);
  const scenarios = orderScenarios(
    resolveScenarioRuns(loadScenarios(options), options),
    options.scenarioOrderSeed,
  );
  if (scenarios.length === 0) {
    process.stdout.write("No benchmark scenarios matched.\n");
    return;
  }
  assertFormalRunEligibility(options, sutRoot, scenarios);
  const regressionSharedPath = path.join(sutRoot, "tests", "regression", "shared.js");
  const { resolveRegressionContext, runBackendBuildOnce } = require(regressionSharedPath);
  const context = resolveRegressionContext(sutRoot);
  for (const [k, v] of Object.entries(context.env)) {
    if (v !== undefined && v !== "") {
      process.env[k] = v;
    }
  }
  // Benchmark runs measure the configured LLM path. Product fallbacks remain
  // available outside this runner, but must not mask provider/model failures.
  process.env.SCLAW_BENCHMARK_LLM_ONLY = "1";

  const prepareRuntime = async () => {
    if (process.env.SCLAW_BENCHMARK_BACKEND_PREBUILT !== "1") {
      await runBackendBuildOnce(context);
    }
    const { execSync } = require("node:child_process");
    execSync("npx prisma db push --accept-data-loss", {
      cwd: path.join(sutRoot, "backend"),
      env: { ...process.env, ...context.env },
      stdio: "pipe",
    });
  };

  if (options.supervise) {
    await prepareRuntime();
    process.env.SCLAW_BENCHMARK_RUNTIME_PREPARED = "1";
    const runMetadata = buildRunMetadata(options, sutRoot, scenarios);
    process.env.SCLAW_BENCHMARK_FINGERPRINTS_JSON = JSON.stringify(runMetadata.fingerprints);
    await runSupervisedBenchmark(options, sutRoot, scenarios, runMetadata);
    return;
  }

  if (process.env.SCLAW_BENCHMARK_RUNTIME_PREPARED !== "1") {
    await prepareRuntime();
  }

  process.stdout.write(`\n${"=".repeat(60)}\n`);
  process.stdout.write(`LangGraph Agent Benchmark: ${scenarios.length} scenario run(s)\n`);
  process.stdout.write(`Mode: ${options.mode}\n`);
  process.stdout.write(`Execution: ${options.execution}\n`);
  process.stdout.write(`Case timeout: ${options.caseTimeoutMs}ms\n`);
  process.stdout.write(`SUT root: ${sutRoot}\n`);
  process.stdout.write(`Model: ${context.env.LLM_MODEL || "(default)"}\n`);
  process.stdout.write(`Base URL: ${context.env.LLM_BASE_URL || "(default)"}\n`);
  process.stdout.write(`${"=".repeat(60)}\n`);

  const { AgentSkillRuntime, LangGraphAgentService } = await importBackendModules(sutRoot);
  const runtime = new AgentSkillRuntime();
  const service = new LangGraphAgentService(runtime);
  const solverGate = installSolverGate(service);
  const benchmarkContext = await buildBenchmarkCapabilityContext(runtime, LangGraphAgentService);
  const runMetadata = buildRunMetadata(options, sutRoot, scenarios);

  const results = [];

  for (const rawScenario of scenarios) {
    const scenario = normalizeScenario(resolveAttachmentPaths(rawScenario));
    const skillIds = resolveBenchmarkSkillIds(scenario, benchmarkContext.manifests);
    const maxRetries = Math.max(0, typeof scenario.maxRetries === "number" ? scenario.maxRetries : 0);
    let attempt = 0;
    let lastEvaluation = null;
    const attemptRounds = [];
    const caseTimeout = createCaseTimeout(options.caseTimeoutMs);
    let lastConversationId = null;

    try {
      while (attempt <= maxRetries) {
        let feedbackPrefix = "";
        if (attempt > 0 && lastEvaluation) {
          feedbackPrefix = buildFeedbackFromEvaluation(lastEvaluation, scenario.locale || "zh");
          if (feedbackPrefix) {
            process.stdout.write(`  Feedback: ${feedbackPrefix.slice(0, 100)}...\n`);
          }
        }

        if (attempt > 0) {
          process.stdout.write(`  Retrying (attempt ${attempt + 1}/${maxRetries + 1})...\n`);
        } else {
          process.stdout.write(`\nRunning: ${scenario.id}...\n`);
        }

        const scenarioStart = Date.now();
        let executionError = false;
        const turnResults = [];
        let currentTurnIndex = 0;
        let currentTurnStart = scenarioStart;
        let totalExecutionDurationMs = 0;
        let resumeRequired = false;
        const conversationId = benchmarkConversationId();
        lastConversationId = conversationId;
        const runScenario = prepareScenarioAttachmentsForRun(scenario, conversationId);

        const prevLogLevel = process.env.LOG_LEVEL;
        process.env.LOG_LEVEL = "warn";

        // Dynamic turns (custom_tasks): the "user" answers with the hint only if the agent asked
        // for one itself (ask_user_clarification) during the previous turn.
        let clarificationsBeforeTurn = 0;
        let lastTurnState = null;
        try {
          for (let i = 0; i < runScenario.turns.length; i++) {
            currentTurnIndex = i;
            const turn = runScenario.turns[i];
            const turnStart = Date.now();
            currentTurnStart = turnStart;

            let turnMessage = turn.message;
            if (turn.dynamic === "answer-if-asked" && lastTurnState) {
              const asked = countClarificationCalls(lastTurnState) > clarificationsBeforeTurn;
              turnMessage = asked ? turn.messageIfAsked : turn.messageIfNotAsked;
              process.stdout.write(`[dynamic-turn] turn ${i + 1}: agent ${asked ? "ASKED" : "did not ask"} -> ${asked ? "hint" : "no hint"}\n`);
            }
            if (lastTurnState) clarificationsBeforeTurn = countClarificationCalls(lastTurnState);

            const messageWithFeedback = (i === 0 && feedbackPrefix)
              ? feedbackPrefix + "\n\n" + turnMessage
              : turnMessage;
            const turnContext = buildTurnContext({
              scenario: runScenario,
              turn,
              turnIndex: i,
              benchmarkContext,
              skillIds,
            });
            const visionSummaries = await buildVisionSummaries(
              turnContext.attachments,
              scenario.locale || "zh",
              caseTimeout.signal,
            );
            if (visionSummaries.length > 0) {
              turnContext.attachments = filterImageAttachments(turnContext.attachments);
            }
            const messageWithVision = attachVisionSummariesToMessage(
              messageWithFeedback,
              visionSummaries,
              scenario.locale || "zh",
              turn.engineeringSpecification
                ?? runScenario.engineeringSpecification,
            );

            const turnExecution = await runAgentForBenchmark(service, {
              message: messageWithVision,
              conversationId,
              signal: caseTimeout.signal,
              context: turnContext,
            }, options.execution, { resume: resumeRequired });
            const state = turnExecution.state;
            lastTurnState = state;
            resumeRequired = turnExecution.resumeRequired;
            const infrastructureToolError = findBenchmarkInfrastructureError(state);
            if (infrastructureToolError) {
              throw new Error(infrastructureToolError);
            }
            if (process.env.SCLAW_BENCHMARK_LLM_ONLY === "1") {
              const policyViolation = findBenchmarkPolicyViolation(state);
              if (policyViolation) {
                throw new Error(`BENCHMARK_POLICY_VIOLATION: ${policyViolation}`);
              }
            }

            const turnDurationMs = Date.now() - turnStart;
            totalExecutionDurationMs += turnDurationMs;

            if (turn.assertions && turn.assertions.length > 0) {
              const turnScenario = { ...runScenario, expect: { assertions: turn.assertions } };
              const evaluation = await evaluateScenario(turnScenario, state, turnDurationMs);
              appendVisionUsageMetrics(evaluation, visionSummaries);
              turnResults.push({ turnIndex: i, evaluation, executionDurationMs: turnDurationMs });
            }
          }
        } catch (err) {
          executionError = true;
          const errorMessage = err instanceof Error ? err.message : String(err);
          const message = caseTimeout.timedOut()
            ? `case timed out after ${options.caseTimeoutMs}ms`
            : errorMessage;
          const failedTurnDurationMs = Date.now() - currentTurnStart;
          totalExecutionDurationMs += failedTurnDurationMs;
          process.stdout.write(`  error: ${message}\n`);
          turnResults.push({
            turnIndex: currentTurnIndex,
            evaluation: failedSupervisedEvaluation(
              scenario,
              message,
              failedTurnDurationMs,
              { ...options, supervise: false },
            ),
            executionDurationMs: failedTurnDurationMs,
          });
        } finally {
          if (prevLogLevel === undefined) {
            delete process.env.LOG_LEVEL;
          } else {
            process.env.LOG_LEVEL = prevLogLevel;
          }
        }

        const totalDurationMs = totalExecutionDurationMs;

        if (turnResults.length > 0) {
          if (scenario._multiTurn) {
            lastEvaluation = mergeTurnResults(scenario, turnResults, totalDurationMs);
          } else {
            lastEvaluation = turnResults[0].evaluation;
          }
        }

        if (lastEvaluation) {
          attemptRounds.push({
            attempt: attempt + 1,
            allPassed: lastEvaluation.allPassed,
            metrics: (lastEvaluation.metrics || []).map((m) => ({ metric: m.metric, pass: m.pass })),
          });
        }
        if (lastEvaluation && lastEvaluation.allPassed) break;
        if (executionError) break;
        attempt += 1;
      }
    } finally {
      caseTimeout.clear();
    }

    if (lastEvaluation) {
      lastEvaluation.executionProfile = {
        execution: options.execution,
        mode: scenario.mode || "auto",
        skillIds,
        enabledToolIds: benchmarkContext.enabledToolIds,
        sourceDataDir: process.env.SCLAW_BENCHMARK_SOURCE_DATA_DIR || null,
        runtimeDataDir: process.env.SCLAW_DATA_DIR || null,
        visionModel: process.env.LLM_VISION_MODEL || null,
        analysisSkillTarget: scenario.analysisSkillTarget || "opensees-static",
        caseTimeoutMs: options.caseTimeoutMs,
        yjkCloseAfterRun: process.env.YJK_CLOSE_AFTER_RUN || null,
        conversationId: lastConversationId,
      };
      attachSolverGateProfile(lastEvaluation, solverGate);
      const attempts = attemptRounds.length;
      lastEvaluation.retries = {
        attempts,
        maxRetries,
        retriesUsed: Math.max(0, attempts - 1),
        passAt1: attemptRounds[0]?.allPassed === true,
        passAtN: lastEvaluation.allPassed === true,
        rounds: attemptRounds,
      };
    }

    if (!lastEvaluation) {
      lastEvaluation = {
        scenarioId: scenario.id,
        description: scenario.description || "",
        passed: 0,
        total: 1,
        allPassed: false,
        metrics: [{ metric: "execution", pass: false, expected: "no evaluation produced", actual: "(none)" }],
        durationMs: 0,
      };
    }

    printScenarioResult(rawScenario, lastEvaluation);
    results.push(lastEvaluation);
    if (options.outputPath) {
      writeJsonOutput(options.outputPath, results, { quiet: true, runMetadata, completed: false });
    }
  }

  printSummary(results);

  if (options.outputPath) {
    writeJsonOutput(options.outputPath, results, { runMetadata, completed: true });
  }

  if (results.some((r) => !r.allPassed)) {
    process.exitCode = 1;
  }
}

module.exports = {
  attachVisionSummariesToMessage,
  attachSolverGateProfile,
  appendVisionUsageMetrics,
  benchmarkConversationId,
  buildVisionSummaries,
  buildRunMetadata,
  buildTurnContext,
  buildVisionPrompt,
  calculateProviderRateLimitBackoffMs,
  chatCompletionsUrl,
  classifyInfrastructureEvaluation,
  contentTextFromOpenAiMessage,
  copyAttachmentsToRuntimeUploads,
  detectOpenSeesRuntime,
  formalRunViolations,
  fetchWithAbortSignal,
  findBenchmarkInfrastructureError,
  findBenchmarkPolicyViolation,
  filterImageAttachments,
  loadScenarios,
  mergeTurnResults,
  normalizeScenario,
  normalizeScenarioMetadata,
  orderScenarios,
  parseVisionSummary,
  resolveAttachmentPaths,
  runAgentLikeWeb,
  runAgentWebTurn,
  runBenchmark,
  selectBenchmarkToolIds,
  supervisedOutputPath,
};

if (require.main === module) {
  runBenchmark(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
