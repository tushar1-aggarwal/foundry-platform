/**
 * Per-session serialization mutex.
 *
 * The dispatch <-> report-driven-advance loop has two independent
 * concurrency origins for a single session:
 *
 *   1. session_created -> SessionDispatchListeners.kickDispatch -> dispatch
 *   2. agent report -> mediateStageHandoff -> advance -> dispatch(next stage)
 *
 * Without serialization these interleave: a fast/stub agent reports
 * "completed" while the stage's own dispatch (finalizeLaunch) is still in
 * flight, so the advance + next-stage dispatch races the running-write.
 * Observed symptoms: duplicate `prompt_sent`, scrambled event ordering,
 * finalizeLaunch's own "Session moved on during dispatch" guard firing,
 * sessions parked/blocked. This was the root cause behind the reverted
 * async-contract big-bang.
 *
 * Invariant enforced here: for a given sessionId, the dispatch-mutating
 * critical sections run mutually exclusive (FIFO). Different sessions run
 * fully in parallel.
 *
 * Acquire ONLY at the true concurrency origins (kickDispatch + the
 * external report->mediate entry points). Never inside `dispatch()` or
 * `mediate()` themselves -- their internal/recursive calls are already
 * within a held lock, and re-acquiring would deadlock this non-reentrant
 * mutex.
 */

const tails = new Map<string, Promise<unknown>>();

export async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(sessionId) ?? Promise.resolve();
  // Chain after whatever is currently queued for this session. The
  // `.catch` keeps a rejected predecessor from poisoning the chain.
  const run = prev.then(
    () => fn(),
    () => fn(),
  );
  // The tail is the settle of `run` (not its value/throw) so the next
  // waiter starts only after this critical section fully completes.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(sessionId, tail);
  // Best-effort cleanup so the Map doesn't grow unbounded: if no one
  // chained after us, drop the entry once we settle.
  void tail.then(() => {
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  });
  return run;
}
