/**
 * CSS-TS public API entrypoint.
 * @module
 */
import runtimeCt from "./runtime.js";
import type { CtBuilder } from "./runtime.js";
import { cssTsPlugin } from "./vite.js";
import { cv } from "./shared.js";

type Ct = typeof runtimeCt & {
  new (): CtBuilder;
  vite: typeof cssTsPlugin;
  cv: typeof cv;
  var: typeof cv;
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
}) as Ct;

/** Default export for the CSS-TS runtime API. */
export default ct;
/** Named export for the Vite plugin. */
export { cssTsPlugin as vite };
/** Named export for creating CSS variable references. */
export { cv };
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
