import { defineStrings } from './catalog.ts';
import { zhTW } from './join.zh-TW.ts';

// The invite acceptance page (/join/:workspaceId, ARCHITECTURE §4.1).
export const tJoin = defineStrings(
  'join',
  {
    title: 'Join a workspace',
    'reading': 'Reading the invite link…',
    'invalid.title': 'The invite link is malformed',
    'invalid.body': 'This invite link is incomplete or was changed, so it cannot be used. Ask the host for a new invite link and copy the whole address (including the part after the "#").',
    'missing.title': 'The invite link is incomplete',
    'missing.body': 'The address lacks the "#k=…&s=…" part, so the identity of the host cannot be checked. Some chat apps cut links short: copy the whole address the host gave you and open it again.',
    'storageMemory': 'This browser does not let sites keep data, so you will have to open the invite link once more after you log in.',
    'login.title': 'Log in to join the workspace',
    'login.body': 'After you log in you come back here and the join continues. The secret part of the invite link stays in this tab and is never sent to any server.',
    'connecting.title': 'Joining the workspace',
    'connecting.hostOffline': "The host's computer is offline. The join continues automatically when the host is back: keep this tab open.",
    'keyChange.title': "The host computer's key has changed",
    'keyChange.lead': "You joined this workspace before, and the key of the host's computer was not the one this invite link records.",
    'keyChange.reason': 'Usually this means the host reinstalled smurg, but someone could also be pretending to be the host.',
    'keyChange.ask': 'Continue only if you have confirmed with the host some other way (in person, by phone, or in the chat app you normally use) that the host really just gave you this new link.',
    'keyChange.confirm': 'I confirmed with the host: use the new link',
    'keyChange.cancel': 'Cancel',
    'confirm.title': 'Join this workspace?',
    'confirm.lead': 'You opened a smurg invite link. Someone gave you this link (or a web page brought you here).',
    'confirm.workspace': 'Workspace ID',
    'confirm.identity': 'Your identity',
    'confirm.identityValue': '{name} ({provider})',
    'confirm.providerDev': 'development account',
    'confirm.shared': 'After you join, the host of this workspace sees your name, your account and your device name, and you become a member of this workspace.',
    'confirm.ask': 'Click "Join" only if you recognize this invite and really want to join.',
    'confirm.join': 'Join',
    'confirm.cancel': 'Do not join',
    'done': 'Joined. Opening the workspace…',
  },
  zhTW,
);
