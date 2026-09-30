import { z } from 'zod';
import { clientKindSchema, memberSchema, publicSettingsSchema, workspaceInfoSchema } from './entities.ts';
import { CNF_NONCE_BYTES } from '../channel/identity-binding.ts';
import { SHORT_TEXT_MAX_CHARS } from './limits.ts';
import { bytesSchema, epochMsSchema, identityTokenSchema, lineTextSchema, opaqueIdSchema, seqSchema } from './primitives.ts';

// Structures of the encrypted handshake (ARCHITECTURE §4.2). They are not Envelopes: the ClientHello is the payload
// of Noise msg3 and the Verdict is the first DATA record from the daemon (`channel.hello` / `channel.welcome`
// in §5.1 name these). Encoding lives in codec.ts.

export const CHANNEL_PURPOSES = ['interactive', 'transfer'] as const;
export const channelPurposeSchema = z.enum(CHANNEL_PURPOSES);
export type ChannelPurpose = z.infer<typeof channelPurposeSchema>;

/** `ClientHello.resume`: the logical channel to continue and the last daemon `seq` the client processed. */
export const resumeRequestSchema = z.strictObject({ channelId: opaqueIdSchema, lastSeq: seqSchema });

export const clientHelloSchema = z
  .strictObject({
    /** Must equal PROTOCOL_VERSION; decodeClientHello reports a mismatch as `version` before strict parsing. */
    protocolVersion: z.int().min(0),
    purpose: channelPurposeSchema,
    /** Relay-signed identity JWT (sensitive: a bearer credential for 5 minutes; never log it). */
    identityToken: identityTokenSchema,
    /** `n` of the blinded commitment `cnf = SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey)`. */
    cnfNonce: bytesSchema({ exact: CNF_NONCE_BYTES }),
    clientKind: clientKindSchema,
    /** e.g. 「Chrome on macOS」, shown in the host's device list */
    deviceName: lineTextSchema(SHORT_TEXT_MAX_CHARS, 1),
    /** interactive channel only */
    resume: resumeRequestSchema.optional(),
  })
  .refine((hello) => hello.purpose === 'interactive' || hello.resume === undefined, {
    message: 'resume is only valid on the interactive channel',
    path: ['resume'],
  });
export type ClientHello = z.infer<typeof clientHelloSchema>;

/** `channel.welcome`: what an admitted client learns first. `resumed = false` ⇒ the client performs a full resync. */
export const welcomeSchema = z.strictObject({
  channelId: opaqueIdSchema,
  resumed: z.boolean(),
  member: memberSchema,
  workspace: workspaceInfoSchema,
  settings: publicSettingsSchema,
  serverTime: epochMsSchema,
});
export type Welcome = z.infer<typeof welcomeSchema>;

export const VERDICT_REJECT_REASONS = [
  'invite-invalid',
  'device-revoked',
  /**
   * The device key is registered in this workspace for ANOTHER account than the one logged in now (one browser profile
   * or CLI state dir is one person per workspace). Sent only in the encrypted verdict, to the holder of that key, and
   * never names the other account.
   */
  'device-other-account',
  'identity-invalid',
  'kicked',
  'version',
  'busy',
] as const;
export const verdictRejectReasonSchema = z.enum(VERDICT_REJECT_REASONS);
export type VerdictRejectReason = z.infer<typeof verdictRejectReasonSchema>;

export const verdictSchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), welcome: welcomeSchema }),
  z.strictObject({ ok: z.literal(false), reason: verdictRejectReasonSchema }),
]);
export type Verdict = z.infer<typeof verdictSchema>;
