/**
 * Durable commerce job lifecycle store (JSON file — OCI-friendly).
 * Persist operation_id BEFORE submitting a hire.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const JOB_STATES = Object.freeze([
  "DISCOVERED",
  "EVALUATED",
  "APPROVED",
  "PAYMENT_PENDING",
  "HIRED",
  "IN_PROGRESS",
  "DELIVERED",
  "ACCEPTED",
  "DISPUTED",
  "REFUNDED",
  "FAILED",
]);

export function openJobStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(
      path,
      JSON.stringify({ version: 1, jobs: [], updated_at: new Date().toISOString() }, null, 2)
    );
  }
  const api = {
    path,
    read() {
      return JSON.parse(readFileSync(path, "utf8"));
    },
    write(data) {
      data.updated_at = new Date().toISOString();
      writeFileSync(path, JSON.stringify(data, null, 2));
    },
    list() {
      return api.read().jobs || [];
    },
    get(operationId) {
      return api.list().find((j) => j.operation_id === operationId) || null;
    },
    getByMarketJobId(marketJobId) {
      return api.list().find((j) => j.market_job_id === marketJobId) || null;
    },
    create(partial) {
      const data = api.read();
      const operation_id =
        partial.operation_id ||
        createHash("sha256")
          .update(`${partial.agent_id}:${partial.brief_hash}:${randomBytes(8).toString("hex")}`)
          .digest("hex")
          .slice(0, 24);
      if ((data.jobs || []).some((j) => j.operation_id === operation_id)) {
        throw new Error("duplicate_operation_id");
      }
      const job = {
        operation_id,
        state: "DISCOVERED",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        agent_id: null,
        agent_handle: null,
        listing_url: null,
        market_job_id: null,
        hire_draft_id: null,
        brief: null,
        brief_hash: null,
        quoted_price_usdc: null,
        paid_amount_usdc: null,
        currency: "USDC",
        payment_rail: "marketplace_escrow",
        payment_status: null,
        delivery_hash: null,
        verification: null,
        receipt: null,
        tx_url: null,
        mock: false,
        ...partial,
      };
      data.jobs = data.jobs || [];
      data.jobs.push(job);
      api.write(data);
      return job;
    },
    update(operationId, patch) {
      const data = api.read();
      const idx = (data.jobs || []).findIndex((j) => j.operation_id === operationId);
      if (idx < 0) throw new Error("job_not_found");
      if (patch.state && !JOB_STATES.includes(patch.state)) {
        throw new Error(`invalid_state:${patch.state}`);
      }
      data.jobs[idx] = {
        ...data.jobs[idx],
        ...patch,
        updated_at: new Date().toISOString(),
      };
      api.write(data);
      return data.jobs[idx];
    },
  };
  return api;
}
