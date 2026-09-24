// Deterministic serialization used for signatures and AAD. Key order is
// normalized so the same logical value always signs/encrypts identically.

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

function normalize(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("cannot canonicalize non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    out[key] = normalize(value[key]);
  }
  return out;
}

export function aadFrom(parts) {
  return Buffer.from(canonicalJson(parts), "utf8");
}
