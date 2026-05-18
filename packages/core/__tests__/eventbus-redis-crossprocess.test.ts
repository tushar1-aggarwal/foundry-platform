/**
 * Cross-process delivery proof for the Redis-backed eventBus + SSE bus.
 *
 * Models the deployed multi-pod topology: emitters run on the
 * temporal-worker process, subscribers on the control-plane process. These
 * are SEPARATE EventBus instances (separate processes). This test stands up
 * two independent EventBus/RedisSSEBus instances against ONE in-process
 * Redis broker fake and asserts an emit on instance A reaches instance B's
 * onAll subscriber -- the core multi-process correctness claim. It also
 * proves the origin-tag loop guard (A's own subscriber must NOT re-receive
 * its own publish) and the redisUrl-unset in-process fallback.
 *
 * The broker is an in-process double of the exact `redis` v5 surface the
 * transport uses (connect/publish/subscribe/quit); no live Redis server.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus, type ArkEvent } from "../hooks.js";
import { _setRedisClientFactory, type RedisPubSubClient } from "../hosted/redis-pubsub.js";
import { RedisSSEBus } from "../hosted/sse-redis.js";

// ── In-process Redis pub/sub broker double ──────────────────────────────────

class Broker {
  private subs = new Map<string, Set<(m: string) => void>>();
  publish(channel: string, message: string): void {
    for (const cb of this.subs.get(channel) ?? []) cb(message);
  }
  subscribe(channel: string, cb: (m: string) => void): void {
    if (!this.subs.has(channel)) this.subs.set(channel, new Set());
    this.subs.get(channel)!.add(cb);
  }
}

function makeFactory(broker: Broker) {
  return (_url: string): RedisPubSubClient => ({
    connect: async () => {},
    publish: (channel, message) => {
      broker.publish(channel, message);
      return 1;
    },
    subscribe: async (channel, listener) => {
      broker.subscribe(channel, listener);
    },
    quit: async () => {},
  });
}

const ev = (type: string, sessionId: string): Parameters<EventBus["emit"]> =>
  [type, sessionId, { data: { k: 1 } }] as const as Parameters<EventBus["emit"]>;

describe("eventBus Redis cross-process transport", () => {
  let broker: Broker;

  beforeEach(() => {
    broker = new Broker();
    _setRedisClientFactory(makeFactory(broker));
  });
  afterEach(() => {
    _setRedisClientFactory();
  });

  it("delivers an event emitted on bus A to a subscriber on bus B (different processes)", async () => {
    const busA = new EventBus(); // temporal-worker process
    const busB = new EventBus(); // control-plane process
    await busA.attachRedis("redis://fake");
    await busB.attachRedis("redis://fake");

    const onB: ArkEvent[] = [];
    busB.onAll((e) => onB.push(e));

    busA.emit(...ev("session_updated", "s-1"));

    expect(onB).toHaveLength(1);
    expect(onB[0].type).toBe("session_updated");
    expect(onB[0].sessionId).toBe("s-1");

    await busA.detachRedis();
    await busB.detachRedis();
  });

  it("does NOT re-deliver an event back to the emitting process (origin-tag loop guard)", async () => {
    const busA = new EventBus();
    const busB = new EventBus();
    await busA.attachRedis("redis://fake");
    await busB.attachRedis("redis://fake");

    const onA: ArkEvent[] = [];
    const onB: ArkEvent[] = [];
    busA.onAll((e) => onA.push(e));
    busB.onAll((e) => onB.push(e));

    busA.emit(...ev("hook_status", "s-2"));

    // A's local handler fires exactly once (the direct dispatch). The Redis
    // echo of A's own publish is dropped by the origin guard -- no double.
    expect(onA).toHaveLength(1);
    // B receives it exactly once across the wire.
    expect(onB).toHaveLength(1);

    await busA.detachRedis();
    await busB.detachRedis();
  });

  it("preserves the in-process replay buffer for late local subscribers", async () => {
    const busA = new EventBus();
    await busA.attachRedis("redis://fake");
    busA.emit(...ev("session_created", "s-3"));
    const replayed = busA.replay(0);
    expect(replayed.map((e) => e.type)).toContain("session_created");
    await busA.detachRedis();
  });

  it("redisUrl unset: stays pure in-process (no transport attached)", () => {
    const bus = new EventBus(); // attachRedis never called
    const got: ArkEvent[] = [];
    bus.onAll((e) => got.push(e));
    bus.emit(...ev("session_updated", "s-4"));
    expect(got).toHaveLength(1);
  });

  it("RedisSSEBus crosses processes against the same broker", async () => {
    const a = new RedisSSEBus("redis://fake");
    const b = new RedisSSEBus("redis://fake");
    await a.connect();
    await b.connect();

    const received: Array<{ event: string; data: unknown }> = [];
    b.subscribe("sessions", (event, data) => received.push({ event, data }));

    a.publish("sessions", "update", { id: "s-9" });

    expect(received).toEqual([{ event: "update", data: { id: "s-9" } }]);

    await a.disconnect();
    await b.disconnect();
  });
});
