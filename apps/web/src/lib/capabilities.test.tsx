import { act, render, screen } from '@testing-library/react';
import { CAPABILITIES, CAPABILITY_MATRIX, ROLES } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { WorkspaceTestProviders, createTestWorkspace } from '../testing/services.tsx';
import { makeMember } from '../testing/fixtures.ts';
import { canRole, capabilitiesForRole } from './capabilities.ts';
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

  it('knows which session a role creates (host: unsandboxed, runner: sandboxed, others: none)', () => {
    expect(capabilitiesForRole('host').sessionCreate).toBe('session.create.host');
    expect(capabilitiesForRole('runner').sessionCreate).toBe('session.create.sandboxed');
    expect(capabilitiesForRole('editor').sessionCreate).toBeNull();
    expect(capabilitiesForRole('viewer').sessionCreate).toBeNull();
    expect(capabilitiesForRole(null).all).toEqual([]);
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
