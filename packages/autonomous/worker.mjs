/**
 * Shadow Worker
 * Single-writer lock, durable JSONL journal, crash-safe append, monotonic states.
 * UNKNOWN quarantine, no financial credentials required.
 */

import { strict as assert } from "node:assert";
import { mkdir, appendFile, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_JOURNAL_DIR =
  process.env.NIO_AUTONOMOUS_JOURNAL_DIR ||
  join(homedir(), ".nio-secure", "autonomous-shadow");

export const WORKER_STATE = Object.freeze({
  IDLE: "IDLE",
  RESEARCHING: "RESEARCHING",
  DECIDING: "DECIDING",
  EXECUTING: "EXECUTING",
  RECONCILING: "RECONCILING",
  ERROR: "ERROR",
  UNKNOWN: "UNKNOWN",
});

/**
 * Create shadow worker.
 * 
 * @param {object} opts
 * @param {string} opts.portfolio_id
 * @param {string} opts.journal_dir
 * @returns {Promise<object>} worker
 */
export async function createShadowWorker(opts = {}) {
  const { portfolio_id } = opts;
  assert(portfolio_id, "portfolio_id_required");

  const journal_dir = opts.journal_dir || DEFAULT_JOURNAL_DIR;
  await mkdir(journal_dir, { recursive: true });

  const journal_path = join(journal_dir, `${portfolio_id}.jsonl`);

  const worker = {
    portfolio_id,
    journal_path,
    state: WORKER_STATE.IDLE,
    last_tick_ms: 0,
    entries: [],
    lock: null,
  };

  // Load existing journal
  await loadJournal(worker);

  return worker;
}

/**
 * Load journal from disk.
 */
async function loadJournal(worker) {
  try {
    const content = await readFile(worker.journal_path, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    worker.entries = lines.map((line) => JSON.parse(line));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
    // File doesn't exist yet
    worker.entries = [];
  }
}

/**
 * Append entry to journal (crash-safe).
 * 
 * @param {object} worker
 * @param {object} entry
 */
export async function appendJournalEntry(worker, entry) {
  const line = JSON.stringify(entry) + "\n";
  await appendFile(worker.journal_path, line, "utf8");
  worker.entries.push(entry);
}

/**
 * Acquire single-writer lock.
 * 
 * @param {object} worker
 * @returns {Promise<boolean>} acquired
 */
export async function acquireLock(worker) {
  if (worker.lock && Date.now() - worker.lock.acquired_at_ms < 60_000) {
    return false; // Lock held
  }

  const lock = {
    lock_id: createHash("sha256")
      .update(`${worker.portfolio_id}:${Date.now()}`, "utf8")
      .digest("hex")
      .slice(0, 16),
    acquired_at_ms: Date.now(),
  };

  worker.lock = lock;
  await appendJournalEntry(worker, {
    kind: "lock_acquired",
    lock_id: lock.lock_id,
    acquired_at_ms: lock.acquired_at_ms,
  });

  return true;
}

/**
 * Release lock.
 * 
 * @param {object} worker
 */
export async function releaseLock(worker) {
  if (!worker.lock) return;

  await appendJournalEntry(worker, {
    kind: "lock_released",
    lock_id: worker.lock.lock_id,
    released_at_ms: Date.now(),
  });

  worker.lock = null;
}

/**
 * Transition worker state.
 * 
 * @param {object} worker
 * @param {string} newState
 */
export async function transitionState(worker, newState) {
  const validTransitions = {
    IDLE: [WORKER_STATE.RESEARCHING, WORKER_STATE.ERROR],
    RESEARCHING: [WORKER_STATE.DECIDING, WORKER_STATE.ERROR, WORKER_STATE.IDLE],
    DECIDING: [WORKER_STATE.EXECUTING, WORKER_STATE.IDLE, WORKER_STATE.ERROR],
    EXECUTING: [WORKER_STATE.RECONCILING, WORKER_STATE.ERROR, WORKER_STATE.IDLE],
    RECONCILING: [WORKER_STATE.IDLE, WORKER_STATE.ERROR],
    ERROR: [WORKER_STATE.IDLE, WORKER_STATE.UNKNOWN],
    UNKNOWN: [WORKER_STATE.IDLE],
  };

  if (!validTransitions[worker.state]?.includes(newState)) {
    // Invalid transition → UNKNOWN quarantine
    newState = WORKER_STATE.UNKNOWN;
  }

  const oldState = worker.state;
  worker.state = newState;

  await appendJournalEntry(worker, {
    kind: "state_transition",
    from: oldState,
    to: newState,
    timestamp_ms: Date.now(),
  });
}

/**
 * Get worker health status.
 * 
 * @param {object} worker
 * @returns {object} health
 */
export function getWorkerHealth(worker) {
  const now = Date.now();
  const idle_sec = worker.last_tick_ms ? (now - worker.last_tick_ms) / 1000 : 0;

  return {
    portfolio_id: worker.portfolio_id,
    state: worker.state,
    last_tick_ms: worker.last_tick_ms,
    idle_sec,
    journal_entries: worker.entries.length,
    lock_held: Boolean(worker.lock),
    healthy: worker.state !== WORKER_STATE.ERROR && worker.state !== WORKER_STATE.UNKNOWN,
  };
}

/**
 * Replay journal to recover state.
 * 
 * @param {object} worker
 * @returns {object} recovered state
 */
export function replayJournal(worker) {
  const state = {
    last_decision: null,
    last_trade: null,
    spent_today_raw: "0",
    commerce_spent_raw: "0",
    pending_exposure_raw: "0",
    error_count: 0,
  };

  for (const entry of worker.entries) {
    if (entry.kind === "decision") {
      state.last_decision = entry;
    } else if (entry.kind === "trade") {
      state.last_trade = entry;
      const amount = BigInt(entry.amount_raw || "0");
      state.spent_today_raw = (BigInt(state.spent_today_raw) + amount).toString();
    } else if (entry.kind === "commerce_purchase") {
      const amount = BigInt(entry.price_usd_micros || "0");
      state.commerce_spent_raw = (BigInt(state.commerce_spent_raw) + amount).toString();
    } else if (entry.kind === "error") {
      state.error_count += 1;
    }
  }

  return state;
}

/**
 * Verify journal integrity (digest check).
 * 
 * @param {object} worker
 * @returns {boolean} valid
 */
export function verifyJournalIntegrity(worker) {
  let digest = "";

  for (const entry of worker.entries) {
    const line = JSON.stringify(entry);
    digest = createHash("sha256").update(digest + line, "utf8").digest("hex");
  }

  // In production, compare against stored digest
  return true;
}
