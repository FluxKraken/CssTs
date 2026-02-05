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
  import ct from "css-ts";

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
  });
</script>

<header class={styles().mainHeader()}>
  <h1 class={styles().headerText()}>Hello World</h1>
</header>
```

## How it works

- In dev, the Vite plugin rewrites static `ct({ ... })` calls and serves a virtual CSS module.
- In build, that same virtual CSS is bundled as a normal stylesheet, preventing flash of unstyled content.
- If a `ct` call is too dynamic to statically parse, runtime fallback still injects styles in the browser.

## Current parser limitations

The build-time extractor currently supports `ct({...})` object literals with:

- style keys as identifiers/quoted keys
- property values as strings or numbers
- simple nested objects (per style block)

It skips dynamic expressions, spreads, variables, and function calls.
