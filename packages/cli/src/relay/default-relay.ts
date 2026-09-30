// The relay that `smurg host`, `smurg login`, `smurg logout` and `smurg attach` use when nothing else names one (no
// --relay, no SMURG_RELAY_URL, no relay remembered from an earlier login, no invite link): the project's hosted relay
// on Cloudflare Workers (apps/relay/README.md「部署到 Cloudflare」).
//
// null = there is no built-in relay, and a command without a relay refuses with a hint (the behaviour of CLI-12: a
// guessed domain would receive the host's login and every invite link printed for it). Set it ONLY to the exact origin
// that scripts/deploy-relay.sh printed after a successful deploy (and whose --check passes), e.g.
//   export const DEFAULT_RELAY_URL: string | null = 'https://smurg-relay.<account subdomain>.workers.dev';
// packages/cli/test/default-relay.test.ts checks the value: null, or an https origin without a path.
export const DEFAULT_RELAY_URL: string | null = 'https://smurg-relay.gclin-ian.workers.dev';
