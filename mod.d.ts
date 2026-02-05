import type { Plugin } from "vite";
import type {
  CssVarRef,
  PrimitiveStyleValue,
  StyleDeclaration,
  StyleSheet,
  StyleValue,
} from "./dist/shared.d.ts";
import type { CssTsPluginOptions } from "./dist/vite.d.ts";

type CompiledMap<T extends StyleSheet> = Partial<Record<keyof T, string>>;
type VariantSheet<T extends StyleSheet> = Record<string, Record<string, Partial<T>>>;
type VariantClassMap<T extends StyleSheet> = Record<
  string,
  Record<string, Partial<Record<keyof T, string>>>
>;
type CompiledBundle<T extends StyleSheet> = {
  base: CompiledMap<T>;
  variants?: VariantClassMap<T>;
};
type VariantSelection<V extends VariantSheet<any> | undefined> = V extends VariantSheet<any>
  ? { [G in keyof V]?: keyof V[G] }
  : Record<string, string>;
type Accessor<T extends StyleSheet, V extends VariantSheet<T> | undefined> = {
  [K in keyof T]: (variants?: VariantSelection<V>) => string;
};

/** Re-exported Vite plugin options. */
export type { CssTsPluginOptions };
/** Re-exported style declaration type. */
export type { StyleDeclaration };
/** Re-exported style sheet type. */
export type { StyleSheet };
/** Re-exported style value type. */
export type { StyleValue };

/** Combined CSS-TS runtime API. */
export interface Ct {
  <T extends StyleSheet, V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined>(
    styles: T,
    variantsOrCompiled?: V | CompiledBundle<T> | CompiledMap<T>,
    compiledMaybe?: CompiledBundle<T> | CompiledMap<T>,
  ): () => Accessor<T, V>;
  /** Vite plugin entry point. */
  vite: (options?: CssTsPluginOptions) => Plugin;
  /** Create a CSS variable reference. */
  cv: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
  /** Alias for {@link Ct.cv}. */
  var: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
}

/** Default export for the CSS-TS runtime API. */
declare const ct: Ct;
export default ct;
/** Named export for the Vite plugin. */
export const vite: (options?: CssTsPluginOptions) => Plugin;
/** Named export for creating CSS variable references. */
export const cv: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
