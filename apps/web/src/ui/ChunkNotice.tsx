// What the page says when a part of it could not be loaded (lib/chunks.ts: ChunkLoadError), the same words wherever
// it happens: in a slot (ui/Boundary.tsx), in the editor, a terminal or the transfers panel (their own place), for
// the whole page (app/PageBoundary.tsx), for a failure that has no place of its own in the workspace's banner, and in
// the message for something a person just tried that needed the part (`chunkToast`).
//
// The words depend on why: "smurg was updated" only when the server no longer has the file; a lost network is said
// to be that. The one action is "Reload the page": a browser keeps a failed import for as long as the page lives.
import { chunkFailures, page, worstChunkFailure, type ChunkFailure, type ChunkLoadError } from '../lib/chunks.ts';
import { useStore } from '../lib/store.ts';
import { tUi } from '../strings/ui.ts';
import { Button, type ButtonSize, type ButtonVariant } from './Button.tsx';
import { Banner, EmptyState } from './Feedback.tsx';
import { IconAlertTriangle, IconCloudOff, IconRefresh } from './icons.tsx';
import type { ToastInput } from './Toast.tsx';

/** The title and the sentence for a reason, in the viewer's language. */
export function chunkNoticeText(reason: ChunkFailure): { title: string; body: string } {
  switch (reason) {
    case 'gone':
      return { title: tUi('chunk.gone.title'), body: tUi('chunk.gone.body') };
    case 'offline':
      return { title: tUi('chunk.offline.title'), body: tUi('chunk.offline.body') };
    case 'failed':
      return { title: tUi('chunk.failed.title'), body: tUi('chunk.failed.body') };
  }
}

export function ChunkNoticeIcon({ reason, size = 20 }: { reason: ChunkFailure; size?: number }) {
  if (reason === 'gone') return <IconRefresh size={size} />;
  if (reason === 'offline') return <IconCloudOff size={size} />;
  return <IconAlertTriangle size={size} />;
}

export function ReloadButton({ size = 'sm', variant = 'primary' }: { size?: ButtonSize; variant?: ButtonVariant }) {
  return (
    <Button size={size} variant={variant} onClick={() => page.reload()}>
      {tUi('chunk.reload')}
    </Button>
  );
}

/**
 * The same words as a message (`useToast().show(chunkToast(error))`), for an action that needed the part and did
 * nothing (a file dropped while the transfer Worker's file is gone). It stays until it is dismissed: it is the answer
 * to what the person just did, and its one action is the way out.
 */
export function chunkToast(error: ChunkLoadError): ToastInput {
  const { title, body } = chunkNoticeText(error.reason);
  return { tone: 'warning', title, description: body, duration: 0, action: { label: tUi('chunk.reload'), onClick: () => page.reload() } };
}

/** In the place of the part that did not load: a column's body, a panel, the editor. */
export function ChunkNotice({ error }: { error: ChunkLoadError }) {
  const { title, body } = chunkNoticeText(error.reason);
  return (
    <div className="ui-slot-error" role="alert" data-chunk-failure={error.reason}>
      <EmptyState compact icon={<ChunkNoticeIcon reason={error.reason} />} title={title} description={body} action={<ReloadButton />} />
    </div>
  );
}

/**
 * One banner for every failure that has no place of its own (a dialog that would have opened, an overlay that shows
 * nothing by itself): nothing while there is none. The workspace shell mounts it with its other banners.
 */
export function ChunkFailureBanner() {
  const worst = useStore(chunkFailures, worstChunkFailure);
  if (worst === null) return null;
  const { title, body } = chunkNoticeText(worst.reason);
  return (
    <Banner tone="warning" title={title} icon={<ChunkNoticeIcon reason={worst.reason} size={16} />} live="alert" actions={<ReloadButton />}>
      <span data-chunk-failure={worst.reason}>{body}</span>
    </Banner>
  );
}
