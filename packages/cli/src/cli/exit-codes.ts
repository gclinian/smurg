// Exit codes of the `smurg` command. `smurg attach` passes the remote session's own exit code through (0–255) when
// the session ends; these are for everything else.
export const EXIT = Object.freeze({
  ok: 0,
  /** Something went wrong at run time (relay unreachable, daemon start failed, connection lost). */
  failure: 1,
  /** Bad arguments, or input the command refuses (a folder that may not be shared, --dev-user for a remote relay). */
  usage: 2,
  /** `smurg stop` / `status` / a local `attach`: no running `smurg host` found. */
  notRunning: 3,
  /** Login required or failed. */
  auth: 4,
  /** Terminated by SIGINT (a second Ctrl-C while stopping). */
  interrupted: 130,
} as const);

export type ExitCode = number;
