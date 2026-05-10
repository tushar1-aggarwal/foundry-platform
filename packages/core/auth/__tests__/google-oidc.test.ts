/**
 * verifyGoogleIdToken tests.
 *
 * Crypto / signature / JWKS verification is delegated to `jose` and not
 * re-tested here -- jose has its own ~thousand-test suite for that. These
 * tests exercise:
 *
 *   1. Defensive guards before jose is invoked (empty token, missing
 *      clientId).
 *   2. The library wrapper correctly returns null on jose-thrown errors
 *      rather than propagating exceptions.
 *
 * Positive-path verification (a real Google-signed token round-trip)
 * lives in the login-route integration tests where we can fake the JWKS
 * endpoint with a local key pair.
 */

import { describe, it, expect } from "bun:test";
import { verifyGoogleIdToken } from "../google-oidc.js";

const cfg = {
  clientId: "test-client.apps.googleusercontent.com",
  allowedDomains: ["paytm.com", "paytmpayments.com", "paytmmoney.com"],
};

describe("verifyGoogleIdToken", () => {
  it("returns null for empty token", async () => {
    expect(await verifyGoogleIdToken("", cfg)).toBeNull();
  });

  it("returns null when clientId is not configured", async () => {
    const result = await verifyGoogleIdToken("any.token.value", {
      clientId: null as any,
      allowedDomains: ["paytm.com"],
    });
    expect(result).toBeNull();
  });

  it("returns null when allowedDomains is empty", async () => {
    const result = await verifyGoogleIdToken("any.token.value", { clientId: "x", allowedDomains: [] });
    expect(result).toBeNull();
  });

  it("returns null for a malformed (non-JWT) string", async () => {
    expect(await verifyGoogleIdToken("not-a-jwt", cfg)).toBeNull();
  });

  it("returns null for a structurally-valid but unsigned token", async () => {
    // Header + payload, no signature. jose will reject (alg-confusion guard).
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: cfg.clientId,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        sub: "1234567890",
        email: "alice@paytm.com",
        email_verified: true,
        hd: "paytm.com",
      }),
    ).toString("base64url");
    const fake = `${header}.${payload}.`;
    expect(await verifyGoogleIdToken(fake, cfg)).toBeNull();
  });

  it("returns null for a token signed by an arbitrary key (not Google)", async () => {
    // RS256 token signed locally; signature won't match Google's JWKS.
    const { generateKeyPair, SignJWT } = await import("jose");
    const { privateKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({
      email: "alice@paytm.com",
      email_verified: true,
      hd: "paytm.com",
      name: "Alice",
    })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://accounts.google.com")
      .setAudience(cfg.clientId)
      .setSubject("1234567890")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);
    expect(await verifyGoogleIdToken(token, cfg)).toBeNull();
  });
});
