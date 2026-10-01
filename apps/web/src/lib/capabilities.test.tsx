import { act, render, screen } from '@testing-library/react';
import { CAPABILITIES, CAPABILITY_MATRIX, ROLES } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { WorkspaceTestProviders, createTestWorkspace } from '../testing/services.tsx';
import { makeMember } from '../testing/fixtures.ts';
import { canRole, capabilitiesForRole, drivesSession, isRiskyRole } from './capabilities.ts';
import { Can, useCan, useCapabilities } from './workspace/context.tsx';

describe('capability helper (UI hiding only; the daemon enforces)', () => {
  it('matches the protocol roles matrix cell by cell', () => {
    for (const role of ROLES) {
      for (const capability of CAPABILITIES) {
        expect(canRole(role, capability), `${role} ${capability}`).toBe(CAPABILITY_MATRIX[capability][role]);
        expect(capabilitiesForRole(role).can(capability)).toBe(CAPABILITY_MATRIX[capability][role]);
      }
    }
  });

  it('denies everything before admission and for unknown values (fail closed)', () => {
    for (const capability of CAPABILITIES) {
      expect(canRole(null, capability)).toBe(false);
      expect(canRole(undefined, capability)).toBe(false);
      expect(canRole('superuser' as never, capability)).toBe(false);
    }
    expect(canRole('host', 'root' as never)).toBe(false);
  });

  it('the host and 「可使用 agent」 open sessions and type into any session; editors and viewers do neither', () => {
    for (const role of ['host', 'agent'] as const) {
      expect(capabilitiesForRole(role).canCreateSession, role).toBe(true);
      expect(capabilitiesForRole(role).canDrive, role).toBe(true);
    }
    for (const role of ['editor', 'viewer', null] as const) {
      expect(capabilitiesForRole(role).canCreateSession, String(role)).toBe(false);
      expect(capabilitiesForRole(role).canDrive, String(role)).toBe(false);
    }
    expect(capabilitiesForRole(null).all).toEqual([]);
  });

  it('a driver types into any running session, never into an ended one; nobody else types', () => {
    expect(drivesSession(capabilitiesForRole('agent'), { status: 'running' })).toBe(true);
    expect(drivesSession(capabilitiesForRole('host'), { status: 'starting' })).toBe(true);
    expect(drivesSession(capabilitiesForRole('agent'), { status: 'exited' })).toBe(false);
    expect(drivesSession(capabilitiesForRole('editor'), { status: 'running' })).toBe(false);
    expect(drivesSession(capabilitiesForRole('viewer'), { status: 'running' })).toBe(false);
  });

  it('only 「可使用 agent」 is a role whose hand-out asks the host to confirm the risk', () => {
    expect(isRiskyRole('agent')).toBe(true);
    expect(isRiskyRole('editor')).toBe(false);
    expect(isRiskyRole('viewer')).toBe(false);
    expect(isRiskyRole('host')).toBe(false);
  });

  it("useCan('file.write') follows a live role change (channel.memberUpdated)", () => {
    const context = createTestWorkspace({ role: 'editor' });
    function Probe() {
      const canWrite = useCan('file.write');
      const caps = useCapabilities();
      return (
        <>
          <p>{canWrite ? 'write:yes' : 'write:no'}</p>
          <p>{`role:${caps.role}`}</p>
          <Can capability="admin" fallback={<p>console:hidden</p>}>
            <p>console:shown</p>
          </Can>
        </>
      );
    }
    render(
      <WorkspaceTestProviders context={context}>
        <Probe />
      </WorkspaceTestProviders>,
    );
    expect(screen.getByText('write:yes')).toBeTruthy();
    expect(screen.getByText('console:hidden')).toBeTruthy();
    act(() => context.conn.emit('channel.memberUpdated', { member: makeMember({ role: 'viewer' }) }));
    expect(screen.getByText('write:no')).toBeTruthy();
    expect(screen.getByText('role:viewer')).toBeTruthy();
  });
});
