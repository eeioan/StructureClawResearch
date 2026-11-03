const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const { evaluateScenario } = require("../../lib/evaluate.cjs");
const {
  printScenarioResult,
  printSummary,
  writeJsonOutput,
} = require("../../lib/report.cjs");
const {
  appendVisionUsageMetrics,
  attachVisionSummariesToMessage,
  buildVisionSummaries,
  filterImageAttachments,
  loadScenarios,
  mergeTurnResults,
  normalizeScenario,
  resolveAttachmentPaths,
} = require("../../runner.cjs");
const {
  BENCHMARK_MODEL_LABEL,
  BENCHMARK_TOOL_IDS,
  DEFAULT_BASE_URL,
  DEFAULT_YJK_COOLDOWN_MS,
  OPENCLAW_MODEL,
  OPENCLAW_MODEL_ID,
  OPENCLAW_PACKAGE,
  OPENCLAW_THINKING,
  OPENCLAW_VERSION,
  parseOpenClawOptions,
  prepareOpenClawWorkspace,
  resolveExternalScenarioRuns,
  resolveSkillIds,
  safeSegment,
} = require("./lib/config.cjs");

const BENCHMARK_ROOT = path.resolve(__dirname, "../..");
const PLUGIN_ROOT = path.join(__dirname, "plugin");
const DEFAULT_MAX_TOOL_CALLS = 32;
const DEFAULT_PROVIDER_RATE_LIMIT_RERUNS = 5;
const DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS = 30_000;
const DEFAULT_PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS = 120_000;

function printHelp() {
  process.stdout.write(`OpenClaw + StructureClaw benchmark

Usage:
  node external/openclaw/runner.cjs [options]

Options:
  --scenario <id>          Run one scenario
  --family <name>          Filter by task family
  --mode <mode>            auto, generic-only, or all (default: all)
  --concurrency <n>        Scenario concurrency (default: 10)
  --case-timeout-ms <ms>   Per-scenario timeout
  --output <path>          JSON result path
  --runtime-root <path>    Runtime artifact directory
  --solver-lock-root <path> Shared cross-process solver lock directory
  --sut-root <path>        StructureClaw checkout
  --provider <name>        paratera or mine (default: paratera)
  --repeat <n>             Repeat identifier: 1, 2, or 3
  --resume                 Continue from completed cases in --output
  --dry-run                Validate setup and print the frozen run matrix

Environment:
  SCLAW_OPENCLAW_API_KEY   Paratera API key
  PARATERA_API_KEY         Paratera API key fallback
  SCLAW_OPENCLAW_BASE_URL  Paratera endpoint override
  SCLAW_OPENCLAW_MINE_API_KEY   Mine API key (ZHIPU_API_KEY fallback)
  SCLAW_OPENCLAW_MINE_BASE_URL  Mine endpoint
  SCLAW_OPENCLAW_BIN       Optional local OpenClaw executable; version must still match
`);
}

function resolveSutRoot(explicitRoot) {
  const root = path.resolve(explicitRoot || process.env.SCLAW_ROOT || path.join(BENCHMARK_ROOT, "../.."));
  if (!fs.existsSync(path.join(root, "backend", "package.json"))) {
    throw new Error(`Invalid StructureClaw checkout: ${root}`);
  }
  return root;
}

function resolveProviderProfile(options) {
  if (options.provider === "mine") {
    const baseUrl = process.env.SCLAW_OPENCLAW_MINE_BASE_URL?.trim();
    if (!baseUrl) {
      throw new Error("SCLAW_OPENCLAW_MINE_BASE_URL is required for the mine provider");
    }
    const modelId = process.env.SCLAW_OPENCLAW_MINE_MODEL?.trim() || "glm-5.2";
    return {
      id: "mine",
      baseUrl,
      modelId,
      modelRef: `mine/${modelId}`,
      modelLabel: "glm-5.2-mine",
    };
  }
  const modelId = OPENCLAW_MODEL_ID;
  return {
    id: "paratera",
    baseUrl: process.env.SCLAW_OPENCLAW_BASE_URL || DEFAULT_BASE_URL,
    modelId,
    modelRef: OPENCLAW_MODEL,
    modelLabel: BENCHMARK_MODEL_LABEL,
  };
}

function resolveApiKey(runtimeDir, provider) {
  if (provider.id === "mine") {
    return process.env.SCLAW_OPENCLAW_MINE_API_KEY
      || process.env.ZHIPU_API_KEY
      || "";
  }
  const settings = readSourceSettings(runtimeDir);
  const llmBaseUrl = String(process.env.LLM_BASE_URL || settings.llm?.baseUrl || "");
  return process.env.SCLAW_OPENCLAW_API_KEY
    || process.env.PARATERA_API_KEY
    || settings.vision?.apiKey
    || (llmBaseUrl.includes("paratera.com")
      ? process.env.LLM_API_KEY || settings.llm?.apiKey
      : "")
    || "";
}

function npmLaunch() {
  if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, prefixArgs: [process.env.npm_execpath] };
  }
  if (process.platform === "win32") {
    const cliPath = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(cliPath)) {
      return { command: process.execPath, prefixArgs: [cliPath] };
    }
  }
  return { command: "npm", prefixArgs: [] };
}

function openClawLaunch() {
  const explicit = process.env.SCLAW_OPENCLAW_BIN?.trim();
  if (explicit) {
    return { command: explicit, prefixArgs: [] };
  }
  const npm = npmLaunch();
  return {
    command: npm.command,
    prefixArgs: [
      ...npm.prefixArgs,
      "exec",
      "--yes",
      "--prefer-offline",
      `--package=${OPENCLAW_PACKAGE}`,
      "--",
      "openclaw",
    ],
  };
}

function killProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree(child.pid);
        }, options.timeoutMs)
      : null;
    if (timeout && typeof timeout.unref === "function") timeout.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function verifyPinnedOpenClaw() {
  const launch = openClawLaunch();
  const result = await runProcess(
    launch.command,
    [...launch.prefixArgs, "--version"],
    { cwd: BENCHMARK_ROOT, env: process.env, timeoutMs: 120_000 },
  );
  if (result.code !== 0) {
    throw new Error(
      `Unable to run ${OPENCLAW_PACKAGE}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const match = `${result.stdout}\n${result.stderr}`.match(/OpenClaw\s+([^\s]+)/i);
  if (!match || match[1] !== OPENCLAW_VERSION) {
    throw new Error(
      `OpenClaw version mismatch: expected ${OPENCLAW_VERSION}, got ${match?.[1] || "unknown"}`,
    );
  }
  return match[1];
}

async function validateOpenClawConfig(configPath, workspaceRoot, env) {
  const launch = openClawLaunch();
  const result = await runProcess(
    launch.command,
    [...launch.prefixArgs, "config", "validate"],
    {
      cwd: workspaceRoot,
      env: {
        ...env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
      },
      timeoutMs: 120_000,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `OpenClaw config validation failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

async function validateOpenClawPlugin(configPath, workspaceRoot, env) {
  const launch = openClawLaunch();
  const result = await runProcess(
    launch.command,
    [
      ...launch.prefixArgs,
      "plugins",
      "inspect",
      "structureclaw-benchmark",
      "--runtime",
      "--json",
    ],
    {
      cwd: workspaceRoot,
      env: {
        ...env,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
      },
      timeoutMs: 120_000,
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `OpenClaw plugin validation failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const inspection = parseJsonOutput(result.stdout);
  if (inspection?.plugin?.status !== "loaded" || inspection?.plugin?.imported !== true) {
    throw new Error("OpenClaw did not load the StructureClaw benchmark plugin runtime");
  }
  const toolNames = inspection.plugin.toolNames || [];
  if (
    toolNames.length !== BENCHMARK_TOOL_IDS.length
    || BENCHMARK_TOOL_IDS.some((toolId) => !toolNames.includes(toolId))
  ) {
    throw new Error(
      `OpenClaw plugin tool mismatch: ${toolNames.join(", ") || "(none)"}`,
    );
  }
}

function readSourceSettings(runtimeDir) {
  const settingsPath = path.join(runtimeDir, "settings.json");
  if (!fs.existsSync(settingsPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read StructureClaw settings: ${error.message}`);
  }
}

function withoutSecrets(value) {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/(?:api.?key|token|secret|password|private.?key)/i.test(key))
      .map(([key, nested]) => [key, withoutSecrets(nested)]),
  );
}

function prepareSharedRuntime(options, context, provider, apiKey) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const runtimeRoot = path.resolve(
    options.runtimeRoot || path.join(BENCHMARK_ROOT, "runtime", "openclaw", runId),
  );
  const dataRoot = path.join(runtimeRoot, "structureclaw-data");
  const solverLockRoot = path.resolve(
    options.solverLockRoot || path.join(runtimeRoot, "solver-locks"),
  );
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(solverLockRoot, { recursive: true });
  const databasePath = path.join(dataRoot, "data", "structureclaw-openclaw.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const databaseUrl = `file:${databasePath.replace(/\\/g, "/")}`;
  const sourceSettingsWithSecrets = readSourceSettings(context.paths.runtimeDir);
  const sourceSettings = withoutSecrets(sourceSettingsWithSecrets);
  const settings = {
    ...sourceSettings,
    llm: {
      ...(sourceSettings.llm || {}),
      apiKey: undefined,
      model: provider.modelId,
      baseUrl: provider.baseUrl,
      maxRetries: 0,
    },
    database: { url: databaseUrl },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(dataRoot, "settings.json"),
    `${JSON.stringify(settings, (_key, value) => value === undefined ? undefined : value, 2)}\n`,
  );
  const env = {
    ...process.env,
    ...context.env,
    SCLAW_ROOT: options.sutRoot,
    SCLAW_BENCHMARK_ROOT: BENCHMARK_ROOT,
    SCLAW_BENCHMARK_LLM_ONLY: "1",
    SCLAW_BENCHMARK_SOLVER_GATE: "per-engine",
    SCLAW_BENCHMARK_SOLVER_LOCK_ROOT: solverLockRoot,
    SCLAW_BENCHMARK_YJK_COOLDOWN_MS: String(DEFAULT_YJK_COOLDOWN_MS),
    SCLAW_DATA_DIR: dataRoot,
    DATABASE_URL: databaseUrl,
    LLM_API_KEY: apiKey,
    LLM_MODEL: provider.modelId,
    LLM_BASE_URL: provider.baseUrl,
    LLM_VISION_API_KEY: process.env.LLM_VISION_API_KEY
      || sourceSettingsWithSecrets.vision?.apiKey
      || "",
    LLM_VISION_MODEL: process.env.LLM_VISION_MODEL
      || sourceSettingsWithSecrets.vision?.model
      || "",
    LLM_VISION_BASE_URL: process.env.LLM_VISION_BASE_URL
      || sourceSettingsWithSecrets.vision?.baseUrl
      || "",
    OPENCLAW_BENCHMARK_API_KEY: apiKey,
    PARATERA_API_KEY: provider.id === "paratera"
      ? apiKey
      : process.env.PARATERA_API_KEY || "",
    YJK_CLOSE_AFTER_RUN: "1",
    LOG_LEVEL: "warn",
  };
  return { runtimeRoot, dataRoot, solverLockRoot, databaseUrl, env, provider };
}

function initializeState({ locale, workspaceRoot, skillIds, attachmentPaths }) {
  return {
    messages: [],
    draftState: null,
    artifacts: {},
    selectedSkillIds: [...skillIds],
    toolAccessPolicy: {
      enabledToolIds: [...BENCHMARK_TOOL_IDS],
      disabledToolIds: [],
      fileAccessAllowlist: [...attachmentPaths],
    },
    locale: locale === "en" ? "en" : "zh",
    workspaceRoot,
    policy: {},
    contextSeismicWorkflow: null,
    bindings: {},
    lastUserMessage: "",
    structuralTypeKey: null,
    model: null,
    analysisResult: null,
    codeCheckResult: null,
    report: null,
    _solverEvents: [],
  };
}

function uniqueAttachmentName(attachment, index, turnIndex) {
  const original = attachment.originalName || path.basename(attachment.relPath || "") || "attachment";
  const extension = path.extname(original);
  const stem = path.basename(original, extension);
  return `${turnIndex}-${index}-${safeSegment(stem)}${extension.toLowerCase()}`;
}

function copyAttachments(attachments, workspaceRoot, turnIndex) {
  if (!Array.isArray(attachments) || attachments.length === 0) return [];
  const attachmentRoot = path.join(workspaceRoot, "attachments");
  fs.mkdirSync(attachmentRoot, { recursive: true });
  return attachments.map((attachment, index) => {
    const sourcePath = path.resolve(attachment.relPath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Benchmark attachment does not exist: ${sourcePath}`);
    }
    const targetPath = path.join(
      attachmentRoot,
      uniqueAttachmentName(attachment, index, turnIndex),
    );
    fs.copyFileSync(sourcePath, targetPath);
    return { ...attachment, originalSourcePath: sourcePath, relPath: targetPath };
  });
}

function attachmentPrompt(attachments, locale) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  const title = locale === "en"
    ? "Supplied benchmark attachments (analyze only with analyze_file):"
    : "本轮提供的 benchmark 附件（只能通过 analyze_file 读取）：";
  return [
    title,
    ...attachments.map((attachment) =>
      `- ${attachment.originalName || path.basename(attachment.relPath)}: ${attachment.relPath}`),
  ].join("\n");
}

function appendUserMessage(state, message) {
  state.lastUserMessage = message;
  state.messages.push({ role: "user", type: "human", content: message });
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(
    usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.input ?? 0,
  );
  const output = Number(
    usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.output ?? 0,
  );
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? input + output);
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
    total_tokens: Number.isFinite(total) ? total : 0,
  };
}

function appendAssistantMessage(state, text, result) {
  const usage = normalizeUsage(result?.meta?.agentMeta?.usage || result?.meta?.usage);
  state.messages.push({
    role: "assistant",
    type: "ai",
    content: text,
    usage_metadata: usage || undefined,
    response_metadata: {
      provider: result?.meta?.agentMeta?.provider || null,
      model: result?.meta?.agentMeta?.model || null,
    },
  });
}

function parseJsonOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("OpenClaw returned empty JSON output");
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // Fall through to prefixed-log recovery.
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trimStart().startsWith("{")) continue;
    try {
      const parsed = JSON.parse(lines.slice(index).join("\n"));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Keep scanning because plugin startup logs may precede the JSON object.
    }
  }
  throw new Error(`Unable to parse OpenClaw JSON output: ${trimmed.slice(-1000)}`);
}

function assistantText(result) {
  const payloads = Array.isArray(result?.payloads)
    ? result.payloads
    : Array.isArray(result?.result?.payloads)
      ? result.result.payloads
      : [];
  return payloads
    .map((payload) => typeof payload?.text === "string" ? payload.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function assistantFromSession(stateRoot, sessionId) {
  const sessionPath = path.join(
    stateRoot,
    "agents",
    "main",
    "sessions",
    `${sessionId}.jsonl`,
  );
  if (!fs.existsSync(sessionPath)) return null;
  const lines = fs.readFileSync(sessionPath, "utf8").split(/\r?\n/).filter(Boolean);
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let finalAssistant = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const message = record?.message;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const messageUsage = message.usage;
    if (messageUsage && typeof messageUsage === "object") {
      const input = Number(messageUsage.input || 0) + Number(messageUsage.cacheRead || 0);
      const output = Number(messageUsage.output || 0);
      const total = Number(messageUsage.totalTokens);
      usage.inputTokens += Number.isFinite(input) ? input : 0;
      usage.outputTokens += Number.isFinite(output) ? output : 0;
      usage.totalTokens += Number.isFinite(total) ? total : input + output;
    }
    const text = message.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    if (!text || finalAssistant) continue;
    finalAssistant = {
      text,
      model: message.model || null,
      provider: message.provider || null,
    };
  }
  return finalAssistant ? { ...finalAssistant, usage } : null;
}

function subtractUsage(current, previous) {
  const before = previous || {};
  return {
    inputTokens: Math.max(0, Number(current?.inputTokens || 0) - Number(before.inputTokens || 0)),
    outputTokens: Math.max(0, Number(current?.outputTokens || 0) - Number(before.outputTokens || 0)),
    totalTokens: Math.max(0, Number(current?.totalTokens || 0) - Number(before.totalTokens || 0)),
  };
}

function assertPinnedResultModel(result, provider = {
  modelId: OPENCLAW_MODEL_ID,
  modelRef: OPENCLAW_MODEL,
}) {
  const model = result?.meta?.agentMeta?.model || result?.meta?.model;
  const expected = new Set([
    "glm-5.2",
    String(provider.modelId).toLowerCase(),
    String(provider.modelRef).toLowerCase(),
  ]);
  if (model && !expected.has(String(model).toLowerCase())) {
    throw new Error(`OpenClaw used unexpected model '${model}' instead of ${provider.modelRef}`);
  }
  const fallbackAttempts = result?.meta?.agentMeta?.fallbackAttempts;
  if (Array.isArray(fallbackAttempts) && fallbackAttempts.length > 0) {
    throw new Error("OpenClaw reported a model fallback attempt in a frozen benchmark run");
  }
}

async function runOpenClawTurn(options) {
  const launch = openClawLaunch();
  const args = [
    ...launch.prefixArgs,
    "agent",
    "--local",
    "--session-id",
    options.sessionId,
    "--message-file",
    options.messagePath,
    "--model",
    options.provider.modelRef,
    "--thinking",
    OPENCLAW_THINKING,
    "--timeout",
    String(Math.max(1, Math.ceil(options.timeoutMs / 1000))),
    "--json",
  ];
  const result = await runProcess(launch.command, args, {
    cwd: options.workspaceRoot,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });
  if (result.timedOut) {
    throw new Error(`OpenClaw case timed out after ${options.timeoutMs}ms`);
  }
  if (result.code !== 0) {
    throw new Error(
      `OpenClaw exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const parsed = parseJsonOutput(result.stdout);
  const runResult = parsed?.result && typeof parsed.result === "object"
    ? parsed.result
    : parsed;
  assertPinnedResultModel(runResult, options.provider);
  const sessionAssistant = assistantFromSession(options.stateRoot, options.sessionId);
  const text = assistantText(runResult) || sessionAssistant?.text || "";
  if (!text) throw new Error("OpenClaw returned no assistant text");
  assertPinnedResultModel(
    sessionAssistant?.model
      ? { meta: { model: sessionAssistant.model } }
      : {},
    options.provider,
  );
  if (!runResult.meta || typeof runResult.meta !== "object") runResult.meta = {};
  if (!runResult.meta.agentMeta || typeof runResult.meta.agentMeta !== "object") {
    runResult.meta.agentMeta = {};
  }
  runResult.meta.agentMeta.model ||= sessionAssistant?.model;
  runResult.meta.agentMeta.provider ||= sessionAssistant?.provider;
  if (sessionAssistant?.usage) {
    runResult.meta.agentMeta.usage = subtractUsage(
      sessionAssistant.usage,
      options.previousSessionUsage,
    );
  }
  return {
    result: runResult,
    text,
    stderr: result.stderr,
    sessionUsage: sessionAssistant?.usage || options.previousSessionUsage || null,
  };
}

function summarizeSolverGate(events, durationMs) {
  const solverQueueWaitMs = events.reduce((sum, event) => sum + Number(event.queueWaitMs || 0), 0);
  const solverExecutionMs = events.reduce(
    (sum, event) => sum + Number(event.solverExecutionMs || 0),
    0,
  );
  const cooldownMs = events.reduce((sum, event) => sum + Number(event.cooldownMs || 0), 0);
  return {
    enabled: true,
    mode: "per-engine",
    events,
    solverQueueWaitMs,
    solverExecutionMs,
    cooldownMs,
    effectiveDurationMs: Math.max(0, durationMs - solverQueueWaitMs - cooldownMs),
  };
}

function redactRuntimeText(value, options) {
  let text = String(value || "");
  const replacements = [
    [options?.sharedRuntime?.runtimeRoot, "<RUN_ROOT>"],
    [options?.sutRoot, "<SUT_ROOT>"],
    [process.env.USERPROFILE || process.env.HOME, "<USER_HOME>"],
  ];
  for (const [target, replacement] of replacements) {
    if (!target) continue;
    const normalized = path.resolve(target);
    text = text.split(normalized).join(replacement);
    text = text.split(normalized.replace(/\\/g, "\\\\")).join(replacement);
  }
  return text;
}

function redactSolverEvents(events, options) {
  return events.map((event) => ({
    ...event,
    ...(event.error ? { error: redactRuntimeText(event.error, options) } : {}),
  }));
}

function failedEvaluation(scenario, message, durationMs) {
  return {
    scenarioId: scenario.id,
    baseScenarioId: scenario.baseScenarioId || scenario.id,
    description: scenario.description || "",
    split: scenario.split || "core",
    taskFamily: scenario.taskFamily,
    inputModality: scenario.inputModality,
    structureType: scenario.structureType,
    difficulty: scenario.difficulty,
    skillTarget: scenario.skillTarget,
    mode: scenario.mode || "auto",
    passed: 0,
    total: 1,
    allPassed: false,
    metrics: [{
      metric: "execution",
      pass: false,
      expected: "OpenClaw scenario completes",
      actual: message,
    }],
    durationMs,
  };
}

function isProviderRateLimitFailure(evaluation) {
  return (evaluation?.metrics || []).some((metric) => (
    metric?.pass === false
    && /(?:provider_rate_limit|rate[-_\s]?limit(?:ed|ing)?|too many requests|达到速率限制|访问量过大|(?:http|status(?:\s+code)?)[\s:=]*429\b|"status"\s*:\s*429\b)/i.test(
      String(metric.actual || ""),
    )
  ));
}

function isRetryableInfrastructureFailure(evaluation) {
  if (isProviderRateLimitFailure(evaluation)) return true;
  return (evaluation?.metrics || []).some((metric) => (
    metric?.pass === false
    && /^OpenClaw exited with code 1:/i.test(String(metric.actual || ""))
  ));
}

function stateHasProviderRateLimit(state) {
  return (state?.messages || []).some((message) => (
    /(?:provider_rate_limit|rate[-_\s]?limit(?:ed|ing)?|too many requests|达到速率限制|访问量过大|(?:http|status(?:\s+code)?)[\s:=]*429\b|"status"\s*:\s*429\b)/i.test(
      String(message?.content ?? message?.kwargs?.content ?? ""),
    )
  ));
}

function providerRateLimitReruns() {
  const value = Number(
    process.env.SCLAW_OPENCLAW_RATE_LIMIT_RERUNS
      || DEFAULT_PROVIDER_RATE_LIMIT_RERUNS,
  );
  return Number.isSafeInteger(value) && value >= 0
    ? value
    : DEFAULT_PROVIDER_RATE_LIMIT_RERUNS;
}

function providerRateLimitBackoffMs(rerunNumber) {
  const base = Number(
    process.env.SCLAW_OPENCLAW_RATE_LIMIT_BACKOFF_MS
      || DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS,
  );
  const maximum = Number(
    process.env.SCLAW_OPENCLAW_RATE_LIMIT_MAX_BACKOFF_MS
      || DEFAULT_PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS,
  );
  const safeBase = Number.isFinite(base) && base >= 0
    ? base
    : DEFAULT_PROVIDER_RATE_LIMIT_BACKOFF_MS;
  const safeMaximum = Number.isFinite(maximum) && maximum >= safeBase
    ? maximum
    : DEFAULT_PROVIDER_RATE_LIMIT_MAX_BACKOFF_MS;
  return Math.min(safeMaximum, safeBase * (2 ** Math.max(0, rerunNumber - 1)));
}

function createProviderCooldown() {
  let cooldownUntil = 0;
  return {
    register(rerunNumber) {
      const backoffMs = providerRateLimitBackoffMs(rerunNumber);
      cooldownUntil = Math.max(cooldownUntil, Date.now() + backoffMs);
      return backoffMs;
    },
    async wait(staggerMs = 0) {
      const delayMs = Math.max(0, cooldownUntil - Date.now()) + Math.max(0, staggerMs);
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    },
  };
}

async function runScenario(options) {
  const {
    scenario: rawScenario,
    manifests,
    sharedRuntime,
    runRoot,
  } = options;
  const scenario = normalizeScenario(resolveAttachmentPaths(rawScenario));
  const skillIds = resolveSkillIds(scenario, manifests);
  const caseRoot = path.join(
    runRoot,
    "cases",
    safeSegment(scenario.id),
    `attempt-${Number(options.infrastructureAttempt || 0) + 1}`,
  );
  const workspaceRoot = path.join(caseRoot, "workspace");
  const openClawStateRoot = path.join(caseRoot, "openclaw-state");
  fs.mkdirSync(caseRoot, { recursive: true });
  const allAttachments = [
    ...(Array.isArray(scenario.attachments) ? scenario.attachments : []),
    ...(Array.isArray(scenario.turns)
      ? scenario.turns.flatMap((turn) => Array.isArray(turn.attachments) ? turn.attachments : [])
      : []),
  ];
  const copiedAllAttachments = copyAttachments(allAttachments, workspaceRoot, 0);
  const attachmentPaths = copiedAllAttachments.map((attachment) => attachment.relPath);
  const statePath = path.join(caseRoot, "structureclaw-state.json");
  const runConfigPath = path.join(caseRoot, "run-config.json");
  const state = initializeState({
    locale: scenario.locale,
    workspaceRoot,
    skillIds,
    attachmentPaths,
  });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  fs.writeFileSync(runConfigPath, `${JSON.stringify({
    statePath,
    workspaceRoot,
    skillIds,
    enabledToolIds: BENCHMARK_TOOL_IDS,
    attachmentPaths,
    maxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS,
  }, null, 2)}\n`);
  const { configPath } = prepareOpenClawWorkspace({
    workspaceRoot,
    stateRoot: openClawStateRoot,
    pluginRoot: PLUGIN_ROOT,
    manifests,
    skillIds,
    locale: scenario.locale,
    baseUrl: options.provider.baseUrl,
    providerId: options.provider.id,
    modelId: options.provider.modelId,
    modelRef: options.provider.modelRef,
  });
  const env = {
    ...sharedRuntime.env,
    SCLAW_OPENCLAW_RUN_CONFIG: runConfigPath,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: openClawStateRoot,
  };
  const sessionId = safeSegment(`benchmark-${scenario.id}`);
  const startedAt = Date.now();
  const turnResults = [];
  let previousSessionUsage = null;
  try {
    for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex += 1) {
      const turn = scenario.turns[turnIndex];
      const sourceAttachments = (turn.attachments !== undefined
        ? turn.attachments
        : turnIndex === 0 ? scenario.attachments : []) || [];
      const copiedTurnAttachments = sourceAttachments.map((attachment) => {
        const sourcePath = path.resolve(attachment.relPath);
        return copiedAllAttachments.find(
          (candidate) => candidate.originalSourcePath === sourcePath,
        );
      }).filter(Boolean);
      const visionSummaries = await buildVisionSummaries(
        copiedTurnAttachments,
        scenario.locale || "zh",
      );
      const analyzableAttachments = filterImageAttachments(copiedTurnAttachments) || [];
      let message = attachVisionSummariesToMessage(
        turn.message,
        visionSummaries,
        scenario.locale || "zh",
        turn.engineeringSpecification ?? scenario.engineeringSpecification,
      );
      const attachmentBlock = attachmentPrompt(analyzableAttachments, scenario.locale || "zh");
      if (attachmentBlock) message = `${message}\n\n${attachmentBlock}`;
      const currentState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      appendUserMessage(currentState, message);
      fs.writeFileSync(statePath, `${JSON.stringify(currentState, null, 2)}\n`);
      const messagePath = path.join(caseRoot, `turn-${turnIndex + 1}.txt`);
      fs.writeFileSync(messagePath, message);
      const turnStartedAt = Date.now();
      const response = await runOpenClawTurn({
        sessionId,
        messagePath,
        workspaceRoot: options.sutRoot,
        stateRoot: openClawStateRoot,
        env,
        timeoutMs: Math.max(1, options.caseTimeoutMs - (Date.now() - startedAt)),
        previousSessionUsage,
        provider: options.provider,
      });
      previousSessionUsage = response.sessionUsage;
      const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      appendAssistantMessage(finalState, response.text, response.result);
      fs.writeFileSync(statePath, `${JSON.stringify(finalState, null, 2)}\n`);
      if (stateHasProviderRateLimit(finalState)) {
        throw new Error("PROVIDER_RATE_LIMIT: a model or judge request returned HTTP 429");
      }
      if (Array.isArray(turn.assertions) && turn.assertions.length > 0) {
        const turnScenario = { ...scenario, expect: { assertions: turn.assertions } };
        const evaluation = await evaluateScenario(
          turnScenario,
          finalState,
          Date.now() - turnStartedAt,
        );
        appendVisionUsageMetrics(evaluation, visionSummaries);
        turnResults.push({ turnIndex, evaluation });
      }
    }
    const durationMs = Date.now() - startedAt;
    let evaluation;
    if (scenario._multiTurn) {
      evaluation = mergeTurnResults(scenario, turnResults, durationMs);
    } else {
      evaluation = turnResults[0]?.evaluation
        || failedEvaluation(scenario, "No assertions were evaluated", durationMs);
    }
    const finalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const solverEvents = redactSolverEvents(
      Array.isArray(finalState._solverEvents) ? finalState._solverEvents : [],
      options,
    );
    const solverGate = summarizeSolverGate(solverEvents, durationMs);
    evaluation.executionProfile = {
      harness: "OpenClaw + StructureClaw tool environment + GLM-5.2",
      openClawVersion: OPENCLAW_VERSION,
      openClawPackage: OPENCLAW_PACKAGE,
      model: options.provider.modelRef,
      modelLabel: options.provider.modelLabel,
      provider: options.provider.id,
      thinking: OPENCLAW_THINKING,
      modelFallbacks: [],
      mode: scenario.mode,
      skillIds,
      enabledToolIds: [...BENCHMARK_TOOL_IDS],
      concurrency: options.concurrency,
      analysisSkillTarget: scenario.analysisSkillTarget,
      solverGate,
      effectiveDurationMs: solverGate.effectiveDurationMs,
      yjkCloseAfterRun: "1",
    };
    evaluation.repeatId = options.repeatId;
    evaluation.provider = options.provider.id;
    evaluation.durationMs = durationMs;
    evaluation.retries = {
      attempts: 1,
      maxRetries: 0,
      retriesUsed: 0,
      passAt1: evaluation.allPassed === true,
      passAtN: evaluation.allPassed === true,
      rounds: [{
        attempt: 1,
        allPassed: evaluation.allPassed === true,
        metrics: (evaluation.metrics || []).map((metric) => ({
          metric: metric.metric,
          pass: metric.pass,
        })),
      }],
    };
    return evaluation;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = redactRuntimeText(
      error instanceof Error ? error.message : String(error),
      options,
    );
    const evaluation = failedEvaluation(scenario, message, durationMs);
    let solverEvents = [];
    if (fs.existsSync(statePath)) {
      const failedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      solverEvents = redactSolverEvents(
        Array.isArray(failedState._solverEvents) ? failedState._solverEvents : [],
        options,
      );
    }
    const solverGate = summarizeSolverGate(solverEvents, durationMs);
    evaluation.executionProfile = {
      harness: "OpenClaw + StructureClaw tool environment + GLM-5.2",
      openClawVersion: OPENCLAW_VERSION,
      openClawPackage: OPENCLAW_PACKAGE,
      model: options.provider.modelRef,
      modelLabel: options.provider.modelLabel,
      provider: options.provider.id,
      thinking: OPENCLAW_THINKING,
      modelFallbacks: [],
      mode: scenario.mode,
      skillIds,
      enabledToolIds: [...BENCHMARK_TOOL_IDS],
      concurrency: options.concurrency,
      analysisSkillTarget: scenario.analysisSkillTarget,
      solverGate,
      effectiveDurationMs: solverGate.effectiveDurationMs,
    };
    evaluation.repeatId = options.repeatId;
    evaluation.provider = options.provider.id;
    return evaluation;
  }
}

async function runScenarioWithInfrastructureReruns(options) {
  const maximumReruns = providerRateLimitReruns();
  let infrastructureReruns = 0;
  while (true) {
    await options.providerCooldown.wait((options.scenarioIndex % options.concurrency) * 500);
    const evaluation = await runScenario({
      ...options,
      infrastructureAttempt: infrastructureReruns,
    });
    if (!isRetryableInfrastructureFailure(evaluation)) {
      evaluation.executionProfile = {
        ...(evaluation.executionProfile || {}),
        infrastructureReruns,
      };
      return evaluation;
    }
    infrastructureReruns += 1;
    if (infrastructureReruns > maximumReruns) {
      evaluation.executionProfile = {
        ...(evaluation.executionProfile || {}),
        infrastructureReruns: maximumReruns,
        infrastructureRetryExhausted: true,
      };
      return evaluation;
    }
    const backoffMs = options.providerCooldown.register(infrastructureReruns);
    process.stdout.write(
      `  Provider rate limit for ${options.scenario.id}; discarding attempt `
      + `${infrastructureReruns} and retrying after shared backoff `
      + `(>=${Math.ceil(backoffMs / 1000)}s).\n`,
    );
  }
}

async function runPool(items, concurrency, worker, onResult) {
  let nextIndex = 0;
  const results = new Array(items.length);
  async function consume() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      const result = await worker(items[index], index);
      results[index] = result;
      await onResult?.(result, index, results);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => consume()),
  );
  return results;
}

function buildRunMetadata(options, scenarios) {
  return {
    harness: "OpenClaw + StructureClaw tool environment + GLM-5.2",
    plannedScenarioCount: scenarios.length,
    startedAt: new Date().toISOString(),
    repeatId: options.repeatId,
    model: options.provider.modelRef,
    modelLabel: options.provider.modelLabel,
    provider: options.provider.id,
    thinking: OPENCLAW_THINKING,
    openClaw: {
      version: OPENCLAW_VERSION,
      package: OPENCLAW_PACKAGE,
    },
    concurrency: options.concurrency,
    protocol: {
      phase: "development",
      targeted: Boolean(options.scenarioId || options.taskFamily),
      modes: {
        standard_workflow: ["auto", "generic-only"],
        interactive_robustness: ["auto"],
        multimodal_reverse_engineering: ["auto"],
      },
      solverGate: {
        mode: "per-engine",
        capacities: {
          "builtin-opensees": 1,
          "builtin-pkpm": 1,
          "builtin-yjk": 1,
        },
        yjkCooldownMs: DEFAULT_YJK_COOLDOWN_MS,
        queueTimeExcluded: true,
      },
      tools: [...BENCHMARK_TOOL_IDS],
      modelFallbacks: [],
      retries: 0,
      providerRateLimitReruns: providerRateLimitReruns(),
    },
  };
}

function printMatrix(options, scenarios) {
  process.stdout.write(`\nOpenClaw external baseline\n`);
  process.stdout.write(`OpenClaw: ${OPENCLAW_VERSION} (${OPENCLAW_PACKAGE})\n`);
  process.stdout.write(
    `Model: ${options.provider.modelRef} (${options.provider.modelLabel}); fallbacks: disabled\n`,
  );
  process.stdout.write(`Provider: ${options.provider.id}; repeat: ${options.repeatId || "unset"}\n`);
  process.stdout.write(`Thinking: ${OPENCLAW_THINKING}\n`);
  process.stdout.write(`Scenario runs: ${scenarios.length}; concurrency: ${options.concurrency}\n`);
  process.stdout.write("Modes: standard_workflow=auto,generic-only; other families=auto\n");
  process.stdout.write(
    `Solver gate: per-engine capacity=1; YJK cooldown=${DEFAULT_YJK_COOLDOWN_MS}ms\n`,
  );
  process.stdout.write(`Tools: ${BENCHMARK_TOOL_IDS.join(", ")}\n`);
}

function loadCheckpoint(options, scenarios) {
  if (!options.resume) return [];
  if (!options.outputPath) {
    throw new Error("--resume requires --output");
  }
  const outputPath = path.resolve(options.outputPath);
  if (!fs.existsSync(outputPath)) return [];
  const checkpoint = JSON.parse(fs.readFileSync(outputPath, "utf8"));
  if (
    checkpoint.run?.repeatId !== null
    && checkpoint.run?.repeatId !== undefined
    && checkpoint.run.repeatId !== options.repeatId
  ) {
    throw new Error(
      `Checkpoint repeat ${checkpoint.run.repeatId} does not match --repeat ${options.repeatId}`,
    );
  }
  const plannedIds = new Set(scenarios.map((scenario) => scenario.id));
  const completedById = new Map();
  for (const result of checkpoint.scenarios || []) {
    if (plannedIds.has(result.scenarioId)) completedById.set(result.scenarioId, result);
  }
  return [...completedById.values()];
}

async function prepareDatabase(sutRoot, env) {
  const npm = npmLaunch();
  const prisma = spawnSync(
    npm.command,
    [...npm.prefixArgs, "exec", "--", "prisma", "db", "push", "--accept-data-loss"],
    {
      cwd: path.join(sutRoot, "backend"),
      env,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (prisma.status !== 0) {
    throw new Error(`Prisma db push failed: ${prisma.stderr || prisma.stdout}`);
  }
}

async function loadSkillManifests(sutRoot) {
  const runtimePath = path.join(sutRoot, "backend", "dist", "agent-runtime", "index.js");
  const { AgentSkillRuntime } = await import(`${pathToFileURL(runtimePath).href}?openclaw=${Date.now()}`);
  const runtime = new AgentSkillRuntime();
  return runtime.listSkillManifests();
}

async function runOpenClawBenchmark(argv) {
  const options = parseOpenClawOptions(argv);
  if (options.help) {
    printHelp();
    return;
  }
  options.sutRoot = resolveSutRoot(options.sutRoot);
  options.provider = resolveProviderProfile(options);
  const sharedPath = path.join(options.sutRoot, "tests", "regression", "shared.js");
  const { resolveRegressionContext, runBackendBuildOnce } = require(sharedPath);
  const context = resolveRegressionContext(options.sutRoot);
  const apiKey = resolveApiKey(context.paths.runtimeDir, options.provider);
  if (!options.dryRun && !apiKey) {
    throw new Error(
      `An API key is required for the ${options.provider.id} provider`,
    );
  }
  const version = await verifyPinnedOpenClaw();
  process.env.LLM_API_KEY = apiKey || "dry-run-placeholder";
  process.env.LLM_MODEL = options.provider.modelId;
  process.env.LLM_BASE_URL = options.provider.baseUrl;
  const sharedRuntime = prepareSharedRuntime(
    options,
    context,
    options.provider,
    apiKey || "dry-run-placeholder",
  );
  for (const key of ["LLM_VISION_API_KEY", "LLM_VISION_MODEL", "LLM_VISION_BASE_URL"]) {
    if (sharedRuntime.env[key]) process.env[key] = sharedRuntime.env[key];
  }
  if (process.env.SCLAW_OPENCLAW_SKIP_BUILD !== "1") {
    await runBackendBuildOnce(context);
  }
  if (!options.dryRun) {
    await prepareDatabase(options.sutRoot, sharedRuntime.env);
  }
  const manifests = await loadSkillManifests(options.sutRoot);
  const scenarios = resolveExternalScenarioRuns(loadScenarios({
    scenarioId: options.scenarioId,
    taskFamily: options.taskFamily,
  }), options.mode);
  if (scenarios.length === 0) {
    process.stdout.write("No benchmark scenarios matched.\n");
    return;
  }
  printMatrix(options, scenarios);
  if (options.dryRun) {
    const dryScenario = scenarios[0];
    const skillIds = resolveSkillIds(dryScenario, manifests);
    const dryRoot = path.join(sharedRuntime.runtimeRoot, "dry-run");
    const workspaceRoot = path.join(dryRoot, "workspace");
    const stateRoot = path.join(dryRoot, "openclaw-state");
    const statePath = path.join(dryRoot, "structureclaw-state.json");
    const runConfigPath = path.join(dryRoot, "run-config.json");
    fs.mkdirSync(dryRoot, { recursive: true });
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(initializeState({
        locale: dryScenario.locale,
        workspaceRoot,
        skillIds,
        attachmentPaths: [],
      }), null, 2)}\n`,
    );
    fs.writeFileSync(runConfigPath, `${JSON.stringify({
      statePath,
      workspaceRoot,
      skillIds,
      enabledToolIds: BENCHMARK_TOOL_IDS,
      attachmentPaths: [],
      maxToolCallsPerTurn: DEFAULT_MAX_TOOL_CALLS,
    }, null, 2)}\n`);
    const { configPath } = prepareOpenClawWorkspace({
      workspaceRoot,
      stateRoot,
      pluginRoot: PLUGIN_ROOT,
      manifests,
      skillIds,
      locale: dryScenario.locale,
      baseUrl: options.provider.baseUrl,
      providerId: options.provider.id,
      modelId: options.provider.modelId,
      modelRef: options.provider.modelRef,
    });
    await validateOpenClawConfig(configPath, workspaceRoot, {
      ...sharedRuntime.env,
      SCLAW_OPENCLAW_RUN_CONFIG: runConfigPath,
    });
    await validateOpenClawPlugin(configPath, workspaceRoot, {
      ...sharedRuntime.env,
      SCLAW_OPENCLAW_RUN_CONFIG: runConfigPath,
    });
    process.stdout.write(`Pinned OpenClaw preflight passed: ${version}\n`);
    process.stdout.write("OpenClaw config validation passed.\n");
    process.stdout.write("OpenClaw plugin validation passed with all 9 frozen tools.\n");
    process.stdout.write(`Runtime prepared at: ${sharedRuntime.runtimeRoot}\n`);
    return;
  }
  const runMetadata = buildRunMetadata(options, scenarios);
  const completed = loadCheckpoint(options, scenarios);
  const completedIds = new Set(completed.map((result) => result.scenarioId));
  const pendingScenarios = scenarios.filter((scenario) => !completedIds.has(scenario.id));
  if (completed.length > 0) {
    process.stdout.write(
      `Resuming from ${completed.length}/${scenarios.length} completed scenario runs.\n`,
    );
  }
  const providerCooldown = createProviderCooldown();
  const newResults = await runPool(
    pendingScenarios,
    options.concurrency,
    async (scenario, index) => {
      process.stdout.write(`\nRunning: ${scenario.id}\n`);
      return runScenarioWithInfrastructureReruns({
        scenario,
        scenarioIndex: index,
        manifests,
        sharedRuntime,
        runRoot: sharedRuntime.runtimeRoot,
        provider: options.provider,
        repeatId: options.repeatId,
        sutRoot: options.sutRoot,
        caseTimeoutMs: options.caseTimeoutMs,
        concurrency: options.concurrency,
        providerCooldown,
      });
    },
    async (result, index) => {
      printScenarioResult(pendingScenarios[index], result);
      completed.push(result);
      if (options.outputPath) {
        writeJsonOutput(options.outputPath, completed, {
          quiet: true,
          runMetadata,
          completed: false,
        });
      }
    },
  );
  const results = [
    ...completed.filter((result) => completedIds.has(result.scenarioId)),
    ...newResults,
  ];
  printSummary(results);
  if (options.outputPath) {
    writeJsonOutput(options.outputPath, results, {
      runMetadata,
      completed: true,
    });
  }
  if (results.some((result) => !result.allPassed)) process.exitCode = 1;
}

module.exports = {
  assistantText,
  assistantFromSession,
  assertPinnedResultModel,
  buildRunMetadata,
  initializeState,
  isProviderRateLimitFailure,
  isRetryableInfrastructureFailure,
  openClawLaunch,
  parseJsonOutput,
  providerRateLimitBackoffMs,
  redactRuntimeText,
  runOpenClawBenchmark,
  stateHasProviderRateLimit,
  subtractUsage,
  summarizeSolverGate,
  validateOpenClawConfig,
  validateOpenClawPlugin,
  verifyPinnedOpenClaw,
};

if (require.main === module) {
  runOpenClawBenchmark(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
