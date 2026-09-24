import { describe, expect, it } from "vitest";
import { resolveDelivery } from "../../src/host/delivery.mjs";
import { createSerialQueue } from "../../src/host/command-queue.mjs";

describe("resolveDelivery", () => {
  it("delivers immediately when idle", () => {
    expect(resolveDelivery({ isIdle: true })).toEqual({ deliverAs: null, mode: "immediate" });
  });

  it("steers when running (the default)", () => {
    expect(resolveDelivery({ isIdle: false })).toEqual({ deliverAs: "steer", mode: "steer" });
    expect(resolveDelivery({ isIdle: false, requested: "steer" })).toEqual({ deliverAs: "steer", mode: "steer" });
  });

  it("honors an explicit follow-up request", () => {
    expect(resolveDelivery({ isIdle: false, requested: "followUp" })).toEqual({ deliverAs: "followUp", mode: "followUp" });
  });

  it("ignores follow-up when idle (immediate wins)", () => {
    expect(resolveDelivery({ isIdle: true, requested: "followUp" })).toEqual({ deliverAs: null, mode: "immediate" });
  });
});

describe("createSerialQueue", () => {
  it("runs tasks strictly in order", async () => {
    const queue = createSerialQueue();
    const order = [];
    const a = queue.run(async () => {
      await new Promise((r) => setTimeout(r, 30));
      order.push("a");
      return "a";
    });
    const b = queue.run(async () => {
      order.push("b");
      return "b";
    });
    const c = queue.run(() => {
      order.push("c");
      return "c";
    });
    expect(await Promise.all([a, b, c])).toEqual(["a", "b", "c"]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("continues after a failure", async () => {
    const queue = createSerialQueue();
    await expect(queue.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await queue.run(() => "ok")).toBe("ok");
  });
});
