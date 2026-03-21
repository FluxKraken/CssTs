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
/** Named export for defining theme token maps. */
export { Theme } from "./src/index.ts";
/** Named export for referencing theme-backed CSS variables. */
export { tv } from "./src/index.ts";
/** Re-exported Vite plugin options type. */
export type { CssTsPluginOptions } from "./src/index.ts";
/** Style object for a single class name. */
export type { StyleDeclaration } from "./src/index.ts";
/** Map of class keys to their style declarations. */
export type { StyleSheet } from "./src/index.ts";
/** CSS value accepted by style declarations. */
export type { StyleValue } from "./src/index.ts";
/** Theme token map accepted by `new Theme(...)`. */
export type { ThemeTokenInput } from "./src/index.ts";
/** Theme map accepted by `themes`. */
export type { ImportedThemesInput } from "./src/index.ts";
