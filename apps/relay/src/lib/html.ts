// The few HTML pages the relay renders itself (everything else is the web SPA). zh-TW user-facing strings.
// No page runs script (http.ts HTML_CSP); navigation away from a page is a same-origin form POST, a link, or a meta
// refresh.
import type { CliParams } from './validate.ts';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `body{font-family:system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1f2328}
a.button,button{display:block;width:100%;box-sizing:border-box;margin:.75rem 0;padding:.75rem 1rem;border:1px solid #d0d7de;border-radius:.5rem;background:#f6f8fa;color:inherit;font-size:1rem;text-align:center;text-decoration:none;cursor:pointer}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #d0d7de;border-radius:.5rem}
p.note{color:#57606a;font-size:.9rem}
div.warning{border:1px solid #d4a72c;background:#fff8c5;border-radius:.5rem;padding:.25rem 1rem;margin:1rem 0}
p.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.6rem;letter-spacing:.15em;text-align:center;margin:.5rem 0}`;

function page(title: string, body: string, head = ''): string {
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
${body}
</body>
</html>
`;
}

export type CliProviderChoice = { github: boolean; google: boolean; dev: boolean };

export type CliConfirmOptions = {
  /** The relay's origin, shown so the person sees which relay the CLI signs in to. */
  relayOrigin: string;
  /** cliConfirmCode(cli.state): the smurg CLI prints the same code in the terminal. */
  confirmCode: string;
  /** `provider` from the CLI's URL (e.g. `smurg login --provider github`): only that choice is offered. */
  only?: 'github' | 'google' | 'dev' | undefined;
  /** Dev provider: the account name from the URL, pre-filled (already validated). */
  devUser?: string | undefined;
};

/**
 * `GET /auth/cli/start`: the confirmation step of the CLI loopback login (SEC-E-03). A link alone never signs anyone
 * in: every choice is a same-origin POST form (checked in routes.ts), and the page tells the person to continue only
 * when they started `smurg login` themselves and the terminal shows the same code.
 */
export function cliConfirmPage(cli: CliParams, choice: CliProviderChoice, options: CliConfirmOptions): string {
  const hidden = (provider: string) =>
    Object.entries({ port: String(cli.port), state: cli.state, code_challenge: cli.codeChallenge, provider })
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join('');
  const offered = (provider: 'github' | 'google' | 'dev') => choice[provider] && (options.only === undefined || options.only === provider);
  const form = (provider: string, label: string, extra = '') =>
    `<form method="post" action="/auth/cli/start" data-provider="${escapeHtml(provider)}">${hidden(provider)}${extra}
<button type="submit">${escapeHtml(label)}</button></form>`;
  const parts: string[] = [];
  if (offered('github')) parts.push(form('github', '使用 GitHub 繼續'));
  if (offered('google')) parts.push(form('google', '使用 Google 繼續'));
  if (offered('dev')) {
    const value = options.devUser === undefined ? '' : ` value="${escapeHtml(options.devUser)}"`;
    parts.push(
      form(
        'dev',
        '以開發用帳號繼續',
        `\n<label>開發用帳號（僅限本機）<input name="user" required pattern="[A-Za-z0-9._\\-]{1,64}" autocomplete="off"${value}></label>`,
      ),
    );
  }
  if (parts.length === 0) parts.push('<p>這個 relay 尚未設定任何登入方式。</p>');
  return page(
    '登入 smurg CLI',
    `<h1>登入 smurg CLI</h1>
<div class="warning">
<p>這台電腦上的 <code>smurg</code> 指令要求以你的帳號登入 relay <strong>${escapeHtml(options.relayOrigin)}</strong>。繼續之後，這個 relay 的登入會交給在本機埠 ${cli.port} 等待的程式。</p>
<p><strong>只有在你剛剛自己在終端機執行了 <code>smurg login</code>，而且終端機顯示的確認碼和下面相同時，才繼續。</strong>否則請直接關閉這個頁面：有人可能想借用你的帳號。</p>
</div>
<p>確認碼</p>
<p class="code" data-testid="cli-confirm-code">${escapeHtml(options.confirmCode)}</p>
${parts.join('\n')}
<p class="note">如果你沒有在終端機執行 <code>smurg login</code>，請直接關閉這個頁面。</p>`,
  );
}

/**
 * A page that continues to `target` by itself (meta refresh) and offers a link as a fallback. Used wherever the next
 * hop leaves the relay after a form submission: Chromium checks CSP `form-action` on every redirect of a form
 * submission, so a 302 to the CLI's loopback listener (or to an IdP) would be blocked (OWNER-01). A meta refresh
 * starts a new navigation that is not a form submission.
 */
export function continuePage(title: string, message: string, target: string, linkLabel: string): string {
  const href = escapeHtml(target);
  return page(
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<a class="button" id="continue" href="${href}">${escapeHtml(linkLabel)}</a>
<p class="note">如果頁面沒有自動前往，請按上面的按鈕。</p>`,
    `<meta http-equiv="refresh" content="0;url=${href}">`,
  );
}

export function errorPage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`);
}
