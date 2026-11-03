const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCENARIOS_ROOT = path.join(ROOT, "scenarios");
const MANIFEST_PATH = path.join(ROOT, "benchmark.json");
const GROUND_TRUTH_PATH = path.join(ROOT, "fixtures", "ground-truth-models.json");
const SCHEMA_PATHS = [
  path.join(ROOT, "schemas", "scenario.schema.json"),
  path.join(ROOT, "schemas", "result.schema.json"),
];

const ASSERTION_TYPES = new Set([
  "analysis_or_interaction",
  "engine_match",
  "has_analysis",
  "has_interaction_questions",
  "has_model",
  "has_report",
  "model_matches",
  "natural_language",
  "no_bad_model",
  "numerical_matches",
  "report_numerical_consistency",
  "should_not_analyze",
  "skill_match",
  "structural_type",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertionGroups(scenario) {
  return [
    scenario.expect?.assertions,
    ...(scenario.turns || []).map((turn) => turn.assertions),
  ].filter(Array.isArray);
}

function validateScenario(scenario, family, filePath, groundTruthIds, errors) {
  const label = path.relative(ROOT, filePath);
  const requiredStrings = [
    "id",
    "description",
    "split",
    "taskFamily",
    "inputModality",
    "structureType",
    "benchmarkStructureType",
    "difficulty",
    "skillTarget",
    "category",
    "locale",
  ];

  for (const key of requiredStrings) {
    if (typeof scenario[key] !== "string" || !scenario[key].trim()) {
      errors.push(`${label}: missing non-empty ${key}`);
    }
  }

  if (scenario.taskFamily !== family) {
    errors.push(`${label}: taskFamily must match its directory`);
  }
  if (!["en", "zh"].includes(scenario.locale)) {
    errors.push(`${label}: locale must be en or zh`);
  }
  if (scenario.maxRetries !== 0) {
    errors.push(`${label}: maxRetries must be 0`);
  }
  if (!Array.isArray(scenario.evaluationFocus) || scenario.evaluationFocus.length === 0) {
    errors.push(`${label}: evaluationFocus must be a non-empty array`);
  }
  if (!Array.isArray(scenario.tags) || scenario.tags.length === 0) {
    errors.push(`${label}: tags must be a non-empty array`);
  }

  const hasSingleTurn = typeof scenario.message === "string"
    && Array.isArray(scenario.expect?.assertions);
  const hasMultipleTurns = Array.isArray(scenario.turns)
    && scenario.turns.length > 0
    && scenario.turns.every((turn) => (
      typeof turn.message === "string"
      && Array.isArray(turn.assertions)
    ));
  if (!hasSingleTurn && !hasMultipleTurns) {
    errors.push(`${label}: scenario must define message/expect or valid turns`);
  }

  for (const assertions of assertionGroups(scenario)) {
    for (const assertion of assertions) {
      if (!ASSERTION_TYPES.has(assertion?.type)) {
        errors.push(`${label}: unknown assertion type ${String(assertion?.type)}`);
      }
      if (
        typeof assertion?.groundTruthId === "string"
        && !groundTruthIds.has(assertion.groundTruthId)
      ) {
        errors.push(`${label}: unknown groundTruthId ${assertion.groundTruthId}`);
      }
    }
  }

  for (const attachment of scenario.attachments || []) {
    if (
      typeof attachment?.relPath !== "string"
      || !fs.existsSync(path.resolve(ROOT, attachment.relPath))
    ) {
      errors.push(`${label}: attachment does not resolve: ${String(attachment?.relPath)}`);
    }
  }
}

function main() {
  const manifest = readJson(MANIFEST_PATH);
  for (const schemaPath of SCHEMA_PATHS) {
    readJson(schemaPath);
  }
  const groundTruthIds = new Set(
    readJson(GROUND_TRUTH_PATH).map((entry) => entry.id),
  );
  const errors = [];
  const seenIds = new Set();
  let total = 0;

  for (const [family, expected] of Object.entries(manifest.taskFamilies)) {
    const familyRoot = path.join(SCENARIOS_ROOT, family);
    const files = fs.readdirSync(familyRoot)
      .filter((name) => name.endsWith(".json"))
      .sort();
    const localeCounts = { en: 0, zh: 0 };

    for (const name of files) {
      const filePath = path.join(familyRoot, name);
      const scenario = readJson(filePath);
      validateScenario(scenario, family, filePath, groundTruthIds, errors);
      total += 1;

      if (seenIds.has(scenario.id)) {
        errors.push(`${path.relative(ROOT, filePath)}: duplicate id ${scenario.id}`);
      }
      seenIds.add(scenario.id);
      if (scenario.locale === "en" || scenario.locale === "zh") {
        localeCounts[scenario.locale] += 1;
      }
    }

    if (files.length !== expected.total) {
      errors.push(`${family}: expected ${expected.total} scenarios, found ${files.length}`);
    }
    for (const locale of ["en", "zh"]) {
      if (localeCounts[locale] !== expected[locale]) {
        errors.push(
          `${family}: expected ${expected[locale]} ${locale} scenarios, `
          + `found ${localeCounts[locale]}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    process.stderr.write("Corpus validation failed / 评测集校验失败:\n");
    for (const error of errors) {
      process.stderr.write(`- ${error}\n`);
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    `Corpus validation passed / 评测集校验通过: ${total} scenarios.\n`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  ASSERTION_TYPES,
  assertionGroups,
  validateScenario,
};
