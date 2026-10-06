// What the worktree feature contributes to the workspace shell (lib/slots.ts): the toast that tells the person who
// asked for a merge what the host decided. Its review pieces are mounted by the topics feature's columns and by the
// host console; its switcher by code mode.
import { lazy } from 'react';
import { defineSlots } from '../../lib/slots.ts';

export const slots = defineSlots({ feature: 'worktree', overlays: [lazy(() => import('./MergeNotices.tsx'))] });
