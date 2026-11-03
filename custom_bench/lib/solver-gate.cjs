const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT_POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_YJK_COOLDOWN_MS = 5 * 1000;
const OWNER_GRACE_MS = 5 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sanitizeLockName(value) {
  return String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

function solverLockGroup(mode, engineId) {
  if (mode === "global") return "all-analysis";
  return sanitizeLockName(engineId || "builtin-opensees");
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOwner(ownerPath) {
  try {
    return JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    return null;
  }
}

function lockAgeMs(lockPath) {
  try {
    return Math.max(0, Date.now() - fs.statSync(lockPath).mtimeMs);
  } catch {
    return 0;
  }
}

function removeStaleLock(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
  const owner = readOwner(ownerPath);
  const oldEnough = lockAgeMs(lockPath) >= OWNER_GRACE_MS;
  const localDeadOwner = owner
    && owner.hostname === os.hostname()
    && !processIsAlive(Number(owner.pid));
  const missingOwner = !owner && oldEnough;
  if (!localDeadOwner && !missingOwner) return false;
  fs.rmSync(lockPath, { recursive: true, force: true });
  return true;
}

function waitForPoll(delayMs, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const timer = setTimeout(() => finish(resolve), delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      finish(() => reject(signal.reason || new Error("Solver queue wait aborted")));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function acquireDirectoryLock(options) {
  const lockRoot = path.resolve(options.lockRoot);
  const group = sanitizeLockName(options.group);
  const pollMs = positiveInteger(options.pollMs, DEFAULT_POLL_MS);
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const lockPath = path.join(lockRoot, `${group}.lock`);
  const token = randomUUID();
  const waitStartedAt = Date.now();
  fs.mkdirSync(lockRoot, { recursive: true });

  while (true) {
    if (options.signal?.aborted) {
      throw options.signal.reason || new Error("Solver queue wait aborted");
    }
    try {
      fs.mkdirSync(lockPath);
      const owner = {
        token,
        pid: process.pid,
        hostname: os.hostname(),
        group,
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`);
      return {
        group,
        lockPath,
        token,
        queueWaitMs: Date.now() - waitStartedAt,
        release() {
          const currentOwner = readOwner(path.join(lockPath, "owner.json"));
          if (currentOwner?.token === token) {
            fs.rmSync(lockPath, { recursive: true, force: true });
          }
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (removeStaleLock(lockPath)) continue;
      if (Date.now() - waitStartedAt >= timeoutMs) {
        const timeoutError = new Error(
          `BENCHMARK_SOLVER_QUEUE_TIMEOUT: group=${group} waited ${timeoutMs}ms`,
        );
        timeoutError.code = "BENCHMARK_SOLVER_QUEUE_TIMEOUT";
        throw timeoutError;
      }
      await waitForPoll(pollMs, options.signal);
    }
  }
}

function installSolverGate(service, options = {}) {
  const mode = options.mode || process.env.SCLAW_BENCHMARK_SOLVER_GATE || "off";
  if (!["off", "per-engine", "global"].includes(mode)) {
    throw new Error(`Unsupported benchmark solver gate mode: ${mode}`);
  }
  const engineClient = service?.engineClient;
  if (!engineClient || typeof engineClient.get !== "function" || typeof engineClient.post !== "function") {
    throw new Error("Benchmark solver gate requires LangGraphAgentService.engineClient");
  }

  const events = [];
  if (mode === "off") {
    return {
      enabled: false,
      mode,
      snapshot({ reset = true } = {}) {
        const value = [...events];
        if (reset) events.length = 0;
        return value;
      },
      restore() {},
    };
  }

  const lockRoot = path.resolve(
    options.lockRoot
      || process.env.SCLAW_BENCHMARK_SOLVER_LOCK_ROOT
      || path.join(__dirname, "..", "runtime", "solver-locks"),
  );
  const pollMs = positiveInteger(
    options.pollMs || process.env.SCLAW_BENCHMARK_SOLVER_LOCK_POLL_MS,
    DEFAULT_POLL_MS,
  );
  const timeoutMs = positiveInteger(
    options.timeoutMs || process.env.SCLAW_BENCHMARK_SOLVER_LOCK_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const yjkCooldownMs = nonNegativeInteger(
    options.yjkCooldownMs ?? process.env.SCLAW_BENCHMARK_YJK_COOLDOWN_MS,
    DEFAULT_YJK_COOLDOWN_MS,
  );
  const wrappedClient = {
    get: engineClient.get.bind(engineClient),
    async post(requestPath, payload = {}, requestOptions) {
      if (requestPath !== "/analyze") {
        return engineClient.post(requestPath, payload, requestOptions);
      }
      const engineId = payload.engineId || "builtin-opensees";
      const group = solverLockGroup(mode, engineId);
      const lock = await acquireDirectoryLock({
        lockRoot,
        group,
        pollMs,
        timeoutMs,
        signal: requestOptions?.signal,
      });
      const executionStartedAt = Date.now();
      const event = {
        engineId,
        group,
        queueWaitMs: lock.queueWaitMs,
        solverExecutionMs: 0,
        cooldownMs: 0,
        success: false,
      };
      try {
        const response = await engineClient.post(requestPath, payload, requestOptions);
        event.success = true;
        return response;
      } catch (error) {
        event.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        event.solverExecutionMs = Date.now() - executionStartedAt;
        if (engineId === "builtin-yjk" && yjkCooldownMs > 0) {
          const cooldownStartedAt = Date.now();
          try {
            await waitForPoll(yjkCooldownMs, requestOptions?.signal);
          } catch {
            // Cancellation should release the solver lock immediately.
          }
          event.cooldownMs = Date.now() - cooldownStartedAt;
        }
        events.push(event);
        lock.release();
      }
    },
  };

  service.engineClient = wrappedClient;
  return {
    enabled: true,
    mode,
    lockRoot,
    yjkCooldownMs,
    snapshot({ reset = true } = {}) {
      const value = events.map((event) => ({ ...event }));
      if (reset) events.length = 0;
      return value;
    },
    restore() {
      if (service.engineClient === wrappedClient) {
        service.engineClient = engineClient;
      }
    },
  };
}

module.exports = {
  acquireDirectoryLock,
  installSolverGate,
  solverLockGroup,
};
