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
/** Style object for a single class name. */
export type { StyleDeclaration } from "./src/index.ts";
/** Map of class keys to their style declarations. */
export type { StyleSheet } from "./src/index.ts";
/** CSS value accepted by style declarations. */
export type { StyleValue } from "./src/index.ts";
