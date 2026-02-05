import runtimeCt from "./runtime.js";
import { cssTsPlugin } from "./vite.js";

type Ct = typeof runtimeCt & {
  vite: typeof cssTsPlugin;
};

const ct = Object.assign(runtimeCt, {
  vite: cssTsPlugin,
}) as Ct;

export default ct;
export { cssTsPlugin as vite };
export type { CssTsPluginOptions } from "./vite.js";
export type { StyleDeclaration, StyleSheet, StyleValue } from "./shared.js";
