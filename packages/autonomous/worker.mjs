/**
 * Shadow / Autonomous Worker
 * Cross-process file lock, hash-chained JSONL journal, crash-safe append,
 * authoritative budget recovery, UNKNOWN quarantine.
 */

import { strict as assert } from "node:assert";
import {
  mkdir,
  appendFile,
  readFile,
  writeFile,
  unlink,
  rename,
  open,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_JOURNAL_DIR =
  process.env.NIO_AUTONOMOUS_JOURNAL_DIR ||
  join(homedir(), ".nio-secure", "autonomous-shadow");

export const GENESIS_HASH =
  "0000000000000000000000000000000000000000000000000000000000000000";

export const WORKER_STATE = Object.freeze({
  IDLE: "IDLE",
  RESEARCHING: "RESEARCHING",
  DECIDING: "DECIDING",
  EXECUTING: "EXECUTING",
  RECONCILING: "RECONCILING",
  ERROR: "ERROR",
  UNKNOWN: "UNKNOWN",
});

const LOCK_STALE_MS = Number(process.env.NIO_AUTONOMOUS_LOCK_STALE_MS || 120_000);

function hashLine(prevHash, entryWithoutHash) {
  const canonical = JSON.stringify(entryWithoutHash);
  return createHash("sha256")
    .update(`${prevHash}|${canonical}`, "utf8")
    .digest("hex");
}

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} opts
 * @param {string} opts.portfolio_id
 * @param {string} [opts.journal_dir]
 */
export async function createShadowWorker(opts = {}) {
  const { portfolio_id } = opts;
  assert(portfolio_id, "portfolio_id_required");

  const journal_dir = opts.journal_dir || DEFAULT_JOURNAL_DIR;
  await mkdir(journal_dir, { recursive: true });

  const journal_path = join(journal_dir, `${portfolio_id}.jsonl`);
  const lock_path = join(journal_dir, `${portfolio_id}.lock`);
  const budget_path = join(journal_dir, `${portfolio_id}.budget.json`);
  const tip_path = join(journal_dir, `${portfolio_id}.tip.json`);

  const worker = {
    portfolio_id,
    journal_dir,
    journal_path,
    lock_path,
    budget_path,
    tip_path,
    state: WORKER_STATE.IDLE,
    last_tick_ms: 0,
    entries: [],
    tip_hash: GENESIS_HASH,
    lock: null,
    unknown_blocks_spend: false,
  };

  await loadJournal(worker);
  await loadBudget(worker);

  const integrity = verifyJournalIntegrity(worker);
  if (!integrity.ok) {
    worker.state = WORKER_STATE.UNKNOWN;
    worker.unknown_blocks_spend = true;
  } else if (worker.budget?.unknown_outcome) {
    worker.state = WORKER_STATE.UNKNOWN;
    worker.unknown_blocks_spend = true;
  }

  return worker;
}

async function loadJournal(worker) {
  try {
    const content = await readFile(worker.journal_path, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    worker.entries = lines.map((line) => JSON.parse(line));
    if (worker.entries.length) {
      worker.tip_hash = worker.entries[worker.entries.length - 1].entry_hash || GENESIS_HASH;
    } else {
      worker.tip_hash = GENESIS_HASH;
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    worker.entries = [];
    worker.tip_hash = GENESIS_HASH;
  }
}

async function loadBudget(worker) {
  try {
    const raw = await readFile(worker.budget_path, "utf8");
    worker.budget = JSON.parse(raw);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    worker.budget = {
      day_key: utcDayKey(),
      spent_today_raw: "0",
      commerce_spent_raw: "0",
      pending_exposure_raw: "0",
      openrouter_spent_usd: 0,
      openrouter_requests_today: 0,
      recent_operation_sizes: [],
      unknown_outcome: false,
      last_reconciled_at_ms: null,
    };
  }
  // Roll daily counters
  const today = utcDayKey();
  if (worker.budget.day_key !== today) {
    worker.budget.day_key = today;
    worker.budget.spent_today_raw = "0";
    worker.budget.openrouter_spent_usd = 0;
    worker.budget.openrouter_requests_today = 0;
  }
}

export function utcDayKey(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Persist budget atomically (write temp + rename).
 */
export async function persistBudget(worker) {
  const tmp = `${worker.budget_path}.tmp`;
  const payload = JSON.stringify(worker.budget, null, 2);
  await writeFile(tmp, payload, "utf8");
  await rename(tmp, worker.budget_path);
}

/**
 * Append hash-chained journal entry (crash-safe append + tip update).
 */
export async function appendJournalEntry(worker, entry) {
  const seq = worker.entries.length;
  const prev_hash = worker.tip_hash || GENESIS_HASH;
  const base = {
    seq,
    prev_hash,
    kind: entry.kind || "event",
    timestamp_ms: entry.timestamp_ms ?? Date.now(),
    ...entry,
  };
  // entry_hash computed over everything except itself
  const { entry_hash: _drop, ...withoutHash } = base;
  const entry_hash = hashLine(prev_hash, withoutHash);
  const sealed = { ...withoutHash, entry_hash };

  const line = JSON.stringify(sealed) + "\n";
  await appendFile(worker.journal_path, line, "utf8");
  worker.entries.push(sealed);
  worker.tip_hash = entry_hash;

  const tipTmp = `${worker.tip_path}.tmp`;
  await writeFile(
    tipTmp,
    JSON.stringify({ tip_hash: entry_hash, seq, updated_at_ms: Date.now() }),
    "utf8"
  );
  await rename(tipTmp, worker.tip_path);

  return sealed;
}

/**
 * Cross-process exclusive lock via O_EXCL create.
 * @returns {Promise<boolean>}
 */
export async function acquireLock(worker) {
  if (worker.lock) return false;

  const payload = JSON.stringify({
    pid: process.pid,
    portfolio_id: worker.portfolio_id,
    acquired_at_ms: Date.now(),
    host: process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown",
  });

  try {
    const handle = await open(worker.lock_path, "wx");
    await handle.writeFile(payload, "utf8");
    await handle.close();
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Stale recovery
    let existing = null;
    try {
      existing = JSON.parse(await readFile(worker.lock_path, "utf8"));
    } catch {
      return false;
    }
    const age = Date.now() - Number(existing.acquired_at_ms || 0);
    const alive = isPidAlive(Number(existing.pid));
    if (alive && age < LOCK_STALE_MS) {
      return false;
    }
    // Steal stale lock
    try {
      await unlink(worker.lock_path);
    } catch {
      return false;
    }
    try {
      const handle = await open(worker.lock_path, "wx");
      await handle.writeFile(payload, "utf8");
      await handle.close();
    } catch {
      return false;
    }
  }

  worker.lock = {
    lock_id: createHash("sha256")
      .update(`${worker.portfolio_id}:${process.pid}:${Date.now()}`, "utf8")
      .digest("hex")
      .slice(0, 16),
    acquired_at_ms: Date.now(),
    pid: process.pid,
  };

  await appendJournalEntry(worker, {
    kind: "lock_acquired",
    lock_id: worker.lock.lock_id,
    pid: process.pid,
  });

  return true;
}

export async function releaseLock(worker) {
  if (!worker.lock) return;

  await appendJournalEntry(worker, {
    kind: "lock_released",
    lock_id: worker.lock.lock_id,
    pid: process.pid,
  });

  worker.lock = null;
  try {
    if (existsSync(worker.lock_path)) {
      const raw = await readFile(worker.lock_path, "utf8");
      const parsed = JSON.parse(raw);
      if (Number(parsed.pid) === process.pid) {
        await unlink(worker.lock_path);
      }
    }
  } catch {
    // best-effort
  }
}

export async function transitionState(worker, newState) {
  const validTransitions = {
    IDLE: [WORKER_STATE.RESEARCHING, WORKER_STATE.ERROR, WORKER_STATE.UNKNOWN],
    RESEARCHING: [WORKER_STATE.DECIDING, WORKER_STATE.ERROR, WORKER_STATE.IDLE, WORKER_STATE.UNKNOWN],
    DECIDING: [
      WORKER_STATE.EXECUTING,
      WORKER_STATE.RECONCILING,
      WORKER_STATE.IDLE,
      WORKER_STATE.ERROR,
      WORKER_STATE.UNKNOWN,
    ],
    EXECUTING: [
      WORKER_STATE.RECONCILING,
      WORKER_STATE.ERROR,
      WORKER_STATE.IDLE,
      WORKER_STATE.UNKNOWN,
    ],
    RECONCILING: [WORKER_STATE.IDLE, WORKER_STATE.ERROR, WORKER_STATE.UNKNOWN],
    ERROR: [WORKER_STATE.IDLE, WORKER_STATE.UNKNOWN],
    UNKNOWN: [WORKER_STATE.IDLE],
  };

  let target = newState;
  let invalid = false;
  if (!validTransitions[worker.state]?.includes(newState)) {
    // Invalid FSM edge → ERROR (not financial UNKNOWN).
    // Only markUnknownOutcome() may set unknown_blocks_spend.
    invalid = true;
    target = WORKER_STATE.ERROR;
  }

  const oldState = worker.state;
  worker.state = target;

  await appendJournalEntry(worker, {
    kind: "state_transition",
    from: oldState,
    to: target,
    invalid_transition_requested: invalid ? newState : undefined,
  });
}

export function getWorkerHealth(worker) {
  const now = Date.now();
  const idle_sec = worker.last_tick_ms ? (now - worker.last_tick_ms) / 1000 : 0;
  return {
    portfolio_id: worker.portfolio_id,
    state: worker.state,
    last_tick_ms: worker.last_tick_ms,
    idle_sec,
    journal_entries: worker.entries.length,
    tip_hash: worker.tip_hash,
    lock_held: Boolean(worker.lock),
    unknown_blocks_spend: Boolean(worker.unknown_blocks_spend),
    healthy: worker.state !== WORKER_STATE.ERROR && worker.state !== WORKER_STATE.UNKNOWN,
  };
}

export function replayJournal(worker) {
  const state = {
    last_decision: null,
    last_trade: null,
    spent_today_raw: "0",
    commerce_spent_raw: "0",
    pending_exposure_raw: "0",
    openrouter_spent_usd: 0,
    openrouter_requests_today: 0,
    recent_operation_sizes: [],
    error_count: 0,
    unknown_outcome: false,
  };

  for (const entry of worker.entries) {
    if (entry.kind === "decision") {
      state.last_decision = entry;
      if (typeof entry.openrouter_spent_usd === "number") {
        state.openrouter_spent_usd = entry.openrouter_spent_usd;
      }
      if (typeof entry.openrouter_requests_today === "number") {
        state.openrouter_requests_today = entry.openrouter_requests_today;
      }
    } else if (entry.kind === "trade") {
      state.last_trade = entry;
      const amount = BigInt(entry.amount_raw || "0");
      state.spent_today_raw = (BigInt(state.spent_today_raw) + amount).toString();
      state.recent_operation_sizes.push(String(entry.amount_raw || "0"));
      if (entry.outcome === "UNKNOWN") {
        state.unknown_outcome = true;
      }
    } else if (entry.kind === "commerce_purchase") {
      const amount = BigInt(entry.price_usd_micros || "0");
      state.commerce_spent_raw = (BigInt(state.commerce_spent_raw) + amount).toString();
    } else if (entry.kind === "error") {
      state.error_count += 1;
    } else if (entry.kind === "unknown_outcome") {
      state.unknown_outcome = true;
    }
  }

  // Durable budget overlays caps / LLM spend. Prefer the larger spend figures so
  // a partial journal rebuild cannot under-count vs an updated budget file (or vice versa).
  if (worker.budget) {
    const budSpend = BigInt(worker.budget.spent_today_raw || "0");
    const jSpend = BigInt(state.spent_today_raw || "0");
    state.spent_today_raw = (budSpend > jSpend ? budSpend : jSpend).toString();

    const budComm = BigInt(worker.budget.commerce_spent_raw || "0");
    const jComm = BigInt(state.commerce_spent_raw || "0");
    state.commerce_spent_raw = (budComm > jComm ? budComm : jComm).toString();

    const budPend = BigInt(worker.budget.pending_exposure_raw || "0");
    const jPend = BigInt(state.pending_exposure_raw || "0");
    state.pending_exposure_raw = (budPend > jPend ? budPend : jPend).toString();

    state.openrouter_spent_usd = Math.max(
      Number(worker.budget.openrouter_spent_usd || 0),
      Number(state.openrouter_spent_usd || 0)
    );
    state.openrouter_requests_today = Math.max(
      Number(worker.budget.openrouter_requests_today || 0),
      Number(state.openrouter_requests_today || 0)
    );
    if (
      Array.isArray(worker.budget.recent_operation_sizes) &&
      worker.budget.recent_operation_sizes.length >= state.recent_operation_sizes.length
    ) {
      state.recent_operation_sizes = worker.budget.recent_operation_sizes;
    }
    state.unknown_outcome = Boolean(
      worker.budget.unknown_outcome || state.unknown_outcome
    );
  }

  return state;
}

/**
 * Verify hash-chain integrity. Returns false when broken — never a placeholder PASS.
 * @returns {{ ok: boolean, broken_at: number|null, tip_hash: string, checked: number }}
 */
export function verifyJournalIntegrity(worker) {
  let prev = GENESIS_HASH;
  for (let i = 0; i < worker.entries.length; i++) {
    const entry = worker.entries[i];
    if (entry.prev_hash !== prev) {
      return { ok: false, broken_at: i, tip_hash: prev, checked: i, reason: "prev_hash_mismatch" };
    }
    if (typeof entry.seq === "number" && entry.seq !== i) {
      return { ok: false, broken_at: i, tip_hash: prev, checked: i, reason: "seq_mismatch" };
    }
    const { entry_hash, ...withoutHash } = entry;
    const expected = hashLine(prev, withoutHash);
    if (entry_hash !== expected) {
      return { ok: false, broken_at: i, tip_hash: prev, checked: i, reason: "entry_hash_mismatch" };
    }
    prev = entry_hash;
  }
  return { ok: true, broken_at: null, tip_hash: prev, checked: worker.entries.length };
}

/**
 * Mark financial outcome UNKNOWN — blocks further spending until reconciled.
 */
export async function markUnknownOutcome(worker, detail) {
  worker.unknown_blocks_spend = true;
  worker.budget.unknown_outcome = true;
  await persistBudget(worker);
  await transitionState(worker, WORKER_STATE.UNKNOWN);
  await appendJournalEntry(worker, {
    kind: "unknown_outcome",
    detail: detail || {},
  });
}

/**
 * Clear UNKNOWN only after independent reconciliation evidence.
 */
export async function clearUnknownAfterReconcile(worker, evidence) {
  assert(evidence?.independent === true, "independent_reconcile_evidence_required");
  assert(evidence?.verified === true, "verified_reconcile_required");
  worker.budget.unknown_outcome = false;
  worker.budget.last_reconciled_at_ms = Date.now();
  worker.unknown_blocks_spend = false;
  await persistBudget(worker);
  await appendJournalEntry(worker, {
    kind: "reconcile_cleared",
    evidence: {
      independent: true,
      verified: true,
      source: evidence.source || null,
      reference: evidence.reference || null,
    },
  });
  if (worker.state === WORKER_STATE.UNKNOWN) {
    await transitionState(worker, WORKER_STATE.IDLE);
  }
}
