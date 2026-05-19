/**
 * Event bus with replay buffer (Goose pattern).
 *
 * Typed pub/sub for session events. Supports:
 * - Subscribe with replay (catch up on missed events)
 * - Cancellable "before" events (Pi pattern)
 * - JSON serialization for WebSocket/SSE push
 */

export interface ArkEvent {
  id: number;
  type: string;
  sessionId: string;
  stage?: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type EventHandler = (event: ArkEvent) => void | Promise<void>;
export type BeforeHandler = (event: ArkEvent) => { cancelled: boolean; reason?: string } | void;

const REPLAY_BUFFER_SIZE = 512;

// Cross-process fan-out. Emitters (report-pipeline, hook-status, rollback)
// run on the temporal-worker process; subscribers (SSE fan-out in web.ts,
// the live session-tree WS in conductor/handlers/session.ts) run on the
// control-plane process. In a multi-pod / multi-replica deploy these are
// different processes, so an in-process EventEmitter never crosses. When a
// redisUrl is configured every emit is also PUBLISHed to this channel and
// every process SUBSCRIBES and re-dispatches into its local handlers.
const REDIS_EVENT_CHANNEL = "ark:eventbus";

interface RedisEnvelope {
  origin: string;
  event: ArkEvent;
}

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private beforeHandlers = new Map<string, Set<BeforeHandler>>();
  private buffer: ArkEvent[] = [];
  private seq = 0;

  // Cross-process transport. `null` until attachRedis() runs (redisUrl
  // unset -> pure in-process, the local/dev path stays untouched).
  private redis: import("./hosted/redis-pubsub.js").RedisPubSub | null = null;
  // Per-process identity. An envelope tagged with our own origin is one we
  // just published -- ignore it so emit -> publish -> subscribe -> emit
  // can't form an infinite loop across the pub/sub round-trip.
  private readonly origin = `eb-${Math.random().toString(36).slice(2)}-${process.pid}`;

  /**
   * Make this bus cross-process via Redis pub/sub. Idempotent. Called once
   * per process from AppContext.boot() when config.redisUrl is set; both the
   * temporal-worker and the control-plane go through boot(), so emitters and
   * subscribers in different pods now share one logical bus. Best-effort:
   * a Redis failure must not break the in-process path.
   */
  async attachRedis(redisUrl: string): Promise<void> {
    if (this.redis) return;
    const { RedisPubSub } = await import("./hosted/redis-pubsub.js");
    const bus = new RedisPubSub(redisUrl);
    await bus.connect();
    await bus.subscribe(REDIS_EVENT_CHANNEL, (message) => {
      let env: RedisEnvelope;
      try {
        env = JSON.parse(message) as RedisEnvelope;
      } catch {
        return;
      }
      // Skip our own publishes (loop guard) and malformed payloads.
      if (!env || env.origin === this.origin || !env.event) return;
      this.dispatchLocal(env.event);
    });
    this.redis = bus;
  }

  async detachRedis(): Promise<void> {
    const bus = this.redis;
    this.redis = null;
    if (bus) await bus.disconnect();
  }

  /**
   * Run an event through the local replay buffer + handlers. Shared by
   * emit() (locally originated) and the Redis subscriber (remote-originated)
   * so semantics are identical and remote events are NOT re-published
   * (only emit() publishes).
   */
  private dispatchLocal(event: ArkEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > REPLAY_BUFFER_SIZE) {
      this.buffer = this.buffer.slice(-REPLAY_BUFFER_SIZE);
    }
    for (const handler of this.handlers.get(event.type) ?? []) {
      try {
        handler(event);
      } catch (e) {
        console.error(`Handler error for ${event.type}:`, e);
      }
    }
    for (const handler of this.handlers.get("*") ?? []) {
      try {
        handler(event);
      } catch (e) {
        console.error(`Wildcard handler error:`, e);
      }
    }
  }

  /** Subscribe to events. Returns unsubscribe function. */
  on(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  /** Subscribe to all events */
  onAll(handler: EventHandler): () => void {
    return this.on("*", handler);
  }

  /** Subscribe to "before" events (cancellable) */
  before(type: string, handler: BeforeHandler): () => void {
    if (!this.beforeHandlers.has(type)) this.beforeHandlers.set(type, new Set());
    this.beforeHandlers.get(type)!.add(handler);
    return () => this.beforeHandlers.get(type)?.delete(handler);
  }

  /** Emit an event. Returns false if cancelled by a before handler. */
  emit(type: string, sessionId: string, data?: { stage?: string; data?: Record<string, unknown> }): boolean {
    // Check before handlers
    const beforeEvent: ArkEvent = {
      id: 0,
      type,
      sessionId,
      stage: data?.stage,
      data: data?.data,
      timestamp: new Date().toISOString(),
    };

    for (const handler of this.beforeHandlers.get(type) ?? []) {
      try {
        const result = handler(beforeEvent) as { cancelled: boolean } | void;
        if (result && result.cancelled) return false;
      } catch (e) {
        console.error(`Before handler error for ${type}:`, e);
      }
    }

    // Create event with sequence ID
    const event: ArkEvent = { ...beforeEvent, id: ++this.seq };

    this.dispatchLocal(event);

    // Fan out to other processes. Tagged with our origin so the subscriber
    // on this process drops the echo instead of re-dispatching it.
    if (this.redis) {
      const envelope: RedisEnvelope = { origin: this.origin, event };
      this.redis.publish(REDIS_EVENT_CHANNEL, JSON.stringify(envelope));
    }

    return true;
  }

  /** Get replay events since a sequence ID (for reconnecting clients) */
  replay(sinceId: number): ArkEvent[] {
    return this.buffer.filter((e) => e.id > sinceId);
  }

  /** Clear all handlers */
  clear(): void {
    this.handlers.clear();
    this.beforeHandlers.clear();
  }
}

export const eventBus = new EventBus();
