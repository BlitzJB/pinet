// Portable base64 using btoa/atob (global in Node 22+ and browsers).

export function toBase64(bytes) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < array.length; i += chunk) {
    binary += String.fromCharCode.apply(null, array.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function fromBase64(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
