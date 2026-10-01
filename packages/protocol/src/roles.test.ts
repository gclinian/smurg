import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CAPABILITY_MATRIX,
  type Capability,
  GUEST_ROLES,
  ROLES,
  type Role,
  can,
  capabilitiesOf,
  guestRoleSchema,
  isCapability,
  isGuestRole,
  isRole,
  roleSchema,
} from './roles.ts';

// SPEC §8 as the owner changed it on 2026-10-01 (ARCHITECTURE §11 D-15: no guest sandbox, 「可使用 agent」 replaces
// 「可執行 agent」), transcribed row by row. Columns: 主人 host | 可使用 agent agent | 可編輯 editor | 旁觀 viewer.
// '—' (not applicable) and '❌' both mean "does not have it". '提出請求' (may request) is its own cell value.
type Cell = '✅' | '❌' | '—' | '提出請求';
type SpecRow = { readonly spec: string; readonly cells: readonly [Cell, Cell, Cell, Cell]; readonly capabilities: readonly Capability[] };

const SPEC_8: readonly SpecRow[] = [
  { spec: '瀏覽檔案、看所有 agent session', cells: ['✅', '✅', '✅', '✅'], capabilities: ['file.read', 'session.view'] },
  { spec: '編輯、上傳檔案', cells: ['✅', '✅', '✅', '❌'], capabilities: ['file.write'] },
  { spec: '下載檔案', cells: ['✅', '✅', '✅', '✅'], capabilities: ['file.download'] },
  { spec: '對別人的 session 提建議', cells: ['✅', '✅', '✅', '❌'], capabilities: ['suggest.create'] },
  {
    spec: '開 agent session 和一般終端機（以主人的身分執行，無沙盒，用主人的 Claude 登入）',
    cells: ['✅', '✅', '❌', '❌'],
    capabilities: ['session.create'],
  },
  {
    spec: '直接在任何 session 裡輸入、採用或拒絕別人對它的建議',
    cells: ['✅', '✅', '❌', '❌'],
    capabilities: ['session.drive'],
  },
  // 「請主人代為執行 [上線]」 (R10) is launch-phase: it has no capability in the prototype (see below).
  {
    spec: '邀請、改角色、踢人、看操作紀錄、強制釋放檔案鎖',
    cells: ['✅', '❌', '❌', '❌'],
    capabilities: ['admin', 'lock.force-release'],
  },
];

// 「合併 worktree 回主工作區」: host ✅, agent 提出請求, editor ❌, viewer ❌. ARCHITECTURE §3 splits it into
// merge.decide (the ✅) and merge.request (the 提出請求; the host may also request).
const MERGE_ROW = { cells: ['✅', '提出請求', '❌', '❌'] as const };

// ARCHITECTURE §3 table, transcribed.
const ARCH_3: Record<Capability, readonly [boolean, boolean, boolean, boolean]> = {
  'file.read': [true, true, true, true],
  'file.download': [true, true, true, true],
  'session.view': [true, true, true, true],
  'file.write': [true, true, true, false],
  'suggest.create': [true, true, true, false],
  'session.create': [true, true, false, false],
  'session.drive': [true, true, false, false],
  'worktree.merge.request': [true, true, false, false],
  'worktree.merge.decide': [true, false, false, false],
  'lock.force-release': [true, false, false, false],
  admin: [true, false, false, false],
};

describe('roles', () => {
  it('are exactly the four of SPEC §8, in its column order', () => {
    expect(ROLES).toEqual(['host', 'agent', 'editor', 'viewer']);
    expect(GUEST_ROLES).toEqual(['agent', 'editor', 'viewer']);
  });


  it('validate strictly', () => {
    for (const role of ROLES) expect(roleSchema.parse(role)).toBe(role);
    for (const bad of ['owner', 'Host', '', null, 1]) expect(roleSchema.safeParse(bad).success).toBe(false);
    expect(guestRoleSchema.safeParse('host').success).toBe(false);
    expect(isRole('viewer')).toBe(true);
    expect(isRole('admin')).toBe(false);
    expect(isGuestRole('host')).toBe(false);
    expect(isCapability('admin')).toBe(true);
    expect(isCapability('root')).toBe(false);
  });
});

describe('capability matrix vs SPEC §8 (cell by cell)', () => {
  for (const row of SPEC_8) {
    for (const [column, role] of ROLES.entries()) {
      const cell = row.cells[column] as Cell;
      for (const capability of row.capabilities) {
        it(`${row.spec} | ${role} = ${cell} → can(${role}, ${capability}) is ${cell === '✅'}`, () => {
          expect(can(role, capability)).toBe(cell === '✅');
        });
      }
    }
  }

  for (const [column, role] of ROLES.entries()) {
    const cell = MERGE_ROW.cells[column];
    it(`合併 worktree | ${role} = ${cell}`, () => {
      expect(can(role, 'worktree.merge.decide')).toBe(cell === '✅');
      // Whoever may decide or request may request; nobody else.
      expect(can(role, 'worktree.merge.request')).toBe(cell === '✅' || cell === '提出請求');
    });
  }

  it('R10 run-on-behalf is not a prototype capability', () => {
    expect(CAPABILITIES.some((capability) => capability.startsWith('exec.request'))).toBe(false);
  });
});

describe('capability matrix vs ARCHITECTURE §3 (cell by cell)', () => {
  it('covers exactly the capabilities of §3', () => {
    expect([...CAPABILITIES].sort()).toEqual(Object.keys(ARCH_3).sort());
    expect(Object.keys(CAPABILITY_MATRIX).sort()).toEqual(Object.keys(ARCH_3).sort());
  });

  for (const capability of CAPABILITIES) {
    for (const [column, role] of ROLES.entries()) {
      const expected = ARCH_3[capability][column] as boolean;
      it(`${capability} | ${role} = ${expected}`, () => {
        expect(can(role, capability)).toBe(expected);
      });
    }
  }
});

describe('can()', () => {
  it('fails closed on values that skipped validation', () => {
    expect(can('owner' as Role, 'file.read')).toBe(false);
    expect(can('host', 'root' as Capability)).toBe(false);
    expect(can('host', '__proto__' as Capability)).toBe(false);
    expect(can('toString' as Role, 'admin')).toBe(false);
  });

  it('cannot be changed at runtime', () => {
    expect(Object.isFrozen(CAPABILITY_MATRIX)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_MATRIX.admin)).toBe(true);
    expect(() => {
      (CAPABILITY_MATRIX.admin as { viewer: boolean }).viewer = true;
    }).toThrow(TypeError);
    expect(can('viewer', 'admin')).toBe(false);
  });

  it('capabilitiesOf lists the row', () => {
    expect(capabilitiesOf('viewer')).toEqual(['file.read', 'file.download', 'session.view']);
    expect(capabilitiesOf('editor')).toEqual(['file.read', 'file.download', 'file.write', 'session.view', 'suggest.create']);
    expect(capabilitiesOf('agent')).toEqual([
      'file.read',
      'file.download',
      'file.write',
      'session.view',
      'session.create',
      'session.drive',
      'suggest.create',
      'worktree.merge.request',
    ]);
  });

  it("the agent role is everything but the host's administration", () => {
    const hostOnly = CAPABILITIES.filter((capability) => can('host', capability) && !can('agent', capability));
    expect(hostOnly).toEqual(['worktree.merge.decide', 'lock.force-release', 'admin']);
  });
});
