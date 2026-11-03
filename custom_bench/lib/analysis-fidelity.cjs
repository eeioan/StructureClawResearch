function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resultData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const data = value.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const keys = ["displacements", "nodeDisplacements", "reactions", "nodeReactions", "forces", "memberForces"];
    if (keys.some((key) => data[key] !== undefined)) return data;
  }
  return value;
}

function normalizeResponseCoordinates(result) {
  if (result?.analysisMode !== "opensees_2d_frame"
      || result?.responseCoordinateConvention === "global-xyz") {
    return result;
  }
  const normalized = { ...result, responseCoordinateConvention: "global-xyz" };
  for (const alias of ["displacements", "nodeDisplacements"]) {
    const values = result[alias];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    normalized[alias] = Object.fromEntries(Object.entries(values).map(([nodeId, value]) => [
      nodeId,
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, ry: finiteNumber(value.ry) === null ? value.ry : -value.ry }
        : value,
    ]));
  }
  for (const alias of ["reactions", "nodeReactions"]) {
    const values = result[alias];
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    normalized[alias] = Object.fromEntries(Object.entries(values).map(([nodeId, value]) => [
      nodeId,
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...value, my: finiteNumber(value.my) === null ? value.my : -value.my }
        : value,
    ]));
  }
  return normalized;
}

function collection(result, aliases) {
  for (const alias of aliases) {
    const value = result?.[alias];
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  }
  return {};
}

function compareAnalysisResults(actualInput, expectedInput, mappings, tolerances = {}) {
  const actual = normalizeResponseCoordinates(resultData(actualInput));
  const expected = normalizeResponseCoordinates(resultData(expectedInput));
  const relativeTolerance = tolerances.numeric ?? tolerances.relative ?? 0.05;
  const absoluteTolerance = tolerances.numericAbsolute ?? tolerances.absolute ?? 1e-8;
  const failures = [];
  let comparedValues = 0;
  let maxAbsoluteDifference = 0;
  let maxRelativeDifference = 0;

  function compareNumber(actualValue, expectedValue, path) {
    let actualNumber = finiteNumber(actualValue);
    let expectedNumber = finiteNumber(expectedValue);
    if (actualNumber === null || expectedNumber === null) {
      failures.push(`${path}: missing finite numeric value`);
      return;
    }
    comparedValues += 1;
    const absoluteDifference = Math.abs(actualNumber - expectedNumber);
    const expectedIsNearZero = Math.abs(expectedNumber) <= absoluteTolerance;
    const relativeDifference = expectedIsNearZero
      ? 0
      : absoluteDifference / Math.abs(expectedNumber);
    maxAbsoluteDifference = Math.max(maxAbsoluteDifference, absoluteDifference);
    maxRelativeDifference = Math.max(maxRelativeDifference, relativeDifference);
    if (
      (expectedIsNearZero && absoluteDifference > absoluteTolerance)
      || (!expectedIsNearZero
        && absoluteDifference > absoluteTolerance
        && relativeDifference > relativeTolerance)
    ) {
      failures.push(`${path}: ${actualNumber} vs ${expectedNumber}`);
    }
  }

  function compareNodeCollection(expectedAliases, actualAliases, label) {
    const expectedCollection = collection(expected, expectedAliases);
    const actualCollection = collection(actual, actualAliases);
    for (const [expectedNodeId, expectedValues] of Object.entries(expectedCollection)) {
      const actualNodeId = mappings.nodeMapping?.[expectedNodeId];
      const actualValues = actualNodeId === undefined ? null : actualCollection[actualNodeId];
      if (!actualValues || typeof actualValues !== "object") {
        failures.push(`${label}.${expectedNodeId}: missing mapped result`);
        continue;
      }
      for (const [component, expectedValue] of Object.entries(expectedValues)) {
        if (finiteNumber(expectedValue) !== null) {
          compareNumber(actualValues[component], expectedValue, `${label}.${expectedNodeId}.${component}`);
        }
      }
    }
  }

  compareNodeCollection(["displacements", "nodeDisplacements"], ["displacements", "nodeDisplacements"], "displacements");
  compareNodeCollection(["reactions", "nodeReactions"], ["reactions", "nodeReactions"], "reactions");

  const expectedForces = collection(expected, ["forces", "memberForces"]);
  const actualForces = collection(actual, ["forces", "memberForces"]);
  for (const [expectedElementId, expectedForce] of Object.entries(expectedForces)) {
    const actualElementId = mappings.elementMapping?.[expectedElementId];
    const actualForce = actualElementId === undefined ? null : actualForces[actualElementId];
    if (!actualForce || typeof actualForce !== "object") {
      failures.push(`forces.${expectedElementId}: missing mapped result`);
      continue;
    }
    for (const component of ["axial", "stress"] ) {
      if (finiteNumber(expectedForce[component]) !== null) {
        compareNumber(actualForce[component], expectedForce[component], `forces.${expectedElementId}.${component}`);
      }
    }
    const expectedEnds = [expectedForce.n1, expectedForce.n2];
    let actualEnds = [actualForce.n1, actualForce.n2];
    if (expectedEnds.some((end) => end && typeof end === "object")) {
      if (!actualEnds.every((end) => end && typeof end === "object")) {
        failures.push(`forces.${expectedElementId}: missing end-force results`);
        continue;
      }
      const components = new Set(expectedEnds.flatMap((end) => Object.keys(end || {})));
      if (mappings.elementOrientation?.[expectedElementId] === "reversed") {
        const hasVectorComponents = components.has("V2") || components.has("V3")
          || components.has("M2") || components.has("M3");
        const reversedSign = (component) => {
          if (["N", "V2", "T", "M2"].includes(component)) return -1;
          if (component === "V" && !hasVectorComponents) return -1;
          return 1;
        };
        actualEnds = [actualEnds[1], actualEnds[0]].map((end) => Object.fromEntries(
          Object.entries(end).map(([component, value]) => [
            component,
            finiteNumber(value) === null ? value : value * reversedSign(component),
          ]),
        ));
      }
      for (const component of components) {
        const expectedPair = expectedEnds.map((end) => finiteNumber(end?.[component]));
        const actualPair = actualEnds.map((end) => finiteNumber(end?.[component]));
        if (expectedPair.some((value) => value === null)) continue;
        if (actualPair.some((value) => value === null)) {
          failures.push(`forces.${expectedElementId}.${component}: missing endpoint value`);
          continue;
        }
        compareNumber(actualPair[0], expectedPair[0], `forces.${expectedElementId}.${component}.n1`);
        compareNumber(actualPair[1], expectedPair[1], `forces.${expectedElementId}.${component}.n2`);
      }
    }
  }

  if (comparedValues === 0) failures.push("no comparable numerical response values");
  return {
    pass: failures.length === 0,
    comparedValues,
    maxAbsoluteDifference,
    maxRelativeDifference,
    tolerances: { absolute: absoluteTolerance, relative: relativeTolerance },
    failures,
  };
}

module.exports = { compareAnalysisResults };
