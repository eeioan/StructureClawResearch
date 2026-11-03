const crypto = require("node:crypto");

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function compareNumericalResults(left, right, tolerances = {}) {
  const absoluteTolerance = tolerances.absolute ?? 1e-10;
  const relativeTolerance = tolerances.relative ?? 1e-10;
  let maxAbsoluteDifference = 0;
  let maxRelativeDifference = 0;
  let comparedNumbers = 0;
  const failures = [];

  function visit(leftValue, rightValue, path) {
    const leftIsNumber = typeof leftValue === "number" && !Number.isNaN(leftValue);
    const rightIsNumber = typeof rightValue === "number" && !Number.isNaN(rightValue);
    if (leftIsNumber || rightIsNumber) {
      if (!leftIsNumber || !rightIsNumber || !Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
        failures.push(`${path}: non-finite or type mismatch`);
        return;
      }
      comparedNumbers += 1;
      const absoluteDifference = Math.abs(leftValue - rightValue);
      const scale = Math.max(Math.abs(leftValue), Math.abs(rightValue));
      const relativeDifference = scale === 0 ? 0 : absoluteDifference / scale;
      maxAbsoluteDifference = Math.max(maxAbsoluteDifference, absoluteDifference);
      maxRelativeDifference = Math.max(maxRelativeDifference, relativeDifference);
      if (absoluteDifference > absoluteTolerance && relativeDifference > relativeTolerance) {
        failures.push(`${path}: ${leftValue} != ${rightValue}`);
      }
      return;
    }
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (!Array.isArray(leftValue) || !Array.isArray(rightValue) || leftValue.length !== rightValue.length) {
        failures.push(`${path}: array shape mismatch`);
        return;
      }
      leftValue.forEach((item, index) => visit(item, rightValue[index], `${path}[${index}]`));
      return;
    }
    if (leftValue && typeof leftValue === "object" || rightValue && typeof rightValue === "object") {
      if (!leftValue || !rightValue || typeof leftValue !== "object" || typeof rightValue !== "object") {
        failures.push(`${path}: object type mismatch`);
        return;
      }
      const leftKeys = Object.keys(leftValue).sort();
      const rightKeys = Object.keys(rightValue).sort();
      if (JSON.stringify(leftKeys) !== JSON.stringify(rightKeys)) {
        failures.push(`${path}: object keys mismatch`);
        return;
      }
      for (const key of leftKeys) visit(leftValue[key], rightValue[key], `${path}.${key}`);
      return;
    }
    if (leftValue !== rightValue) failures.push(`${path}: ${String(leftValue)} != ${String(rightValue)}`);
  }

  visit(left, right, "result");
  return {
    pass: failures.length === 0,
    comparedNumbers,
    maxAbsoluteDifference,
    maxRelativeDifference,
    failures,
  };
}

function crossValidateRuns(runs, tolerances = {}) {
  if (!Array.isArray(runs) || runs.length < 2) {
    throw new Error("At least two independent OpenSees runs are required");
  }
  const version = runs[0]?.solver?.version;
  const packageVersion = runs[0]?.solver?.packageVersion;
  const runtimePackage = runs[0]?.solver?.runtimePackage;
  const runtimePackageVersion = runs[0]?.solver?.runtimePackageVersion;
  if (!version || !packageVersion || runs.some((run) => run?.solver?.name !== "OpenSeesPy"
    || run.solver.version !== version
    || run.solver.packageVersion !== packageVersion
    || run.solver.runtimePackage !== runtimePackage
    || run.solver.runtimePackageVersion !== runtimePackageVersion)) {
    throw new Error("All truth runs must use the same identified OpenSeesPy version");
  }
  const comparisons = runs.slice(1).map((run) => compareNumericalResults(
    runs[0].result,
    run.result,
    tolerances,
  ));
  const failed = comparisons.find((comparison) => !comparison.pass);
  if (failed) {
    throw new Error(`Independent OpenSees runs disagree: ${failed.failures.slice(0, 5).join("; ")}`);
  }
  return {
    runCount: runs.length,
    outputHashes: runs.map((run) => sha256(run.result)),
    comparedNumbers: Math.min(...comparisons.map((comparison) => comparison.comparedNumbers)),
    maxAbsoluteDifference: Math.max(...comparisons.map((comparison) => comparison.maxAbsoluteDifference)),
    maxRelativeDifference: Math.max(...comparisons.map((comparison) => comparison.maxRelativeDifference)),
    tolerances: {
      absolute: tolerances.absolute ?? 1e-10,
      relative: tolerances.relative ?? 1e-10,
    },
  };
}

module.exports = {
  canonicalJson,
  compareNumericalResults,
  crossValidateRuns,
  sha256,
};
