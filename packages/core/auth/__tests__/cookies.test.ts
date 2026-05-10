/**
 * Cookie helper tests. Two read paths (auth-aware vs generic) and two
 * write paths (set / clear) plus the cookie-tossing fail-closed logic.
 */

import { describe, it, expect } from "bun:test";
import { getSessionCookie, getCookie, setSessionCookie, clearSessionCookie } from "../cookies.js";

function reqWithCookieHeader(value: string | null): Request {
  const headers = new Headers();
  if (value !== null) headers.set("cookie", value);
  return new Request("https://example.com/", { headers });
}

describe("getSessionCookie", () => {
  it("returns null when no cookie header is present", () => {
    expect(getSessionCookie(reqWithCookieHeader(null), "ark_session")).toBeNull();
  });

  it("returns null when the named cookie is absent", () => {
    expect(getSessionCookie(reqWithCookieHeader("other=foo; another=bar"), "ark_session")).toBeNull();
  });

  it("returns the value when the named cookie appears exactly once", () => {
    expect(getSessionCookie(reqWithCookieHeader("ark_session=ABC123"), "ark_session")).toBe("ABC123");
  });

  it("returns the value alongside other cookies", () => {
    expect(getSessionCookie(reqWithCookieHeader("locale=en; ark_session=XYZ; theme=dark"), "ark_session")).toBe("XYZ");
  });

  it("FAILS CLOSED: returns null when the named cookie appears twice (cookie-tossing attack signal)", () => {
    expect(getSessionCookie(reqWithCookieHeader("ark_session=A; ark_session=B"), "ark_session")).toBeNull();
  });

  it("FAILS CLOSED: returns null on interleaved duplicates (attacker mixed with other cookies)", () => {
    expect(getSessionCookie(reqWithCookieHeader("ark_session=A; locale=en; ark_session=B"), "ark_session")).toBeNull();
  });

  it("FAILS CLOSED: rejects three or more occurrences too", () => {
    expect(
      getSessionCookie(reqWithCookieHeader("ark_session=A; ark_session=B; ark_session=C"), "ark_session"),
    ).toBeNull();
  });

  it("is unaffected by duplicates of OTHER cookie names", () => {
    expect(getSessionCookie(reqWithCookieHeader("ark_session=KEEP; other=X; other=Y"), "ark_session")).toBe("KEEP");
  });

  it("does NOT prefix-match: 'ark_session_legacy=B' alongside 'ark_session=A' isn't a duplicate", () => {
    expect(getSessionCookie(reqWithCookieHeader("ark_session=A; ark_session_legacy=B"), "ark_session")).toBe("A");
  });

  it("ignores stray empty segments", () => {
    expect(getSessionCookie(reqWithCookieHeader(";; ark_session=X ;;"), "ark_session")).toBe("X");
  });

  it("handles values containing additional `=` characters (e.g. base64 padding)", () => {
    // Cookie syntax says the value runs up to the next `;`. Anything
    // after the FIRST `=` is the value, including more `=` characters.
    // The raw-segment scanner must split at the first `=` only.
    expect(getSessionCookie(reqWithCookieHeader("ark_session=a=b=c"), "ark_session")).toBe("a=b=c");
    expect(getSessionCookie(reqWithCookieHeader("ark_session=YWxpY2U=; theme=dark"), "ark_session")).toBe("YWxpY2U=");
  });

  it("preserves whitespace in segment trimming (per RFC 6265)", () => {
    // Browsers emit `name=v; name=v` with a single space after each
    // `;`. Our segment trim handles both with and without leading
    // whitespace.
    expect(getSessionCookie(reqWithCookieHeader("ark_session=X; theme=dark"), "ark_session")).toBe("X");
    expect(getSessionCookie(reqWithCookieHeader("ark_session=X;theme=dark"), "ark_session")).toBe("X");
    expect(getSessionCookie(reqWithCookieHeader("ark_session=X;   theme=dark"), "ark_session")).toBe("X");
  });
});

describe("getCookie (generic, NOT for auth)", () => {
  it("returns null when absent", () => {
    expect(getCookie(reqWithCookieHeader(null), "theme")).toBeNull();
    expect(getCookie(reqWithCookieHeader("locale=en"), "theme")).toBeNull();
  });

  it("returns the value for a single occurrence", () => {
    expect(getCookie(reqWithCookieHeader("theme=dark"), "theme")).toBe("dark");
  });

  it("collapses duplicates per cookie.parse() default (does NOT fail closed)", () => {
    // Generic ambiguity is acceptable for non-auth cookies. The exact
    // value returned is whichever the cookie package picks; we don't
    // assert which one, just that we return SOME value rather than null.
    const result = getCookie(reqWithCookieHeader("theme=A; theme=B"), "theme");
    expect(result).not.toBeNull();
    expect(["A", "B"]).toContain(result);
  });
});

describe("setSessionCookie", () => {
  it("emits HttpOnly + SameSite=Lax + Path=/", () => {
    const out = setSessionCookie({ name: "ark_session", value: "X", maxAgeSec: 3600, secure: true });
    expect(out.toLowerCase()).toContain("httponly");
    expect(out.toLowerCase()).toContain("samesite=lax");
    expect(out.toLowerCase()).toContain("path=/");
  });

  it("emits Secure when secure=true", () => {
    const out = setSessionCookie({ name: "ark_session", value: "X", maxAgeSec: 3600, secure: true });
    expect(out.toLowerCase()).toContain("secure");
  });

  it("omits Secure when secure=false (local HTTP dev)", () => {
    const out = setSessionCookie({ name: "ark_session", value: "X", maxAgeSec: 3600, secure: false });
    expect(out.toLowerCase()).not.toContain("secure");
  });

  it("includes Max-Age", () => {
    const out = setSessionCookie({ name: "ark_session", value: "X", maxAgeSec: 60, secure: false });
    expect(out.toLowerCase()).toContain("max-age=60");
  });

  it("includes Domain when provided, omits when null", () => {
    expect(
      setSessionCookie({
        name: "ark_session",
        value: "X",
        maxAgeSec: 60,
        secure: false,
        domain: ".paytm.com",
      }).toLowerCase(),
    ).toContain("domain=.paytm.com");
    expect(
      setSessionCookie({ name: "ark_session", value: "X", maxAgeSec: 60, secure: false, domain: null }).toLowerCase(),
    ).not.toContain("domain=");
  });

  it("encodes the cookie value (delegates to cookie package serialize)", () => {
    const out = setSessionCookie({ name: "ark_session", value: "abc def", maxAgeSec: 60, secure: false });
    expect(out).toContain("ark_session=abc%20def");
  });
});

describe("clearSessionCookie", () => {
  it("emits Max-Age=0 to delete", () => {
    const out = clearSessionCookie({ name: "ark_session" });
    expect(out.toLowerCase()).toContain("max-age=0");
  });

  it("includes empty value", () => {
    const out = clearSessionCookie({ name: "ark_session" });
    expect(out).toMatch(/^ark_session=;/);
  });

  it("scopes Domain when provided", () => {
    expect(clearSessionCookie({ name: "ark_session", domain: ".paytm.com" }).toLowerCase()).toContain(
      "domain=.paytm.com",
    );
  });
});
