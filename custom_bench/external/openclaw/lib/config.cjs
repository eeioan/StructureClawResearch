const fs = require("node:fs");
const path = require("node:path");

const OPENCLAW_VERSION = "2026.6.33";
const OPENCLAW_PACKAGE = `openclaw@${OPENCLAW_VERSION}`;
const BENCHMARK_MODEL_LABEL = "glm-5.2-paratera";
const OPENCLAW_MODEL = "paratera/GLM-5.2";
const OPENCLAW_MODEL_ID = "GLM-5.2";
const OPENCLAW_THINKING = "high";
const DEFAULT_BASE_URL = "https://llmapi.paratera.com/v1";
const DEFAULT_CONCURRENCY = 10;
const DEFAULT_CASE_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_YJK_COOLDOWN_MS = 5000;

const BENCHMARK_TOOL_IDS = Object.freeze([
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

const UTILITY_SKILL_IDS = Object.freeze([
  "validation-structure-model",
  "report-export-builtin",
]);

function positiveInteger(value, fallback, label) {
  const parsed = Number(value);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  if (value === undefined) return fallback;
  throw new Error(`${label} must be a positive integer`);
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseOpenClawOptions(argv) {
  const options = {
    scenarioId: null,
    taskFamily: null,
    mode: "all",
    outputPath: null,
    concurrency: DEFAULT_CONCURRENCY,
    caseTimeoutMs: DEFAULT_CASE_TIMEOUT_MS,
    runtimeRoot: null,
    solverLockRoot: null,
    sutRoot: null,
    provider: "paratera",
    repeatId: null,
    resume: false,
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scenario") {
      options.scenarioId = requireValue(argv, ++index, arg);
    } else if (arg === "--family") {
      options.taskFamily = requireValue(argv, ++index, arg);
    } else if (arg === "--mode") {
      options.mode = requireValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.outputPath = requireValue(argv, ++index, arg);
    } else if (arg === "--concurrency") {
      options.concurrency = positiveInteger(
        requireValue(argv, ++index, arg),
        DEFAULT_CONCURRENCY,
        "--concurrency",
      );
    } else if (arg === "--case-timeout-ms") {
      options.caseTimeoutMs = positiveInteger(
        requireValue(argv, ++index, arg),
        DEFAULT_CASE_TIMEOUT_MS,
        "--case-timeout-ms",
      );
    } else if (arg === "--runtime-root") {
      options.runtimeRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--solver-lock-root") {
      options.solverLockRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--sut-root") {
      options.sutRoot = requireValue(argv, ++index, arg);
    } else if (arg === "--provider") {
      options.provider = requireValue(argv, ++index, arg);
    } else if (arg === "--repeat") {
      options.repeatId = positiveInteger(
        requireValue(argv, ++index, arg),
        null,
        "--repeat",
      );
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown OpenClaw benchmark option: ${arg}`);
    }
  }

  if (!["all", "auto", "generic-only"].includes(options.mode)) {
    throw new Error("--mode must be auto, generic-only, or all");
  }
  if (!["paratera", "mine"].includes(options.provider)) {
    throw new Error("--provider must be paratera or mine");
  }
  if (options.repeatId !== null && ![1, 2, 3].includes(options.repeatId)) {
    throw new Error("--repeat must be 1, 2, or 3");
  }
  return options;
}

function modesForExternalScenario(scenario) {
  if (scenario.taskFamily === "standard_workflow") {
    return ["auto", "generic-only"];
  }
  return ["auto"];
}

function assertionsForMode(assertions, mode) {
  if (!Array.isArray(assertions) || mode === "auto") return assertions;
  return assertions
    .filter((assertion) => assertion?.type !== "skill_match" && assertion?.type !== "structural_type")
    .map((assertion) => ({ ...assertion }));
}

function applyExternalMode(scenario, mode) {
  const clone = {
    ...scenario,
    baseScenarioId: scenario.id,
    id: `${scenario.id}#${mode}`,
    mode,
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

function resolveExternalScenarioRuns(scenarios, mode) {
  return scenarios.flatMap((scenario) => {
    const modes = modesForExternalScenario(scenario)
      .filter((candidate) => mode === "all" || candidate === mode);
    return modes.map((candidate) => applyExternalMode(scenario, candidate));
  });
}

function uniqueStrings(values) {
  return [...new Set(values.filter(
    (value) => typeof value === "string" && value.trim().length > 0,
  ))];
}

function resolveSkillIds(scenario, manifests) {
  const available = new Set(manifests.map((manifest) => manifest.id));
  const structureSkills = manifests
    .filter((manifest) => manifest.domain === "structure-type")
    .map((manifest) => manifest.id);
  const structureScope = scenario.mode === "generic-only"
    ? ["generic"]
    : structureSkills;
  const analysisSkillTarget = scenario.analysisSkillTarget || "opensees-static";
  return uniqueStrings([
    ...structureScope,
    analysisSkillTarget,
    ...UTILITY_SKILL_IDS,
  ]).filter((skillId) => available.has(skillId));
}

function safeSegment(value) {
  return String(value || "scenario")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "scenario";
}

function skillDescription(manifest, locale) {
  const preferred = locale === "en" ? manifest.description?.en : manifest.description?.zh;
  return preferred || manifest.description?.en || manifest.description?.zh || manifest.id;
}

function writeSkill(workspaceRoot, manifest, locale) {
  const skillRoot = path.join(workspaceRoot, "skills", safeSegment(manifest.id));
  fs.mkdirSync(skillRoot, { recursive: true });
  const description = skillDescription(manifest, locale).replace(/\s+/g, " ").trim();
  const name = locale === "en"
    ? manifest.name?.en || manifest.name?.zh || manifest.id
    : manifest.name?.zh || manifest.name?.en || manifest.id;
  const content = [
    "---",
    `name: ${manifest.id}`,
    `description: ${JSON.stringify(description)}`,
    "user-invocable: false",
    "---",
    "",
    `# ${name}`,
    "",
    description,
    "",
    `Domain: ${manifest.domain}.`,
    `Stages: ${(manifest.stages || []).join(", ") || "unspecified"}.`,
    "",
    "Use only the typed StructureClaw benchmark tools exposed in this workspace.",
    "Do not invoke an analysis executable directly and do not invent numerical results.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(skillRoot, "SKILL.md"), content);
}

function agentInstructions(locale) {
  if (locale === "en") {
    return [
      "# StructureClaw benchmark agent",
      "",
      "Solve the user's structural-engineering task with the visible skills and typed tools.",
      "For modeling or analysis, call tools in this order:",
      "detect_structure_type, extract_draft_params, build_model, validate_model, run_analysis, generate_report.",
      "Do not call detect_structure_type and extract_draft_params in parallel.",
      "When critical information is missing or conflicting, call ask_user_clarification and stop before analysis.",
      "The active analysis skill selects OpenSees, PKPM, or YJK. Never substitute another engine.",
      "Do not use shell, web, memory, file-write, or unlisted tools.",
      "Do not fabricate tool output or numerical engineering conclusions.",
      "Reply in English unless the user requests another language.",
      "",
    ].join("\n");
  }
  return [
    "# StructureClaw benchmark agent",
    "",
    "使用当前可见技能和类型化工具完成用户的结构工程任务。",
    "建模或分析时按顺序调用：",
    "detect_structure_type、extract_draft_params、build_model、validate_model、run_analysis、generate_report。",
    "禁止并行调用 detect_structure_type 和 extract_draft_params。",
    "关键信息缺失或冲突时，调用 ask_user_clarification，并在分析前停止。",
    "当前分析技能决定使用 OpenSees、PKPM 或 YJK，禁止替换成其他引擎。",
    "禁止使用 shell、网络、记忆、文件写入或未列出的工具。",
    "不得编造工具输出或数值工程结论。",
    "除非用户另有要求，使用中文回答。",
    "",
  ].join("\n");
}

function buildOpenClawConfig(options) {
  const {
    workspaceRoot,
    pluginRoot,
    skillIds,
    baseUrl = DEFAULT_BASE_URL,
    providerId = "paratera",
    modelId = OPENCLAW_MODEL_ID,
    modelRef = OPENCLAW_MODEL,
  } = options;
  return {
    agents: {
      defaults: {
        workspace: workspaceRoot,
        skipBootstrap: true,
        skills: skillIds,
        model: {
          primary: modelRef,
          fallbacks: [],
        },
        models: {
          [modelRef]: {
            params: {
              extra_body: {
                thinking: { type: "enabled" },
                reasoning_effort: OPENCLAW_THINKING,
                tool_stream: true,
              },
            },
          },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [providerId]: {
          baseUrl,
          apiKey: "${OPENCLAW_BENCHMARK_API_KEY}",
          api: "openai-completions",
          authHeader: true,
          models: [
            {
              id: modelId,
              name: "GLM-5.2",
              reasoning: true,
              input: ["text"],
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
              contextWindow: 1_000_000,
              maxTokens: 131_072,
              compat: {
                supportsReasoningEffort: true,
                supportsUsageInStreaming: true,
              },
            },
          ],
        },
      },
    },
    tools: {
      allow: [...BENCHMARK_TOOL_IDS],
      codeMode: { enabled: false },
    },
    plugins: {
      allow: ["structureclaw-benchmark"],
      load: {
        paths: [pluginRoot],
      },
      entries: {
        "structureclaw-benchmark": {
          enabled: true,
        },
      },
    },
  };
}

function prepareOpenClawWorkspace(options) {
  const {
    workspaceRoot,
    stateRoot,
    pluginRoot,
    manifests,
    skillIds,
    locale,
    baseUrl,
    providerId,
    modelId,
    modelRef,
  } = options;
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "AGENTS.md"), agentInstructions(locale));

  const manifestById = new Map(manifests.map((manifest) => [manifest.id, manifest]));
  for (const skillId of skillIds) {
    const manifest = manifestById.get(skillId);
    if (!manifest) {
      throw new Error(`OpenClaw benchmark skill manifest not found: ${skillId}`);
    }
    writeSkill(workspaceRoot, manifest, locale);
  }

  const config = buildOpenClawConfig({
    workspaceRoot,
    pluginRoot,
    skillIds,
    baseUrl,
    providerId,
    modelId,
    modelRef,
  });
  const configPath = path.join(stateRoot, "openclaw.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return { configPath, config };
}

module.exports = {
  BENCHMARK_MODEL_LABEL,
  BENCHMARK_TOOL_IDS,
  DEFAULT_BASE_URL,
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_YJK_COOLDOWN_MS,
  OPENCLAW_MODEL,
  OPENCLAW_MODEL_ID,
  OPENCLAW_PACKAGE,
  OPENCLAW_THINKING,
  OPENCLAW_VERSION,
  UTILITY_SKILL_IDS,
  applyExternalMode,
  buildOpenClawConfig,
  modesForExternalScenario,
  parseOpenClawOptions,
  prepareOpenClawWorkspace,
  resolveExternalScenarioRuns,
  resolveSkillIds,
  safeSegment,
};
