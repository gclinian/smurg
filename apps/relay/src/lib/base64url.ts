// Small encoding helpers shared by the Worker and its Node tests (Web APIs only: btoa, crypto, TextEncoder).

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] ?? 0);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `bytes` of CSPRNG output, base64url without padding (32 bytes -> 43 characters). */
export function randomToken(bytes = 32): string {
  return base64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** base64url(SHA-256(utf8(text))): the PKCE S256 transform (RFC 7636 §4.2). */
export async function sha256Base64url(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return base64urlEncode(new Uint8Array(digest));
}

/**
 * Compares two strings without an early exit on the first differing character. Lengths are not secret here (every
 * compared value has a fixed, public length), so a length mismatch returns immediately.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
