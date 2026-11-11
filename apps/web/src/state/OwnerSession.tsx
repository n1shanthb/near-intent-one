/**
 * Owner session (Ledger NEP-413 verified). Session token lives in HttpOnly cookie
 * via /api/owner-auth — never in localStorage.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  fetchOwnerSession,
  logoutOwnerSession,
  type OwnerSessionInfo,
} from "../adapters/ownerAuth";
import type { LedgerClient } from "../ledger/ledgerClient";

export type OwnerDeviceState = {
  connected: boolean;
  appVersion: string | null;
  publicKey: string | null;
  derivationPath: string | null;
  accounts: string[];
  selectedAccount: string | null;
};

type OwnerCtx = {
  session: OwnerSessionInfo | null;
  refreshing: boolean;
  device: OwnerDeviceState;
  /** Live Ledger client while connected (not persisted). */
  ledgerClient: LedgerClient | null;
  setLedgerClient: (c: LedgerClient | null) => void;
  setDevice: (d: Partial<OwnerDeviceState>) => void;
  refreshSession: () => Promise<OwnerSessionInfo | null>;
  clearOwner: () => Promise<void>;
  verified: boolean;
};

const Ctx = createContext<OwnerCtx | null>(null);

const emptyDevice: OwnerDeviceState = {
  connected: false,
  appVersion: null,
  publicKey: null,
  derivationPath: null,
  accounts: [],
  selectedAccount: null,
};

export function OwnerSessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<OwnerSessionInfo | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [device, setDeviceState] = useState<OwnerDeviceState>(emptyDevice);
  const [ledgerClient, setLedgerClient] = useState<LedgerClient | null>(null);

  const setDevice = useCallback((partial: Partial<OwnerDeviceState>) => {
    setDeviceState((prev) => ({ ...prev, ...partial }));
  }, []);

  const refreshSession = useCallback(async () => {
    setRefreshing(true);
    try {
      const s = await fetchOwnerSession();
      if (s.ok && s.account_id) {
        setSession(s);
        return s;
      }
      setSession(null);
      return null;
    } catch {
      setSession(null);
      return null;
    } finally {
      setRefreshing(false);
    }
  }, []);

  const clearOwner = useCallback(async () => {
    try {
      await logoutOwnerSession();
    } catch {
      /* ignore */
    }
    setSession(null);
    if (ledgerClient) {
      await ledgerClient.disconnect().catch(() => undefined);
    }
    setLedgerClient(null);
    setDeviceState(emptyDevice);
  }, [ledgerClient]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const value = useMemo<OwnerCtx>(
    () => ({
      session,
      refreshing,
      device,
      ledgerClient,
      setLedgerClient,
      setDevice,
      refreshSession,
      clearOwner,
      verified: Boolean(session?.ok && session.account_id),
    }),
    [
      session,
      refreshing,
      device,
      ledgerClient,
      setDevice,
      refreshSession,
      clearOwner,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOwnerSession(): OwnerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOwnerSession outside provider");
  return ctx;
}

export function abbreviateKey(pk: string | null | undefined, head = 12, tail = 8): string {
  if (!pk) return "—";
  const s = pk.startsWith("ed25519:") ? pk.slice("ed25519:".length) : pk;
  if (s.length <= head + tail) return pk;
  return `ed25519:${s.slice(0, head)}…${s.slice(-tail)}`;
}
