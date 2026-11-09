#!/usr/bin/env node
import { readFileSync } from "node:fs";
const RPC = process.env.NEAR_RPC || "https://test.rpc.fastnear.com";
const owner = JSON.parse(readFileSync(new URL("../../evidence/live/gate-c-evidence.json", import.meta.url))).accounts.owner.account_id;
const j = await fetch(RPC, { method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"query", params:{ request_type:"view_access_key_list", finality:"final", account_id: owner }})}).then(r=>r.json());
console.log(JSON.stringify({ owner, keys: j.result?.keys }, null, 2));
