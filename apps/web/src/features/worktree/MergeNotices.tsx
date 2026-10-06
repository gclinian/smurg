// Mounted once by the workspace shell (slots.tsx, in both modes): the person who asked for a merge hears what the host
// decided wherever they are. Renders nothing.
import { useMember } from '../../lib/workspace/context.tsx';
import { useMergeResultNotices } from './use-merge-notices.ts';

export default function MergeNotices(): null {
  useMergeResultNotices(useMember()?.userId ?? null);
  return null;
}
