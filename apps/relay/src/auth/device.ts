// The CLI's device-code login (RFC 8628 style; ARCHITECTURE §6, decided 2026-10-01). It replaces the loopback login
// (./routes.ts, deprecated): nothing has to reach the CLI's machine from the browser, so it works the same over SSH and
// the code can be entered on any device, a phone included.
//
//   POST /auth/device/start                  JSON → { deviceCode, userCode, verificationUri, expiresIn, interval }
//   POST /auth/device/token { deviceCode }   JSON → the session (sessionJson) once allowed, issued once; until then 400
//                                            authorization_pending / slow_down / access_denied / expired_token /
//                                            invalid_request
//   GET  /device                             the relay's login (it comes back here), then the code form
//   POST /device  code                       same-origin form → the confirmation screen
//   POST /device  code, account, decision    same-origin form → allow / deny, bound to this browser session's identity
//
// The pending logins and the rate limits live in DeviceLoginDO (./device-store.ts). /device never takes the code from
// its URL: a prefilled link would let an attacker send someone a link carrying the attacker's own code.
import {
  DEVICE_CODE_PATTERN,
  DEVICE_LOGIN_INTERVAL_SECONDS,
  DEVICE_LOGIN_TTL_SECONDS,
  RELAY_PATHS,
  formatDeviceUserCode,
  normalizeDeviceUserCode,
  type DeviceTokenError,
} from '@smurg/protocol/relay';
import type { RequestContext } from '../context.ts';
import { randomToken, sha256Base64url } from '../lib/base64url.ts';
import { devLoginEnabled } from '../lib/config.ts';
import {
  DEVICE_LIMITS,
  ageText,
  minutesUntil,
  placeText,
  randomUserCode,
  requestPlace,
  type DeviceLoginRecord,
} from '../lib/device.ts';
import { deviceCodePage, deviceConfirmPage, deviceLoginPage, deviceResultPage, errorPage } from '../lib/html.ts';
import { errorResponse, htmlResponse, isRecord, jsonResponse, readFormBody, readJsonBody } from '../lib/http.ts';
import type { Identity } from './identity.ts';
import { isSameOriginFormPost, methodNotAllowed, sessionJson } from './routes.ts';
import { authenticate } from './session.ts';

const WRONG_CODE = '代碼不正確或已失效。請確認終端機上的代碼（8 個英文字母，10 分鐘內有效）。';

function loginObject(ctx: RequestContext, userCode: string) {
  return ctx.env.DEVICE_LOGIN.getByName(`code:${userCode}`);
}

/** A counter; IP addresses and account ids are hashed into the object's name. */
async function limitObject(ctx: RequestContext, kind: 'start-ip' | 'code-ip' | 'code-account', key: string) {
  return ctx.env.DEVICE_LOGIN.getByName(`limit:${kind}:${await sha256Base64url(`smurg-device-limit:${kind}:${key}`)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// CLI side (JSON)
// ---------------------------------------------------------------------------------------------------------------

/** POST /auth/device/start [{}]: a new pending login, 10 minutes. No session needed; bounded per IP address. */
export async function handleDeviceStart(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'POST') return methodNotAllowed();
  const body = await readJsonBody(ctx.req, { optional: true });
  if (!body.ok) return body.response;
  if (body.value !== undefined && !isRecord(body.value)) return errorResponse(400, 'invalid_request', 'expected a JSON object');
  const now = Date.now();
  const place = requestPlace(ctx.req);
  const refusedUntil = await (await limitObject(ctx, 'start-ip', place.ip ?? 'unknown')).take(DEVICE_LIMITS.startsPerIp, DEVICE_LIMITS.windowMs, now);
  if (refusedUntil !== null) {
    const response = errorResponse(429, 'too_many_requests', 'too many logins were started from this address; try again later');
    response.headers.set('retry-after', String(Math.ceil((refusedUntil - now) / 1000)));
    return response;
  }
  const secret = randomToken(32);
  const secretHash = await sha256Base64url(secret);
  // A collision with a live login is about one in 2^34 per pending login: drawing again is enough.
  for (let attempt = 0; attempt < 4; attempt++) {
    const userCode = randomUserCode();
    const record: DeviceLoginRecord = {
      userCode,
      secretHash,
      createdAt: now,
      expiresAt: now + DEVICE_LOGIN_TTL_SECONDS * 1000,
      interval: DEVICE_LOGIN_INTERVAL_SECONDS,
      ...place,
      status: 'pending',
    };
    if (await loginObject(ctx, userCode).create(record)) {
      return jsonResponse({
        deviceCode: `${userCode}.${secret}`,
        userCode: formatDeviceUserCode(userCode),
        verificationUri: `${ctx.config.issuer}${RELAY_PATHS.device}`,
        expiresIn: DEVICE_LOGIN_TTL_SECONDS,
        interval: DEVICE_LOGIN_INTERVAL_SECONDS,
      });
    }
  }
  return errorResponse(503, 'unavailable', 'no free user code; try again');
}

function tokenError(error: DeviceTokenError, message?: string): Response {
  return errorResponse(400, error, message);
}

/** POST /auth/device/token { deviceCode }: the session once the login was allowed (and never again), or an RFC 8628 error. */
export async function handleDeviceToken(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method !== 'POST') return methodNotAllowed();
  const body = await readJsonBody(ctx.req);
  const deviceCode = body.ok && isRecord(body.value) ? body.value['deviceCode'] : undefined;
  const match = typeof deviceCode === 'string' ? DEVICE_CODE_PATTERN.exec(deviceCode) : null;
  if (!match) return tokenError('invalid_request', 'expected { deviceCode } as JSON');
  const [, userCode = '', secret = ''] = match;
  const result = await loginObject(ctx, userCode).poll(await sha256Base64url(secret), Date.now());
  switch (result.status) {
    case 'pending':
      return tokenError('authorization_pending');
    case 'slow_down':
      return tokenError('slow_down', `poll at most every ${DEVICE_LOGIN_INTERVAL_SECONDS} s, plus 5 s for every slow_down`);
    case 'denied':
      return tokenError('access_denied');
    case 'expired':
      return tokenError('expired_token');
    case 'approved':
      // Defence in depth, as for every session: a dev identity only where the dev login itself is open.
      if (result.identity.provider === 'dev' && !devLoginEnabled(ctx.config, ctx.url)) return tokenError('access_denied');
      return sessionJson(ctx, result.identity);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Browser side: /device
// ---------------------------------------------------------------------------------------------------------------

/** Every /device page: its forms post back here, so the browser must send the real Origin (HtmlOptions). */
function devicePage(html: string, status = 200): Response {
  return htmlResponse(html, status, [], { referrerPolicy: 'same-origin' });
}

/** The account of this browser's relay session (the cookie; a bearer token is not a browser session), or null. */
async function browserAccount(ctx: RequestContext): Promise<Identity | null> {
  const outcome = await authenticate(ctx);
  return outcome.status === 'ok' && outcome.auth.via === 'cookie' ? outcome.auth.identity : null;
}

function loginPage(ctx: RequestContext): Response {
  const choice = { github: ctx.config.github !== null, google: ctx.config.google !== null, dev: devLoginEnabled(ctx.config, ctx.url) };
  return devicePage(deviceLoginPage(choice, { relayOrigin: ctx.config.issuer }));
}

/** GET /device: the relay's login, or the code form. POST /device: a code, or a decision. */
export async function handleDevicePage(ctx: RequestContext): Promise<Response> {
  if (ctx.req.method === 'POST') return handleDeviceForm(ctx);
  if (ctx.req.method !== 'GET') return methodNotAllowed();
  const account = await browserAccount(ctx);
  return account === null ? loginPage(ctx) : devicePage(deviceCodePage(account));
}

async function handleDeviceForm(ctx: RequestContext): Promise<Response> {
  if (!isSameOriginFormPost(ctx)) {
    return htmlResponse(errorPage('無法繼續', '這個要求不是從 relay 的 /device 頁面送出的，已經拒絕。請直接在瀏覽器打開終端機顯示的網址。'), 403);
  }
  const form = await readFormBody(ctx.req);
  if (!form.ok) return form.response;
  const account = await browserAccount(ctx);
  // Logged out in the meantime (another tab, an expired session): log in again first.
  if (account === null) return loginPage(ctx);

  const now = Date.now();
  const ip = requestPlace(ctx.req).ip ?? 'unknown';
  const limits = [
    { object: await limitObject(ctx, 'code-account', account.userId), max: DEVICE_LIMITS.wrongCodesPerAccount },
    { object: await limitObject(ctx, 'code-ip', ip), max: DEVICE_LIMITS.wrongCodesPerIp },
  ];
  // Checked before the code is looked up, so a blocked account or address learns nothing about any code.
  const blocked = (await Promise.all(limits.map(({ object, max }) => object.blockedUntil(max, now)))).filter((end) => end !== null);
  if (blocked.length > 0) {
    const error = `輸入錯誤的次數太多，請在 ${minutesUntil(Math.max(...blocked), now)}後再試。`;
    return devicePage(deviceCodePage(account, { error }), 429);
  }

  const typed = form.value.get('code') ?? '';
  const userCode = normalizeDeviceUserCode(typed);
  const login = userCode === null ? null : await loginObject(ctx, userCode).pending(now);
  if (userCode === null || login === null) {
    // Unknown, malformed, expired, already decided (also by another account): all count as a wrong code, the
    // decision form too, so it cannot be used to guess codes either.
    await Promise.all(limits.map(({ object, max }) => object.take(max, DEVICE_LIMITS.windowMs, now)));
    return devicePage(deviceCodePage(account, { error: WRONG_CODE, value: typed }), 400);
  }

  const decision = form.value.get('decision');
  if (decision === null) {
    return devicePage(
      deviceConfirmPage(
        account,
        {
          userCode: formatDeviceUserCode(userCode),
          codeField: userCode,
          ip: login.ip,
          place: placeText(login.country, login.city),
          age: ageText(login.createdAt, now),
        },
        { relayOrigin: ctx.config.issuer },
      ),
    );
  }
  if (decision !== 'allow' && decision !== 'deny') return devicePage(errorPage('無法繼續', '不認得的選擇，請重新輸入代碼。'), 400);
  // The screen named an account; the decision must come from that same account (another tab may have switched it).
  if (form.value.get('account') !== account.userId) {
    return devicePage(deviceCodePage(account, { error: '這個瀏覽器登入的帳號在這段時間內換過了。請確認目前的帳號，再輸入一次代碼。' }), 409);
  }
  if ((await loginObject(ctx, userCode).decide(decision, account, now)) === 'gone') {
    return devicePage(deviceResultPage('代碼已失效', ['這個代碼已經用過、被拒絕或已過期。請回到終端機重新執行 smurg login。'], { href: RELAY_PATHS.device, label: '輸入另一組代碼' }), 410);
  }
  return devicePage(
    decision === 'allow'
      ? deviceResultPage('已允許', ['終端機裡的 smurg 會在幾秒內完成登入，之後就可以關閉這個頁面。'])
      : deviceResultPage('已拒絕', [
          '這次登入不會完成，終端機裡的 smurg 會顯示登入被拒絕。',
          '如果那不是你自己執行的 smurg login，有人可能想用你的帳號登入：不要把代碼告訴別人。',
        ]),
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tests: DEV_LOGIN=1 AND a local hostname, otherwise 404 (like /api/debug/room)
// ---------------------------------------------------------------------------------------------------------------

/**
 * `GET /api/debug/device-login?code=<user code>` or `?limit=<kind>&key=<address or account>`: what that object stores
 * (DeviceLoginInspection). `POST …?code=<user code>&expire=1`: the login expires now (the tests cannot wait 10 minutes).
 */
export async function handleDeviceDebug(ctx: RequestContext): Promise<Response> {
  if (!devLoginEnabled(ctx.config, ctx.url)) return errorResponse(404, 'not_found');
  const params = ctx.url.searchParams;
  const userCode = normalizeDeviceUserCode(params.get('code') ?? '');
  const kind = params.get('limit');
  const key = params.get('key');
  let object;
  if (userCode !== null) object = loginObject(ctx, userCode);
  else if ((kind === 'start-ip' || kind === 'code-ip' || kind === 'code-account') && key !== null) object = await limitObject(ctx, kind, key);
  else return errorResponse(400, 'bad_request');
  if (ctx.req.method === 'POST' && params.get('expire') === '1' && userCode !== null) await object.expireNow();
  else if (ctx.req.method !== 'GET') return methodNotAllowed();
  return jsonResponse(await object.inspect());
}
