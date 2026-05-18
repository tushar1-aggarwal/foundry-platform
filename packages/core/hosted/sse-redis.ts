/**
 * Redis-backed SSE bus -- enables horizontal scaling across multiple
 * Ark control plane instances. Uses Redis pub/sub (via the shared
 * RedisPubSub wrapper) for cross-process event broadcasting.
 *
 * Connection is established lazily in the background on first use so the
 * sync `startWebServer` path can construct this without awaiting. Publishes
 * issued before the connection is up are queued and flushed on connect;
 * subscriptions are (re)registered once connected.
 */

import type { SSEBus } from "./sse-bus.js";
import { RedisPubSub } from "./redis-pubsub.js";
import { logInfo, logDebug, logWarn } from "../observability/structured-log.js";

type Listener = (event: string, data: unknown) => void;

export class RedisSSEBus implements SSEBus {
  private bus: RedisPubSub;
  private listeners = new Map<string, Set<Listener>>();
  private subscribedChannels = new Set<string>();
  private connected = false;
  private pending: Array<{ channel: string; event: string; data: unknown }> = [];
  private connectPromise: Promise<void> | null = null;

  constructor(redisUrl: string) {
    this.bus = new RedisPubSub(redisUrl);
  }

  /** Idempotent. Safe to call repeatedly; connects once. */
  async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      await this.bus.connect();
      this.connected = true;
      for (const channel of this.subscribedChannels) await this.wireChannel(channel);
      const queued = this.pending;
      this.pending = [];
      for (const p of queued) this.bus.publish(p.channel, JSON.stringify({ event: p.event, data: p.data }));
      logInfo("web", "RedisSSEBus connected");
    })();
    return this.connectPromise;
  }

  private async wireChannel(channel: string): Promise<void> {
    await this.bus.subscribe(channel, (message) => {
      try {
        const { event, data } = JSON.parse(message);
        for (const cb of this.listeners.get(channel) ?? []) {
          try {
            cb(event, data);
          } catch {
            logInfo("web", "Don't let one bad listener break others");
          }
        }
      } catch {
        logDebug("web", "Ignore malformed messages");
      }
    });
  }

  publish(channel: string, event: string, data: unknown): void {
    if (!this.connected) {
      this.pending.push({ channel, event, data });
      return;
    }
    this.bus.publish(channel, JSON.stringify({ event, data }));
  }

  subscribe(channel: string, callback: Listener): () => void {
    if (!this.listeners.has(channel)) this.listeners.set(channel, new Set());
    this.listeners.get(channel)!.add(callback);
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      if (this.connected) {
        this.wireChannel(channel).catch((e) =>
          logWarn("web", `RedisSSEBus subscribe failed channel=${channel}: ${(e as Error)?.message ?? e}`),
        );
      }
    }
    return () => {
      this.listeners.get(channel)?.delete(callback);
    };
  }

  subscriberCount(channel: string): number {
    return this.listeners.get(channel)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.bus.disconnect();
  }
}
