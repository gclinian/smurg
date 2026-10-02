// The few HTML pages the relay renders itself (everything else is the web SPA). Their text is in ./strings.ts, in
// English and zh-TW; the language is the viewer's (./locale.ts: the smurg_lang cookie, then Accept-Language).
// No page runs script (http.ts HTML_CSP); navigation away from a page is a same-origin form POST, a link, or a
// same-origin GET form. The language switch is two plain links (`?lang=`, answered by ./locale.ts).
import { LOCALES, intlTag, type Locale } from '@smurg/protocol/locale';
import { LANGUAGE_NAMES, STRINGS } from './strings.ts';

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** For each language, the same-origin link that switches this page to it (`<path>?lang=<locale>`). */
export type LanguageLinks = Readonly<Record<Locale, string>>;

/** How one page is rendered: its language, and the switch links when the page is the answer to a GET (else none). */
export type PageView = { readonly locale: Locale; readonly languageLinks?: LanguageLinks };

/** `data-state` of <body>: which page this is, independent of the language (tests and smokes select by it). */
export type PageState = 'login' | 'code' | 'confirm' | 'allowed' | 'denied' | 'gone' | 'wrong-code' | 'blocked' | 'account-changed' | 'error';

const STYLE = `body{font-family:system-ui,-apple-system,"PingFang TC","Noto Sans TC",sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1f2328}
a.button,button{display:block;width:100%;box-sizing:border-box;margin:.75rem 0;padding:.75rem 1rem;border:1px solid #d0d7de;border-radius:.5rem;background:#f6f8fa;color:inherit;font-size:1rem;text-align:center;text-decoration:none;cursor:pointer}
input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #d0d7de;border-radius:.5rem}
p.note{color:#57606a;font-size:.9rem}
div.warning{border:1px solid #d4a72c;background:#fff8c5;border-radius:.5rem;padding:.25rem 1rem;margin:1rem 0}
dd.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.6rem;letter-spacing:.15em;margin:.5rem 0}
p.error{color:#cf222e;font-weight:600}
dt{color:#57606a;font-size:.9rem}
dd{margin:0 0 .75rem}
button[value="allow"]{font-weight:600}
nav.lang{margin-top:2.5rem;color:#57606a;font-size:.9rem}
nav.lang a{color:inherit}
nav.lang a[aria-current]{font-weight:600;text-decoration:none}`;

function languageSwitch(view: PageView): string {
  const links = view.languageLinks;
  if (links === undefined) return '';
  const items = LOCALES.map((locale) => {
    const current = locale === view.locale ? ' aria-current="true"' : '';
    return `<a href="${escapeHtml(links[locale])}" lang="${intlTag(locale)}" hreflang="${intlTag(locale)}" data-lang="${locale}"${current}>${escapeHtml(LANGUAGE_NAMES[locale])}</a>`;
  });
  return `\n<nav class="lang" aria-label="${escapeHtml(STRINGS[view.locale].languageSwitchLabel)}">${items.join(' · ')}</nav>`;
}

function page(view: PageView, state: PageState, title: string, body: string): string {
  return `<!doctype html>
<html lang="${intlTag(view.locale)}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body data-state="${state}">
${body}${languageSwitch(view)}
</body>
</html>
`;
}

export function errorPage(view: PageView, title: string, message: string): string {
  return page(view, 'error', title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`);
}

// ---------------------------------------------------------------------------------------------------------------
// /device: the CLI's device-code login (auth/device.ts)
// ---------------------------------------------------------------------------------------------------------------

/** Which login methods the relay offers for this request. */
export type LoginChoice = { github: boolean; google: boolean; dev: boolean };

export type DeviceAccount = { displayName: string; userId: string };

function accountHtml(locale: Locale, account: DeviceAccount): string {
  return STRINGS[locale].accountHtml(escapeHtml(account.displayName), escapeHtml(account.userId));
}

/**
 * `GET /device` without a session: the relay's own login, which comes back to /device. The person enters the code
 * only once logged in, so the code is never typed into a page that does not know who would approve it.
 */
export function deviceLoginPage(view: PageView, choice: LoginChoice, options: { relayOrigin: string }): string {
  const s = STRINGS[view.locale];
  const parts: string[] = [];
  const back = encodeURIComponent('/device');
  if (choice.google) parts.push(`<a class="button" data-provider="google" href="/auth/google/login?return_to=${back}">${escapeHtml(s.loginWith('Google'))}</a>`);
  if (choice.github) parts.push(`<a class="button" data-provider="github" href="/auth/github/login?return_to=${back}">${escapeHtml(s.loginWith('GitHub'))}</a>`);
  if (choice.dev) {
    parts.push(`<form method="get" action="/auth/dev/start" data-provider="dev"><input type="hidden" name="return_to" value="/device">
<label>${escapeHtml(s.devAccountLabel)}<input name="user" required pattern="[A-Za-z0-9._\\-]{1,64}" autocomplete="off"></label>
<button type="submit">${escapeHtml(s.devLoginButton)}</button></form>`);
  }
  if (parts.length === 0) parts.push(`<p>${escapeHtml(s.noLoginMethods)}</p>`);
  return page(
    view,
    'login',
    s.loginTitle,
    `<h1>${escapeHtml(s.loginTitle)}</h1>
<p>${s.loginIntroHtml}</p>
${parts.join('\n')}
<p class="note">${escapeHtml(s.relayNote(options.relayOrigin))}</p>`,
  );
}

/** Why the code form is shown again: the sentence above it and the page's `data-state`. */
export type DeviceCodeError = { readonly state: 'wrong-code' | 'blocked' | 'account-changed'; readonly text: string };

/** The code form of a logged-in browser; `error` above it, `value` (what was typed) kept in the field. */
export function deviceCodePage(view: PageView, account: DeviceAccount, options: { error?: DeviceCodeError; value?: string } = {}): string {
  const s = STRINGS[view.locale];
  const error = options.error === undefined ? '' : `<p class="error" role="alert">${escapeHtml(options.error.text)}</p>\n`;
  const value = options.value === undefined || options.value === '' ? '' : ` value="${escapeHtml(options.value.slice(0, 32))}"`;
  return page(
    view,
    options.error?.state ?? 'code',
    s.codeTitle,
    `<h1>${escapeHtml(s.codeTitle)}</h1>
<p>${s.loggedInAsHtml(accountHtml(view.locale, account))}</p>
${error}<form method="post" action="/device" data-testid="device-code-form">
<label for="code">${escapeHtml(s.codeLabel)}</label>
<input id="code" name="code" required maxlength="32" autofocus autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="XXXX-XXXX"${value}>
<button type="submit">${escapeHtml(s.next)}</button></form>
<p class="note">${s.codeNoteHtml}</p>
<p class="note">${s.wrongAccountHtml}</p>`,
  );
}

export type DeviceConfirmation = {
  /** `XXXX-XXXX`. */
  userCode: string;
  /** The normalised code, sent back with the decision. */
  codeField: string;
  ip: string | null;
  /** placeText(): `Taipei, Taiwan`. */
  place: string;
  /** ageText(): `3 minutes ago (… UTC)`. */
  age: string;
};

/**
 * The confirmation screen after a correct code: who would be logged in, where and when the request came from, the
 * warning, and Allow / Deny (a same-origin POST that carries the account it was shown for).
 */
export function deviceConfirmPage(view: PageView, account: DeviceAccount, login: DeviceConfirmation, options: { relayOrigin: string }): string {
  const s = STRINGS[view.locale];
  return page(
    view,
    'confirm',
    s.confirmTitle,
    `<h1>${escapeHtml(s.confirmTitle)}</h1>
<p>${s.confirmIntroHtml(escapeHtml(options.relayOrigin))}</p>
<dl>
<dt>${escapeHtml(s.account)}</dt><dd data-testid="device-account">${accountHtml(view.locale, account)}</dd>
<dt>${escapeHtml(s.code)}</dt><dd class="code" data-testid="device-user-code">${escapeHtml(login.userCode)}</dd>
<dt>${escapeHtml(s.requestFrom)}</dt><dd data-testid="device-origin">${escapeHtml(s.requestOrigin(login.ip, login.place))}</dd>
<dt>${escapeHtml(s.requestTime)}</dt><dd data-testid="device-age">${escapeHtml(login.age)}</dd>
</dl>
<div class="warning">
<p><strong>${escapeHtml(s.warningMain)}</strong></p>
<p>${escapeHtml(s.warningNote)}</p>
</div>
<form method="post" action="/device" data-testid="device-decision">
<input type="hidden" name="code" value="${escapeHtml(login.codeField)}">
<input type="hidden" name="account" value="${escapeHtml(account.userId)}">
<button type="submit" name="decision" value="allow">${escapeHtml(s.allow)}</button>
<button type="submit" name="decision" value="deny">${escapeHtml(s.deny)}</button></form>`,
  );
}

/** The outcome pages of /device: a title, paragraphs, and for a code that is no longer valid a link back to the form. */
export function deviceResultPage(view: PageView, outcome: 'allowed' | 'denied' | 'gone'): string {
  const s = STRINGS[view.locale];
  const content: { title: string; paragraphs: readonly string[]; link?: { href: string; label: string } } =
    outcome === 'allowed'
      ? { title: s.allowedTitle, paragraphs: [s.allowedText] }
      : outcome === 'denied'
        ? { title: s.deniedTitle, paragraphs: [s.deniedText, s.deniedWarning] }
        : { title: s.goneTitle, paragraphs: [s.goneText], link: { href: '/device', label: s.enterAnotherCode } };
  const more = content.link === undefined ? '' : `\n<p class="note"><a href="${escapeHtml(content.link.href)}">${escapeHtml(content.link.label)}</a></p>`;
  return page(view, outcome, content.title, `<h1>${escapeHtml(content.title)}</h1>\n${content.paragraphs.map((text) => `<p>${escapeHtml(text)}</p>`).join('\n')}${more}`);
}
