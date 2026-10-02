// The small zh-TW suite of the daemon. The daemon itself is English only; what a zh-TW member reads is rendered by
// the client from the references the daemon sends. This drives a real daemon and renders what arrives, the way the
// web app and the CLI do: `render('zh-TW', x.text) ?? <English fallback>`.
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError, type FileRef } from '@smurg/protocol';
import { msg, render, roleLabel } from '@smurg/protocol/i18n';
import { agentHeldReason, humanHeldReason } from '../src/hooks/deny-text.ts';
import { locksModule } from '../src/locks/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';
import { agentSession, preToolUse, recorder } from './locks/agent-sim.ts';

const CJK = /[\u3400-\u9fff]/u;
const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

let t: TestDaemon | null = null;
afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('what a zh-TW member reads (rendered by the client from the daemon\'s references)', () => {
  it('an error: the specific sentence, the default of a code, and the English fallback next to it', async () => {
    t = await createTestDaemon({ modules: [locksModule] });
    const host = await t.connectHost();
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'viewer' });
    const specific = await host.conn.request('admin.member.kick', { userId: host.userId }).catch((e: unknown) => e);
    if (!isSmurgError(specific)) throw new Error('expected a SmurgError');
    expect(specific).toMatchObject({ code: 'bad_request', detail: { reason: 'host' }, text: { id: 'member.hostNotRemovable' }, message: 'The host cannot be removed.' });
    expect(render('zh-TW', specific.text)).toBe('不能踢掉主人');
    const unknown = await host.conn.request('admin.member.kick', { userId: 'dev:nobody' }).catch((e: unknown) => e);
    expect(unknown).toMatchObject({ code: 'not_found', detail: { reason: 'unknown-member' }, text: { id: 'member.notFound' } });
    const refused = await amy.conn.request('admin.member.list', {}).catch((e: unknown) => e);
    if (!isSmurgError(refused)) throw new Error('expected a SmurgError');
    expect(refused).toMatchObject({ code: 'forbidden', text: { id: 'error.default.forbidden' }, message: 'You do not have permission to do this.' });
    expect(render('zh-TW', refused.text)).toBe('你沒有權限執行這個動作');
    expect(roleLabel('zh-TW', 'agent')).toBe('可使用 agent');
    expect(roleLabel('en', 'agent')).toBe('Agent access');
  });

  it('the activity feed: one event, two languages, the same agent name in both', async () => {
    t = await createTestDaemon({ modules: [locksModule], project: { files: { 'README.md': '# hi\n' } } });
    const host = await t.connectHost();
    await t.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'agent' });
    const live = recorder(host.conn, 'activity.event');
    t.ctx.services.locks.touchHuman(main('README.md'), { userId: 'dev:host', displayName: 'Host' });
    expect(preToolUse(t, agentSession('ses_ian', 'dev:ian', 'Ian'), main('README.md')).granted).toBe(false);
    await waitFor(() => live.length >= 1, { what: 'the lock.denied entry' });
    const event = live[0]?.event;
    expect(event?.summary).toBe('Claude (Ian) wanted to change README.md, but Host is editing it: blocked');
    expect(render('en', event?.text)).toBe(event?.summary);
    expect(render('zh-TW', event?.text)).toBe('Claude (Ian) 想修改 README.md，但 Host 正在編輯，已被擋下');
    expect(event?.actor).toMatchObject({ kind: 'agent', displayName: 'Claude (Ian)' });
  });

  it('a notification the daemon wrote; an agent\'s own words are never translated', async () => {
    t = await createTestDaemon({ modules: [locksModule] });
    const amy = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'agent' });
    const notes = recorder(amy.conn, 'activity.notify');
    const ref = msg('notify.claudeVersionUnverified', { version: '2.9.0', verified: ['2.1.0', '2.1.1'] });
    t.ctx.services.activity.notify('dev:amy', { from: { kind: 'system' }, msg: ref, fallback: render('en', ref) ?? '' });
    t.ctx.services.activity.notify('dev:amy', { from: { kind: 'agent', sessionId: 'ses_1', ownerUserId: 'dev:amy', displayName: 'Claude (Amy)' }, text: 'done with src/app.ts' });
    await waitFor(() => notes.length === 2, { what: 'both notifications' });
    const written = notes[0]?.notification;
    expect(written?.text).toBeUndefined();
    expect(written?.fallback).toBe('Note: Claude Code 2.9.0 has not been verified with smurg yet (verified: 2.1.0, 2.1.1). Report any problem you run into.');
    expect(render('zh-TW', written?.msg)).toBe('注意：Claude Code 2.9.0 尚未經過 smurg 驗證（已驗證：2.1.0、2.1.1），如遇問題請回報。');
    expect(notes[1]?.notification).toMatchObject({ text: 'done with src/app.ts' });
    expect(notes[1]?.notification.msg).toBeUndefined();
  });

  it('what an AGENT reads stays English whatever language the members use', () => {
    expect(humanHeldReason(['小明'])).toBe('This file is being edited by 小明. Work on other files first, or try again later.');
    expect(agentHeldReason('Claude (Ian)').replace('Claude (Ian)', '')).not.toMatch(CJK);
  });
});
