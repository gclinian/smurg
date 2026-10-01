// The few HTML pages the relay renders itself (everything else is the web SPA). zh-TW user-facing strings.
// No page runs script (http.ts HTML_CSP); navigation away from a page is a same-origin form POST, a link, or a
// same-origin GET form.

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
dd.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.6rem;letter-spacing:.15em;margin:.5rem 0}
p.error{color:#cf222e;font-weight:600}
dt{color:#57606a;font-size:.9rem}
dd{margin:0 0 .75rem}
button[value="allow"]{font-weight:600}`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
${body}
</body>
</html>
`;
}

export function errorPage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`);
}

// ---------------------------------------------------------------------------------------------------------------
// /device: the CLI's device-code login (auth/device.ts)
// ---------------------------------------------------------------------------------------------------------------

/** Which login methods the relay offers for this request. */
export type LoginChoice = { github: boolean; google: boolean; dev: boolean };

export type DeviceAccount = { displayName: string; userId: string };

function accountHtml(account: DeviceAccount): string {
  return `<strong>${escapeHtml(account.displayName)}</strong>（${escapeHtml(account.userId)}）`;
}

/**
 * `GET /device` without a session: the relay's own login, which comes back to /device. The person enters the code
 * only once logged in, so the code is never typed into a page that does not know who would approve it.
 */
export function deviceLoginPage(choice: LoginChoice, options: { relayOrigin: string }): string {
  const parts: string[] = [];
  const back = encodeURIComponent('/device');
  if (choice.google) parts.push(`<a class="button" data-provider="google" href="/auth/google/login?return_to=${back}">使用 Google 登入</a>`);
  if (choice.github) parts.push(`<a class="button" data-provider="github" href="/auth/github/login?return_to=${back}">使用 GitHub 登入</a>`);
  if (choice.dev) {
    parts.push(`<form method="get" action="/auth/dev/start" data-provider="dev"><input type="hidden" name="return_to" value="/device">
<label>開發用帳號（僅限本機）<input name="user" required pattern="[A-Za-z0-9._\\-]{1,64}" autocomplete="off"></label>
<button type="submit">以開發用帳號登入</button></form>`);
  }
  if (parts.length === 0) parts.push('<p>這個 relay 尚未設定任何登入方式。</p>');
  return page(
    '登入 smurg CLI',
    `<h1>登入 smurg CLI</h1>
<p>終端機裡的 <code>smurg login</code> 會顯示一組代碼。請先在這裡登入你的帳號，下一步再輸入那組代碼。</p>
${parts.join('\n')}
<p class="note">relay：${escapeHtml(options.relayOrigin)}</p>`,
  );
}

/** The code form of a logged-in browser; `error` above it, `value` (what was typed) kept in the field. */
export function deviceCodePage(account: DeviceAccount, options: { error?: string; value?: string } = {}): string {
  const error = options.error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(options.error)}</p>\n`;
  const value = options.value === undefined || options.value === '' ? '' : ` value="${escapeHtml(options.value.slice(0, 32))}"`;
  return page(
    '輸入代碼',
    `<h1>輸入代碼</h1>
<p>登入的帳號：${accountHtml(account)}</p>
${error}<form method="post" action="/device" data-testid="device-code-form">
<label for="code">終端機顯示的代碼</label>
<input id="code" name="code" required maxlength="32" autofocus autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX"${value}>
<button type="submit">下一步</button></form>
<p class="note">代碼是你在終端機執行 <code>smurg login</code>（或 <code>smurg host</code>）時顯示的 8 個英文字母，10 分鐘內有效；大小寫和「-」都可以省略。</p>
<p class="note">不是這個帳號？請先到 <a href="/">smurg 網頁版</a>登出，再回到這個頁面。</p>`,
  );
}

export type DeviceConfirmation = {
  /** `XXXX-XXXX`. */
  userCode: string;
  /** The normalised code, sent back with the decision. */
  codeField: string;
  ip: string | null;
  /** placeText(): 「Taipei，台灣」. */
  place: string;
  /** ageText(): 「3 分鐘前（… UTC）」. */
  age: string;
};

/**
 * The confirmation screen after a correct code: who would be logged in, where and when the request came from, the
 * warning, and 允許 / 拒絕 (a same-origin POST that carries the account it was shown for).
 */
export function deviceConfirmPage(account: DeviceAccount, login: DeviceConfirmation, options: { relayOrigin: string }): string {
  return page(
    '允許 smurg CLI 登入嗎？',
    `<h1>允許 smurg CLI 登入嗎？</h1>
<p>按「允許」之後，執行 <code>smurg login</code> 的那台電腦就會以你的帳號登入 relay <strong>${escapeHtml(options.relayOrigin)}</strong>（7 天內有效）。</p>
<dl>
<dt>帳號</dt><dd data-testid="device-account">${accountHtml(account)}</dd>
<dt>代碼</dt><dd class="code" data-testid="device-user-code">${escapeHtml(login.userCode)}</dd>
<dt>要求來自</dt><dd data-testid="device-origin">IP 位址 ${escapeHtml(login.ip ?? '不明')}，位置大約在 ${escapeHtml(login.place)}</dd>
<dt>要求時間</dt><dd data-testid="device-age">${escapeHtml(login.age)}</dd>
</dl>
<div class="warning">
<p><strong>只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。</strong></p>
<p>IP 位址和位置是執行 smurg login 的電腦連到 relay 時，relay 看到的（位置是推測的，可能不準；透過 SSH 執行時是那台遠端電腦）。</p>
</div>
<form method="post" action="/device" data-testid="device-decision">
<input type="hidden" name="code" value="${escapeHtml(login.codeField)}">
<input type="hidden" name="account" value="${escapeHtml(account.userId)}">
<button type="submit" name="decision" value="allow">允許</button>
<button type="submit" name="decision" value="deny">拒絕</button></form>`,
  );
}

/** The outcome pages of /device (allowed, denied, a code that is no longer valid): a title, paragraphs, a link. */
export function deviceResultPage(title: string, paragraphs: readonly string[], link?: { href: string; label: string }): string {
  const more = link === undefined ? '' : `\n<p class="note"><a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a></p>`;
  return page(title, `<h1>${escapeHtml(title)}</h1>\n${paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('\n')}${more}`);
}
