# css-ts

A TypeScript-first CSS object API with a Vite plugin that extracts styles to real stylesheets during build.

## Install

```bash
deno add @kt-tools/css-ts
```

```bash
npm i @kt-tools/css-ts
```

```bash
pnpm add @kt-tools/css-ts
```

```bash
yarn add @kt-tools/css-ts
```

## Vite setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import ct from "@kt-tools/css-ts";

export default defineConfig({
  plugins: [
    ct.vite(),
  ],
});
```

## Svelte usage

```svelte
<script lang="ts">
  import ct, { cv } from "@kt-tools/css-ts";

  const styles = ct({
    mainHeader: {
      display: "grid",
      placeItems: "center",
      gap: "1rem",
      padding: "1rem",
    },
    headerText: {
      fontFamily: "ui-monospace, monospace",
      fontSize: "3rem",
      fontWeight: 600,
      textAlign: "center",
    },
    mainContainer: {
      backgroundColor: cv("--background"),
      padding: cv("--space", 8),
    },
    navLink: {
      hover: { textDecoration: "underline" },
    },
    navItem: {
      before: {
        content: "\"- \"",
      },
    },
  });
</script>

<header class={styles().mainHeader()}>
  <h1 class={styles().headerText()}>Hello World</h1>
</header>
```

### Pseudo selectors

You can nest pseudo-classes/elements inside a style block. Keys are camel-cased (e.g. `focusVisible`)
or explicit selectors (e.g. `":hover"`, `"::after"`). Known pseudo-elements map to `::` automatically.

```ts
const styles = ct({
  link: {
    hover: { textDecoration: "underline" },
    focusVisible: { outline: "2px solid #111" },
    ":active": { opacity: 0.7 },
  },
  item: {
    before: { content: "\"- \"" },
    "::after": { content: "\"\"" },
  },
});
```

## Variant usage

`ct` accepts an optional second argument for variants, which you select by passing a variant object
when you call a class accessor:

```ts
import ct from "@kt-tools/css-ts";

const styles = ct(
  {
    button: {
      padding: "0.75rem 1rem",
      borderRadius: 8,
    },
    label: {},
  },
  {
    intent: {
      primary: {
        button: {
          backgroundColor: "#111",
          color: "#fff",
        },
      },
      secondary: {
        button: {
          backgroundColor: "#eee",
          color: "#111",
        },
      },
    },
    size: {
      sm: {
        label: { fontSize: 12 },
      },
      lg: {
        label: { fontSize: 18 },
      },
    },
  },
);

// base classes
styles().button();
styles().label();

// variant classes
styles().button({ intent: "primary" });
styles().label({ size: "lg" });
styles().button({ intent: "secondary", size: "sm" });
```

Notes:
- Variant entries are partial overrides; you can provide only the keys you need.
- Variant keys must exist in the base style object.
- If a key is variant-only, define it in base as an empty object (for example `label: {}`).

## How it works

- In dev, the Vite plugin rewrites static `ct(...)` calls (base styles and optional variants) and serves a virtual CSS module.
- In build, that same virtual CSS is bundled as a normal stylesheet, preventing flash of unstyled content.
- If a `ct` call is too dynamic to statically parse, runtime fallback still injects styles in the browser.
- Svelte files automatically import the virtual CSS module when static styles are detected.

## Current parser limitations

The build-time extractor currently supports `ct(...)` with object literal arguments:

- style keys as identifiers/quoted keys
- property values as strings, numbers, or `cv("--token")`
- simple nested objects for pseudo selectors (e.g. `hover`, `before`, or `":hover"`)
- optional variants via `ct(baseStyles, variantStyles)` when both arguments are object literals

It skips dynamic expressions, spreads, variables, and function calls.
