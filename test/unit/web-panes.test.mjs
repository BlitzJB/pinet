import { describe, expect, it } from "vitest";
import { MAX_PANES, addSide, closePane, paneAction, paneList, parseSide, sideParam } from "../../web/src/lib/panes.ts";

describe("parseSide / sideParam", () => {
  it("parses, trims and de-duplicates", () => {
    expect(parseSide("a, b ,a,,")).toEqual(["a", "b"]);
    expect(parseSide(["a", "b", "a"])).toEqual(["a", "b"]);
    expect(parseSide(undefined)).toEqual([]);
    expect(parseSide(42)).toEqual([]);
  });

  it("round-trips and returns undefined when empty", () => {
    expect(sideParam(["a", "b"])).toBe("a,b");
    expect(sideParam([])).toBeUndefined();
    expect(sideParam(["a", "a"])).toBe("a");
  });
});

describe("paneList", () => {
  it("puts the primary first and drops it from the side list", () => {
    expect(paneList("p", ["a", "p", "b"])).toEqual(["p", "a", "b"]);
  });

  it("caps the number of panes", () => {
    expect(paneList("p", ["a", "b", "c", "d", "e"])).toHaveLength(MAX_PANES);
  });

  it("handles a missing primary", () => {
    expect(paneList(undefined, ["a"])).toEqual(["a"]);
  });
});

describe("paneAction", () => {
  it("allows a new session", () => {
    expect(paneAction("p", ["a"], "b")).toEqual({ allowed: true });
  });

  it("refuses sessions that are already open", () => {
    expect(paneAction("p", ["a"], "a").allowed).toBe(false);
    expect(paneAction("p", ["a"], "p").allowed).toBe(false);
  });

  it("refuses past the cap", () => {
    expect(paneAction("p", ["a", "b", "c"], "d")).toMatchObject({ allowed: false, reason: expect.stringContaining("4") });
  });
});

describe("addSide", () => {
  it("appends a new pane", () => {
    expect(addSide("p", ["a"], "b")).toEqual(["a", "b"]);
  });

  it("is a no-op for the primary, duplicates, and the cap", () => {
    expect(addSide("p", ["a"], "p")).toEqual(["a"]);
    expect(addSide("p", ["a"], "a")).toEqual(["a"]);
    expect(addSide("p", ["a", "b", "c"], "d")).toEqual(["a", "b", "c"]);
    expect(addSide(undefined, ["a"], "b")).toEqual(["a"]);
  });
});

describe("closePane", () => {
  it("removes a side pane", () => {
    expect(closePane("p", ["a", "b"], "a")).toEqual({ primary: "p", side: ["b"] });
  });

  it("promotes the next pane when the primary closes", () => {
    expect(closePane("p", ["a", "b"], "p")).toEqual({ primary: "a", side: ["b"] });
  });

  it("reports an empty layout when the last pane closes", () => {
    expect(closePane("p", [], "p")).toEqual({ side: [] });
  });
});
