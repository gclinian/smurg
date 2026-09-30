// Optional secrets. `wrangler types` only declares the required ones (RELAY_SIGNING_KEY); a relay may run with only
// one OAuth provider configured, so these are not in `secrets.required`.
interface Env {
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_SECRET?: string;
}
