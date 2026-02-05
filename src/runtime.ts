import {
  createClassName,
  StyleSheet,
  toCssRule,
} from "./shared.js";

type CompiledMap<T extends StyleSheet> = Partial<Record<keyof T, string>>;
type Accessor<T extends StyleSheet> = { [K in keyof T]: () => string };

const RUNTIME_STYLE_TAG_ID = "__css_ts_runtime_styles";
const injectedRules = new Set<string>();

function injectRule(rule: string): void {
  if (typeof document === "undefined" || injectedRules.has(rule)) {
    return;
  }

  let tag = document.getElementById(RUNTIME_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!tag) {
    tag = document.createElement("style");
    tag.id = RUNTIME_STYLE_TAG_ID;
    document.head.appendChild(tag);
  }

  tag.appendChild(document.createTextNode(rule));
  injectedRules.add(rule);
}

export default function ct<T extends StyleSheet>(
  styles: T,
  compiled?: CompiledMap<T>,
): () => Accessor<T> {
  const accessors = {} as Accessor<T>;

  for (const [key, declaration] of Object.entries(styles) as [keyof T, T[keyof T]][]) {
    const className = compiled?.[key] ?? createClassName(String(key), declaration, "runtime");

    if (!compiled?.[key]) {
      injectRule(toCssRule(className, declaration));
    }

    accessors[key] = () => className;
  }

  return () => accessors;
}

export type { StyleSheet, StyleDeclaration, StyleValue } from "./shared.js";
