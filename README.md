# css-ts

A TypeScript-first CSS object API with a Vite plugin that extracts styles to real stylesheets during build.

## Install

```bash
npm i css-ts
```

## Vite setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import ct from "css-ts";

export default defineConfig({
  plugins: [
    ct.vite(),
  ],
});
```

## Svelte usage

```svelte
<script lang="ts">
  import ct, { cv } from "css-ts";

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
  });
</script>

<header class={styles().mainHeader()}>
  <h1 class={styles().headerText()}>Hello World</h1>
</header>
```

## Variant usage

`ct` accepts an optional second argument for variants:

```ts
import ct from "css-ts";

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
styles().variants.intent.primary.button?.();
styles().variants.size.lg.label?.();
```

Notes:
- Variant entries are partial overrides; you can provide only the keys you need.
- Variant keys must exist in the base style object.
- If a key is variant-only, define it in base as an empty object (for example `label: {}`).

## How it works

- In dev, the Vite plugin rewrites static `ct(...)` calls (base styles and optional variants) and serves a virtual CSS module.
- In build, that same virtual CSS is bundled as a normal stylesheet, preventing flash of unstyled content.
- If a `ct` call is too dynamic to statically parse, runtime fallback still injects styles in the browser.

## Current parser limitations

The build-time extractor currently supports `ct(...)` with object literal arguments:

- style keys as identifiers/quoted keys
- property values as strings, numbers, or `cv("--token")`
- simple nested objects (per style block)
- optional variants via `ct(baseStyles, variantStyles)` when both arguments are object literals

It skips dynamic expressions, spreads, variables, and function calls.
