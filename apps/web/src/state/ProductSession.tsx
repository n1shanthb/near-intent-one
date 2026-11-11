import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { gateIHealth } from "../adapters/gatei";
import type { AuthMode, GateIStatus, PortfolioRecord } from "../types/gateI";

type Session = {
  authMode: AuthMode | null;
  setAuthMode: (m: AuthMode | null) => void;
  portfolio: PortfolioRecord | null;
  setPortfolio: (p: PortfolioRecord | null) => void;
  /** Bound wallet owner — portfolios for other owners are never shown */
  boundOwner: string | null;
  /** Call on wallet connect / switch / disconnect to prevent cross-user leakage */
  syncOwner: (ownerAccount: string | null) => void;
  clearSession: () => void;
  gateI: { status: GateIStatus; detail: string; network?: string | null };
  refreshGateI: () => Promise<void>;
};

const Ctx = createContext<Session | null>(null);
const STORAGE_PREFIX = "nio.portfolio.v1:";
const AUTH_KEY = "nio.authMode.v1";
const LEGACY_KEY = "nio.portfolio.v1";

function storageKey(owner: string) {
  return `${STORAGE_PREFIX}${owner}`;
}

function readPortfolio(owner: string): PortfolioRecord | null {
  try {
    const raw = localStorage.getItem(storageKey(owner));
    if (!raw) return null;
    const p = JSON.parse(raw) as PortfolioRecord;
    if (p.owner_account && p.owner_account !== owner) return null;
    return p;
  } catch {
    return null;
  }
}

function writePortfolio(owner: string, p: PortfolioRecord | null) {
  if (!p) {
    localStorage.removeItem(storageKey(owner));
    return;
  }
  if (p.owner_account !== owner) return;
  localStorage.setItem(storageKey(owner), JSON.stringify(p));
}

export function ProductSessionProvider({ children }: { children: ReactNode }) {
  const [authMode, setAuthModeState] = useState<AuthMode | null>(() => {
    try {
      return (localStorage.getItem(AUTH_KEY) as AuthMode | null) ?? null;
    } catch {
      return null;
    }
  });
  const [boundOwner, setBoundOwner] = useState<string | null>(null);
  const [portfolio, setPortfolioState] = useState<PortfolioRecord | null>(null);
  const [gateI, setGateI] = useState<{
    status: GateIStatus;
    detail: string;
    network?: string | null;
  }>({
    status: "unavailable",
    detail: "Checking Gate I…",
    network: null,
  });

  // One-time: drop legacy single-slot cache that could leak across users
  useEffect(() => {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  const setAuthMode = (m: AuthMode | null) => {
    setAuthModeState(m);
    try {
      if (m) localStorage.setItem(AUTH_KEY, m);
      else localStorage.removeItem(AUTH_KEY);
    } catch {
      /* ignore */
    }
  };

  const setPortfolio = useCallback(
    (p: PortfolioRecord | null) => {
      if (p && boundOwner && p.owner_account !== boundOwner) {
        // Refuse binding another owner's portfolio into this session
        return;
      }
      setPortfolioState(p);
      if (boundOwner) writePortfolio(boundOwner, p);
    },
    [boundOwner]
  );

  const syncOwner = useCallback((ownerAccount: string | null) => {
    setBoundOwner(ownerAccount);
    if (!ownerAccount) {
      setPortfolioState(null);
      return;
    }
    setPortfolioState(readPortfolio(ownerAccount));
  }, []);

  const clearSession = useCallback(() => {
    if (boundOwner) writePortfolio(boundOwner, null);
    setPortfolioState(null);
    setBoundOwner(null);
    setAuthMode(null);
  }, [boundOwner]);

  const refreshGateI = useCallback(async () => {
    const h = await gateIHealth();
    setGateI({
      status: h.status,
      detail: h.detail,
      network: h.payload?.network ?? null,
    });
  }, []);

  useEffect(() => {
    void refreshGateI();
    const id = window.setInterval(() => void refreshGateI(), 30_000);
    return () => window.clearInterval(id);
  }, [refreshGateI]);

  const value = useMemo(
    () => ({
      authMode,
      setAuthMode,
      portfolio,
      setPortfolio,
      boundOwner,
      syncOwner,
      clearSession,
      gateI,
      refreshGateI,
    }),
    [
      authMode,
      portfolio,
      setPortfolio,
      boundOwner,
      syncOwner,
      clearSession,
      gateI,
      refreshGateI,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProductSession() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("ProductSessionProvider missing");
  return ctx;
}

/** Pure helper for tests — never mix owners in one cache slot */
export function __test_ownerStorageKey(owner: string) {
  return storageKey(owner);
}
