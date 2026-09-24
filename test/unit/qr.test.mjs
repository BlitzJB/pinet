import { describe, expect, it } from "vitest";
import { qrSvg } from "../../src/coordinator/qr.mjs";

describe("qrSvg", () => {
  it("renders an inline SVG for an otpauth link", () => {
    const svg = qrSvg("otpauth://totp/Pinet:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Pinet");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("</svg>");
    expect(svg).toContain("<path");
  });

  it("never throws (returns empty string on bad input)", () => {
    expect(() => qrSvg("")).not.toThrow();
    expect(typeof qrSvg("x".repeat(5000))).toBe("string");
  });
});
