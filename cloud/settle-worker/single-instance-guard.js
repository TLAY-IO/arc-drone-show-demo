// single-instance-guard — refuse to start if another instance of this worker
// is already running for this device/broker pair.
//
// Why this exists: on 2026-06-15 a stray-process incident
// caused 5 burn-intent-worker processes to coexist (all started via
// `nohup node index.js &`, none reliably killed by `pkill -f`). Each stray
// independently accumulated unminted state via MQTT and could fire its own
// gatewayMint when /api/mint was called. One stray accidentally minted 176895µ
// from its private backlog before we noticed.
//
// `pkill -f '<path>'` does NOT reliably catch nohup-detached node processes
// started from a different shell context. The only safe single-instance
// pattern is a pidfile + exclusive file lock.
//
// Usage:
//   import { acquire } from "./single-instance-guard.js"
//   const release = acquire("burn-intent-worker")
//   // ... worker runs ...
//   // (release is automatically called on SIGINT/SIGTERM/exit)

import fs from "fs"
import os from "os"
import path from "path"
import { execSync } from "child_process"

const LOCK_DIR = path.join(os.tmpdir(), "arc-drone-show-demo-locks")

function ensureLockDir() {
  if (!fs.existsSync(LOCK_DIR)) {
    fs.mkdirSync(LOCK_DIR, { mode: 0o700, recursive: true })
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)  // signal 0 = existence check, doesn't kill
    return true
  } catch (e) {
    if (e.code === "ESRCH") return false
    if (e.code === "EPERM") return true  // exists but we don't own it
    return false
  }
}

/**
 * Acquire a single-instance lock for the given worker name.
 *
 * @param {string} workerName - logical worker name (e.g. "burn-intent-worker").
 *                              Determines the pidfile path.
 * @throws if another instance is already running.
 * @returns release function (call to remove the pidfile manually; also runs on exit).
 */
export function acquire(workerName) {
  ensureLockDir()
  const lockPath = path.join(LOCK_DIR, `${workerName}.pid`)

  // Check if existing pidfile points to a live process.
  if (fs.existsSync(lockPath)) {
    const raw = fs.readFileSync(lockPath, "utf8").trim()
    const existingPid = parseInt(raw, 10)
    if (!Number.isNaN(existingPid) && existingPid !== process.pid) {
      if (isProcessAlive(existingPid)) {
        throw new Error(
          `[single-instance-guard] another ${workerName} is already running (PID ${existingPid}).\n` +
            `  If you're certain it's dead, remove ${lockPath} manually and retry.\n` +
            `  This guard exists because pkill -f does not reliably catch nohup-detached node processes.`,
        )
      }
      console.warn(
        `[single-instance-guard] stale pidfile for ${workerName} (PID ${existingPid} not alive), reclaiming`,
      )
    }
  }

  // Write our own PID.
  fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 })

  // Belt-and-suspenders: scan ps for other node processes with our index.js.
  // This catches workers started in a foreign LOCK_DIR (e.g. test machines
  // with mismatched tmpdir). It's a warning, not a fatal error.
  try {
    const out = execSync(
      `ps aux | grep "node.*index.js" | grep -v grep | wc -l`,
      { encoding: "utf8" },
    ).trim()
    const count = parseInt(out, 10)
    if (count > 1) {
      console.warn(
        `[single-instance-guard] ⚠️  ps shows ${count} node index.js processes running.\n` +
          `  This guard only protects against duplicate pidfiles in ${LOCK_DIR}.\n` +
          `  Strays from a different tmpdir/user/container can still coexist.\n` +
          `  Run: ps aux | grep node`,
      )
    }
  } catch {
    // ps may not be available in some environments; silent skip is fine.
  }

  // Register cleanup on exit / signals.
  const release = () => {
    try {
      const raw = fs.readFileSync(lockPath, "utf8").trim()
      if (parseInt(raw, 10) === process.pid) {
        fs.unlinkSync(lockPath)
      }
    } catch {
      // pidfile might already be gone, or owned by someone else now; ignore.
    }
  }
  process.on("exit", release)
  process.on("SIGINT", () => { release(); process.exit(0) })
  process.on("SIGTERM", () => { release(); process.exit(0) })

  console.log(`[single-instance-guard] acquired lock for ${workerName} (PID ${process.pid})`)
  return release
}
