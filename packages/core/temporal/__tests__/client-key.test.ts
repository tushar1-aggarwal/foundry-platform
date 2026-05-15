import { test, expect } from "bun:test";
import { temporalClientKey } from "../client.js";

test("temporalClientKey is distinct per namespace at the same address", () => {
  const a = temporalClientKey({ serverUrl: "localhost:7233", namespace: "tenant-a" });
  const b = temporalClientKey({ serverUrl: "localhost:7233", namespace: "tenant-b" });
  expect(a).not.toBe(b);
});

test("temporalClientKey is distinct per server at the same namespace", () => {
  const a = temporalClientKey({ serverUrl: "host-a:7233", namespace: "default" });
  const b = temporalClientKey({ serverUrl: "host-b:7233", namespace: "default" });
  expect(a).not.toBe(b);
});

test("temporalClientKey is stable for the same pair", () => {
  const a = temporalClientKey({ serverUrl: "localhost:7233", namespace: "default" });
  const b = temporalClientKey({ serverUrl: "localhost:7233", namespace: "default" });
  expect(a).toBe(b);
});
