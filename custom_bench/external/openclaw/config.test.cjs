const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BENCHMARK_MODEL_LABEL,
  BENCHMARK_TOOL_IDS,
  DEFAULT_CONCURRENCY,
  OPENCLAW_MODEL,
  OPENCLAW_PACKAGE,
  OPENCLAW_THINKING,
  OPENCLAW_VERSION,
  buildOpenClawConfig,
  parseOpenClawOptions,
  resolveExternalScenarioRuns,
  resolveSkillIds,
} = require("./lib/config.cjs");
const {
  assistantFromSession,
  assertPinnedResultModel,
  initializeState,
  isProviderRateLimitFailure,
  isRetryableInfrastructureFailure,
  parseJsonOutput,
  providerRateLimitBackoffMs,
  redactRuntimeText,
  stateHasProviderRateLimit,
  subtractUsage,
  summarizeSolverGate,
} = require("./runner.cjs");

test("pins the complete OpenClaw runtime identity", () => {
  assert.equal(OPENCLAW_VERSION, "2026.6.33");
  assert.equal(OPENCLAW_PACKAGE, "openclaw@2026.6.33");
  assert.equal(BENCHMARK_MODEL_LABEL, "glm-5.2-paratera");
  assert.equal(OPENCLAW_MODEL, "paratera/GLM-5.2");
  assert.equal(OPENCLAW_THINKING, "high");
  assert.equal(DEFAULT_CONCURRENCY, 10);
});

test("freezes the external mode matrix", () => {
  const scenarios = [
    { id: "standard", taskFamily: "standard_workflow", expect: { assertions: [] } },
    { id: "interactive", taskFamily: "interactive_robustness", expect: { assertions: [] } },
    { id: "multimodal", taskFamily: "multimodal_reverse_engineering", expect: { assertions: [] } },
  ];
  assert.deepEqual(
    resolveExternalScenarioRuns(scenarios, "all").map((scenario) => scenario.id),
    [
      "standard#auto",
      "standard#generic-only",
      "interactive#auto",
      "multimodal#auto",
    ],
  );
});

test("auto and generic-only expose the intended skill scopes", () => {
  const manifests = [
    { id: "beam", domain: "structure-type" },
    { id: "frame", domain: "structure-type" },
    { id: "generic", domain: "structure-type" },
    { id: "pkpm-static", domain: "analysis" },
    { id: "validation-structure-model", domain: "validation" },
    { id: "report-export-builtin", domain: "report-export" },
  ];
  assert.deepEqual(
    resolveSkillIds({ mode: "auto", analysisSkillTarget: "pkpm-static" }, manifests),
    [
      "beam",
      "frame",
      "generic",
      "pkpm-static",
      "validation-structure-model",
      "report-export-builtin",
    ],
  );
  assert.deepEqual(
    resolveSkillIds({ mode: "generic-only", analysisSkillTarget: "pkpm-static" }, manifests),
    [
      "generic",
      "pkpm-static",
      "validation-structure-model",
      "report-export-builtin",
    ],
  );
});

test("OpenClaw config disables fallbacks and unlisted tools", () => {
  const config = buildOpenClawConfig({
    workspaceRoot: "C:/runtime/workspace",
    pluginRoot: "C:/runtime/plugin",
    skillIds: ["beam", "opensees-static"],
  });
  assert.equal(config.agents.defaults.model.primary, "paratera/GLM-5.2");
  assert.deepEqual(config.agents.defaults.model.fallbacks, []);
  assert.deepEqual(config.tools.allow, BENCHMARK_TOOL_IDS);
  assert.equal(config.tools.codeMode.enabled, false);
  assert.deepEqual(config.plugins.allow, ["structureclaw-benchmark"]);
  assert.deepEqual(Object.keys(config.plugins.entries), ["structureclaw-benchmark"]);
  assert.equal(config.models.providers.paratera.models[0].id, "GLM-5.2");
});

test("OpenClaw config supports an equivalent provider without changing the frozen model policy", () => {
  const config = buildOpenClawConfig({
    workspaceRoot: "C:/runtime/workspace",
    pluginRoot: "C:/runtime/plugin",
    skillIds: ["beam", "opensees-static"],
    baseUrl: "https://example.invalid/v1",
    providerId: "mine",
    modelId: "glm-5.2",
    modelRef: "mine/glm-5.2",
  });
  assert.equal(config.agents.defaults.model.primary, "mine/glm-5.2");
  assert.deepEqual(config.agents.defaults.model.fallbacks, []);
  assert.equal(config.models.providers.mine.models[0].id, "glm-5.2");
  assert.equal(config.models.providers.mine.apiKey, "${OPENCLAW_BENCHMARK_API_KEY}");
});

test("plugin manifest and runner use the same frozen tool list", () => {
  const manifestPath = path.join(__dirname, "plugin", "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest.contracts.tools, BENCHMARK_TOOL_IDS);
});

test("CLI parsing keeps the frozen concurrency default", () => {
  assert.equal(parseOpenClawOptions([]).concurrency, 10);
  assert.equal(parseOpenClawOptions(["--concurrency", "12"]).concurrency, 12);
  assert.deepEqual(
    {
      provider: parseOpenClawOptions(["--provider", "mine", "--repeat", "2"]).provider,
      repeatId: parseOpenClawOptions(["--provider", "mine", "--repeat", "2"]).repeatId,
    },
    { provider: "mine", repeatId: 2 },
  );
  assert.throws(
    () => parseOpenClawOptions(["--concurrency", "0"]),
    /positive integer/,
  );
  assert.throws(
    () => parseOpenClawOptions(["--repeat", "4"]),
    /1, 2, or 3/,
  );
});

test("state and solver metrics keep queue time separate", () => {
  const state = initializeState({
    locale: "en",
    workspaceRoot: "C:/runtime/workspace",
    skillIds: ["beam"],
    attachmentPaths: [],
  });
  assert.deepEqual(state.selectedSkillIds, ["beam"]);
  assert.deepEqual(state.toolAccessPolicy.enabledToolIds, BENCHMARK_TOOL_IDS);
  const profile = summarizeSolverGate([
    {
      engineId: "builtin-yjk",
      queueWaitMs: 100,
      solverExecutionMs: 200,
      cooldownMs: 5000,
    },
  ], 6000);
  assert.equal(profile.solverQueueWaitMs, 100);
  assert.equal(profile.solverExecutionMs, 200);
  assert.equal(profile.cooldownMs, 5000);
  assert.equal(profile.effectiveDurationMs, 900);
});

test("redacts local paths before benchmark results are written", () => {
  const sutRoot = path.resolve("C:/work/structureclaw");
  const runRoot = path.resolve("C:/work/structureclaw/runtime/openclaw/run-1");
  assert.equal(
    redactRuntimeText(
      `${runRoot}${path.sep}case failed under ${sutRoot}`,
      { sutRoot, sharedRuntime: { runtimeRoot: runRoot } },
    ),
    `<RUN_ROOT>${path.sep}case failed under <SUT_ROOT>`,
  );
});

test("classifies and backs off provider rate limits without scoring them", () => {
  assert.equal(isProviderRateLimitFailure({
    metrics: [{ pass: false, actual: "HTTP 429 rate limit reached" }],
  }), true);
  assert.equal(isProviderRateLimitFailure({
    metrics: [{ pass: false, actual: "model assertion mismatch" }],
  }), false);
  assert.equal(isRetryableInfrastructureFailure({
    metrics: [{ pass: false, actual: "OpenClaw exited with code 1: truncated stream" }],
  }), true);
  assert.equal(isRetryableInfrastructureFailure({
    metrics: [{ pass: false, actual: "VISION_MODEL_INVALID_OUTPUT" }],
  }), false);
  assert.equal(providerRateLimitBackoffMs(1), 30_000);
  assert.equal(providerRateLimitBackoffMs(2), 60_000);
  assert.equal(providerRateLimitBackoffMs(3), 120_000);
  assert.equal(providerRateLimitBackoffMs(4), 120_000);
});

test("does not classify engineering row counts as provider rate limits", () => {
  assert.equal(stateHasProviderRateLimit({
    messages: [{
      role: "tool",
      content: "YJK element mapping used endpoint fallback for 429 force rows.",
    }],
  }), false);
  assert.equal(stateHasProviderRateLimit({
    messages: [{
      role: "assistant",
      content: "HTTP 429: Too Many Requests",
    }],
  }), true);
});

test("OpenClaw JSON result parsing rejects model drift", () => {
  const parsed = parseJsonOutput('notice\n{"payloads":[{"text":"ok"}],"meta":{"agentMeta":{"model":"GLM-5.2"}}}');
  assert.doesNotThrow(() => assertPinnedResultModel(parsed));
  assert.deepEqual(
    parseJsonOutput('startup\n{\n  "result": {\n    "payloads": []\n  }\n}'),
    { result: { payloads: [] } },
  );
  assert.throws(() => parseJsonOutput('notice\n"not-an-object"'), /Unable to parse/);
  assert.throws(
    () => assertPinnedResultModel({ meta: { agentMeta: { model: "unexpected-model" } } }),
    /unexpected model/,
  );
});

test("recovers final text from the pinned OpenClaw session transcript", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sclaw-openclaw-session-"));
  try {
    const sessionRoot = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionRoot, { recursive: true });
    fs.writeFileSync(path.join(sessionRoot, "case-1.jsonl"), [
      JSON.stringify({ message: { role: "assistant", content: [{ type: "toolCall" }] } }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "final" }],
          provider: "paratera",
          model: "GLM-5.2",
          usage: { input: 1, output: 1, cacheRead: 2, totalTokens: 4 },
        },
      }),
      "",
    ].join("\n"));
    assert.deepEqual(assistantFromSession(root, "case-1"), {
      text: "final",
      provider: "paratera",
      model: "GLM-5.2",
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
    });
    assert.deepEqual(
      subtractUsage(
        { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
        { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      ),
      { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
