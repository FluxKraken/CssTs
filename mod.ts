/**
 * Deno/JSR entrypoint for the CSS-TS public API.
 * @module
 */
// @deno-types="./mod.d.ts"
/** Default export for the CSS-TS runtime API. */
export { default } from "./dist/index.js";
/** Named export for the Vite plugin. */
export { vite } from "./dist/index.js";
/** Named export for creating CSS variable references. */
export { cv } from "./dist/index.js";
