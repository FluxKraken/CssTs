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
