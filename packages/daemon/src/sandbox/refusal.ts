// Why the guest sandbox refuses to start a process, and what the person on the other side is told (R5: no fallback
// to unsandboxed, and a clear error). Every refusal carries a closed `reason` (machine-readable, sent as
// `detail.reason` of `sandbox_unavailable`), a zh-TW message a user can act on (sent to the client, so it never names
// host paths), and an English `internal` text for the host's own log only.

export const SANDBOX_REFUSAL_REASONS = [
  'unsupported-platform', // not macOS / Linux, or srt does not support this platform
  'no-host-home', // config.sessions.hostHome is not set: nothing to deny, so nothing may run
  'dependency-missing', // sandbox-exec (macOS) or bwrap / socat / rg (Linux), or srt's own dependency check
  'apparmor-userns', // Ubuntu 24.04+: AppArmor forbids the user namespaces bubblewrap needs
  'runtime-busy', // another daemon in this process owns srt's process-wide configuration
  'init-failed', // SandboxManager.initialize() failed (proxies, config validation)
  'config-update-failed', // the live network allow-list could not be applied: network is closed until restart
  'launcher-missing', // the wrapped command does not run through sandbox-exec / bwrap
  'hardening-failed', // srt's generated profile is not the text this code was verified against (srt changed)
  'self-test-failed', // the canary check inside the real sandbox did not come back clean
  'policy-invalid', // the session's paths cannot be expressed safely (glob characters, contradictions, layout)
  'root-unknown', // the session root is neither the share nor a registered worktree
  'hook-unreachable', // `smurg hook` could not run inside this sandbox: the agent's file locks would not exist
  'hook-self-test-failed', // the real `smurg hook`, run inside this session's sandbox with a probe event, did not answer right
  'wrap-failed', // anything else while wrapping (fail closed)
] as const;

export type SandboxRefusalReason = (typeof SANDBOX_REFUSAL_REASONS)[number];

const MESSAGES: Readonly<Record<SandboxRefusalReason, string>> = {
  'unsupported-platform': '主人的作業系統不支援客人沙盒（只支援 macOS 和 Linux），因此無法開啟客人 session。',
  'no-host-home': '主人的 daemon 沒有設定家目錄位置，沙盒無法確定要保護哪些檔案，因此拒絕開啟客人 session。',
  'dependency-missing': '主人電腦缺少沙盒需要的元件，因此拒絕開啟客人 session。',
  'apparmor-userns':
    '主人電腦的 AppArmor 限制了 bubblewrap 建立 user namespace，沙盒無法啟動，因此拒絕開啟客人 session。' +
    '請主人為 /usr/bin/bwrap 安裝允許 userns 的 AppArmor 設定檔（smurg host 啟動時會印出修正指令；安裝程式 install.sh 也會處理），' +
    '或執行 sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0（此設定會放寬整台電腦的限制）。',
  'runtime-busy': '主人的 daemon 目前無法使用沙盒（沙盒已被同一個程序中的另一個工作區占用），因此拒絕開啟客人 session。',
  'init-failed': '沙盒無法初始化，因此拒絕開啟客人 session。請主人查看 daemon 的紀錄。',
  'config-update-failed': '沙盒的網路白名單無法更新，為了安全已暫停所有客人的網路存取。請主人重新啟動 smurg。',
  'launcher-missing': '沙盒沒有真正包住這個程序，因此拒絕開啟客人 session。',
  'hardening-failed': '沙盒設定的安全強化步驟失敗（沙盒元件的版本可能已變更），因此拒絕開啟客人 session。請主人更新 smurg。',
  'self-test-failed': '沙盒自我檢查失敗，無法確認客人讀不到主人的檔案，因此拒絕開啟客人 session。',
  'policy-invalid': '這個 session 的資料夾設定無法安全地放進沙盒，因此拒絕開啟客人 session。',
  'root-unknown': '找不到這個 session 要使用的工作區或 worktree，因此拒絕開啟客人 session。',
  'hook-unreachable': '沙盒裡無法執行 smurg 的檔案鎖程式（smurg 安裝在共享資料夾或 smurg 的資料夾裡），agent 的檔案鎖會失效，因此拒絕開啟客人的 agent session。請主人把 smurg 安裝在共享資料夾以外的地方。',
  'hook-self-test-failed':
    '在沙盒裡試跑 smurg 的檔案鎖程式失敗（程式無法啟動、連不到 smurg daemon，或回答不正確），agent 的檔案鎖會失效，因此拒絕開啟客人的 agent session。' +
    '請主人確認 smurg 安裝在共享資料夾和 ~/.smurg 以外的地方、smurg host 仍在執行，然後再開一次 session；若仍失敗，請主人查看 daemon 的紀錄。',
  'wrap-failed': '沙盒無法啟動，因此拒絕開啟客人 session。請主人查看 daemon 的紀錄。',
};

/** A refusal of the guest sandbox. `message` is the zh-TW text for the user; `internal` is for the host's log. */
export class SandboxRefusal extends Error {
  readonly reason: SandboxRefusalReason;
  readonly internal: string;

  constructor(reason: SandboxRefusalReason, internal: string, options?: { readonly message?: string; readonly cause?: unknown }) {
    super(options?.message ?? MESSAGES[reason], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SandboxRefusal';
    this.reason = reason;
    this.internal = internal;
  }
}

export function isSandboxRefusal(value: unknown): value is SandboxRefusal {
  return value instanceof SandboxRefusal;
}

/** The generic zh-TW message of a reason. */
export function refusalMessage(reason: SandboxRefusalReason): string {
  return MESSAGES[reason];
}

/** A dependency refusal whose message names what is missing and how to install it (R5.4: "a clear error"). */
export function dependencyRefusal(platform: 'darwin' | 'linux', missing: readonly string[], internal: string): SandboxRefusal {
  const names = missing.join('、');
  const fix =
    platform === 'darwin'
      ? '請主人確認 macOS 內建的 /usr/bin/sandbox-exec 存在且可以執行。'
      : '請主人安裝缺少的套件，例如在 Ubuntu 上執行 sudo apt-get install bubblewrap socat ripgrep。';
  return new SandboxRefusal('dependency-missing', internal, {
    message: `主人電腦缺少沙盒需要的元件（${names}），因此拒絕開啟客人 session。${fix}`,
  });
}
