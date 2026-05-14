import { describe, it, expect } from "bun:test";
import { AppContext } from "../../core/app.js";
import { SecureBuffer } from "../../secrets/index.js";

describe("arkd boot -- KEK", () => {
  it("boots with the default stub KEK installed by forTestAsync", async () => {
    const app = await AppContext.forTestAsync();
    await app.boot();
    expect(app.phase).toBe("ready");
    const kek = app.loadedKek;
    expect(kek.material.byteLength).toBe(32);
    expect(kek.version).toBeGreaterThanOrEqual(1);
    await app.shutdown();
    expect(app.phase).toBe("stopped");
  }, 60_000);

  it("disposes the SecureBuffer on shutdown", async () => {
    const material = new SecureBuffer(new Uint8Array(32).fill(0x5a));
    const stubKek = { material, version: 7, describe: () => "stub:test@v7" };
    const app = await AppContext.forTestAsync(undefined, { stubKek });
    await app.boot();
    expect(app.loadedKek.version).toBe(7);
    await app.shutdown();
    expect(material.bytes().every((b) => b === 0)).toBe(true);
  }, 60_000);

  it("fails to boot when config.kek is missing and no stub provided", async () => {
    // Build a real AppContext bypassing forTestAsync's default stub.
    // We borrow a fresh test config so dirs/db are valid, then null out
    // kek and clear stubKek before booting.
    const ref = await AppContext.forTestAsync();
    const cfg: any = { ...ref.config, kek: undefined };
    // ref has not been booted yet -- shutdown is a no-op for fast path.
    await ref.shutdown();

    const app = new AppContext(cfg, {});
    let caught: any = null;
    try {
      await app.boot();
    } catch (e) {
      caught = e;
    } finally {
      try {
        await app.shutdown();
      } catch {
        /* ignore */
      }
    }
    expect(caught).toBeTruthy();
    expect(String(caught.message)).toMatch(/ARK_KEK_BACKEND|kek/i);
  }, 60_000);
});
