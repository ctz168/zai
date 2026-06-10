/**
 * ZAI Agent Daemon — Double-Fork Process Guardian
 *
 * Implements the classic Unix double-fork technique to create a fully
 * detached daemon process that survives terminal closure, SIGHUP, and
 * parent process crashes. A supervisor process monitors the agent and
 * automatically restarts it on failure.
 *
 * Architecture:
 *   Terminal (CLI) → fork #1 (intermediate) → fork #2 (supervisor) → agent worker
 *
 *   - The CLI exits immediately after spawning the intermediate process.
 *   - The intermediate process forks again and exits, orphaning the supervisor.
 *   - The supervisor (PID 1's child) monitors the agent worker process.
 *   - If the worker crashes, the supervisor restarts it with exponential backoff.
 *   - PID file, log file, and status file for monitoring.
 *
 * Usage:
 *   zai agent --daemon             # Start as daemon
 *   zai agent --daemon stop        # Stop daemon
 *   zai agent --daemon restart     # Restart daemon
 *   zai agent --daemon status      # Check daemon status
 *   zai agent --daemon log         # Tail daemon log
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  appendFileSync,
  statSync,
  openSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// ESM-compatible __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────

const RUN_DIR = join(homedir(), ".zai", "run");

function getPidFile(): string {
  return join(RUN_DIR, "agent.pid");
}

function getLogFile(): string {
  return join(RUN_DIR, "agent.log");
}

function getErrorLogFile(): string {
  return join(RUN_DIR, "agent-error.log");
}

function getStatusFile(): string {
  return join(RUN_DIR, "agent-status.json");
}

function ensureRunDir(): void {
  if (!existsSync(RUN_DIR)) {
    mkdirSync(RUN_DIR, { recursive: true });
  }
}

// ─── Logging ──────────────────────────────────────────────────

function daemonLog(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    ensureRunDir();
    appendFileSync(getLogFile(), line);
  } catch {
    // Best effort
  }
}

// ─── PID File Management ─────────────────────────────────────

function writePid(pid: number): void {
  ensureRunDir();
  writeFileSync(getPidFile(), String(pid), { mode: 0o644 });
}

function readPid(): number | null {
  const f = getPidFile();
  if (!existsSync(f)) return null;
  try {
    const pid = parseInt(readFileSync(f, "utf-8").trim(), 10);
    if (isNaN(pid)) return null;
    return pid;
  } catch {
    return null;
  }
}

function removePid(): void {
  try {
    if (existsSync(getPidFile())) unlinkSync(getPidFile());
  } catch {
    // Ignore
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── Status File ─────────────────────────────────────────────

interface DaemonStatus {
  pid: number;
  supervisorPid: number;
  startedAt: string;
  restarts: number;
  lastRestartAt: string | null;
  state: "running" | "stopped" | "crashed";
}

function writeStatus(status: DaemonStatus): void {
  ensureRunDir();
  writeFileSync(getStatusFile(), JSON.stringify(status, null, 2));
}

function readStatus(): DaemonStatus | null {
  const f = getStatusFile();
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, "utf-8")) as DaemonStatus;
  } catch {
    return null;
  }
}

// ─── Open log file descriptor for spawn stdio ────────────────

function openLogFd(path: string): number {
  ensureRunDir();
  return openSync(path, "a");
}

// ─── Double-Fork Daemon Launch ────────────────────────────────

/**
 * Launch the agent as a double-fork daemon.
 *
 * Step 1: CLI process forks an intermediate child (detached, unref'd)
 * Step 2: Intermediate child forks the supervisor (detached, unref'd)
 * Step 3: Supervisor detaches, sets up session, monitors the agent worker
 * Step 4: CLI and intermediate both exit → supervisor is fully orphaned
 */
export function launchDaemon(options: {
  name?: string;
  server?: string;
  model?: string;
  prompt?: string;
  master?: string;
}): void {
  const existingPid = readPid();
  if (existingPid && isProcessRunning(existingPid)) {
    console.error(`❌ Agent daemon already running (PID ${existingPid})`);
    console.error(`   Use 'zai agent --daemon stop' to stop it first.`);
    process.exit(1);
  }

  // Clean stale PID file
  removePid();

  ensureRunDir();
  const logFile = getLogFile();
  const errLogFile = getErrorLogFile();

  // Clear previous logs
  writeFileSync(logFile, "");
  writeFileSync(errLogFile, "");

  console.log("🚀 Launching agent daemon (double-fork)...");

  // ─── First Fork: Intermediate Process ───────────────────────
  // Spawns a detached child that will perform the second fork.
  // This child is unref'd so the CLI process can exit immediately.

  const child = spawn(
    process.execPath,
    [join(__dirname, "cli.js"), "agent", "--_internal-daemon"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ZAI_DAEMON_NAME: options.name || "",
        ZAI_DAEMON_SERVER: options.server || "",
        ZAI_DAEMON_MODEL: options.model || "",
        ZAI_DAEMON_PROMPT: options.prompt || "",
        ZAI_DAEMON_MASTER: options.master || "",
        ZAI_DAEMON_LOG: logFile,
        ZAI_DAEMON_ERRLOG: errLogFile,
        ZAI_DAEMON_RUNDIR: RUN_DIR,
      },
      detached: true,    // Allow parent to exit without killing child
      stdio: "ignore",   // Fully detach I/O
    },
  );

  child.unref(); // Let parent exit independently

  // Wait a moment and check if the daemon started
  setTimeout(() => {
    const pid = readPid();
    if (pid && isProcessRunning(pid)) {
      console.log(`✅ Agent daemon launched successfully!`);
      console.log(`   PID:     ${pid}`);
      console.log(`   Log:     ${logFile}`);
      console.log(`   ErrLog:  ${errLogFile}`);
      console.log();
      console.log("   Commands:");
      console.log(`     zai agent --daemon status    # Check status`);
      console.log(`     zai agent --daemon log       # View log`);
      console.log(`     zai agent --daemon stop      # Stop daemon`);
      console.log(`     zai agent --daemon restart   # Restart daemon`);
    } else {
      console.error(`⚠️  Daemon may have failed to start. Check log: ${logFile}`);
      try {
        const log = readFileSync(logFile, "utf-8");
        const lines = log.trim().split("\n").slice(-5);
        if (lines.length > 0 && lines[0].trim()) {
          console.error("   Last log lines:");
          lines.forEach((l) => console.error(`   ${l}`));
        }
      } catch {
        // No log yet
      }
    }
  }, 1500);
}

// ─── Internal Daemon Entry Point ─────────────────────────────

/**
 * This function runs inside the first intermediate child process.
 * It performs the second fork (spawning the supervisor) and exits.
 */
export function runInternalDaemon(): void {
  const logFile = process.env.ZAI_DAEMON_LOG || getLogFile();
  const errLogFile = process.env.ZAI_DAEMON_ERRLOG || getErrorLogFile();

  daemonLog("[Intermediate] First fork running, spawning supervisor...");

  // ─── Second Fork: Become Supervisor ────────────────────────
  const supervisorEnv = { ...process.env };
  supervisorEnv.ZAI_DAEMON_ROLE = "supervisor";

  const logFd = openLogFd(logFile);
  const errFd = openLogFd(errLogFile);

  const supervisor = spawn(
    process.execPath,
    [join(__dirname, "cli.js"), "agent", "--_internal-daemon"],
    {
      cwd: process.cwd(),
      env: supervisorEnv,
      detached: true,
      stdio: [
        "ignore",   // stdin
        logFd,      // stdout → log file
        errFd,      // stderr → error log file
      ],
    },
  );

  supervisor.unref();

  daemonLog(`[Intermediate] Supervisor spawned (PID ${supervisor.pid}). Exiting intermediate.`);

  // Exit the intermediate process — the supervisor is now orphaned (adopted by PID 1)
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

// ─── Supervisor Process ──────────────────────────────────────

/**
 * The supervisor process. Monitors the agent worker and restarts on failure.
 * This runs as a long-lived detached process (orphan of PID 1).
 */
export function runSupervisor(): void {
  const logFile = process.env.ZAI_DAEMON_LOG || getLogFile();
  const errLogFile = process.env.ZAI_DAEMON_ERRLOG || getErrorLogFile();

  // Ignore SIGHUP (terminal closed)
  process.on("SIGHUP", () => {
    daemonLog("[Supervisor] SIGHUP received (ignored — daemon mode)");
  });

  daemonLog("[Supervisor] Starting up...");
  daemonLog(`[Supervisor] PID: ${process.pid}`);
  daemonLog(`[Supervisor] Log: ${logFile}`);

  // Write PID file
  writePid(process.pid);

  // Write initial status
  const startTime = new Date().toISOString();
  writeStatus({
    pid: 0,
    supervisorPid: process.pid,
    startedAt: startTime,
    restarts: 0,
    lastRestartAt: null,
    state: "running",
  });

  // ─── Worker Management ─────────────────────────────────────
  let restartCount = 0;
  let backoff = 1000;
  const maxBackoff = 60000;
  let currentWorker: ChildProcess | null = null;
  let shuttingDown = false;

  function spawnWorker(): void {
    if (shuttingDown) return;

    daemonLog("[Supervisor] Spawning agent worker...");

    const workerEnv = { ...process.env };
    // Remove daemon flags so worker runs as normal agent
    delete workerEnv.ZAI_DAEMON_ROLE;
    delete workerEnv.ZAI_DAEMON_LOG;
    delete workerEnv.ZAI_DAEMON_ERRLOG;

    const workerArgs = [
      join(__dirname, "cli.js"),
      "agent",
      "--_internal-worker",
    ];

    const logFd = openLogFd(logFile);
    const errFd = openLogFd(errLogFile);

    const worker = spawn(process.execPath, workerArgs, {
      cwd: process.cwd(),
      env: workerEnv,
      stdio: ["ignore", logFd, errFd],
      detached: false,
    });

    currentWorker = worker;

    daemonLog(`[Supervisor] Worker spawned (PID ${worker.pid})`);

    // Update status with worker PID
    const status = readStatus();
    if (status) {
      status.pid = worker.pid || 0;
      status.state = "running";
      writeStatus(status);
    }

    worker.on("exit", (code, signal) => {
      daemonLog(`[Supervisor] Worker exited (code=${code}, signal=${signal})`);
      currentWorker = null;

      if (shuttingDown) {
        daemonLog("[Supervisor] Shutting down, not restarting.");
        removePid();
        const finalStatus = readStatus();
        if (finalStatus) {
          finalStatus.state = "stopped";
          writeStatus(finalStatus);
        }
        process.exit(0);
        return;
      }

      restartCount++;

      const currentStatus = readStatus();
      if (currentStatus) {
        currentStatus.state = code === 0 ? "stopped" : "crashed";
        currentStatus.restarts = restartCount;
        currentStatus.lastRestartAt = new Date().toISOString();
        writeStatus(currentStatus);
      }

      // If exit was intentional (code 0 or SIGTERM), don't restart
      if (code === 0 || signal === "SIGTERM") {
        daemonLog("[Supervisor] Worker stopped intentionally. Not restarting.");
        removePid();
        const finalStatus = readStatus();
        if (finalStatus) {
          finalStatus.state = "stopped";
          writeStatus(finalStatus);
        }
        process.exit(0);
        return;
      }

      // Auto-restart with exponential backoff
      daemonLog(
        `[Supervisor] Restarting worker in ${backoff}ms (restart #${restartCount})...`,
      );
      setTimeout(() => {
        backoff = Math.min(backoff * 2, maxBackoff);
        spawnWorker();
      }, backoff);
    });

    worker.on("error", (err) => {
      daemonLog(`[Supervisor] Worker spawn error: ${err.message}`);
      currentWorker = null;
    });
  }

  // Spawn initial worker
  spawnWorker();

  // ─── Handle Supervisor Signals ─────────────────────────────

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    daemonLog(`[Supervisor] ${signal} received. Shutting down...`);

    const status = readStatus();
    if (status) {
      status.state = "stopped";
      writeStatus(status);
    }

    // Kill worker
    if (currentWorker && currentWorker.pid) {
      try {
        process.kill(currentWorker.pid, "SIGTERM");
      } catch {
        // Worker may already be dead
      }
    }

    removePid();

    // Give worker time to shut down, then exit
    setTimeout(() => {
      daemonLog("[Supervisor] Exiting.");
      process.exit(0);
    }, 2000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// ─── Daemon Control Commands ─────────────────────────────────

export function stopDaemon(): void {
  const pid = readPid();
  if (!pid) {
    console.log("❌ No agent daemon running (no PID file found).");
    process.exit(1);
  }

  if (!isProcessRunning(pid)) {
    console.log("⚠️  Daemon process not found (stale PID file). Cleaning up.");
    removePid();
    return;
  }

  console.log(`🛑 Stopping agent daemon (PID ${pid})...`);

  try {
    process.kill(pid, "SIGTERM");

    let attempts = 0;
    const checkInterval = setInterval(() => {
      attempts++;
      if (!isProcessRunning(pid) || attempts > 30) {
        clearInterval(checkInterval);
        if (isProcessRunning(pid)) {
          console.log("⚠️  Process didn't exit gracefully, force killing...");
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already dead
          }
        }
        removePid();
        console.log("✅ Agent daemon stopped.");
      }
    }, 200);
  } catch (e: any) {
    console.error(`❌ Failed to stop daemon: ${e.message}`);
    removePid();
  }
}

export function restartDaemon(options: {
  name?: string;
  server?: string;
  model?: string;
  prompt?: string;
  master?: string;
}): void {
  const pid = readPid();
  if (pid && isProcessRunning(pid)) {
    console.log("🛑 Stopping current daemon...");
    stopDaemon();
    setTimeout(() => {
      launchDaemon(options);
    }, 2000);
  } else {
    removePid();
    launchDaemon(options);
  }
}

export function daemonStatus(): void {
  const pid = readPid();
  const status = readStatus();

  if (!pid && !status) {
    console.log("❌ Agent daemon is not running.");
    return;
  }

  console.log("\n🤖 Agent Daemon Status:\n");

  if (pid) {
    const running = isProcessRunning(pid);
    console.log(`  Daemon PID:   ${pid} ${running ? "✅ Running" : "❌ Not running"}`);
  }

  if (status) {
    console.log(`  Worker PID:   ${status.pid || "N/A"}`);
    console.log(`  Supervisor:   ${status.supervisorPid}`);
    console.log(`  Started:      ${status.startedAt}`);
    console.log(`  Restarts:     ${status.restarts}`);
    if (status.lastRestartAt) {
      console.log(`  Last Restart: ${status.lastRestartAt}`);
    }
    console.log(`  State:        ${status.state}`);
  }

  const logFile = getLogFile();
  if (existsSync(logFile)) {
    const stat = statSync(logFile);
    console.log(`  Log Size:     ${(stat.size / 1024).toFixed(1)} KB`);
  }

  console.log();
}

export function daemonLogTail(lines: number = 30): void {
  const logFile = getLogFile();
  if (!existsSync(logFile)) {
    console.log("No log file found.");
    return;
  }

  try {
    const content = readFileSync(logFile, "utf-8");
    const allLines = content.trim().split("\n");
    const tail = allLines.slice(-lines);
    console.log(`\n📋 Last ${tail.length} log lines:\n`);
    tail.forEach((l) => console.log(`  ${l}`));
    console.log();
  } catch {
    console.log("Could not read log file.");
  }
}

// ─── Re-exports ──────────────────────────────────────────────

export {
  getPidFile,
  getLogFile,
  getErrorLogFile,
  getStatusFile,
  RUN_DIR,
};
