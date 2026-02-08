/**
 * Deno/JSR entrypoint for the CSS-TS public API.
 * @module
 */
/** Default export for the CSS-TS runtime API. */
export { default } from "./src/index.ts";
/** Named export for the Vite plugin. */
export { vite } from "./src/index.ts";
/** Named export for creating CSS variable references. */
export { cv } from "./src/index.ts";
/** Re-exported Vite plugin options type. */
export type { CssTsPluginOptions } from "./src/index.ts";
/** Re-exported builder type returned by `new ct()`. */
export type { CtBuilder } from "./src/index.ts";
/** Re-exported style types. */
export type { StyleDeclaration, StyleSheet, StyleValue } from "./src/index.ts";
