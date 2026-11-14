/**
 * Autonomous package re-exports
 */

export {
  MODE,
  LLM_MODE,
  ACTION,
  REASON,
  createShadowAgent,
  runShadowTick,
} from "./shadowAgent.mjs";

export { mandateV1ToGateJ } from "./mandateAdapter.mjs";

export {
  discoverProviders,
  quoteService,
  matchMandate,
  checkCommerceBalance,
  reserveBudget,
  createPurchaseOp,
  confirmPayment,
  retrieveDelivery,
  verifyDelivery,
  storeReceipts,
  releaseOrReconcile,
} from "./agentMarket.mjs";

export {
  WORKER_STATE,
  GENESIS_HASH,
  createShadowWorker,
  appendJournalEntry,
  acquireLock,
  releaseLock,
  transitionState,
  replayJournal,
  getWorkerHealth,
  verifyJournalIntegrity,
  persistBudget,
  markUnknownOutcome,
  clearUnknownAfterReconcile,
} from "./worker.mjs";

export {
  simulateCycle,
  simulateCrashRestart,
} from "./simulateCycle.mjs";

export { runKeeperCycles } from "./keeper.mjs";

export {
  EXEC_MODE,
  planAutonomousExecution,
  extractFitterBoundAmount,
  revalidateAgainstChain,
  persistPreBroadcast,
  evaluateBroadcastAttempt,
  listOwnerApprovalDependencies,
  executeShadowPlan,
} from "./executorAdapter.mjs";

export {
  deterministicTradeScenario,
  runAutonomousExecution,
} from "./executionService.mjs";
