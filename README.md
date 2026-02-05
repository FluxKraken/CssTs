# css-ts

A TypeScript-first CSS object API with a Vite plugin that extracts styles to real stylesheets during build.

## Install

```bash
deno add npm:@jsr/kt-tools__css-ts
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

## SvelteKit setup tool

This package ships a setup tool that can update a SvelteKit project to match the
recommended configuration.

### Deno + Vite + SvelteKit

1. Install:

```bash
deno add npm:@jsr/kt-tools__css-ts
```

2. Run the tool:

```bash
deno run -A jsr:@kt-tools/css-ts/tool sveltekit --deno
```

This will update `deno.json` and `vite.config.*` to include the CSS-TS import map
entry, Vite alias, and plugin.

### NPM + Vite + SvelteKit

1. Install:

```bash
npm i @kt-tools/css-ts
```

2. Run the tool:

```bash
npx css-ts sveltekit --npm
```

This will update `vite.config.*` to add the CSS-TS Vite plugin.

---

### Deno + Vite configuration (no package.json)

Only needed if you install via Deno and do not use a `package.json`. Vite does not read `deno.json`
import maps, so you must map the JSR package to its npm shim and add a Vite alias.

1. Add the import map entry:

```json
// deno.json
{
  "imports": {
    "@kt-tools/css-ts": "npm:@jsr/kt-tools__css-ts@^0.1.1"
  }
}
```

2. Add the Vite alias:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import ct from "@kt-tools/css-ts";

export default defineConfig({
  resolve: {
    alias: {
      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",
    },
  },
  plugins: [ct.vite()],
});
```

### SvelteKit + Deno example (no package.json)

This example assumes `nodeModulesDir` is enabled in `deno.json` and you are using the Deno adapter.

1. Install:

```bash
deno add npm:@jsr/kt-tools__css-ts
```

2. `deno.json`:

```json
{
  "nodeModulesDir": "auto",
  "imports": {
    "@kt-tools/css-ts": "npm:@jsr/kt-tools__css-ts@^0.1.1",
    "@sveltejs/kit": "npm:@sveltejs/kit@^2.50.2",
    "@sveltejs/vite-plugin-svelte": "npm:@sveltejs/vite-plugin-svelte@^6.2.4",
    "svelte": "npm:svelte@^5.49.2",
    "vite": "npm:vite@^7.3.1"
  }
}
```

3. `vite.config.ts`:

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import ct from "@kt-tools/css-ts";

export default defineConfig({
  resolve: {
    alias: {
      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",
    },
  },
  plugins: [ct.vite(), sveltekit()],
});
```

4. `svelte.config.js`:

```js
import adapter from "@deno/svelte-adapter";

const config = {
  kit: {
    adapter: adapter(),
  },
};

export default config;
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
        content: "- ",
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
    before: { content: "- " },
    "::after": { content: "." },
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
