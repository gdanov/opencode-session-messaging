/**
 * Entry point for the session-messaging plugin.
 *
 * The implementation lives in `src/`; this file exists so the plugin can be
 * loaded as a plain directory, which is how OpenCode discovers local plugins.
 */

export { default } from "./src/index.ts"
export { envelope, MESSAGE_CHAR_LIMIT } from "./src/envelope.ts"
