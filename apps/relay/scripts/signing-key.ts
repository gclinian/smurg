// Generates the relay's Ed25519 signing key (RELAY_SIGNING_KEY: a private JWK as JSON).
//
//   node scripts/signing-key.ts | wrangler secret put RELAY_SIGNING_KEY      production (reads the secret from stdin)
//
// The key is printed to stdout only; nothing is written to disk. `pnpm dev:relay` creates .dev.vars with its own key
// (scripts/ensure-dev-vars.ts), and tests generate one per relay (test-support).
import { fileURLToPath } from 'node:url';
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';

export async function generateSigningKey(): Promise<string> {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwk = await exportJWK(privateKey);
  jwk.kid = await calculateJwkThumbprint({ kty: jwk.kty ?? 'OKP', crv: jwk.crv ?? 'Ed25519', x: jwk.x ?? '' });
  return JSON.stringify(jwk);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.stdout.write(await generateSigningKey());
}
