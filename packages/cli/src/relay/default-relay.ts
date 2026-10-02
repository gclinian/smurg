// The relay that `smurg host`, `smurg login`, `smurg logout` and `smurg attach` use when nothing else names one (no
// --relay, no SMURG_RELAY_URL, no relay remembered from an earlier login, no invite link): the project's shared relay,
// which also serves the web app, on Cloudflare Workers at the custom domain https://app.smurg.ai (apps/relay/README.md,
// "Deploying to Cloudflare"; it was https://smurg-relay.<account subdomain>.workers.dev until 2026-10-01, which answers 404 now).
//
// null = there is no built-in relay, and a command without a relay refuses with a hint (the behaviour of CLI-12: a
// guessed domain would receive the host's login and every invite link printed for it). Set it ONLY to the deployed
// relay's origin, the RELAY_ISSUER of the committed apps/relay/wrangler.jsonc (apps/relay/test/config.test.ts checks
// that they are equal), checked from outside with `scripts/deploy-relay.sh --check <origin>`. Invite links are built on
// the relay's origin (<relay>/join/<id>#…), so this is also where every invite printed through the built-in relay
// points.
// packages/cli/test/default-relay.test.ts checks the value: null, or an https origin without a path. Keep this exact line
// shape: scripts/release-assets.sh refuses a release unless it matches
//   export const DEFAULT_RELAY_URL: string | null = 'https://<host>';
export const DEFAULT_RELAY_URL: string | null = 'https://app.smurg.ai';
