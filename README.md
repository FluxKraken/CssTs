# css-ts

A TypeScript-first CSS object API with a Vite plugin that extracts styles to real stylesheets during build.

## Install

```bash
deno add jsr:@kt-tools/css-ts
```

```bash
npx jsr add @kt-tools/css-ts
```

```bash
npx jsr add --pnpm @kt-tools/css-ts
```

```bash
npx jsr add --yarn @kt-tools/css-ts
```

## Vite setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import ctVite from "@kt-tools/css-ts/vite";

export default defineConfig({
  plugins: [
    ctVite(),
  ],
});
```

By default, `ctVite()` only transforms modules inside `<project-root>/src/**`. This avoids transforming third-party code in `node_modules`.

To include extra directories, add `include` paths in root `css.config.ts`:

```ts
export default {
  include: ["./packages/ui"],
};
```

If you need full control, pass `ctVite({ include: /.../ })` to override the default scope matcher.

## SvelteKit setup workflow (Python + uv)

This repo includes a local setup CLI built with Python (`click` + `rich`).

1. Install the tool from this monorepo:

```bash
uv tool install --editable .
```

2. Run it against your project:

```bash
css-ts-setup --npm --cwd /path/to/project
```

or for Deno projects:

```bash
css-ts-setup --deno --cwd /path/to/project
```

If you prefer not to install globally:

```bash
uv run css-ts-setup --npm --cwd /path/to/project
```

This updates `vite.config.*`, plus `package.json` (npm mode) or `deno.json` (deno mode), and installs `@kt-tools/css-ts`.

---

### Deno + Vite configuration (no package.json)

Only needed if you install via Deno and do not use a `package.json`. Vite does not read `deno.json`
import maps, so you must map the JSR package to its npm shim and add a Vite alias.

1. Add the import map entry:

```json
// deno.json
{
  "imports": {
    "@kt-tools/css-ts": "npm:@jsr/kt-tools__css-ts"
  }
}
```

2. Add the Vite alias:

```ts
// vite.config.ts
import { defineConfig } from "vite";
import ctVite from "@kt-tools/css-ts/vite";

export default defineConfig({
  resolve: {
    alias: {
      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",
    },
  },
  plugins: [ctVite()],
});
```

### SvelteKit + Deno example (no package.json)

This example assumes `nodeModulesDir` is enabled in `deno.json` and you are using the Deno adapter.

1. Install:

```bash
deno add jsr:@kt-tools/css-ts
```

2. `deno.json`:

```json
{
  "nodeModulesDir": "auto",
  "imports": {
    "@kt-tools/css-ts": "npm:@jsr/kt-tools__css-ts",
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
import ctVite from "@kt-tools/css-ts/vite";

export default defineConfig({
  resolve: {
    alias: {
      "@kt-tools/css-ts": "@jsr/kt-tools__css-ts",
    },
  },
  plugins: [ctVite(), sveltekit()],
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
    base: {
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
    },
  });
</script>

<header class={styles().mainHeader()}>
  <h1 class={styles().headerText()}>Hello World</h1>
</header>
```

### Inline style output (`style={...}`)

Each accessor now includes:

- `myStyle()` -> class string (existing behavior)
- `myStyle.class()` -> class string alias
- `myStyle.style()` -> inline style string

This is useful for components that expect a `style` prop (for example PaneForge):

```svelte
<script lang="ts">
  import ct from "@kt-tools/css-ts";

  const styles = ct({
    base: {
      myGroup: { backgroundColor: "#111", color: "white" },
      leftPane: { minWidth: "200px" },
      rightPane: { minWidth: "200px" },
    },
  });
</script>

<PaneGroup style={styles().myGroup.style()} direction="horizontal">
  <Pane style={styles().leftPane.style()} defaultSize={50}>Pane 1</Pane>
  <PaneResizer />
  <Pane style={styles().rightPane.style()} defaultSize={50}>Pane 2</Pane>
</PaneGroup>
```

### Pseudo selectors

You can nest pseudo-classes/elements inside a style block. Keys are camel-cased (e.g. `focusVisible`)
or explicit selectors (e.g. `":hover"`, `"::after"`). Known pseudo-elements map to `::` automatically.

```ts
const styles = ct({
  base: {
    link: {
      hover: { textDecoration: "underline" },
      focusVisible: { outline: "2px solid #111" },
      ":active": { opacity: 0.7 },
    },
    item: {
      before: { content: "- " },
      "::after": { content: "." },
    },
  },
});
```

### Nested selectors, media, and container queries

Quoted keys are treated as nested selectors, and nested `@media` / `@container` blocks are supported.

```ts
const styles = ct({
  base: {
    mainNavigation: {
      fontSize: "1.25rem",
      "ul": {
        display: "flex",
        flexWrap: "wrap",
        gap: "0.5rem",
        "@media (width < 20rem)": {
          "ul": { display: "grid" },
        },
        "@container nav (inline-size > 30rem)": {
          "a:hover": { textDecoration: "underline" },
        },
      },
      "a:hover": {
        textDecoration: "underline",
        textUnderlineOffset: "6px",
      },
    },
  },
});
```

## Variant usage

`ct` accepts a single config object with optional `global`, `base`, `variant`, and `defaults` sections:

```ts
import ct from "@kt-tools/css-ts";

const styles = ct({
  global: {
    "@layer reset": {
      "html": { scrollBehavior: "smooth" },
    },
  },
  base: {
    button: {
      padding: "0.75rem 1rem",
      borderRadius: 8,
    },
    label: {},
  },
  variant: {
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
  defaults: {
    size: "sm",
  },
});

// base classes
styles().button();
styles().label();

// variant classes
styles().button({ intent: "primary" });
styles().label({ size: "lg" });
styles().button({ intent: "secondary", size: "sm" });
styles().label(); // applies defaults.size when available
```

Notes:
- Variant entries are partial overrides; you can provide only the keys you need.
- Variant keys must exist in the base style object.
- If a key is variant-only, define it in base as an empty object (for example `label: {}`).

### Reusable style objects and declaration arrays

You can compose declarations from reusable constants, including imported constants, and arrays are merged left-to-right:

```ts
import ct from "@kt-tools/css-ts";
import { buttonStyles, commonColors } from "$lib/styles";

const styles = ct({
  base: {
    myButton: [buttonStyles, commonColors],
  },
});
```

When these references resolve to static `const` objects at build time, the Vite plugin precompiles them into CSS.

### Space-delimited CSS values with arrays

Property values can be arrays to produce space-delimited CSS values:

```ts
import ct from "@kt-tools/css-ts";

const styles = ct({
  base: {
    pageWrapper: {
      display: "grid",
      gridTemplateRows: ["auto", "1fr", "auto"],
    },
  },
});
```

### `@apply` merge lists inside class declarations

Use `@apply` to merge declaration objects at any position in a class declaration. Merge order is top-to-bottom and left-to-right.

```ts
import ct from "@kt-tools/css-ts";

const singleColumn = {
  gridTemplateRows: ["auto", "1fr", "auto"],
};

const baseColors = {
  backgroundColor: "#4f4f4f",
  color: "black",
};

const styles = ct({
  base: {
    pageWrapper: {
      display: "grid",
      "@apply": [baseColors, singleColumn],
      color: "#00aaff", // overrides baseColors.color
    },
  },
});
```

`@apply` entries can be:
- declaration objects
- arrays of declaration objects
- utility names from `css.config.ts` (see below)

### Container presets and shorthand

You can define container presets in `css.config.ts`:

```ts
export default {
  containers: {
    card: {
      type: "inline-size",
      rule: "width < 20rem",
    },
  },
};
```

Then use:

- `@set` to apply `container-name` and `container-type` to a class
- `@<name>` shorthand to emit a matching `@container` query

```ts
import ct from "@kt-tools/css-ts";

const styles = ct({
  base: {
    mainContainer: {
      "@set": "card",
      // injects: container-name: card; container-type: inline-size;
    },
    card: {
      "@card": {
        backgroundColor: "blue",
      },
      // resolves to: @container card (width < 20rem) { ... }
    },
  },
});
```

You can also set containers at runtime on a builder:

```ts
import ct from "@kt-tools/css-ts";

const styles = new ct();
styles.addContainer({
  name: "card",
  type: "inline-size",
  rule: "width < 20rem",
});
```

### Global `css.config.ts`

Create a config file at project root to define project-wide imports, breakpoints, containers, and utility classes. Supported filenames: `css.config.ts`, `css.config.mts`, `css.config.js`, `css.config.mjs`, `css.config.cts`, `css.config.cjs`.

```ts
import "./src/global.css";

export default {
  include: ["./packages/ui"],
  imports: ["./src/theme.css"],
  breakpoints: {
    sm: "40rem",
    md: "48rem",
    lg: "64rem",
  },
  containers: {
    card: {
      type: "inline-size",
      rule: "width < 20rem",
    },
  },
  utilities: {
    cardBase: {
      borderRadius: "0.75rem",
      padding: "1rem",
      backgroundColor: "#4f4f4f",
      color: "black",
    },
  },
};
```

`css.config.ts` supports the same static identifier resolution used for `ct(...)` extraction, including:

- local `const` values
- imported `const` values from relative files
- imports resolved through Vite aliases (including SvelteKit `$lib/...`)
- imports resolved through `tsconfig.json` `paths` aliases

#### Transform include paths

By default, extraction only runs for files under `<project-root>/src/**`.
Use `include` to add additional directories:

```ts
export default {
  include: ["./packages/ui", "./shared/styles"],
};
```

#### Global stylesheet imports

Both `import "./file.css"` side-effect imports and the `imports: [...]` array add global stylesheet imports to the virtual CSS bundle as `@import` rules.

#### Breakpoint aliases

`breakpoints` defines named aliases for `@media` width queries. Use `@<name>` in style objects:

```ts
const styles = ct({
  base: {
    pageWrapper: {
      display: "grid",
      "@md": {
        gridTemplateColumns: "1fr 1fr",
      },
      "!@md": {
        gridTemplateColumns: "1fr",
      },
    },
  },
});
```

`"@md"` expands to `@media (width >= 48rem) { ... }`.
`"!@md"` expands to `@media (width <= 48rem) { ... }`.

Breakpoint values can be strings or numbers (numbers get a `px` suffix):

```ts
breakpoints: {
  sm: 640,    // becomes "640px"
  md: "48rem",
}
```

Alias names may start with digits (for example `2xs`, `2xl`):

```ts
breakpoints: { "2xs": "20rem", "2xl": "96rem" }
// "@2xs" -> @media (width >= 20rem)
```

Target a range between two breakpoints with `@(from,to)`:

```ts
"@(xs,xl)": { gridTemplateColumns: "1fr 1fr" }
// expands to: @media (30rem < width < 80rem) { ... }
```

If an alias is not found, the key is kept as a literal at-rule.

#### Container presets

`containers` defines named container presets. Use `@<name>` shorthand for container queries, and `@(from,to)` for range queries across two container presets:

```ts
"@card": { backgroundColor: "blue" }
// expands to: @container card (width < 20rem) { ... }

"@(cardSm,cardLg)": { fontSize: "1.25rem" }
// expands to: @container (smRule) and (lgRule) { ... }
```

See [Container presets and shorthand](#container-presets-and-shorthand) for full usage.

#### Utility classes

`utilities` generates global CSS classes emitted into the virtual stylesheet. Class names are derived from the camelCase key converted to kebab-case with a `u-` prefix:

- `cardBase` &rarr; `.u-card-base`
- `mutedText` &rarr; `.u-muted-text`

Utility names can be referenced by `@apply` inside style declarations:

```ts
"@apply": ["cardBase"]
```

## Builder pattern (`new ct()`)

As an alternative to the config-object API, you can use the builder pattern to declare styles incrementally via property assignment:

```ts
import ct from "@kt-tools/css-ts";

const styles = new ct();

styles.base = {
  card: {
    display: "grid",
    gap: "1rem",
    padding: "1rem",
  },
  title: {
    fontSize: "1.5rem",
    fontWeight: 600,
  },
};

styles.global = {
  "@layer reset": {
    "html": { scrollBehavior: "smooth" },
  },
};

styles.variant = {
  theme: {
    dark: { card: { backgroundColor: "#111", color: "#fff" } },
    light: { card: { backgroundColor: "#fff", color: "#111" } },
  },
};

styles.defaults = { theme: "light" };
```

The builder compiles lazily on first access and supports two access patterns:

```ts
// factory access — call styles() to get the accessor, then call a style key
styles().card();
styles().card({ theme: "dark" });

// direct access — access style keys directly on the builder
styles.card();
styles.card({ theme: "dark" });
```

Both patterns return the same class names. The direct pattern is shorter, but the property names `base`, `global`, `variant`, and `defaults` are reserved for config — use the factory pattern to access style keys with those names.

Setting a config property after the first access invalidates the cache and recompiles on the next access.

The Vite plugin statically extracts `new ct()` declarations the same way it handles `ct({...})` calls. Module-level `const`/`let` declarations followed by property assignments (`styles.base = ...`, `styles.global = ...`, etc.) are detected, extracted to CSS, and rewritten to a precompiled `ct()` call at build time.

## How it works

- In dev, the Vite plugin rewrites static `ct({ ... })` calls and `new ct()` declarations (`global`, `base`, `variant`, and `defaults`) and serves a virtual CSS module.
- In build, that same virtual CSS is bundled as a normal stylesheet, preventing flash of unstyled content.
- If a `ct` call is too dynamic to statically parse, runtime fallback still injects styles in the browser.
- Svelte files automatically import the virtual CSS module when static styles are detected.
- `new ct()` declarations are rewritten to equivalent precompiled `ct()` calls, and the property assignments are blanked out.

## Current parser limitations

The build-time extractor supports `ct(...)` calls and `new ct()` declarations with object literal arguments:

- style keys as identifiers/quoted keys
- property values as strings, numbers, or `cv("--token")`
- property values as arrays for space-delimited CSS values
- declaration arrays (merged left-to-right)
- `@apply` merge lists inside declarations
- simple nested objects for pseudo selectors (e.g. `hover`, `before`, or `":hover"`)
- optional `global`, `base`, `variant`, and `defaults` sections via `ct({ ... })`
- identifier references to `const` objects/arrays in the same module
- named imports of `const` style objects from relative paths, Vite/SvelteKit aliases (including `$lib/...`), and `tsconfig.json` path aliases
- imported/local `const` objects computed by statically evaluable helper function calls
- namespace imports with member access (for example `import * as S ...` + `S.buttonStyles`)
- `new ct()` with subsequent `const`/`let`-scoped property assignments (`styles.base = ...`, etc.)

It skips dynamic expressions, spreads, non-const bindings, and arbitrary function calls. For `new ct()` patterns, only module-level assignments are extracted — assignments inside conditionals, loops, or functions fall back to runtime.
