const DOF_ORDER = ["ux", "uy", "uz", "rx", "ry", "rz"];
const AXES = ["x", "y", "z"];
const MATERIAL_NUMERIC_FIELDS = ["E", "nu", "rho", "fy", "fc"];
const MATERIAL_TEXT_FIELDS = ["category", "grade"];
const SECTION_NUMERIC_FIELDS = ["A", "Iy", "Iz", "J", "G"];
const SECTION_TEXT_FIELDS = ["type", "purpose", "standard_steel_name"];

function normalizedSectionType(value) {
  const normalized = String(value || "").toLowerCase();
  if (["rect", "rectangle", "rectangular"].includes(normalized)) return "rectangular";
  if (["circ", "circle", "circular"].includes(normalized)) return "circular";
  return normalized;
}

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isFiniteNumberValue(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function entityMap(items) {
  return new Map((items || []).map((item) => [String(item.id), item]));
}

function normalizedRestraints(node) {
  const restraints = Array.isArray(node?.restraints) ? node.restraints : [];
  return DOF_ORDER.map((_, index) => Boolean(restraints[index]));
}

function inspectCoordinateContract(model) {
  const coordinateSystem = model?.coordinate_system;
  if (!coordinateSystem || typeof coordinateSystem !== "object" || Array.isArray(coordinateSystem)) {
    return { ok: false, reason: "missing typed coordinate_system" };
  }
  const dimension = coordinateSystem.dimension;
  if (coordinateSystem.semantics !== "global-z-up" || coordinateSystem.version !== 1) {
    return { ok: false, reason: "unsupported coordinate semantics/version" };
  }
  if (!['2d', '3d'].includes(dimension)) {
    return { ok: false, reason: "coordinate dimension must be 2d or 3d" };
  }
  if ((dimension === "2d" && coordinateSystem.plane !== "xz")
    || (dimension === "3d" && coordinateSystem.plane !== null)) {
    return { ok: false, reason: "coordinate plane conflicts with dimension" };
  }
  if (!Array.isArray(coordinateSystem.dof_order)
    || coordinateSystem.dof_order.length !== DOF_ORDER.length
    || !DOF_ORDER.every((value, index) => coordinateSystem.dof_order[index] === value)) {
    return { ok: false, reason: "invalid canonical DOF order" };
  }
  for (const node of model.nodes || []) {
    if (!AXES.every((axis) => finiteNumber(node?.[axis]) !== null)) {
      return { ok: false, reason: `node '${node?.id ?? "?"}' lacks finite global X/Y/Z coordinates` };
    }
    if (dimension === "2d" && Math.abs(Number(node.y)) > 1e-9) {
      return { ok: false, reason: `2-D node '${node.id}' is outside the global X-Z plane` };
    }
  }
  const metadata = model.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    if (metadata.coordinateSemantics !== undefined
      && metadata.coordinateSemantics !== "global-z-up") {
      return { ok: false, reason: "metadata coordinate semantics conflict" };
    }
    if (metadata.coordinateContractVersion !== undefined
      && metadata.coordinateContractVersion !== 1) {
      return { ok: false, reason: "metadata coordinate contract version conflicts" };
    }
    if (metadata.frameDimension !== undefined && metadata.frameDimension !== dimension) {
      return { ok: false, reason: "metadata dimension conflicts" };
    }
  }
  return { ok: true, dimension };
}

function inspectModelIntegrity(model) {
  const collections = ["nodes", "elements", "materials", "sections", "load_cases", "load_combinations"];
  for (const collection of collections) {
    const values = model?.[collection];
    if (!Array.isArray(values)) return { ok: false, reason: `${collection} must be an array` };
    const ids = values.map((item) => String(item?.id ?? ""));
    if (ids.some((id) => id.length === 0)) {
      return { ok: false, reason: `${collection} contains an empty id` };
    }
    if (ids.length !== new Set(ids).size) {
      return { ok: false, reason: `${collection} contains duplicate ids` };
    }
  }

  const nodeIds = new Set(model.nodes.map((node) => String(node.id)));
  const elementIds = new Set(model.elements.map((element) => String(element.id)));
  const materialIds = new Set(model.materials.map((material) => String(material.id)));
  const sectionIds = new Set(model.sections.map((section) => String(section.id)));
  const loadCaseIds = new Set(model.load_cases.map((loadCase) => String(loadCase.id)));

  for (const node of model.nodes) {
    if (!AXES.every((axis) => isFiniteNumberValue(node?.[axis]))) {
      return { ok: false, reason: `node '${node?.id ?? "?"}' has non-numeric coordinates` };
    }
    if (node.restraints !== undefined
      && (!Array.isArray(node.restraints)
        || node.restraints.length !== DOF_ORDER.length
        || node.restraints.some((value) => typeof value !== "boolean"))) {
      return { ok: false, reason: `node '${node.id}' has invalid restraints` };
    }
  }

  for (const material of model.materials) {
    for (const field of MATERIAL_NUMERIC_FIELDS) {
      if (material[field] !== undefined && !isFiniteNumberValue(material[field])) {
        return { ok: false, reason: `material '${material.id}' has non-finite ${field}` };
      }
    }
  }

  for (const section of model.sections) {
    for (const [field, value] of Object.entries(section.properties || {})) {
      if (!isFiniteNumberValue(value)) {
        return { ok: false, reason: `section '${section.id}' has non-finite property ${field}` };
      }
    }
    for (const field of ["H", "B", "tw", "tf", "D", "t"]) {
      if (section.shape?.[field] !== undefined && !isFiniteNumberValue(section.shape[field])) {
        return { ok: false, reason: `section '${section.id}' has non-finite shape field ${field}` };
      }
    }
  }

  for (const element of model.elements) {
    if (!Array.isArray(element?.nodes)
      || element.nodes.length !== 2
      || element.nodes.some((nodeId) => !nodeIds.has(String(nodeId)))) {
      return { ok: false, reason: `element '${element?.id ?? "?"}' has invalid node references` };
    }
    if (!materialIds.has(String(element.material)) || !sectionIds.has(String(element.section))) {
      return { ok: false, reason: `element '${element.id}' has invalid material/section references` };
    }
  }

  for (const loadCase of model.load_cases) {
    if (!Array.isArray(loadCase?.loads)) {
      return { ok: false, reason: `load case '${loadCase?.id ?? "?"}' must contain a loads array` };
    }
    for (const load of loadCase.loads) {
      const node = load?.node ?? load?.nodeId ?? load?.node_id;
      const element = load?.element ?? load?.elementId ?? load?.element_id;
      if ((node === undefined) === (element === undefined)
        || (node !== undefined && !nodeIds.has(String(node)))
        || (element !== undefined && !elementIds.has(String(element)))) {
        return { ok: false, reason: `load case '${loadCase.id}' contains an invalid load target` };
      }
      for (const field of ["fx", "fy", "fz", "mx", "my", "mz", "wx", "wy", "wz", "magnitude", "value"]) {
        if (load?.[field] !== undefined && !isFiniteNumberValue(load[field])) {
          return { ok: false, reason: `load case '${loadCase.id}' contains non-finite ${field}` };
        }
      }
      if (load?.forces !== undefined
        && (!Array.isArray(load.forces)
          || load.forces.length !== DOF_ORDER.length
          || load.forces.some((value) => !isFiniteNumberValue(value)))) {
        return { ok: false, reason: `load case '${loadCase.id}' contains invalid force components` };
      }
    }
  }

  if (model.stories !== undefined && !Array.isArray(model.stories)) {
    return { ok: false, reason: "stories must be an array when provided" };
  }
  const storyIds = new Set();
  for (const story of model.stories || []) {
    const storyId = String(story?.id ?? "");
    if (!storyId) return { ok: false, reason: "stories contains an empty id" };
    if (storyIds.has(storyId)) return { ok: false, reason: "stories contains duplicate ids" };
    storyIds.add(storyId);
  }
  for (const entity of [...model.nodes, ...model.elements]) {
    if (entity?.story !== undefined && !storyIds.has(String(entity.story))) {
      return { ok: false, reason: `${entity.id} references an unknown story` };
    }
  }
  for (const story of model.stories || []) {
    for (const field of [
      "height", "elevation", "dead_load", "live_load",
      "floorLoad", "liveLoad", "tributaryWidthM", "equivalentLineLoad",
    ]) {
      if (story?.[field] !== undefined && !isFiniteNumberValue(story[field])) {
        return { ok: false, reason: `story '${story.id}' has non-finite ${field}` };
      }
    }
    if (story?.floor_loads !== undefined && !Array.isArray(story.floor_loads)) {
      return { ok: false, reason: `story '${story.id}' has invalid floor_loads` };
    }
    for (const load of story?.floor_loads || []) {
      if (load?.value !== undefined && !isFiniteNumberValue(load.value)) {
        return { ok: false, reason: `story '${story.id}' has a non-finite floor load` };
      }
    }
  }

  for (const combination of model.load_combinations) {
    if (!combination?.factors
      || typeof combination.factors !== "object"
      || Array.isArray(combination.factors)) {
      return { ok: false, reason: `load combination '${combination?.id ?? "?"}' has invalid factors` };
    }
    for (const [loadCaseId, factor] of Object.entries(combination.factors)) {
      if (!loadCaseIds.has(String(loadCaseId)) || !isFiniteNumberValue(factor)) {
        return { ok: false, reason: `load combination '${combination.id}' references an invalid load case` };
      }
    }
  }

  return { ok: true };
}

function distance(a, b) {
  return Math.sqrt(AXES.reduce((sum, axis) => sum + (Number(a[axis]) - Number(b[axis])) ** 2, 0));
}

function maximumNodeMatching(expectedNodes, actualNodes, tolerance) {
  const candidates = expectedNodes.map((expected) => actualNodes
    .map((actual, actualIndex) => ({ actualIndex, distance: distance(expected, actual) }))
    .filter((candidate) => candidate.distance <= tolerance)
    .sort((left, right) => left.distance - right.distance || left.actualIndex - right.actualIndex));
  const actualToExpected = new Map();

  function augment(expectedIndex, visited) {
    for (const candidate of candidates[expectedIndex]) {
      if (visited.has(candidate.actualIndex)) continue;
      visited.add(candidate.actualIndex);
      const previous = actualToExpected.get(candidate.actualIndex);
      if (previous === undefined || augment(previous, visited)) {
        actualToExpected.set(candidate.actualIndex, expectedIndex);
        return true;
      }
    }
    return false;
  }

  for (let expectedIndex = 0; expectedIndex < expectedNodes.length; expectedIndex += 1) {
    augment(expectedIndex, new Set());
  }

  const expectedToActual = new Map();
  for (const [actualIndex, expectedIndex] of actualToExpected.entries()) {
    expectedToActual.set(String(expectedNodes[expectedIndex].id), String(actualNodes[actualIndex].id));
  }
  return expectedToActual;
}

function precisionRecall(matched, actualCount, expectedCount) {
  return {
    matched,
    actualCount,
    expectedCount,
    precision: actualCount === 0 ? (expectedCount === 0 ? 1 : 0) : matched / actualCount,
    recall: expectedCount === 0 ? 1 : matched / expectedCount,
  };
}

function thresholdPass(score, threshold) {
  return score.precision + 1e-12 >= threshold && score.recall + 1e-12 >= threshold;
}

function unorderedPair(left, right) {
  return left <= right ? `${left}\u0000${right}` : `${right}\u0000${left}`;
}

function elementEndpoints(element) {
  const nodes = Array.isArray(element?.nodes)
    ? element.nodes
    : Array.isArray(element?.nodeIds) ? element.nodeIds : [];
  return nodes.slice(0, 2).map(String);
}

function maximumElementMatching(expectedElements, actualElements, nodeMapping) {
  const candidates = expectedElements.map((expected) => {
    const [expectedStart, expectedEnd] = elementEndpoints(expected);
    const mappedStart = nodeMapping.get(expectedStart);
    const mappedEnd = nodeMapping.get(expectedEnd);
    if (mappedStart === undefined || mappedEnd === undefined) return [];
    const expectedPair = unorderedPair(mappedStart, mappedEnd);
    return actualElements.flatMap((actual, actualIndex) => {
      const [actualStart, actualEnd] = elementEndpoints(actual);
      const sameType = String(actual?.type || "") === String(expected?.type || "");
      return sameType && unorderedPair(actualStart, actualEnd) === expectedPair ? [actualIndex] : [];
    });
  });
  const actualToExpected = new Map();

  function augment(expectedIndex, visited) {
    for (const actualIndex of candidates[expectedIndex]) {
      if (visited.has(actualIndex)) continue;
      visited.add(actualIndex);
      const previous = actualToExpected.get(actualIndex);
      if (previous === undefined || augment(previous, visited)) {
        actualToExpected.set(actualIndex, expectedIndex);
        return true;
      }
    }
    return false;
  }

  for (let expectedIndex = 0; expectedIndex < expectedElements.length; expectedIndex += 1) {
    augment(expectedIndex, new Set());
  }

  const expectedToActual = new Map();
  for (const [actualIndex, expectedIndex] of actualToExpected.entries()) {
    expectedToActual.set(String(expectedElements[expectedIndex].id), String(actualElements[actualIndex].id));
  }
  return expectedToActual;
}

function numericClose(actual, expected, relativeTolerance, absoluteTolerance = 1e-12) {
  const actualNumber = finiteNumber(actual);
  const expectedNumber = finiteNumber(expected);
  if (actualNumber === null || expectedNumber === null) return false;
  return Math.abs(actualNumber - expectedNumber)
    <= Math.max(absoluteTolerance, Math.abs(expectedNumber) * relativeTolerance);
}

function compareStructuredValue(actual, expected, relativeTolerance, path, failures) {
  if (typeof expected === "number") {
    if (!numericClose(actual, expected, relativeTolerance)) failures.push(path);
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      failures.push(path);
      return;
    }
    expected.forEach((value, index) => compareStructuredValue(
      actual[index], value, relativeTolerance, `${path}[${index}]`, failures,
    ));
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      failures.push(path);
      return;
    }
    for (const [key, value] of Object.entries(expected)) {
      compareStructuredValue(actual[key], value, relativeTolerance, `${path}.${key}`, failures);
    }
    return;
  }
  if (actual !== expected) failures.push(path);
}

function hasMeaningfulValue(value) {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (typeof value === "number") return Math.abs(value) > 1e-12;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value === "object") return Object.values(value).some(hasMeaningfulValue);
  return true;
}

function compareAssignedProperties(expectedModel, actualModel, elementMapping, propertyTolerance) {
  const expectedElements = entityMap(expectedModel.elements);
  const actualElements = entityMap(actualModel.elements);
  const expectedMaterials = entityMap(expectedModel.materials);
  const actualMaterials = entityMap(actualModel.materials);
  const expectedSections = entityMap(expectedModel.sections);
  const actualSections = entityMap(actualModel.sections);
  const failures = [];

  for (const [expectedElementId, actualElementId] of elementMapping.entries()) {
    const expectedElement = expectedElements.get(expectedElementId);
    const actualElement = actualElements.get(actualElementId);
    const expectedMaterial = expectedMaterials.get(String(expectedElement?.material));
    const actualMaterial = actualMaterials.get(String(actualElement?.material));
    const expectedSection = expectedSections.get(String(expectedElement?.section));
    const actualSection = actualSections.get(String(actualElement?.section));

    if (!expectedMaterial || !actualMaterial) {
      failures.push(`${expectedElementId}: missing assigned material`);
    } else {
      for (const field of MATERIAL_NUMERIC_FIELDS) {
        if (expectedMaterial[field] !== undefined
          && !numericClose(actualMaterial[field], expectedMaterial[field], propertyTolerance)) {
          failures.push(`${expectedElementId}: material.${field}`);
        }
      }
      for (const field of MATERIAL_TEXT_FIELDS) {
        if (expectedMaterial[field] !== undefined
          && String(actualMaterial[field] || "").toLowerCase() !== String(expectedMaterial[field]).toLowerCase()) {
          failures.push(`${expectedElementId}: material.${field}`);
        }
      }
    }

    if (!expectedSection || !actualSection) {
      failures.push(`${expectedElementId}: missing assigned section`);
    } else {
      for (const field of SECTION_TEXT_FIELDS) {
        const actualValue = field === "type"
          ? normalizedSectionType(actualSection[field])
          : String(actualSection[field] || "").toLowerCase();
        const expectedValue = field === "type"
          ? normalizedSectionType(expectedSection[field])
          : String(expectedSection[field]).toLowerCase();
        if (expectedSection[field] !== undefined && actualValue !== expectedValue) {
          failures.push(`${expectedElementId}: section.${field}`);
        }
      }
      if (expectedSection.shape !== undefined) {
        compareStructuredValue(
          actualSection.shape,
          expectedSection.shape,
          propertyTolerance,
          `${expectedElementId}: section.shape`,
          failures,
        );
      }
      for (const field of ["width", "height", "diameter", "thickness"]) {
        if (expectedSection[field] !== undefined
          && !numericClose(actualSection[field], expectedSection[field], propertyTolerance)) {
          failures.push(`${expectedElementId}: section.${field}`);
        }
      }
      for (const field of SECTION_NUMERIC_FIELDS) {
        if (expectedSection.properties?.[field] !== undefined
          && !numericClose(
            actualSection.properties?.[field],
            expectedSection.properties[field],
            propertyTolerance,
          )) {
          failures.push(`${expectedElementId}: section.${field}`);
        }
      }
    }
  }
  return failures;
}

function compareElementModifiers(expectedModel, actualModel, elementMapping, propertyTolerance) {
  const expectedElements = entityMap(expectedModel.elements);
  const actualElements = entityMap(actualModel.elements);
  const failures = [];
  const behavioralOverrideFields = ["releases", "offsets"];
  const gradeFields = ["concrete_grade", "steel_grade", "rebar_grade", "seismic_grade"];
  for (const [expectedId, actualId] of elementMapping.entries()) {
    const expected = expectedElements.get(expectedId);
    const actual = actualElements.get(actualId);
    if (!numericClose(actual?.rotation_angle ?? 0, expected?.rotation_angle ?? 0, propertyTolerance)) {
      failures.push(`${expectedId}: rotation_angle`);
    }
    for (const field of behavioralOverrideFields) {
      if (expected?.[field] !== undefined) {
        compareStructuredValue(actual?.[field], expected[field], propertyTolerance, `${expectedId}: ${field}`, failures);
      } else if (hasMeaningfulValue(actual?.[field])) {
        failures.push(`${expectedId}: unexpected ${field}`);
      }
    }
    for (const field of gradeFields) {
      if (expected?.[field] !== undefined) {
        compareStructuredValue(actual?.[field], expected[field], propertyTolerance, `${expectedId}: ${field}`, failures);
      }
    }
  }

  const expectedVectors = expectedModel.metadata?.elementReferenceVectors || {};
  const actualVectors = actualModel.metadata?.elementReferenceVectors || {};
  const expectedVectorIds = new Set(Object.keys(expectedVectors));
  for (const [expectedId, actualId] of elementMapping.entries()) {
    if (expectedVectorIds.has(expectedId)) {
      compareStructuredValue(
        actualVectors[actualId],
        expectedVectors[expectedId],
        propertyTolerance,
        `${expectedId}: reference vector`,
        failures,
      );
    }
  }
  return failures;
}

function loadTarget(load) {
  const node = load?.node ?? load?.nodeId ?? load?.node_id;
  const element = load?.element ?? load?.elementId ?? load?.element_id;
  if (node !== undefined) return { kind: "node", id: String(node) };
  if (element !== undefined) return { kind: "element", id: String(element) };
  return null;
}

function loadType(load) {
  const target = loadTarget(load);
  if (target?.kind === "node") return "nodal";
  if (target?.kind === "element") return "distributed";
  return String(load?.type || "unknown").toLowerCase();
}

function loadComponents(load) {
  if (loadType(load) === "distributed") {
    return ["wx", "wy", "wz"].map((field) => finiteNumber(load?.[field]) ?? 0);
  }
  const forces = Array.isArray(load?.forces) ? load.forces : [];
  return ["fx", "fy", "fz", "mx", "my", "mz"]
    .map((field, index) => finiteNumber(load?.[field]) ?? finiteNumber(forces[index]) ?? 0);
}

function floorLoadTypesForCase(loadCase) {
  const type = String(loadCase?.type || "").toLowerCase();
  if (type === "dead" || type === "live") return [type];
  const id = String(loadCase?.id || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["d", "dl", "dead", "deadload"].includes(id) || id.startsWith("dead") || id.startsWith("dl")) {
    return ["dead"];
  }
  if (["l", "ll", "live", "liveload"].includes(id) || id.startsWith("live") || id.startsWith("ll")) {
    return ["live"];
  }
  return [];
}

function canonical2dStoryLoads(model, loadCase) {
  const dimension = String(model?.coordinate_system?.dimension || model?.metadata?.frameDimension || "").toLowerCase();
  if (dimension !== "2d") return [];
  const loadKinds = floorLoadTypesForCase(loadCase);
  if (loadKinds.length === 0) return [];
  const stories = entityMap(model.stories);
  return (model.elements || []).flatMap((element) => {
    if (String(element?.type || "").toLowerCase() !== "beam" || element?.story === undefined) return [];
    const story = stories.get(String(element.story));
    if (!story) return [];
    const values = storyFloorLoadValues(story);
    return loadKinds.flatMap((loadKind) => {
      const intensity = values[loadKind];
      if (intensity === null || Math.abs(intensity) <= 1e-12) return [];
      return [{
        type: "distributed",
        element: element.id,
        wz: -intensity,
        wy: 0,
        reference_frame: "global",
        source: "canonical_story_line_loads",
        load_kind: loadKind,
      }];
    });
  });
}

function comparableCaseLoads(model, loadCase) {
  const explicit = (loadCase?.loads || []).filter((load) => load?.source !== "story_floor_loads");
  return explicit.length > 0 ? explicit : canonical2dStoryLoads(model, loadCase);
}

function flattenLoads(model) {
  return (model.load_cases || []).flatMap((loadCase) => comparableCaseLoads(model, loadCase)
    .map((load) => ({
      ...load,
      loadCaseType: String(loadCase.type || "other").toLowerCase(),
    })));
}

function flattenLoadComponents(model) {
  return flattenLoads(model).flatMap((load) => {
    const components = loadComponents(load);
    const nonzeroComponents = components
      .map((value, index) => ({ index, value }))
      .filter(({ value }) => value !== 0);
    const entries = nonzeroComponents.length > 0
      ? nonzeroComponents
      : [{ index: -1, value: 0 }];
    return entries.map(({ index, value }) => ({
      ...load,
      componentIndex: index,
      componentValue: value,
    }));
  });
}

function loadCaseTypesCompatible(actualType, expectedType) {
  return expectedType === "other" || actualType === expectedType;
}

function compareLoads(expectedModel, actualModel, nodeMapping, elementMapping, loadTolerance) {
  const expectedLoads = flattenLoadComponents(expectedModel);
  const actualLoads = flattenLoadComponents(actualModel);
  const candidates = expectedLoads.map((expected) => {
    const expectedTarget = loadTarget(expected);
    const mappedTarget = expectedTarget?.kind === "node"
      ? nodeMapping.get(expectedTarget.id)
      : elementMapping.get(expectedTarget?.id);
    if (!expectedTarget || mappedTarget === undefined) return [];
    return actualLoads.flatMap((actual, actualIndex) => {
      const actualTarget = loadTarget(actual);
      if (!actualTarget
        || actualTarget.kind !== expectedTarget.kind
        || actualTarget.id !== mappedTarget
        || loadType(actual) !== loadType(expected)
        || actual.componentIndex !== expected.componentIndex
        || String(actual.reference_frame || "global") !== String(expected.reference_frame || "global")
        || !loadCaseTypesCompatible(actual.loadCaseType, expected.loadCaseType)) return [];
      return numericClose(actual.componentValue, expected.componentValue, loadTolerance, 1e-9)
        ? [actualIndex]
        : [];
    });
  });
  const actualToExpected = new Map();

  function augment(expectedIndex, visited) {
    for (const actualIndex of candidates[expectedIndex]) {
      if (visited.has(actualIndex)) continue;
      visited.add(actualIndex);
      const previous = actualToExpected.get(actualIndex);
      if (previous === undefined || augment(previous, visited)) {
        actualToExpected.set(actualIndex, expectedIndex);
        return true;
      }
    }
    return false;
  }

  for (let expectedIndex = 0; expectedIndex < expectedLoads.length; expectedIndex += 1) {
    augment(expectedIndex, new Set());
  }
  return precisionRecall(actualToExpected.size, actualLoads.length, expectedLoads.length);
}

function loadCombinationEntries(model) {
  const cases = entityMap(model.load_cases);
  return (model.load_combinations || []).map((combination) => Object.entries(combination.factors || {})
    .map(([caseId, factor]) => ({
      type: String(cases.get(String(caseId))?.type || "unknown").toLowerCase(),
      factor: finiteNumber(factor),
    })));
}

function combinationMatches(actual, expected) {
  const uniqueEntries = (entries) => entries.filter((entry, index) => entries.findIndex((candidate) => (
    candidate.type === entry.type
      && numericClose(candidate.factor, entry.factor, 0, 1e-12)
  )) === index);
  const actualUnique = uniqueEntries(actual);
  const expectedUnique = uniqueEntries(expected);
  if (actualUnique.length !== expectedUnique.length) return false;
  const candidates = expectedUnique.map((expectedEntry) => actualUnique.flatMap((actualEntry, actualIndex) => (
    loadCaseTypesCompatible(actualEntry.type, expectedEntry.type)
      && numericClose(actualEntry.factor, expectedEntry.factor, 0, 1e-12)
      ? [actualIndex]
      : []
  )));
  const actualToExpected = new Map();

  function augment(expectedIndex, visited) {
    for (const actualIndex of candidates[expectedIndex]) {
      if (visited.has(actualIndex)) continue;
      visited.add(actualIndex);
      const previous = actualToExpected.get(actualIndex);
      if (previous === undefined || augment(previous, visited)) {
        actualToExpected.set(actualIndex, expectedIndex);
        return true;
      }
    }
    return false;
  }

  for (let expectedIndex = 0; expectedIndex < expectedUnique.length; expectedIndex += 1) {
    if (!augment(expectedIndex, new Set())) return false;
  }
  return true;
}

function combinationLoadVector(model, combination, targetMapping) {
  const cases = entityMap(model.load_cases);
  const vector = new Map();
  for (const [caseId, rawFactor] of Object.entries(combination.factors || {})) {
    const factor = finiteNumber(rawFactor);
    const loadCase = cases.get(String(caseId));
    if (factor === null || !loadCase) return null;
    for (const load of comparableCaseLoads(model, loadCase)) {
      const target = loadTarget(load);
      if (!target) continue;
      const mappedTarget = targetMapping
        ? targetMapping(target.kind, target.id)
        : target.id;
      if (mappedTarget === undefined) return null;
      loadComponents(load).forEach((component, componentIndex) => {
        if (component === 0) return;
        const key = [
          target.kind,
          mappedTarget,
          loadType(load),
          componentIndex,
          String(load.reference_frame || "global"),
        ].join("\u0000");
        vector.set(key, (vector.get(key) || 0) + factor * component);
      });
    }
  }
  for (const [key, value] of vector.entries()) {
    if (Math.abs(value) <= 1e-12) vector.delete(key);
  }
  return vector;
}

function combinationLoadVectorsMatch(actual, expected, loadTolerance) {
  if (!actual || !expected || actual.size !== expected.size) return false;
  for (const [key, expectedValue] of expected.entries()) {
    if (!actual.has(key) || !numericClose(actual.get(key), expectedValue, loadTolerance, 1e-9)) return false;
  }
  return true;
}

function loadCombinationsMatch(actualModel, expectedModel, nodeMapping, elementMapping, loadTolerance) {
  const actualCombinations = actualModel.load_combinations || [];
  const expectedCombinations = expectedModel.load_combinations || [];
  const actualEntries = loadCombinationEntries(actualModel);
  const expectedEntries = loadCombinationEntries(expectedModel);
  if (actualCombinations.length !== expectedCombinations.length) return false;
  const used = new Set();
  for (let expectedIndex = 0; expectedIndex < expectedCombinations.length; expectedIndex += 1) {
    const expectedVector = combinationLoadVector(
      expectedModel,
      expectedCombinations[expectedIndex],
      (kind, id) => (kind === "node" ? nodeMapping.get(id) : elementMapping.get(id)),
    );
    const actualIndex = actualCombinations.findIndex((actualCombination, index) => {
      if (used.has(index)) return false;
      const expectedHasExplicitCategories = expectedEntries[expectedIndex]
        .some((entry) => entry.type !== "other");
      if (expectedHasExplicitCategories
        && !combinationMatches(actualEntries[index], expectedEntries[expectedIndex])) return false;
      const actualVector = combinationLoadVector(actualModel, actualCombination);
      if (actualVector?.size || expectedVector?.size) {
        return combinationLoadVectorsMatch(actualVector, expectedVector, loadTolerance);
      }
      return combinationMatches(actualEntries[index], expectedEntries[expectedIndex]);
    });
    if (actualIndex < 0) return false;
    used.add(actualIndex);
  }
  return true;
}

function storyFloorLoadValues(story) {
  const declared = Array.isArray(story?.floor_loads) ? story.floor_loads : [];
  const value = (type, ...fallbackFields) => {
    const matching = declared.filter((load) => String(load?.type || "").toLowerCase() === type);
    if (matching.length > 0) {
      return matching.reduce((sum, load) => sum + (finiteNumber(load?.value) || 0), 0);
    }
    for (const field of fallbackFields) {
      const fallback = finiteNumber(story?.[field]);
      if (fallback !== null) return fallback;
    }
    return null;
  };
  return {
    dead: value("dead", "dead_load", "floorLoad"),
    live: value("live", "live_load", "liveLoad"),
  };
}

function hasExplicitStoryLineLoads(model, storyId, loadKind) {
  const beamIds = new Set((model.elements || [])
    .filter((element) => (
      String(element?.type || "").toLowerCase() === "beam"
      && String(element?.story || "") === String(storyId)
    ))
    .map((element) => String(element.id)));
  if (beamIds.size === 0) return false;
  const loadedBeamIds = new Set();
  for (const loadCase of model.load_cases || []) {
    if (!floorLoadTypesForCase(loadCase).includes(loadKind)) continue;
    for (const load of loadCase.loads || []) {
      if (load?.source === "story_floor_loads" || loadType(load) !== "distributed") continue;
      const target = loadTarget(load);
      if (target?.kind === "element" && beamIds.has(target.id)) loadedBeamIds.add(target.id);
    }
  }
  return [...beamIds].every((id) => loadedBeamIds.has(id));
}

function compareStories(expectedModel, actualModel, nodeMapping, elementMapping, coordinateTolerance, loadTolerance) {
  const expectedStories = expectedModel.stories || [];
  const actualStories = actualModel.stories || [];
  const failures = [];
  if (expectedStories.length === 0) {
    const hasUnexpectedFloorLoads = actualStories.some((story) => {
      const values = storyFloorLoadValues(story);
      return [values.dead, values.live].some((value) => value !== null && Math.abs(value) > 1e-12);
    });
    return hasUnexpectedFloorLoads ? ["unexpected story loads"] : failures;
  }
  if (expectedStories.length !== actualStories.length) return ["story count"];
  const expectedNodes = entityMap(expectedModel.nodes);
  const actualNodes = entityMap(actualModel.nodes);
  const expectedElements = entityMap(expectedModel.elements);
  const actualElements = entityMap(actualModel.elements);
  const actualStoryById = entityMap(actualStories);
  const storyCandidates = new Map(expectedStories.map((story) => [String(story.id), new Set()]));
  const collectStoryCandidate = (expectedEntity, actualEntity) => {
    if (expectedEntity?.story === undefined) return;
    const expectedStoryId = String(expectedEntity.story);
    const candidates = storyCandidates.get(expectedStoryId);
    if (!candidates) return;
    if (actualEntity?.story === undefined) {
      failures.push(`${expectedEntity.id}: missing story`);
      return;
    }
    candidates.add(String(actualEntity.story));
  };
  for (const [expectedId, actualId] of nodeMapping.entries()) {
    collectStoryCandidate(expectedNodes.get(expectedId), actualNodes.get(actualId));
  }
  for (const [expectedId, actualId] of elementMapping.entries()) {
    collectStoryCandidate(expectedElements.get(expectedId), actualElements.get(actualId));
  }

  const storyMapping = new Map();
  const usedActualStories = new Set();
  for (const expected of expectedStories) {
    const expectedId = String(expected.id);
    const candidates = storyCandidates.get(expectedId) || new Set();
    if (candidates.size !== 1) {
      failures.push(`${expected.id}: inconsistent entity assignments`);
      continue;
    }
    const actualId = [...candidates][0];
    if (!actualStoryById.has(actualId) || usedActualStories.has(actualId)) {
      failures.push(`${expected.id}: invalid story mapping`);
      continue;
    }
    storyMapping.set(expectedId, actualId);
    usedActualStories.add(actualId);
  }

  for (let index = 0; index < expectedStories.length; index += 1) {
    const expected = expectedStories[index];
    const actual = actualStoryById.get(storyMapping.get(String(expected.id)));
    if (!actual) continue;
    if (!numericClose(actual.height, expected.height, 0, coordinateTolerance)) failures.push(`${expected.id}: height`);
    if (expected.elevation !== undefined
      && !numericClose(actual.elevation, expected.elevation, 0, coordinateTolerance)) {
      failures.push(`${expected.id}: elevation`);
    }
    const expectedFloorLoads = storyFloorLoadValues(expected);
    const actualFloorLoads = storyFloorLoadValues(actual);
    for (const loadKind of ["dead", "live"]) {
      if (!hasExplicitStoryLineLoads(expectedModel, expected.id, loadKind)
        && expectedFloorLoads[loadKind] !== null
        && !numericClose(actualFloorLoads[loadKind], expectedFloorLoads[loadKind], loadTolerance, 1e-9)) {
        failures.push(`${expected.id}: ${loadKind} floor load`);
      }
    }
    const declaredLoadKinds = ["dead", "live"].filter((loadKind) => expectedFloorLoads[loadKind] !== null);
    const floorLoadIsExplicit = declaredLoadKinds.length > 0
      && declaredLoadKinds.every((loadKind) => hasExplicitStoryLineLoads(expectedModel, expected.id, loadKind));
    for (const field of ["tributaryWidthM", "equivalentLineLoad"]) {
      if (!floorLoadIsExplicit
        && expected[field] !== undefined
        && !numericClose(actual[field], expected[field], loadTolerance, 1e-9)) {
        failures.push(`${expected.id}: ${field}`);
      }
    }
  }
  for (const [expectedId, actualId] of nodeMapping.entries()) {
    const expectedStory = expectedNodes.get(expectedId)?.story;
    const actualStory = actualNodes.get(actualId)?.story;
    if (expectedStory !== undefined && storyMapping.get(String(expectedStory)) !== String(actualStory)) {
      failures.push(`node ${expectedId}: story`);
    }
  }
  for (const [expectedId, actualId] of elementMapping.entries()) {
    const expectedStory = expectedElements.get(expectedId)?.story;
    const actualStory = actualElements.get(actualId)?.story;
    if (expectedStory !== undefined && storyMapping.get(String(expectedStory)) !== String(actualStory)) {
      failures.push(`element ${expectedId}: story`);
    }
  }
  return failures;
}

function compareStructuralModels(actualModel, expectedModel, options = {}) {
  const coordinateTolerance = options.coordinate ?? options.span ?? 0.05;
  const propertyTolerance = options.property ?? 0.05;
  const loadTolerance = options.load ?? 0.05;
  const entityThreshold = 1;
  const actualContract = inspectCoordinateContract(actualModel);
  const expectedContract = inspectCoordinateContract(expectedModel);
  const actualIntegrity = inspectModelIntegrity(actualModel);
  const expectedIntegrity = inspectModelIntegrity(expectedModel);
  const failures = [];

  if (!actualContract.ok || !expectedContract.ok) {
    return {
      pass: false,
      summary: !actualContract.ok
        ? `agent model: ${actualContract.reason}`
        : `ground truth: ${expectedContract.reason}`,
      metrics: {},
      failures: [!actualContract.ok ? actualContract.reason : expectedContract.reason],
    };
  }
  if (!actualIntegrity.ok || !expectedIntegrity.ok) {
    return {
      pass: false,
      summary: !actualIntegrity.ok
        ? `agent model: ${actualIntegrity.reason}`
        : `ground truth: ${expectedIntegrity.reason}`,
      metrics: {},
      failures: ["artifact integrity"],
    };
  }
  if (actualContract.dimension !== expectedContract.dimension) failures.push("dimension");
  if (String(actualModel.schema_version || "") !== String(expectedModel.schema_version || "")) {
    failures.push("schema version");
  }
  if (String(actualModel.unit_system || "") !== String(expectedModel.unit_system || "")) {
    failures.push("unit system");
  }

  const expectedNodes = expectedModel.nodes || [];
  const actualNodes = actualModel.nodes || [];
  const nodeMapping = maximumNodeMatching(expectedNodes, actualNodes, coordinateTolerance);
  const nodeScore = precisionRecall(nodeMapping.size, actualNodes.length, expectedNodes.length);
  if (!thresholdPass(nodeScore, entityThreshold)) failures.push("nodes");

  const expectedElements = expectedModel.elements || [];
  const actualElements = actualModel.elements || [];
  const elementMapping = maximumElementMatching(expectedElements, actualElements, nodeMapping);
  const elementScore = precisionRecall(elementMapping.size, actualElements.length, expectedElements.length);
  if (!thresholdPass(elementScore, entityThreshold)) failures.push("topology");
  const expectedElementMap = entityMap(expectedElements);
  const actualElementMap = entityMap(actualElements);
  const elementOrientation = {};
  for (const [expectedElementId, actualElementId] of elementMapping.entries()) {
    const [expectedStart, expectedEnd] = elementEndpoints(expectedElementMap.get(expectedElementId));
    const [actualStart, actualEnd] = elementEndpoints(actualElementMap.get(actualElementId));
    const mappedStart = nodeMapping.get(expectedStart);
    const mappedEnd = nodeMapping.get(expectedEnd);
    elementOrientation[expectedElementId] = actualStart === mappedStart && actualEnd === mappedEnd
      ? "same"
      : "reversed";
  }

  const expectedNodeMap = entityMap(expectedNodes);
  const actualNodeMap = entityMap(actualNodes);
  const restraintFailures = [];
  for (const [expectedNodeId, actualNodeId] of nodeMapping.entries()) {
    const expected = normalizedRestraints(expectedNodeMap.get(expectedNodeId));
    const actual = normalizedRestraints(actualNodeMap.get(actualNodeId));
    if (!expected.every((value, index) => value === actual[index])) restraintFailures.push(expectedNodeId);
  }
  if (restraintFailures.length > 0) failures.push("restraints");

  const propertyFailures = compareAssignedProperties(
    expectedModel, actualModel, elementMapping, propertyTolerance,
  );
  if (propertyFailures.length > 0) failures.push("properties");
  const modifierFailures = compareElementModifiers(
    expectedModel, actualModel, elementMapping, propertyTolerance,
  );
  if (modifierFailures.length > 0) failures.push("element modifiers");

  const loadScore = compareLoads(expectedModel, actualModel, nodeMapping, elementMapping, loadTolerance);
  if (!thresholdPass(loadScore, entityThreshold)) failures.push("loads");
  const combinationsMatch = loadCombinationsMatch(
    actualModel,
    expectedModel,
    nodeMapping,
    elementMapping,
    loadTolerance,
  );
  if (!combinationsMatch) failures.push("load combinations");
  const storyFailures = compareStories(
    expectedModel,
    actualModel,
    nodeMapping,
    elementMapping,
    coordinateTolerance,
    loadTolerance,
  );
  if (storyFailures.length > 0) failures.push("stories");

  const metrics = {
    nodes: nodeScore,
    elements: elementScore,
    loads: loadScore,
    restraintFailures: restraintFailures.length,
    propertyFailures: propertyFailures.length,
    modifierFailures: modifierFailures.length,
    loadCombinationsMatch: combinationsMatch,
    storyFailures: storyFailures.length,
  };
  const formatScore = (label, score, actualCount, expectedCount) => `${label} actual=${actualCount}, expected=${expectedCount}, matched=${score.matched} `
    + `(P=${score.precision.toFixed(3)}, R=${score.recall.toFixed(3)})`;
  const details = [
    `dimension ${actualContract.dimension}/${expectedContract.dimension}`,
    formatScore("nodes", nodeScore, actualNodes.length, expectedNodes.length),
    formatScore("elements", elementScore, actualElements.length, expectedElements.length),
    `restraints ${nodeMapping.size - restraintFailures.length}/${nodeMapping.size}`,
    `properties ${propertyFailures.length === 0 ? "OK" : `${propertyFailures.length} mismatches`}`,
    `element modifiers ${modifierFailures.length === 0 ? "OK" : `${modifierFailures.length} mismatches`}`,
    formatScore(
      "loads",
      loadScore,
      loadScore.actualCount ?? 0,
      loadScore.expectedCount ?? 0,
    ),
    `load combinations ${combinationsMatch ? "OK" : "FAIL"}`,
    `stories ${storyFailures.length === 0 ? "OK" : `${storyFailures.length} mismatches`}`,
  ];

  return {
    pass: failures.length === 0,
    summary: details.join("; "),
    metrics,
    failures,
    diagnostics: {
      restraintFailures,
      propertyFailures,
      modifierFailures,
      storyFailures,
      nodeMapping: Object.fromEntries(nodeMapping),
      elementMapping: Object.fromEntries(elementMapping),
      elementOrientation,
    },
  };
}

module.exports = {
  compareStructuralModels,
  inspectCoordinateContract,
  inspectModelIntegrity,
};
