const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function hashCanonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function collectFiles(root, entries) {
  const files = [];
  const visit = (entry) => {
    const absolute = path.resolve(root, entry);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Fingerprint input does not exist: ${absolute}`);
    }
    const stat = fs.statSync(absolute);
    if (stat.isFile()) {
      files.push(absolute);
      return;
    }
    if (!stat.isDirectory()) return;
    for (const child of fs.readdirSync(absolute, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (child.name === "node_modules" || child.name === "dist" || child.name === "__pycache__") {
        continue;
      }
      visit(path.join(entry, child.name));
    }
  };
  for (const entry of entries) visit(entry);
  return files.sort((a, b) => a.localeCompare(b));
}

function hashFiles(root, entries) {
  const hash = createHash("sha256");
  for (const file of collectFiles(root, entries)) {
    const relative = path.relative(root, file).replaceAll(path.sep, "/");
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function scenarioAttachments(scenarios) {
  const attachments = [];
  for (const scenario of scenarios) {
    if (Array.isArray(scenario.attachments)) attachments.push(...scenario.attachments);
    for (const turn of scenario.turns || []) {
      if (Array.isArray(turn.attachments)) attachments.push(...turn.attachments);
    }
  }
  return attachments;
}

function resolveAttachmentPath(benchRoot, relPath) {
  if (path.isAbsolute(relPath)) return path.resolve(relPath);
  const normalized = String(relPath).replace(/^tests[\\/]llm-benchmark[\\/]/, "");
  return path.resolve(benchRoot, normalized);
}

function hashAttachments(benchRoot, scenarios) {
  const files = new Map();
  for (const attachment of scenarioAttachments(scenarios)) {
    if (!attachment || typeof attachment.relPath !== "string") continue;
    const absolute = resolveAttachmentPath(benchRoot, attachment.relPath);
    if (!fs.existsSync(absolute)) {
      throw new Error(`Scenario attachment does not exist: ${absolute}`);
    }
    const relative = path.relative(benchRoot, absolute).replaceAll(path.sep, "/");
    files.set(relative, absolute);
  }
  const hash = createHash("sha256");
  for (const [relative, absolute] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relative);
    hash.update("\0");
    hash.update(fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function buildRunFingerprints({ sutRoot, benchRoot, scenarios, runtimeConfig }) {
  const canonicalScenarios = [...scenarios].sort((left, right) =>
    String(left.id || "").localeCompare(String(right.id || "")));
  return {
    scenarioHash: hashCanonical(canonicalScenarios),
    scenarioOrderHash: hashCanonical(scenarios.map((scenario) => scenario.id)),
    attachmentHash: hashAttachments(benchRoot, scenarios),
    promptAndToolHash: hashFiles(sutRoot, [
      "backend/src/agent-langgraph",
      "backend/src/agent-runtime",
      "backend/src/agent-skills",
      "backend/src/skill-shared",
    ]),
    evaluationHash: hashFiles(benchRoot, [
      "lib",
      "runner.cjs",
    ]),
    runtimeConfigHash: hashCanonical(runtimeConfig),
  };
}

module.exports = {
  buildRunFingerprints,
  canonicalize,
  hashAttachments,
  hashCanonical,
  hashFiles,
};
