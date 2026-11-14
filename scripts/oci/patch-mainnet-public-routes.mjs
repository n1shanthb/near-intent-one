#!/usr/bin/env node
/**
 * Idempotent patch: add public /mainnet/* reads to OCI's sparse api-server.mjs
 * without replacing the whole file.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const target = process.argv[2] || "/home/opc/near-intent-one/packages/services/api-server.mjs";
let src = readFileSync(target, "utf8");

if (src.includes("mainnetPublicAudit.mjs")) {
  console.log(JSON.stringify({ ok: true, already_patched: true, target }));
  process.exit(0);
}

if (!existsSync("/home/opc/near-intent-one/packages/services/mainnetPublicAudit.mjs")) {
  console.error("mainnetPublicAudit.mjs missing");
  process.exit(1);
}
if (!existsSync("/home/opc/near-intent-one/packages/autonomous/decisionAudit.mjs")) {
  console.error("decisionAudit.mjs missing");
  process.exit(1);
}

const importBlock = `import {
  getLiveAgentSnapshot,
  getLiveMandateSnapshot,
  getLiveBalancesSnapshot,
  listDecisions,
  getDecision,
  getProof,
  listTransactions,
} from "./mainnetPublicAudit.mjs";
`;

// Insert import after loadServicesEnv import if present, else after first import block
if (src.includes('from "../gate-j/llm.mjs"')) {
  src = src.replace(
    /from "\.\.\/gate-j\/llm\.mjs";/,
    `from "../gate-j/llm.mjs";\n${importBlock}`
  );
} else {
  src = importBlock + src;
}

const publicFlag = `
  const isPublicMainnetRead =
    req.method === "GET" &&
    (path === "/mainnet/agent" ||
      path === "/mainnet/mandate" ||
      path === "/mainnet/decisions" ||
      path.startsWith("/mainnet/decisions/") ||
      path.startsWith("/mainnet/proof/") ||
      path === "/mainnet/transactions" ||
      path === "/mainnet/balances" ||
      path === "/mainnet/health");
`;

if (!src.includes("isPublicMainnetRead")) {
  src = src.replace(
    /const isHealth = req\.method === "GET" && path === "\/health";/,
    `const isHealth = req.method === "GET" && path === "/health";${publicFlag}`
  );
}

// Widen auth bypass
src = src.replace(
  /if \(!isHealth && !isGateJPublicHealth && !isGateKPublicHealth\) \{/,
  `if (!isHealth && !isGateJPublicHealth && !isGateKPublicHealth && !isPublicMainnetRead) {`
);
src = src.replace(
  /if \(\s*!isHealth &&\s*!isGateJPublicHealth &&\s*!isGateKPublicHealth\s*\) \{/s,
  `if (!isHealth && !isGateJPublicHealth && !isGateKPublicHealth && !isPublicMainnetRead) {`
);

const handler = `
    if (isPublicMainnetRead) {
      if (path === "/mainnet/health") {
        return json(req, res, 200, {
          ok: true,
          network: "mainnet",
          service: "nio-mainnet-public-reads",
          note: "Read-only NEAR mainnet views + decision audit index",
        });
      }
      if (path === "/mainnet/agent") return json(req, res, 200, await getLiveAgentSnapshot());
      if (path === "/mainnet/mandate") return json(req, res, 200, await getLiveMandateSnapshot());
      if (path === "/mainnet/decisions") {
        const limit = Number(url.searchParams.get("limit") || 40);
        return json(req, res, 200, await listDecisions(Math.min(100, limit)));
      }
      if (path.startsWith("/mainnet/decisions/")) {
        const cycle_id = decodeURIComponent(path.slice("/mainnet/decisions/".length));
        const detail = await getDecision(cycle_id);
        return json(req, res, detail.ok ? 200 : 404, detail);
      }
      if (path.startsWith("/mainnet/proof/")) {
        const cycle_id = decodeURIComponent(path.slice("/mainnet/proof/".length));
        const proof = await getProof(cycle_id);
        return json(req, res, proof.ok ? 200 : 404, proof);
      }
      if (path === "/mainnet/transactions") return json(req, res, 200, await listTransactions());
      if (path === "/mainnet/balances") return json(req, res, 200, await getLiveBalancesSnapshot());
    }
`;

if (!src.includes("nio-mainnet-public-reads")) {
  src = src.replace(
    /try \{\s*\n\s*if \(isHealth\) \{/,
    `try {\n${handler}\n    if (isHealth) {`
  );
}

writeFileSync(target, src);
console.log(JSON.stringify({ ok: true, patched: true, target, bytes: src.length }));
