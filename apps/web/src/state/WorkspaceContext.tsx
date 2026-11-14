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
  NISHANTH_PUBLIC,
  WORKSPACE_STORAGE_KEY,
  type WorkspaceMode,
} from "../lib/workspaceIds";
import { useOwnerSession } from "./OwnerSession";
import { useProductSession } from "./ProductSession";
import {
  fetchMainnetAgent,
  fetchMainnetBalances,
  fetchMainnetDecisions,
  fetchMainnetMandate,
  fetchMainnetTransactions,
  sanitizeMandate,
  type MainnetBalances,
  type MainnetDecisionSummary,
  type MainnetMandate,
} from "../adapters/mainnetPublic";

const POLL_MS = 20_000;
const STALE_MS = 45_000;

export type WorkspaceLiveStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "stale";

export type WorkspaceIdentities = {
  owner: string | null;
  agent: string | null;
  policy: string | null;
  portfolio_id: string | null;
  network: "mainnet" | "testnet" | "unknown";
};

export type WorkspaceLiveData = {
  status: WorkspaceLiveStatus;
  lastUpdated: number | null;
  error: string | null;
  mandate: MainnetMandate | null;
  agent: Record<string, unknown> | null;
  decisions: MainnetDecisionSummary[];
  transactions: Awaited<ReturnType<typeof fetchMainnetTransactions>> | null;
  balances: MainnetBalances | null;
  refresh: () => Promise<void>;
};

type WorkspaceContextValue = {
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  isPublic: boolean;
  isPersonal: boolean;
  readOnly: boolean;
  identities: WorkspaceIdentities;
  /** Live mainnet feeds for Nishanth public workspace. Empty/null in personal. */
  live: WorkspaceLiveData;
  personalProvisioned: boolean;
  personalOwnerId: string | null;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

function readStoredMode(): WorkspaceMode {
  try {
    const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (raw === "personal" || raw === "nishanth_public") return raw;
  } catch {
    /* ignore */
  }
  return "nishanth_public";
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<WorkspaceMode>(() =>
    typeof window !== "undefined" ? readStoredMode() : "nishanth_public"
  );
  const { verified, session } = useOwnerSession();
  const { portfolio } = useProductSession();

  const setMode = useCallback((next: WorkspaceMode) => {
    setModeState(next);
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const isPublic = mode === "nishanth_public";
  const isPersonal = mode === "personal";
  const personalOwnerId =
    verified && session?.account_id ? session.account_id : null;
  const personalProvisioned = Boolean(
    isPersonal &&
      personalOwnerId &&
      portfolio?.owner_account === personalOwnerId &&
      portfolio?.portfolio_id
  );

  const identities: WorkspaceIdentities = useMemo(() => {
    if (isPublic) {
      return {
        owner: NISHANTH_PUBLIC.owner,
        agent: NISHANTH_PUBLIC.agent,
        policy: NISHANTH_PUBLIC.policy,
        portfolio_id: NISHANTH_PUBLIC.portfolio_id,
        network: "mainnet",
      };
    }
    if (personalProvisioned && portfolio) {
      return {
        owner: portfolio.owner_account ?? personalOwnerId,
        agent: portfolio.agent_account ?? null,
        policy: portfolio.policy_contract ?? null,
        portfolio_id: portfolio.portfolio_id ?? null,
        network: portfolio.network === "testnet" ? "testnet" : "unknown",
      };
    }
    return {
      owner: personalOwnerId,
      agent: null,
      policy: null,
      portfolio_id: null,
      network: "unknown",
    };
  }, [isPublic, personalProvisioned, portfolio, personalOwnerId]);

  const [liveStatus, setLiveStatus] = useState<WorkspaceLiveStatus>("idle");
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [mandate, setMandate] = useState<MainnetMandate | null>(null);
  const [agent, setAgent] = useState<Record<string, unknown> | null>(null);
  const [decisions, setDecisions] = useState<MainnetDecisionSummary[]>([]);
  const [transactions, setTransactions] = useState<Awaited<
    ReturnType<typeof fetchMainnetTransactions>
  > | null>(null);
  const [balances, setBalances] = useState<MainnetBalances | null>(null);

  const refresh = useCallback(async () => {
    if (!isPublic) return;
    setLiveStatus((s) => (s === "ready" || s === "stale" ? s : "loading"));
    const errs: string[] = [];
    let mandateOk = false;
    try {
      // Mandate first so upstream can warm RPC cache before other reads.
      try {
        const m = await fetchMainnetMandate();
        setMandate(
          m?.ok
            ? (sanitizeMandate(
                m as unknown as Record<string, unknown>
              ) as unknown as MainnetMandate)
            : m
        );
        mandateOk = Boolean(m?.ok);
        if (m?.stale || m?.data_quality === "LAST_KNOWN_GOOD") {
          errs.push("mandate:last_known_good");
        }
      } catch (e) {
        errs.push(`mandate:${e instanceof Error ? e.message : String(e)}`);
      }

      const [a, d, t, b] = await Promise.allSettled([
        fetchMainnetAgent(),
        fetchMainnetDecisions(40),
        fetchMainnetTransactions(),
        fetchMainnetBalances(),
      ]);

      if (a.status === "fulfilled" && a.value) setAgent(a.value);
      else if (a.status === "rejected")
        errs.push(`agent:${String((a.reason as Error)?.message || a.reason)}`);

      if (d.status === "fulfilled") setDecisions(d.value.decisions || []);
      else {
        errs.push(
          `decisions:${String((d.reason as Error)?.message || d.reason)}`
        );
        // Keep prior decisions on partial failure — do not wipe the page.
      }

      if (t.status === "fulfilled" && t.value) setTransactions(t.value);
      else if (t.status === "rejected")
        errs.push(`txs:${String((t.reason as Error)?.message || t.reason)}`);

      if (b.status === "fulfilled" && b.value) setBalances(b.value);
      else if (b.status === "rejected")
        errs.push(
          `balances:${String((b.reason as Error)?.message || b.reason)}`
        );

      setLiveError(errs.length ? errs.join(" · ") : null);
      setLastUpdated(Date.now());
      if (!mandateOk && errs.some((e) => e.startsWith("mandate:"))) {
        setLiveStatus("error");
      } else if (errs.length) {
        setLiveStatus("stale");
      } else {
        setLiveStatus("ready");
      }
    } catch (e) {
      setLiveError(e instanceof Error ? e.message : String(e));
      setLiveStatus((s) => (s === "ready" || s === "stale" ? "stale" : "error"));
    }
  }, [isPublic]);

  useEffect(() => {
    if (!isPublic) {
      setLiveStatus("idle");
      return;
    }
    void refresh();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onFocus = () => void refresh();
    const onVis = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [isPublic, refresh]);

  useEffect(() => {
    if (!isPublic || lastUpdated == null) return;
    const id = window.setInterval(() => {
      if (Date.now() - lastUpdated > STALE_MS) {
        setLiveStatus((s) => (s === "ready" ? "stale" : s));
      }
    }, 5_000);
    return () => window.clearInterval(id);
  }, [isPublic, lastUpdated]);

  const live: WorkspaceLiveData = useMemo(
    () => ({
      status: liveStatus,
      lastUpdated,
      error: liveError,
      mandate,
      agent,
      decisions,
      transactions,
      balances,
      refresh,
    }),
    [
      liveStatus,
      lastUpdated,
      liveError,
      mandate,
      agent,
      decisions,
      transactions,
      balances,
      refresh,
    ]
  );

  const value: WorkspaceContextValue = useMemo(
    () => ({
      mode,
      setMode,
      isPublic,
      isPersonal,
      readOnly: isPublic,
      identities,
      live,
      personalProvisioned,
      personalOwnerId,
    }),
    [
      mode,
      setMode,
      isPublic,
      isPersonal,
      identities,
      live,
      personalProvisioned,
      personalOwnerId,
    ]
  );

  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) {
    throw new Error("useWorkspace must be used within WorkspaceProvider");
  }
  return ctx;
}

export function formatLastUpdated(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString();
}
