/**
 * Pure-function tests for the Origin verification helpers.
 */
import { describe, it, expect } from "bun:test";
import { isStateChanging, isWebSocketUpgrade, verifyOriginForCookieAuth } from "../origin.js";

function reqWith(headers: Record<string, string>): Request {
  return new Request("https://example.com/", { headers });
}

describe("isStateChanging", () => {
  it("returns true for POST/PUT/PATCH/DELETE (any case)", () => {
    expect(isStateChanging("POST")).toBe(true);
    expect(isStateChanging("PUT")).toBe(true);
    expect(isStateChanging("PATCH")).toBe(true);
    expect(isStateChanging("DELETE")).toBe(true);
    expect(isStateChanging("post")).toBe(true);
    expect(isStateChanging("Patch")).toBe(true);
  });

  it("returns false for GET/HEAD/OPTIONS", () => {
    expect(isStateChanging("GET")).toBe(false);
    expect(isStateChanging("HEAD")).toBe(false);
    expect(isStateChanging("OPTIONS")).toBe(false);
  });

  it("returns false for unknown methods", () => {
    expect(isStateChanging("CONNECT")).toBe(false);
    expect(isStateChanging("")).toBe(false);
  });
});

describe("isWebSocketUpgrade", () => {
  it("returns true for Upgrade: websocket (any case)", () => {
    expect(isWebSocketUpgrade(reqWith({ Upgrade: "websocket" }))).toBe(true);
    expect(isWebSocketUpgrade(reqWith({ Upgrade: "WebSocket" }))).toBe(true);
    expect(isWebSocketUpgrade(reqWith({ Upgrade: "WEBSOCKET" }))).toBe(true);
  });

  it("returns false for missing Upgrade header", () => {
    expect(isWebSocketUpgrade(reqWith({}))).toBe(false);
  });

  it("returns false for non-websocket Upgrade values", () => {
    expect(isWebSocketUpgrade(reqWith({ Upgrade: "h2c" }))).toBe(false);
    expect(isWebSocketUpgrade(reqWith({ Upgrade: "" }))).toBe(false);
  });
});

describe("verifyOriginForCookieAuth", () => {
  const allowed = ["http://localhost:8420", "https://app.paytm.com"];

  it("returns true on exact match", () => {
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "http://localhost:8420" }), allowed)).toBe(true);
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "https://app.paytm.com" }), allowed)).toBe(true);
  });

  it("FAILS CLOSED: returns false on Origin mismatch", () => {
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "https://evil.com" }), allowed)).toBe(false);
  });

  it("FAILS CLOSED: returns false when Origin header is missing", () => {
    expect(verifyOriginForCookieAuth(reqWith({}), allowed)).toBe(false);
  });

  it("FAILS CLOSED: returns false on empty allowlist", () => {
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "http://localhost:8420" }), [])).toBe(false);
  });

  it("is port-sensitive: 8420 != 8421", () => {
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "http://localhost:8421" }), allowed)).toBe(false);
  });

  it("is scheme-sensitive: http != https", () => {
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "https://localhost:8420" }), allowed)).toBe(false);
  });

  it("does not normalize trailing slash", () => {
    expect(verifyOriginForCookieAuth(reqWith({ Origin: "http://localhost:8420/" }), allowed)).toBe(false);
  });
});
