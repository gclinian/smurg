# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/gclinian/smurg/security/advisories/new> ("Security" tab → "Report a vulnerability").
Do not open a public issue for a vulnerability.

Say what you found, how to reproduce it, and which version (`smurg --version`) or commit it affects. You will get an
answer in the advisory thread. Fixes are released as a new version; only the latest release is supported.

## What is in scope

- **End-to-end encryption.** Everything a workspace exchanges (files, terminal output, edits, suggestions) is
  encrypted between the host's daemon and each member's browser or CLI; the relay forwards ciphertext. A way for the
  relay, or anyone on the network, to read or change that content is a vulnerability. So is a way to join a workspace
  without a valid invite, or to keep access after the host removed it.
- **Roles.** A member doing something their role does not allow (a viewer editing, an editor opening or driving a
  session, a member reading files the host keeps private, anyone escaping the shared folder) is a vulnerability.
- **The relay and the web app** (`apps/relay`, `apps/web`): login, sessions, the device-code login, cross-site
  attacks, anything that lets one account act as another.
- **The installer and the update** (`scripts/install.sh`, `smurg update`): installing anything other than the
  sha256-verified executable of the release.

## What is by design

- **Agent and terminal sessions run as the host.** A member with the role "Agent access" opens sessions that run on
  the host's computer, under the host's account, with no sandbox, and can do there whatever the host can. Hosts give
  that role only to people they fully trust (`docs/HOSTING.md`). This is not a vulnerability.
- **What the relay operator sees**: account identities, IP addresses, workspace ids, frame sizes and timing, never
  content (`docs/ARCHITECTURE.md` §12). Hosts who do not accept that can run their own relay (`apps/relay/README.md`).
- The published checksums (`SHA256SUMS`) are served from the same place as the executables and are not signed: they
  catch a corrupted download, not a compromised publisher (`docs/RELEASING.md` §9).
