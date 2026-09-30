// The files feature's dialogs: a name for a new file / folder or a rename (validated as you type, tree-model.ts), and
// the confirmation before deleting (an alertdialog: deleting is not undoable from here).
import { baseNameOfRelPath, type FileEntry } from '@smurg/protocol';
import { useRef, useState, type FormEvent } from 'react';
import { Button, Dialog, Input } from '../../ui/index.ts';
import { checkNewName } from './tree-model.ts';
import { t } from './strings.ts';

export type NameDialogMode = { readonly kind: 'create'; readonly entryKind: 'file' | 'dir'; readonly parent: string } | { readonly kind: 'rename'; readonly entry: FileEntry };

export interface NameDialogProps {
  readonly mode: NameDialogMode;
  readonly siblings: readonly string[];
  readonly isHost: boolean;
  onSubmit(path: string): Promise<void>;
  onClose(): void;
}

export function NameDialog({ mode, siblings, isHost, onSubmit, onClose }: NameDialogProps) {
  const current = mode.kind === 'rename' ? mode.entry.name : undefined;
  const parent = mode.kind === 'rename' ? mode.entry.path.slice(0, Math.max(0, mode.entry.path.length - mode.entry.name.length - 1)) : mode.parent;
  const [name, setName] = useState(current ?? '');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const check = checkNewName(name, parent, siblings, current === undefined ? { isHost } : { isHost, current });
  const title =
    mode.kind === 'rename'
      ? t('dialog.renameTitle', { name: mode.entry.name })
      : mode.entryKind === 'dir'
        ? t('dialog.newFolderTitle')
        : t('dialog.newFileTitle');
  const where = parent === '' ? t('dialog.inRoot') : t('dialog.inFolder', { folder: parent });

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    setTouched(true);
    if (!check.ok || busy) return;
    setBusy(true);
    onSubmit(check.path).then(onClose, () => setBusy(false));
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={where}
      initialFocus={input}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" type="submit" form="files-name-form" loading={busy} disabled={touched && !check.ok}>
            {mode.kind === 'rename' ? t('dialog.rename') : t('dialog.create')}
          </Button>
        </>
      }
    >
      <form id="files-name-form" onSubmit={submit} noValidate>
        <Input
          ref={input}
          label={mode.kind === 'rename' ? t('dialog.newName') : mode.entryKind === 'dir' ? t('dialog.folderName') : t('dialog.fileName')}
          value={name}
          autoComplete="off"
          spellCheck={false}
          error={(touched || name !== (current ?? '')) && !check.ok ? check.message : undefined}
          onChange={(event) => setName(event.currentTarget.value)}
          onFocus={(event) => {
            // Select the name without its extension, as file managers do.
            const value = event.currentTarget.value;
            const dot = value.lastIndexOf('.');
            event.currentTarget.setSelectionRange(0, dot > 0 ? dot : value.length);
          }}
        />
      </form>
    </Dialog>
  );
}

export interface DeleteDialogProps {
  readonly entry: FileEntry;
  /** Other people (and agents) who have it open or are editing it (tree-model peopleUsing). */
  readonly people?: readonly string[];
  onConfirm(): Promise<void>;
  onClose(): void;
}

export function DeleteDialog({ entry, people = [], onConfirm, onClose }: DeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const name = baseNameOfRelPath(entry.path);
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={entry.kind === 'dir' ? t('dialog.deleteFolderTitle', { name }) : t('dialog.deleteFileTitle', { name })}
      description={entry.kind === 'dir' ? t('dialog.deleteFolderText') : t('dialog.deleteFileText')}
      initialFocus={cancel}
      size="sm"
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              setBusy(true);
              onConfirm().then(onClose, () => setBusy(false));
            }}
          >
            {t('dialog.delete')}
          </Button>
        </>
      }
    >
      {people.length > 0 ? (
        <p className="files-dialog__warning" role="note">
          {t(entry.kind === 'dir' ? 'dialog.deleteFolderInUse' : 'dialog.deleteFileInUse', { names: people.join(t('list.separator')) })}
        </p>
      ) : null}
    </Dialog>
  );
}
