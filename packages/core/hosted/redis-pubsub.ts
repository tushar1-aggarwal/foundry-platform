/**
 * Minimal Redis pub/sub wrapper shared by the cross-process `eventBus`
 * (hooks.ts) and the Redis-backed SSE bus (sse-redis.ts). Wraps the two
 * dedicated connections Redis pub/sub requires (a publisher and a separate
 * subscriber -- a subscribed connection cannot issue other commands) behind
 * one connect/publish/subscribe/quit surface.
 *
 * The `redis` client factory is injectable so tests can stand up two
 * independent pub/sub instances against an in-process broker (no live Redis
 * server) and prove cross-"process" delivery + the loop guard.
 */

import { createClient } from "redis";
import { logDebug, logWarn } from "../observability/structured-log.js";

export interface RedisPubSubClient {
  connect(): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown> | unknown;
  subscribe(channel: string, listener: (message: string) => void): Promise<unknown> | unknown;
  quit(): Promise<unknown> | unknown;
}

export type RedisClientFactory = (redisUrl: string) => RedisPubSubClient;

const defaultFactory: RedisClientFactory = (url) => createClient({ url }) as unknown as RedisPubSubClient;

let factory: RedisClientFactory = defaultFactory;

/** Test seam: swap the redis client factory. Pass nothing to restore. */
export function _setRedisClientFactory(f?: RedisClientFactory): void {
  factory = f ?? defaultFactory;
}

export class RedisPubSub {
  private pub: RedisPubSubClient;
  private sub: RedisPubSubClient;
  private connected = false;

  constructor(redisUrl: string) {
    this.pub = factory(redisUrl);
    this.sub = factory(redisUrl);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.pub.connect();
    await this.sub.connect();
    this.connected = true;
  }

  /** Fire-and-forget publish. A pub/sub blip must never break the emitter. */
  publish(channel: string, message: string): void {
    try {
      const r = this.pub.publish(channel, message);
      if (r && typeof (r as Promise<unknown>).catch === "function") {
        (r as Promise<unknown>).catch((e) =>
          logWarn("web", `redis-pubsub publish failed channel=${channel}: ${(e as Error)?.message ?? e}`),
        );
      }
    } catch (e) {
      logWarn("web", `redis-pubsub publish threw channel=${channel}: ${(e as Error)?.message ?? e}`);
    }
  }

  async subscribe(channel: string, listener: (message: string) => void): Promise<void> {
    await this.sub.subscribe(channel, (message: string) => {
      try {
        listener(message);
      } catch (e) {
        logDebug("web", `redis-pubsub listener threw channel=${channel}: ${(e as Error)?.message ?? e}`);
      }
    });
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}
