import type {
  CssVarRef,
  PrimitiveStyleValue,
  StyleDeclaration,
  StyleSheet,
  StyleValue,
} from "./dist/shared.d.ts";
import type { CssTsPluginOptions } from "./dist/vite.d.ts";

type StyleDeclarationInput = StyleDeclaration | readonly StyleDeclarationInput[];
type StyleSheetInput = Record<string, StyleDeclarationInput>;
type CompiledMap<T extends StyleSheetInput> = Partial<Record<keyof T, string>>;
type VariantSheet<T extends StyleSheetInput> = Record<string, Record<string, Partial<T>>>;
type VariantClassMap<T extends StyleSheetInput> = Record<
  string,
  Record<string, Partial<Record<keyof T, string>>>
>;
type CtConfig<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> = {
  global?: StyleSheetInput;
  base?: T;
  variant?: V;
  defaults?: VariantSelection<V>;
};
type CtRuntimeOptions = {
  breakpoints?: Record<string, string>;
  containers?: Record<string, { type?: string; rule: string }>;
  utilities?: StyleSheetInput;
};
type CompiledConfig<T extends StyleSheetInput> = {
  global?: true;
  base?: CompiledMap<T>;
  variant?: VariantClassMap<T>;
};
type VariantSelection<V extends VariantSheet<any> | undefined> = V extends VariantSheet<any>
  ? { [G in keyof V]?: keyof V[G] }
  : Record<string, string>;
type Accessor<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> = {
  [K in keyof T]: StyleAccessor<V>;
};
type StyleAccessor<V extends VariantSheet<any> | undefined> =
  & ((variants?: VariantSelection<V>) => string)
  & {
    class: (variants?: VariantSelection<V>) => string;
    style: (variants?: VariantSelection<V>) => string;
  };
type CtBuilder<T extends StyleSheetInput, V extends VariantSheet<T> | undefined> =
  & (() => Accessor<T, V>)
  & Accessor<T, V>
  & {
    base: T | undefined;
    global: StyleSheetInput | undefined;
    variant: V | undefined;
    defaults: VariantSelection<V> | undefined;
    addContainer: (
      container: {
        name: string;
        type?: string;
        rule: string;
      },
    ) => CtBuilder<T, V>;
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
  <
    T extends StyleSheetInput = StyleSheetInput,
    V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
  >(
    config: CtConfig<T, V>,
    compiled?: CompiledConfig<T>,
    runtimeOptions?: CtRuntimeOptions,
  ): () => Accessor<T, V>;
  new <
    T extends StyleSheetInput = StyleSheetInput,
    V extends VariantSheet<T> | undefined = VariantSheet<T> | undefined,
  >(): CtBuilder<T, V>;
  /** Vite plugin entry point. */
  vite: (options?: CssTsPluginOptions) => any;
  /** Create a CSS variable reference. */
  cv: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
  /** Alias for {@link Ct.cv}. */
  var: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
}

/** Default export for the CSS-TS runtime API. */
declare const ct: Ct;
export default ct;
/** Named export for the Vite plugin. */
export const vite: (options?: CssTsPluginOptions) => any;
/** Named export for creating CSS variable references. */
export const cv: (name: string, fallback?: PrimitiveStyleValue) => CssVarRef;
