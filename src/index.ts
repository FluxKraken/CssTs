import runtimeCt from "./runtime.js";
import { cssTsPlugin } from "./vite.js";
import { cv } from "./shared.js";

type Ct = typeof runtimeCt & {
  vite: typeof cssTsPlugin;
  cv: typeof cv;
  var: typeof cv;
};

const ct = Object.assign(runtimeCt, {
  vite: cssTsPlugin,
  cv,
  var: cv,
}) as Ct;

export default ct;
export { cssTsPlugin as vite };
export { cv };
export type { CssTsPluginOptions } from "./vite.js";
export type { StyleDeclaration, StyleSheet, StyleValue } from "./shared.js";
