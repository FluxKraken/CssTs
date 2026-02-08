/**
 * Deno/JSR entrypoint for the CSS-TS Vite plugin.
 * @module
 */
import { cssTsPlugin } from "./src/vite.ts";

/** Default export for the CSS-TS Vite plugin. */
export default cssTsPlugin;
/** Named export for the CSS-TS Vite plugin. */
export const vite = cssTsPlugin;
/** Re-exported Vite plugin options. */
export type { CssTsPluginOptions } from "./src/vite.ts";
