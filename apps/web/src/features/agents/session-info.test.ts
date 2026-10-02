// How a session is described: an ended one (a session the host terminated must not read like a normal
// exit), who opened it (every session runs as the host, protocol v2), and a refused request.
import { describe, expect, it } from 'vitest';
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { describeSessionError, effectiveLogin, kindLabel, openedByLabel, openerName, statusLabel, tabLabel } from './session-info.ts';


describe('statusLabel of an ended session', () => {
  it('names the host who terminated it, and the other reasons a session ends without the person who opened it', () => {
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'terminated', endedBy: { userId: 'github:1', displayName: 'Ian Lin' } })).toBe('Terminated by the host (Ian Lin)');
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'terminated' })).toBe('Terminated by the host');
    expect(statusLabel({ status: 'exited', endReason: 'kicked' })).toBe('Ended (the member who opened it was removed from the workspace)');
    expect(statusLabel({ status: 'exited', endReason: 'left' })).toBe('Ended (the member who opened it left the workspace)');
    expect(statusLabel({ status: 'exited', endReason: 'role-changed' })).toBe('Ended (the member who opened it no longer has agent access)');
    expect(statusLabel({ status: 'exited', endReason: 'stopped' })).toBe('Ended (the host stopped sharing)');
  });

  it('a normal exit (or an older daemon that sends no reason) keeps the exit code', () => {
    expect(statusLabel({ status: 'exited', exitCode: 3, endReason: 'exit' })).toBe('Ended (exit code 3)');
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'ended', endedBy: { userId: 'dev:amy', displayName: 'Amy' } })).toBe('Ended (exit code 0)');
    expect(statusLabel({ status: 'exited', exitCode: 3 })).toBe('Ended (exit code 3)');
    expect(statusLabel({ status: 'running' })).toBe('Running');
  });
});

describe('who opened a session', () => {
  it('the tab names the session, then who opened it: the typed title, or the kind of an untitled session', () => {
    // The host sends no default title (protocol 3): an untitled session is named after its kind.
    expect(tabLabel({ kind: 'agent', ownerName: 'Amy' })).toBe('Claude (Amy)');
    expect(tabLabel({ kind: 'terminal', ownerName: 'Amy' })).toBe('Terminal (Amy)');
    expect(tabLabel({ kind: 'agent', title: 'Fix the login page', ownerName: 'Ian' })).toBe('Fix the login page (Ian)');
  });

  it('the summary says "By Amy", or "By you" for one\'s own; the details row names the person, or "You"', () => {
    expect(openedByLabel({ ownerName: 'Amy', ownerUserId: 'dev:amy' }, 'dev:ian')).toBe('By Amy');
    expect(openedByLabel({ ownerName: 'Amy', ownerUserId: 'dev:amy' }, 'dev:amy')).toBe('By you');
    expect(openerName({ ownerName: 'Amy', ownerUserId: 'dev:amy' }, 'dev:ian')).toBe('Amy');
    expect(openerName({ ownerName: 'Amy', ownerUserId: 'dev:amy' }, 'dev:amy')).toBe('You');
  });

  it('there are two kinds: an agent and a terminal (no login process)', () => {
    expect(kindLabel({ kind: 'agent' })).toBe('Agent (Claude Code)');
    expect(kindLabel({ kind: 'terminal' })).toBe('Terminal');
  });

  it('a re-check of the login counts only until the daemon reports something newer', () => {
    expect(effectiveLogin({ login: 'unknown' }, { login: 'logged-in', against: 'unknown' })).toBe('logged-in');
    expect(effectiveLogin({ login: 'logged-out' }, { login: 'logged-in', against: 'unknown' })).toBe('logged-out');
    expect(effectiveLogin({ login: 'logged-out' }, null)).toBe('logged-out');
  });
});

describe('a refused session request in plain words', () => {
  it('a refusal by role says so; a known reason gets a hint; anything else keeps the daemon\'s message', () => {
    expect(describeSessionError(new SmurgError('forbidden', 'no'))).toMatchObject({ title: 'Could not open the session', message: 'Your role does not allow this.' });
    expect(describeSessionError(new SmurgError('conflict', msg('session.limit'), { reason: 'session-limit' })).hint).toBe('End a session you no longer use, then try again.');
    expect(describeSessionError(new SmurgError('conflict', msg('session.limit'), { reason: 'session-limit' })).message).toBe('The workspace has reached its session limit.');
    expect(describeSessionError(new SmurgError('internal'))).toMatchObject({ message: 'Something went wrong on the host.' });
    expect(describeSessionError(new SmurgError('internal')).hint).toBeUndefined();
  });
});
