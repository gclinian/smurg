// Every sentence of the relay's own HTML pages (/device and the login error pages), in both display languages.
// English defines the keys; the zh-TW table has exactly the same keys and parameters (checked by the type and by
// test/strings.test.ts). The JSON API never uses this file: its errors are codes with fixed English messages.
//
// A key that ends in `Html` returns markup: its parameters must already be escaped (lib/html.ts does that). Every
// other value is plain text and is escaped where it is put into a page.
import type { Locale } from '@smurg/protocol/locale';

/** The two names in the language switch: each always in its own language, never translated. */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { en: 'English', 'zh-TW': '繁體中文' };

const en = {
  languageSwitchLabel: 'Language',

  // GET /device without a session
  loginTitle: 'Log in to the smurg CLI',
  loginIntroHtml:
    'Running <code>smurg login</code> in your terminal shows a code. Log in to your account here first; you enter the code in the next step.',
  loginWith: (provider: string) => `Log in with ${provider}`,
  devAccountLabel: 'Development account (this machine only)',
  devLoginButton: 'Log in with a development account',
  noLoginMethods: 'This relay has no login method set up yet.',
  relayNote: (origin: string) => `relay: ${origin}`,

  // The code form
  codeTitle: 'Enter the code',
  accountHtml: (name: string, userId: string) => `<strong>${name}</strong> (${userId})`,
  loggedInAsHtml: (account: string) => `Logged in as ${account}`,
  codeLabel: 'Code shown in your terminal',
  next: 'Next',
  codeNoteHtml:
    'The code is the 8 letters shown when you run <code>smurg login</code> (or <code>smurg host</code>) in your terminal. It is valid for 10 minutes. Upper or lower case both work, and you can leave out the "-".',
  wrongAccountHtml: 'Not your account? Log out in the <a href="/">smurg web app</a> first, then come back to this page.',
  wrongCode: 'That code is not correct or is no longer valid. Check the code in your terminal (8 letters, valid for 10 minutes).',
  tooManyWrongCodes: (minutes: number) => `Too many wrong codes. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`,
  accountChanged: 'The account logged in to this browser changed in the meantime. Check the current account, then enter the code again.',

  // The confirmation screen
  confirmTitle: 'Allow the smurg CLI to log in?',
  confirmIntroHtml: (origin: string) =>
    `After you press "Allow", the computer that ran <code>smurg login</code> is logged in to the relay <strong>${origin}</strong> with your account (valid for 7 days).`,
  account: 'Account',
  code: 'Code',
  requestFrom: 'Request from',
  requestTime: 'Requested',
  requestOrigin: (ip: string | null, place: string) => `IP address ${ip ?? 'unknown'}, located around ${place}`,
  warningMain: 'Press "Allow" only if you just ran smurg login in your terminal yourself. If someone else gave you this code, press "Deny".',
  warningNote:
    'The IP address and the location are what the relay saw when the computer running smurg login connected to it (the location is a guess and may be wrong; over SSH it is the remote computer).',
  allow: 'Allow',
  deny: 'Deny',

  // Where and when a login was started
  placeCityCountry: (city: string, country: string) => `${city}, ${country}`,
  placeUnknown: 'unknown',
  torNetwork: 'Tor network',
  age: (minutes: number, utc: string) =>
    minutes === 0 ? `less than 1 minute ago (${utc})` : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago (${utc})`,

  // Outcomes
  allowedTitle: 'Allowed',
  allowedText: 'smurg in your terminal finishes logging in within a few seconds. You can then close this page.',
  deniedTitle: 'Denied',
  deniedText: 'This login will not complete. smurg in your terminal says that the login was denied.',
  deniedWarning: 'If you did not run smurg login yourself, someone may be trying to log in with your account: do not give the code to anyone.',
  goneTitle: 'This code is no longer valid',
  goneText: 'This code was already used, was denied or has expired. Go back to your terminal and run smurg login again.',
  enterAnotherCode: 'Enter another code',

  // Error pages
  cannotContinueTitle: 'Cannot continue',
  notFromDevicePage:
    "This request was not sent from the relay's /device page, so it was refused. Open the address shown in your terminal directly in your browser.",
  unknownDecision: 'That choice was not recognized. Enter the code again.',
  cannotLogInTitle: 'Cannot log in',
  badLoginLink: 'The login link is invalid or has expired. Go back to the page you came from and log in again.',
  providerNotConfigured: (provider: string) => `This relay has no ${provider} login set up.`,
  loginTimedOutOrDone: 'The login timed out or was already completed in another tab. Log in again.',
  loginTimedOut: 'The login timed out. Log in again.',
  stateMismatch: 'The login request does not match (wrong state). Log in again.',
  loginCancelled: 'You cancelled the login, or the login service refused the request.',
  noAuthorizationCode: 'The login service did not return an authorization code.',
  cannotConfirmIdentity: (provider: string) => `Could not confirm your identity with ${provider}. Try again later.`,
  devNameRule: 'A development account name may contain only letters, digits, ".", "_" and "-", and at most 64 characters.',
};

export type PageStrings = typeof en;

export const STRINGS: Readonly<Record<Locale, PageStrings>> = {
  en,
  'zh-TW': {
    languageSwitchLabel: '語言',

    loginTitle: '登入 smurg CLI',
    loginIntroHtml: '終端機裡的 <code>smurg login</code> 會顯示一組代碼。請先在這裡登入你的帳號，下一步再輸入那組代碼。',
    loginWith: (provider: string) => `使用 ${provider} 登入`,
    devAccountLabel: '開發用帳號（僅限本機）',
    devLoginButton: '以開發用帳號登入',
    noLoginMethods: '這個 relay 尚未設定任何登入方式。',
    relayNote: (origin: string) => `relay：${origin}`,

    codeTitle: '輸入代碼',
    accountHtml: (name: string, userId: string) => `<strong>${name}</strong>（${userId}）`,
    loggedInAsHtml: (account: string) => `登入的帳號：${account}`,
    codeLabel: '終端機顯示的代碼',
    next: '下一步',
    codeNoteHtml:
      '代碼是你在終端機執行 <code>smurg login</code>（或 <code>smurg host</code>）時顯示的 8 個英文字母，10 分鐘內有效；大小寫和「-」都可以省略。',
    wrongAccountHtml: '不是這個帳號？請先到 <a href="/">smurg 網頁版</a>登出，再回到這個頁面。',
    wrongCode: '代碼不正確或已失效。請確認終端機上的代碼（8 個英文字母，10 分鐘內有效）。',
    tooManyWrongCodes: (minutes: number) => `輸入錯誤的次數太多，請在 ${minutes} 分鐘後再試。`,
    accountChanged: '這個瀏覽器登入的帳號在這段時間內換過了。請確認目前的帳號，再輸入一次代碼。',

    confirmTitle: '允許 smurg CLI 登入嗎？',
    confirmIntroHtml: (origin: string) =>
      `按「允許」之後，執行 <code>smurg login</code> 的那台電腦就會以你的帳號登入 relay <strong>${origin}</strong>（7 天內有效）。`,
    account: '帳號',
    code: '代碼',
    requestFrom: '要求來自',
    requestTime: '要求時間',
    requestOrigin: (ip: string | null, place: string) => `IP 位址 ${ip ?? '不明'}，位置大約在 ${place}`,
    warningMain: '只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。',
    warningNote: 'IP 位址和位置是執行 smurg login 的電腦連到 relay 時，relay 看到的（位置是推測的，可能不準；透過 SSH 執行時是那台遠端電腦）。',
    allow: '允許',
    deny: '拒絕',

    placeCityCountry: (city: string, country: string) => `${city}，${country}`,
    placeUnknown: '不明',
    torNetwork: 'Tor 網路',
    age: (minutes: number, utc: string) => (minutes === 0 ? `不到 1 分鐘前（${utc}）` : `${minutes} 分鐘前（${utc}）`),

    allowedTitle: '已允許',
    allowedText: '終端機裡的 smurg 會在幾秒內完成登入，之後就可以關閉這個頁面。',
    deniedTitle: '已拒絕',
    deniedText: '這次登入不會完成，終端機裡的 smurg 會顯示登入被拒絕。',
    deniedWarning: '如果那不是你自己執行的 smurg login，有人可能想用你的帳號登入：不要把代碼告訴別人。',
    goneTitle: '代碼已失效',
    goneText: '這個代碼已經用過、被拒絕或已過期。請回到終端機重新執行 smurg login。',
    enterAnotherCode: '輸入另一組代碼',

    cannotContinueTitle: '無法繼續',
    notFromDevicePage: '這個要求不是從 relay 的 /device 頁面送出的，已經拒絕。請直接在瀏覽器打開終端機顯示的網址。',
    unknownDecision: '不認得的選擇，請重新輸入代碼。',
    cannotLogInTitle: '無法登入',
    badLoginLink: '登入連結無效或已過期，請回到原本的頁面重新登入。',
    providerNotConfigured: (provider: string) => `這個 relay 尚未設定 ${provider} 登入。`,
    loginTimedOutOrDone: '登入逾時或已在其他分頁完成，請重新登入。',
    loginTimedOut: '登入逾時，請重新登入。',
    stateMismatch: '登入請求不相符（state 錯誤），請重新登入。',
    loginCancelled: '你取消了登入，或登入服務拒絕了這次請求。',
    noAuthorizationCode: '登入服務沒有回傳授權碼。',
    cannotConfirmIdentity: (provider: string) => `無法向 ${provider} 確認你的身分，請稍後再試。`,
    devNameRule: '開發用帳號名稱只能包含英數字、「.」、「_」、「-」，最多 64 個字元。',
  },
};
