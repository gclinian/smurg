// zod schemas and types of the message catalog (ARCHITECTURE §4.2, §5). Re-exported by the package barrel, so every
// exported name here must be unique across @smurg/protocol (TS2308 otherwise).
export * from './awareness.ts';
export * from './entities.ts';
export * from './error-details.ts';
export * from './handshake.ts';
export * from './limits.ts';
export * from './paths.ts';
export * from './primitives.ts';
export * from './redact.ts';
export * from './registry.ts';
export * from './messages/admin.ts';
export * from './messages/channel.ts';
export * from './messages/docs.ts';
export * from './messages/files.ts';
export * from './messages/presence.ts';
export * from './messages/sessions.ts';
export * from './messages/suggestions.ts';
export * from './messages/transfer.ts';
export * from './messages/worktrees.ts';
