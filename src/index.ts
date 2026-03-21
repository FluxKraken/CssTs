/**
 * CSS-TS public API entrypoint.
 * @module
 */
import runtimeCt from "./runtime.js";
import type { CtBuilder } from "./runtime.js";
import { cssTsPlugin } from "./vite.js";
import { cv, Theme, tv } from "./shared.js";

type Ct = typeof runtimeCt & {
  new(): CtBuilder;
  vite: typeof cssTsPlugin;
  cv: typeof cv;
  var: typeof cv;
  Theme: typeof Theme;
  tv: typeof tv;
};

/**
 * Primary API for defining styles with CSS-TS.
 *
 * Includes `ct.vite` for the Vite plugin and `ct.cv`/`ct.var` for CSS variables.
 */
const ct = Object.assign(runtimeCt, {
  vite: cssTsPlugin,
  cv,
  var: cv,
  Theme,
  tv,
}) as Ct;

/** Default export for the CSS-TS runtime API. */
export default ct;
/** Named export for the Vite plugin. */
export { cssTsPlugin as vite };
/** Named export for creating CSS variable references. */
export { cv };
/** Named export for defining theme token maps. */
export { Theme };
/** Named export for referencing theme-backed CSS variables. */
export { tv };
/** Re-exported Vite plugin options. */
export type { CssTsPluginOptions } from "./vite.js";
/** Re-exported builder type. */
export type { CtBuilder } from "./runtime.js";
/** Style object for a single class name. */
export type { StyleDeclaration } from "./shared.js";
/** Map of class keys to their style declarations. */
export type { StyleSheet } from "./shared.js";
/** CSS value accepted by style declarations. */
export type { StyleValue } from "./shared.js";
/** Valid input for importing external styles or global style objects. */
export type { ImportInput } from "./shared.js";
/** Theme token map accepted by `new Theme(...)`. */
export type { ThemeTokenInput } from "./shared.js";
/** Theme map accepted by `themes`. */
export type { ImportedThemesInput } from "./shared.js";
