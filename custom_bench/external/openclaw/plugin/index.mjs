import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const TOOL_DEFINITIONS = [
  {
    name: "detect_structure_type",
    label: "Detect Structure Type",
    description: "Detect the structural type from the current user request.",
    parameters: objectSchema({
      message: stringSchema("The user message describing the structure"),
      locale: enumSchema(["zh", "en"], "User locale"),
    }),
  },
  {
    name: "extract_draft_params",
    label: "Extract Draft Parameters",
    description: "Extract structural parameters and merge them into the current draft.",
    parameters: objectSchema({
      message: stringSchema("The user message to extract parameters from"),
      locale: enumSchema(["zh", "en"], "User locale"),
    }),
  },
  {
    name: "build_model",
    label: "Build Model",
    description: "Build a computable structural model from the current draft.",
    parameters: objectSchema({}),
  },
  {
    name: "validate_model",
    label: "Validate Model",
    description: "Validate the current structural model.",
    parameters: objectSchema({
      engineId: stringSchema("Optional analysis engine ID"),
    }),
  },
  {
    name: "run_analysis",
    label: "Run Analysis",
    description: "Execute structural analysis with the selected StructureClaw analysis skill.",
    parameters: objectSchema({
      analysisType: enumSchema(
        ["static", "dynamic", "seismic", "nonlinear"],
        "Type of analysis to perform",
      ),
      analysisSkillId: enumSchema(
        [
          "opensees-static",
          "opensees-dynamic",
          "opensees-seismic",
          "opensees-nonlinear",
          "pkpm-static",
          "yjk-static",
        ],
        "Selected analysis skill ID",
      ),
      loadCombinationId: stringSchema("Optional load-combination ID"),
      floorLoadTransferMode: enumSchema(
        ["auto_code_cn", "node_tributary", "one_way_slab", "two_way_slab"],
        "Optional floor-load transfer mode",
      ),
      seismicWorkflowJson: stringSchema("Structured China seismic workflow JSON"),
    }, ["analysisType"]),
  },
  {
    name: "generate_report",
    label: "Generate Report",
    description: "Generate a report from the current model and analysis result.",
    parameters: objectSchema({
      message: stringSchema("Original user request"),
      analysisType: enumSchema(
        ["static", "dynamic", "seismic", "nonlinear"],
        "Analysis type that was performed",
      ),
      locale: enumSchema(["zh", "en"], "Report language"),
    }, ["message", "analysisType"]),
  },
  {
    name: "ask_user_clarification",
    label: "Ask User Clarification",
    description: "Ask one clarification question when critical input is missing.",
    parameters: objectSchema({
      question: stringSchema("Question to ask the user"),
      optionsJson: stringSchema("Optional JSON array of suggested answers"),
    }, ["question"]),
  },
  {
    name: "set_session_config",
    label: "Set Session Config",
    description: "Set analysis type, design code, or selected skill IDs for this session.",
    parameters: objectSchema({
      analysisType: enumSchema(
        ["static", "dynamic", "seismic", "nonlinear"],
        "Analysis type",
      ),
      designCode: stringSchema("Design code"),
      skillIdsJson: stringSchema("JSON array of skill IDs"),
    }),
  },
  {
    name: "analyze_file",
    label: "Analyze File",
    description: "Read one of the benchmark attachments and extract its content.",
    parameters: objectSchema({
      filePath: stringSchema("Path to a supplied benchmark attachment"),
      maxRows: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        description: "Maximum rows to return",
      },
    }, ["filePath"]),
  },
];

let runtimePromise;
let toolQueue = Promise.resolve();

function stringSchema(description) {
  return { type: "string", description };
}

function enumSchema(values, description) {
  return { type: "string", enum: values, description };
}

function objectSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function requireEnvironmentPath(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required by the StructureClaw benchmark plugin`);
  return path.resolve(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporaryPath, filePath);
}

function plainMessage(message) {
  if (!message || typeof message !== "object") return message;
  const source = typeof message.toDict === "function"
    ? message.toDict()?.data || message
    : message;
  return {
    role: source.role || source.type || (source.name ? "tool" : undefined),
    type: source.type || source.role || (source.name ? "tool" : undefined),
    name: source.name,
    content: source.content ?? "",
    tool_call_id: source.tool_call_id,
    response_metadata: source.response_metadata,
    usage_metadata: source.usage_metadata,
    additional_kwargs: source.additional_kwargs,
  };
}

function commandUpdate(result) {
  return result && typeof result === "object" && result.update && typeof result.update === "object"
    ? result.update
    : null;
}

function toolContent(result, update) {
  const messages = Array.isArray(update?.messages) ? update.messages : [];
  const last = messages.at(-1);
  const content = last?.content ?? last?.kwargs?.content;
  if (typeof content === "string") return content;
  if (content !== undefined) return JSON.stringify(content);
  if (typeof result === "string") return result;
  return JSON.stringify(result ?? null);
}

function applyStateUpdate(state, update) {
  if (!update) return;
  for (const [key, value] of Object.entries(update)) {
    if (key === "messages") continue;
    state[key] = key === "artifacts" && value && typeof value === "object"
      ? { ...(state.artifacts || {}), ...value }
      : value;
  }
  if (Array.isArray(update.messages)) {
    state.messages.push(...update.messages.map(plainMessage));
  }
}

function constrainSelectedSkills(state, allowedSkillIds) {
  const allowed = new Set(allowedSkillIds);
  const requested = Array.isArray(state.selectedSkillIds) ? state.selectedSkillIds : [];
  state.selectedSkillIds = [...new Set(requested.filter((skillId) => allowed.has(skillId)))];
  if (state.selectedSkillIds.length === 0) {
    state.selectedSkillIds = [...allowedSkillIds];
  }
}

function appendAssistantToolCall(state, name, toolCallId, params) {
  state.messages.push({
    role: "assistant",
    type: "ai",
    content: "",
    tool_calls: [{
      id: toolCallId,
      name,
      args: params,
      type: "tool_call",
    }],
  });
}

function appendToolResult(state, name, toolCallId, content, responseMetadata = undefined) {
  state.messages.push({
    role: "tool",
    type: "tool",
    name,
    tool_call_id: toolCallId,
    content,
    response_metadata: responseMetadata,
  });
}

function parseClarificationOptions(optionsJson) {
  if (!optionsJson) return undefined;
  try {
    const parsed = JSON.parse(optionsJson);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

async function initializeRuntime() {
  const runConfigPath = requireEnvironmentPath("SCLAW_OPENCLAW_RUN_CONFIG");
  const sutRoot = requireEnvironmentPath("SCLAW_ROOT");
  const benchmarkRoot = requireEnvironmentPath("SCLAW_BENCHMARK_ROOT");
  const runConfig = readJson(runConfigPath);
  const runtimeModulePath = path.join(sutRoot, "backend", "dist", "agent-runtime", "index.js");
  const serviceModulePath = path.join(
    sutRoot,
    "backend",
    "dist",
    "agent-langgraph",
    "agent-service.js",
  );
  const registryModulePath = path.join(
    sutRoot,
    "backend",
    "dist",
    "agent-langgraph",
    "tool-registry.js",
  );
  const [{ AgentSkillRuntime }, { LangGraphAgentService }, { createRegisteredTools }] =
    await Promise.all([
      import(pathToFileURL(runtimeModulePath).href),
      import(pathToFileURL(serviceModulePath).href),
      import(pathToFileURL(registryModulePath).href),
    ]);

  const skillRuntime = new AgentSkillRuntime();
  const service = new LangGraphAgentService(skillRuntime);
  const { installSolverGate } = require(path.join(benchmarkRoot, "lib", "solver-gate.cjs"));
  const solverGate = installSolverGate(service);
  const registeredTools = createRegisteredTools({
    skillRuntime,
    workspaceRoot: runConfig.workspaceRoot,
  });
  const toolByName = new Map(registeredTools.map((tool) => [tool.name, tool]));
  const enabledToolIds = Array.isArray(runConfig.enabledToolIds)
    ? runConfig.enabledToolIds
    : TOOL_DEFINITIONS.map((definition) => definition.name);
  for (const toolId of enabledToolIds) {
    if (toolId !== "ask_user_clarification" && !toolByName.has(toolId)) {
      throw new Error(`StructureClaw tool is unavailable: ${toolId}`);
    }
  }
  return {
    runConfig,
    service,
    skillRuntime,
    solverGate,
    toolByName,
    enabledToolIds,
  };
}

function getRuntime() {
  runtimePromise ??= initializeRuntime();
  return runtimePromise;
}

async function executeTool(name, params) {
  const runtime = await getRuntime();
  if (!runtime.enabledToolIds.includes(name)) {
    throw new Error(`Tool is not enabled in this benchmark run: ${name}`);
  }
  const state = readJson(runtime.runConfig.statePath);
  state.messages = Array.isArray(state.messages) ? state.messages : [];
  const toolCallId = `openclaw-${randomUUID()}`;
  appendAssistantToolCall(state, name, toolCallId, params);

  if (name === "ask_user_clarification") {
    const payload = {
      type: "clarification_needed",
      question: params.question,
      options: parseClarificationOptions(params.optionsJson),
    };
    const content = JSON.stringify(payload);
    appendToolResult(state, name, toolCallId, content);
    writeJsonAtomic(runtime.runConfig.statePath, state);
    return { content: [{ type: "text", text: content }], details: payload };
  }

  const tool = runtime.toolByName.get(name);
  if (!tool) throw new Error(`StructureClaw tool is unavailable: ${name}`);
  try {
    const result = await tool.invoke(params, {
      configurable: {
        skillRuntime: runtime.skillRuntime,
        engineClient: runtime.service.engineClient,
        codeCheckClient: runtime.service.codeCheckClient,
        structureProtocolClient: runtime.service.structureProtocolClient,
        workspaceRoot: runtime.runConfig.workspaceRoot,
        fileAccessAllowlist: runtime.runConfig.attachmentPaths,
        enabledToolIds: runtime.enabledToolIds,
        disabledToolIds: [],
        allowShell: false,
        maxToolCallsPerTurn: runtime.runConfig.maxToolCallsPerTurn || 32,
        skillScope: runtime.runConfig.skillIds,
        agentState: state,
      },
      toolCall: { id: toolCallId },
    });
    const update = commandUpdate(result);
    applyStateUpdate(state, update);
    constrainSelectedSkills(state, runtime.runConfig.skillIds);
    const content = toolContent(result, update);
    if (!update?.messages) {
      appendToolResult(state, name, toolCallId, content);
    }
    const solverEvents = runtime.solverGate.snapshot();
    if (solverEvents.length > 0) {
      state._solverEvents = [
        ...(Array.isArray(state._solverEvents) ? state._solverEvents : []),
        ...solverEvents,
      ];
    }
    writeJsonAtomic(runtime.runConfig.statePath, state);
    let details;
    try {
      details = JSON.parse(content);
    } catch {
      details = { result: content };
    }
    return { content: [{ type: "text", text: content }], details };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendToolResult(state, name, toolCallId, JSON.stringify({ error: message }));
    const solverEvents = runtime.solverGate.snapshot();
    if (solverEvents.length > 0) {
      state._solverEvents = [
        ...(Array.isArray(state._solverEvents) ? state._solverEvents : []),
        ...solverEvents,
      ];
    }
    writeJsonAtomic(runtime.runConfig.statePath, state);
    throw error;
  }
}

function queuedToolExecution(name, params) {
  const run = toolQueue.then(
    () => executeTool(name, params),
    () => executeTool(name, params),
  );
  toolQueue = run.catch(() => undefined);
  return run;
}

export default {
  id: "structureclaw-benchmark",
  name: "StructureClaw Benchmark Tools",
  description: "Frozen StructureClaw engineering tools for the OpenClaw benchmark.",
  register(api) {
    for (const definition of TOOL_DEFINITIONS) {
      api.registerTool({
        ...definition,
        execute(_toolCallId, params) {
          return queuedToolExecution(definition.name, params);
        },
      });
    }
  },
};
