// Failures that originate in the client SDK (src/client/errors.ts, CLIENT_REQUEST_FAILURES): the request never got a
// daemon answer. `client.<failure>` in camelCase; the two `...OutcomeUnknown` messages are for a request that had
// already been sent when it timed out or was cancelled (it may or may not have happened).
import { message } from '../define.ts';

export const client = {
  'client.timeout': message({}, {
    en: () => 'The request timed out. The host may be offline.',
    'zh-TW': () => '請求逾時，主人可能已離線',
  }),
  'client.cancelled': message({}, {
    en: () => 'The request was cancelled.',
    'zh-TW': () => '請求已取消',
  }),
  'client.connectionLost': message({}, {
    en: () => 'The connection dropped, so this action may not have finished. Reload and check.',
    'zh-TW': () => '連線中斷，這個動作可能沒有完成，請重新整理後確認',
  }),
  'client.closed': message({}, {
    en: () => 'The connection is closed.',
    'zh-TW': () => '連線已關閉',
  }),
  'client.notConnected': message({}, {
    en: () => 'Not connected right now.',
    'zh-TW': () => '目前沒有連線',
  }),
  'client.overflow': message({}, {
    en: () => 'Too much data is waiting to be sent. Try again later.',
    'zh-TW': () => '待送出的資料太多，請稍後再試',
  }),
  'client.timeoutOutcomeUnknown': message({}, {
    en: () => 'The request timed out. It may or may not have gone through: check the result before you retry.',
    'zh-TW': () => '請求逾時：這個動作可能已經完成，也可能沒有，請先確認結果再重試',
  }),
  'client.cancelledOutcomeUnknown': message({}, {
    en: () => 'The request was cancelled. It may or may not have gone through: check the result first.',
    'zh-TW': () => '請求已取消：這個動作可能已經完成，也可能沒有，請先確認結果',
  }),
} as const;
