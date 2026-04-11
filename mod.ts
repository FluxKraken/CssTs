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
/** Named export for creating quoted `font-family` lists. */
export { font } from "./src/index.ts";
/** Named export for defining theme token maps. */
export { Theme } from "./src/index.ts";
/** Named export for Tailwind-aware class markers. */
export { tw } from "./src/index.ts";
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
/** Input accepted by the `@apply` directive. */
export type { ApplyInput } from "./src/index.ts";
/** Input accepted by the `@set` directive. */
export type { SetInput } from "./src/index.ts";
/** Tailwind class marker returned by `tw(...)`. */
export type { TailwindClassValue } from "./src/index.ts";
/** Input accepted by `tw(...)`. */
export type { TailwindClassInput } from "./src/index.ts";
/** Layered `@apply` helper object. */
export type { LayeredApplyInput } from "./src/index.ts";
/** Object form accepted by the `@set` directive. */
export type { ContainerSetInput } from "./src/index.ts";
/** Theme token map accepted by `new Theme(...)`. */
export type { ThemeTokenInput } from "./src/index.ts";
/** Theme map accepted by `themes`. */
export type { ImportedThemesInput } from "./src/index.ts";
