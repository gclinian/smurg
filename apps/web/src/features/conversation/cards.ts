// What the three kinds of cards share: how a refusal that came too late reads, how a withdrawn card reads, the name
// of a permission mode.
import { isSmurgError, settledOfError, type PermissionMode, type SettledDetail } from '@smurg/protocol';
import { permissionModeRef, renderEnglish } from '@smurg/protocol/i18n';
import { renderWireText } from '../../lib/errors.ts';
import { t } from './strings.ts';

/** The settled card a refusal names (someone else answered first), or null for any other failure. */
export function settledOf(error: unknown): SettledDetail | null {
  return isSmurgError(error) ? settledOfError(error) : null;
}

/** "Mei already allowed this.": what the member whose click came second is told (the card itself settles by its update). */
export function lateAnswerText(settled: SettledDetail): string {
  const name = settled.by?.displayName ?? t('card.late.someone');
  switch (settled.status) {
    case 'answered':
      return t('card.late.answered', { name });
    case 'allowed':
      return t('card.late.allowed', { name });
    case 'denied':
      return t('card.late.denied', { name });
    case 'accepted':
    case 'accepted-modified':
    case 'rejected':
      return t('card.late.decided', { name });
    case 'withdrawn':
      return t('card.late.withdrawn');
  }
}

/** "Asks before commands": a permission mode in the viewer's language (the wire catalogue's wording). */
export function modeLabel(mode: PermissionMode): string {
  const ref = permissionModeRef(mode);
  return ref === undefined ? mode : renderWireText(ref, renderEnglish(ref));
}
