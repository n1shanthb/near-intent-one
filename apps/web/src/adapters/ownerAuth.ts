/**
 * Owner authentication client — dedicated /api/owner-auth gateway only.
 * Never uses the public demo BFF allowlist. Never sends GATE_I_API_KEY.
 */
import { bytesToBase64, ledgerNep413ApduPayload, nonceFromBase64 } from "../lib/nep413";
import {
  DEFAULT_DERIVATION_PATH,
  LedgerClient,
  isLedgerSupported,
  mapLedgerError,
} from "../ledger/ledgerClient";
import { fullAccessKeys, viewAccessKeyList } from "../ledger/rpc";

export type OwnerChallenge = {
  scheme: "nep413";
  challenge_id: string;
  account_id: string;
  recipient: string;
  domain: string;
  network: string;
  nonce: string;
  nonce_encoding: string;
  callback_url: string | null;
  issued_at: string;
  expires_at: string;
  message: string;
  wallet_sign_message?: {
    message: string;
    recipient: string;
    nonce: string;
    callbackUrl?: string;
  };
};

export type OwnerSessionInfo = {
  ok: boolean;
  account_id?: string;
  session_id?: string;
  domain?: string;
  public_key?: string;
  expires_at?: string;
  reason?: string;
  scheme?: string;
  cookie?: boolean;
};

const gateway = (action: string) => `/api/owner-auth/${action}`;
const CSRF_COOKIE = "nio_owner_csrf";

function readBrowserCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

/** Ensure CSRF cookie exists (GET session mints one even when unauthenticated). */
export async function ensureOwnerCsrf(): Promise<void> {
  if (readBrowserCookie(CSRF_COOKIE)) return;
  await fetch(gateway("session"), { credentials: "include" }).catch(() => undefined);
}

async function postJson<T>(
  action: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: T & Record<string, unknown> }> {
  await ensureOwnerCsrf();
  const csrf = readBrowserCookie(CSRF_COOKIE);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (csrf) headers["x-nio-owner-csrf"] = csrf;
  const res = await fetch(gateway(action), {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & Record<string, unknown>;
  return { ok: res.ok, status: res.status, data };
}

export type OwnerErrorKind =
  | "webhid_unsupported"
  | "permission_rejected"
  | "near_app_closed"
  | "app_version_unsupported"
  | "account_not_found"
  | "full_access_missing"
  | "signature_rejected"
  | "session_expired"
  | "upstream_down"
  | "secret_misconfigured"
  | "generic";

export function classifyOwnerError(message: string): {
  kind: OwnerErrorKind;
  title: string;
  recovery: string;
} {
  const m = message.toLowerCase();
  if (/webhid unsupported|hid.*not/.test(m)) {
    return {
      kind: "webhid_unsupported",
      title: "Browser does not support WebHID",
      recovery: "Use Chrome or Edge on a desktop USB connection.",
    };
  }
  if (/access denied|user cancelled|denied by the user|no device selected/.test(m)) {
    return {
      kind: "permission_rejected",
      title: "Device permission rejected",
      recovery: "Re-click Connect Ledger and allow the browser HID prompt.",
    };
  }
  if (/not open|0x6e00|0x6d00|0x6e01|bootloader|dashboard/.test(m)) {
    return {
      kind: "near_app_closed",
      title: "NEAR app is not open",
      recovery: "Unlock the Ledger, open the NEAR app home screen, then reconnect.",
    };
  }
  if (/cannot sign nep-413|≥2\.1|app .*cannot sign/.test(m)) {
    return {
      kind: "app_version_unsupported",
      title: "NEAR app version too old for NEP-413",
      recovery: "Update the NEAR Ledger app to 2.1 or newer in Ledger Live, then retry.",
    };
  }
  if (/public_key_not_on_account|account not found|no account/.test(m)) {
    return {
      kind: "account_not_found",
      title: "Account or key not found",
      recovery:
        "Confirm the NEAR testnet account id and that this Ledger FullAccess key is on that account.",
    };
  }
  if (/full_access_key_required|functioncall-limited/.test(m)) {
    return {
      kind: "full_access_missing",
      title: "FullAccess key required",
      recovery:
        "A FunctionCall-limited key cannot prove owner authority. Add this Ledger key as FullAccess.",
    };
  }
  if (/reject|0x6985|conditions of use/.test(m)) {
    return {
      kind: "signature_rejected",
      title: "NEP-413 signature rejected on device",
      recovery: "Ownership was not verified. Re-run Verify and approve the message on the Ledger.",
    };
  }
  if (/session_expired|challenge_expired|no_owner_session/.test(m)) {
    return {
      kind: "session_expired",
      title: "Owner session expired",
      recovery: "Connect Ledger and verify ownership again to refresh the session.",
    };
  }
  if (/upstream_|fetch failed|timeout|unreachable/.test(m)) {
    return {
      kind: "upstream_down",
      title: "Owner API temporarily unreachable",
      recovery: "The public demo still works. Retry owner auth when the API host recovers.",
    };
  }
  if (/owner_auth_secret/.test(m)) {
    return {
      kind: "secret_misconfigured",
      title: "Owner gateway not configured",
      recovery: "Server is missing NIO_OWNER_AUTH_SECRET. Public demo remains available.",
    };
  }
  return {
    kind: "generic",
    title: "Owner authentication failed",
    recovery: "Review the detail below, then reconnect and retry.",
  };
}

export function ownerAuthDomain(): string {
  if (typeof window === "undefined") return "near-intent-one.vercel.app";
  return window.location.hostname || "near-intent-one.vercel.app";
}

export async function requestOwnerChallenge(
  accountId: string
): Promise<OwnerChallenge> {
  const res = await postJson<{ ok?: boolean; challenge?: OwnerChallenge; reason?: string }>(
    "challenge",
    { account_id: accountId, domain: ownerAuthDomain() }
  );
  if (!res.ok || !res.data.ok || !res.data.challenge) {
    throw new Error(
      typeof res.data.reason === "string"
        ? res.data.reason
        : `challenge_failed_${res.status}`
    );
  }
  if (res.data.challenge.scheme !== "nep413") {
    throw new Error("server_challenge_not_nep413");
  }
  return res.data.challenge;
}

export async function verifyOwnerChallenge(input: {
  challenge_id: string;
  account_id: string;
  public_key: string;
  signature: string;
}): Promise<OwnerSessionInfo> {
  const res = await postJson<{ ok?: boolean; session?: OwnerSessionInfo; reason?: string }>(
    "verify",
    {
      ...input,
      domain: ownerAuthDomain(),
      recipient: ownerAuthDomain(),
    }
  );
  if (!res.ok || !res.data.ok || !res.data.session) {
    throw new Error(
      typeof res.data.reason === "string"
        ? res.data.reason
        : `verify_failed_${res.status}`
    );
  }
  const { ok: _ok, ...rest } = res.data.session as OwnerSessionInfo & {
    ok?: boolean;
  };
  return { ok: true, ...rest };
}

export async function fetchOwnerSession(): Promise<OwnerSessionInfo> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const res = await fetch(gateway("session"), {
      credentials: "include",
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as OwnerSessionInfo;
    if (!res.ok) return { ok: false, reason: data.reason || `HTTP_${res.status}` };
    const { ok: _ok, ...rest } = data;
    return { ok: true, ...rest };
  } catch (e) {
    const aborted = e instanceof Error && /abort/i.test(e.message);
    return {
      ok: false,
      reason: aborted ? "session_check_timeout" : "session_check_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function logoutOwnerSession(): Promise<void> {
  await fetch(gateway("logout"), {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

export async function lookupOwnerPortfolio(ownerAccount: string): Promise<{
  status: string;
  reason?: string;
  portfolio?: Record<string, unknown>;
  next_action?: string;
  owner_authenticated?: boolean;
}> {
  const res = await postJson<{
    status?: string;
    reason?: string;
    portfolio?: Record<string, unknown>;
    next_action?: string;
    owner_authenticated?: boolean;
  }>("portfolios", {
    owner_account: ownerAccount,
    auth_mode: "ledger",
  });
  return {
    status: String(res.data.status || (res.ok ? "unknown" : "blocked")),
    reason: res.data.reason,
    portfolio: res.data.portfolio,
    next_action: res.data.next_action,
    owner_authenticated: res.data.owner_authenticated,
  };
}

/** Resolve NEAR accounts that hold this FullAccess public key (FastNear testnet). */
export async function discoverAccountsForKey(
  publicKey: string
): Promise<string[]> {
  const pk = publicKey.startsWith("ed25519:")
    ? publicKey
    : `ed25519:${publicKey}`;
  const url = `https://test.api.fastnear.com/v0/public_key/${encodeURIComponent(pk)}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { account_ids?: string[] };
    return Array.isArray(data.account_ids) ? data.account_ids : [];
  } catch {
    return [];
  }
}

export type LedgerOwnerConnectResult = {
  client: LedgerClient;
  derivationPath: string;
  publicKey: string;
  appVersion: string;
  accounts: string[];
};

export async function connectLedgerForOwner(
  derivationPath = DEFAULT_DERIVATION_PATH
): Promise<LedgerOwnerConnectResult> {
  if (!isLedgerSupported()) {
    throw new Error("WebHID unsupported — use Chrome or Edge on desktop.");
  }
  const client = new LedgerClient();
  try {
    await client.connect();
    const appVersion = await client.getVersion();
    const rawPk = await client.getPublicKey(derivationPath);
    const publicKey = rawPk.startsWith("ed25519:") ? rawPk : `ed25519:${rawPk}`;
    const accounts = await discoverAccountsForKey(publicKey);
    return { client, derivationPath, publicKey, appVersion, accounts };
  } catch (e) {
    await client.disconnect().catch(() => undefined);
    throw new Error(mapLedgerError(e));
  }
}

/**
 * Full challenge → physical Ledger NEP-413 sign → verify → HttpOnly session cookie.
 * Stops at the device prompt for user approval. No transactions are broadcast.
 */
export async function authenticateOwnerWithLedger(input: {
  client: LedgerClient;
  accountId: string;
  publicKey: string;
  derivationPath: string;
  onPrompt?: (msg: string) => void;
}): Promise<OwnerSessionInfo> {
  const keys = await viewAccessKeyList(input.accountId);
  const fa = fullAccessKeys(keys);
  const normalized = input.publicKey.startsWith("ed25519:")
    ? input.publicKey
    : `ed25519:${input.publicKey}`;
  const onAccount = fa.some((k) => k.public_key === normalized);
  if (!onAccount) {
    const any = keys.some((k) => k.public_key === normalized);
    if (any) {
      throw new Error(
        "full_access_key_required — this Ledger key is FunctionCall-limited on the account and cannot prove owner authority."
      );
    }
    throw new Error(
      "public_key_not_on_account — add this Ledger FullAccess key to the NEAR account first."
    );
  }

  input.onPrompt?.("Requesting owner challenge…");
  const challenge = await requestOwnerChallenge(input.accountId);
  const nonce = nonceFromBase64(challenge.nonce);
  const apdu = ledgerNep413ApduPayload({
    message: challenge.message,
    nonce,
    recipient: challenge.recipient,
    callbackUrl: challenge.callback_url,
  });

  input.onPrompt?.(
    "Approve the NEP-413 owner message on your Ledger (NEAR app). No transaction will be sent."
  );
  let signatureB64: string;
  try {
    const sig = await input.client.signNep413Message(apdu, input.derivationPath);
    signatureB64 = bytesToBase64(sig);
  } catch (e) {
    throw new Error(mapLedgerError(e));
  }

  input.onPrompt?.("Verifying signature with NIO…");
  return verifyOwnerChallenge({
    challenge_id: challenge.challenge_id,
    account_id: input.accountId,
    public_key: normalized,
    signature: signatureB64,
  });
}
