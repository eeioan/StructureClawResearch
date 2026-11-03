const ENGINE_KEYS = {
  "builtin-opensees": "opensees",
  "builtin-pkpm": "pkpm",
  "builtin-yjk": "yjk",
  opensees: "opensees",
  pkpm: "pkpm",
  yjk: "yjk",
};

function normalizeEngineKey(value) {
  return ENGINE_KEYS[String(value || "").toLowerCase()] || null;
}

function findEngineGroundTruth(payload, modelId, engineId) {
  const engine = normalizeEngineKey(engineId);
  if (!engine || engine === "opensees") return null;
  const entry = (payload?.cases || []).find(
    (candidate) => candidate?.provenance?.sourceModelId === modelId,
  );
  const truth = entry?.engines?.[engine];
  return truth ? { engine, entry, truth } : null;
}

module.exports = { findEngineGroundTruth, normalizeEngineKey };
