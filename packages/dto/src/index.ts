/**
 * @repo/dto
 *
 * Zod schemas and inferred types for every request, response and socket
 * payload that crosses a process boundary. Validate at the boundary with the
 * schema; pass the inferred type around inside.
 */
export * from './admin/index.js';
export * from './calls/index.js';
export * from './common/index.js';
export * from './socket/index.js';
export * from './user/index.js';
