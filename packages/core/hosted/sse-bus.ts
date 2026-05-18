import { logInfo } from "../observability/structured-log.js";
import { RedisSSEBus } from "./sse-redis.js";
/**
 * SSE broadcast bus -- abstraction over the SSE publish/subscribe mechanism.
 *
 * Current implementation: in-memory EventEmitter-based (single process).
 * Future: RediSSEBus backed by Redis pub/sub for horizontal scaling.
 *
 * Usage:
 *   const bus = new InMemorySSEBus();
 *   const unsub = bus.subscribe("sessions", (event, data) => { ... });
 *   bus.publish("sessions", "update", { id: "s-123" });
 *   unsub(); // unsubscribe
 */

// ── Interface ──────────────────────────────────────────────────────────────

export interface SSEBus {
  /** Publish an event to a channel. */
  publish(channel: string, event: string, data: unknown): void;

  /** Subscribe to events on a channel. Returns an unsubscribe function. */
  subscribe(channel: string, callback: (event: string, data: unknown) => void): () => void;

  /** Get subscriber count for a channel (useful for diagnostics). */
  subscriberCount(channel: string): number;

  /** Remove all subscribers from all channels. */
  clear(): void;
}

// ── In-Memory Implementation ───────────────────────────────────────────────

type Listener = (event: string, data: unknown) => void;

export class InMemorySSEBus implements SSEBus {
  private _channels = new Map<string, Set<Listener>>();

  publish(channel: string, event: string, data: unknown): void {
    const listeners = this._channels.get(channel);
    if (!listeners) return;
    for (const listener of listeners) {
      try {
        listener(event, data);
      } catch {
        logInfo("web", "Don't let one bad listener break others");
      }
    }
  }

  subscribe(channel: string, callback: Listener): () => void {
    if (!this._channels.has(channel)) {
      this._channels.set(channel, new Set());
    }
    const listeners = this._channels.get(channel)!;
    listeners.add(callback);

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0) {
        this._channels.delete(channel);
      }
    };
  }

  subscriberCount(channel: string): number {
    return this._channels.get(channel)?.size ?? 0;
  }

  clear(): void {
    this._channels.clear();
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

/**
 * Create an SSE bus instance. Returns a RedisSSEBus (cross-process pub/sub)
 * when a redisUrl is provided, otherwise an InMemorySSEBus (local/dev).
 *
 * RedisSSEBus connects in the background -- the sync `startWebServer` path
 * needs no await; publishes before connect are queued and flushed. Pass a
 * `redisBus` to reuse a connection already built by the hosted bootstrap
 * instead of opening a second pair of connections.
 */
export function createSSEBus(config?: {
  redisUrl?: string;
  redisBus?: SSEBus & { connect?: () => Promise<void> };
}): SSEBus {
  if (config?.redisBus) {
    void config.redisBus.connect?.();
    return config.redisBus;
  }
  if (config?.redisUrl) {
    const bus = new RedisSSEBus(config.redisUrl);
    void bus.connect();
    return bus;
  }
  return new InMemorySSEBus();
}
