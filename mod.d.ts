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

export type { CssTsPluginOptions, StyleDeclaration, StyleSheet, StyleValue };

export interface Ct {
  <T extends StyleSheet, V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined>(
    styles: T,
    variantsOrCompiled?: V | CompiledBundle<T> | CompiledMap<T>,
    compiledMaybe?: CompiledBundle<T> | CompiledMap<T>,
  ): () => Accessor<T, V>;
  vite: (options?: CssTsPluginOptions) => Plugin;
  cv: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
  var: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
}

declare const ct: Ct;
export default ct;
export const vite: (options?: CssTsPluginOptions) => Plugin;
export const cv: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
