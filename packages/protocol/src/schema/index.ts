// zod schemas and types of the message catalog (ARCHITECTURE §4.2, §5). Re-exported by the package barrel, so every
// exported name here must be unique across @smurg/protocol (TS2308 otherwise).
export * from './awareness.ts';
export * from './conversation.ts';
export * from './entities.ts';
export * from './error-details.ts';
export * from './handshake.ts';
export * from './inbox.ts';
export * from './limits.ts';
export * from './message-ref.ts';
export * from './paths.ts';
export * from './primitives.ts';
export * from './redact.ts';
export * from './registry.ts';
export * from './topics.ts';
export * from './messages/admin.ts';
export * from './messages/channel.ts';
export * from './messages/conversation.ts';
export * from './messages/docs.ts';
export * from './messages/files.ts';
export * from './messages/inbox.ts';
export * from './messages/presence.ts';
export * from './messages/sessions.ts';
export * from './messages/suggestions.ts';
export * from './messages/topics.ts';
export * from './messages/transfer.ts';
export * from './messages/worktrees.ts';
