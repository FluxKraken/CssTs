/**
 * Deno/JSR entrypoint for the CSS-TS Vite plugin.
 * @module
 */
/** Default export for the CSS-TS Vite plugin. */
export { cssTsPlugin as default } from "./src/vite.ts";
/** Named export for the CSS-TS Vite plugin. */
export { cssTsPlugin as vite } from "./src/vite.ts";
/** Re-exported Vite plugin options. */
export type { CssTsPluginOptions } from "./src/vite.ts";
