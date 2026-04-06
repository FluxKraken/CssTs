# css-ts

`css-ts` is a TypeScript-first styling library for Vite projects.

The preferred API is the builder pattern: create `new ct()`, assign `base`,
`variant`, `themes`, `global`, and `root` in small pieces, then use the
generated accessors in your components.

The Vite plugin extracts statically analyzable styles into a real stylesheet at
build time, while runtime fallback still works for dynamic cases.

`tw(...)` integrates cleanly with Tailwind classes and relies on
`tailwind-merge` to collapse conflicting utilities before the final class string
is returned.

## Install

```bash
deno add jsr:@kt-tools/css-ts
```

```bash
npx jsr add @kt-tools/css-ts
```

```bash
pnpm dlx jsr add @kt-tools/css-ts
```

If you want Tailwind-aware class composition, install `tailwind-merge` too:

```bash
npm install tailwind-merge
```

```bash
deno add npm:tailwind-merge
```

## Vite setup

```ts
// vite.config.ts
import { defineConfig } from "vite";
import ctVite from "@kt-tools/css-ts/vite";

export default defineConfig({
  plugins: [ctVite()],
});
```

By default the plugin transforms files inside `<project-root>/src/**`. You can
extend that with `include` in `css.config.ts`.

Astro uses the same plugin through `astro.config.mjs`:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import ctVite from "@kt-tools/css-ts/vite";

export default defineConfig({
  vite: {
    plugins: [ctVite()],
  },
});
```

Additional setup recipes live in [examples.md](./examples.md).

## Quick start

This is the recommended shape for new code: build styles incrementally with
`new ct()`.

```ts
import ct, { cv, font } from "@kt-tools/css-ts";

const styles = new ct();

styles.root = [
  {
    "--surface": "#111827",
    "--text": "#f9fafb",
    "--radius": "1rem",
  },
];

styles.base = {
  card: {
    display: "grid",
    gap: "1rem",
    padding: "1rem",
    borderRadius: cv("--radius"),
    backgroundColor: cv("--surface"),
    color: cv("--text"),
  },
  title: {
    fontFamily: font(["Inter", "system-ui", "sans-serif"]),
    fontSize: "1.25rem",
    fontWeight: 700,
  },
  body: {
    lineHeight: 1.5,
  },
};
```

```tsx
<article className={styles.card()}>
  <h2 className={styles.title()}>Builder first</h2>
  <p className={styles.body()}>
    Styles are authored in TypeScript and extracted to CSS by the Vite plugin.
  </p>
</article>
```

## Accessing styles

Every style key becomes an accessor.

```ts
styles.card(); // class string
styles.card.class(); // same class string
styles.card.style(); // inline style string only

styles().card(); // equivalent factory access
```

Use factory access when a style key collides with a reserved builder property:

```ts
styles().base();
styles().global();
```

The reserved names are `base`, `global`, `themes`, `root`, `variant`, and
`defaults`.

## Core features

### Variants and defaults

Variants are partial overrides grouped by a variant name. Defaults apply when
no explicit selection is passed.

```ts
import ct from "@kt-tools/css-ts";

const styles = new ct();

styles.base = {
  button: {
    padding: "0.75rem 1rem",
    borderRadius: "0.75rem",
    fontWeight: 600,
  },
  label: {},
};

styles.variant = {
  intent: {
    primary: {
      button: {
        backgroundColor: "#111827",
        color: "white",
      },
    },
    secondary: {
      button: {
        backgroundColor: "#e5e7eb",
        color: "#111827",
      },
    },
  },
  size: {
    sm: {
      button: { fontSize: "0.875rem" },
      label: { fontSize: "0.75rem" },
    },
    lg: {
      button: { fontSize: "1rem" },
      label: { fontSize: "0.875rem" },
    },
  },
};

styles.defaults = {
  intent: "primary",
  size: "sm",
};
```

```ts
styles.button(); // primary + sm
styles.button({ intent: "secondary" });
styles.label(); // gets the default size
styles.label.style({ size: "lg" }); // "font-size:0.875rem"
```

Variant blocks can also include quoted selectors such as `":global(html)"` when
you want variant-scoped global rules. See [examples.md](./examples.md) for a
full example.

### Themes and theme variables

`Theme` converts friendly token names into CSS custom properties. `tv` reads
them back inside style objects.

```ts
import ct, { Theme, tv } from "@kt-tools/css-ts";

const styles = new ct();

styles.themes = {
  default: new Theme({
    surface: "#ffffff",
    text: "#111827",
    accent: "#2563eb",
  }),
  dark: new Theme({
    surface: "#111827",
    text: "#f9fafb",
    accent: "#60a5fa",
  }),
};

styles.base = {
  panel: {
    backgroundColor: tv.surface,
    color: tv.text,
    border: [1, "solid", tv.accent],
  },
  hero: {
    backgroundImage: tv.eval("linear-gradient({surface}, {accent})"),
  },
};
```

Keys in `themes` behave like this:

- `default`, `root`, and `:root` go to `:root`
- bare names like `dark` become scoped selectors such as `.dark`
- explicit selectors like `".contrast"` are used as-is

### Tailwind classes via `tw(...)` and `tailwind-merge`

This is the most important integration point for mixed css-ts and Tailwind
projects.

`tw(...)` stores Tailwind classes, and `tailwind-merge` resolves conflicts
before the final class string is returned. That means:

- `px-3 px-4` becomes `px-4`
- `text-sm text-base` becomes `text-base`
- nested pseudo blocks like `hover` automatically prefix Tailwind variants

```ts
import ct, { tw } from "@kt-tools/css-ts";

const styles = new ct();

styles.base = {
  button: {
    "@apply": tw(
      "inline-flex items-center px-3 px-4 py-2 rounded-md text-sm text-base",
    ),
    backgroundColor: "#111827",
    color: "white",
    hover: {
      "@apply": tw("underline underline-offset-2 underline-offset-4"),
    },
  },
  buttonLabel: tw("font-medium tracking-tight"),
};

styles.variant = {
  size: {
    lg: {
      button: tw("text-base text-lg"),
    },
  },
};
```

```ts
styles.button();
// returns merged Tailwind classes + a generated css-ts class name

styles.button.style();
// "background-color:#111827;color:white"

styles.buttonLabel();
// only Tailwind classes

styles.button({ size: "lg" });
// merged size override with tailwind-merge
```

Use `tw(...)` in two places:

- as a full style value: `buttonLabel: tw("font-medium")`
- as a top-level `@apply` entry inside a declaration

### Global CSS and imports

Use `global` for selectors and at-rules that should not generate local class
names.

```ts
import ct from "@kt-tools/css-ts";

const styles = new ct();

styles.global = {
  "@layer reset": {
    "html": { scrollBehavior: "smooth" },
    "body": { margin: 0 },
  },
  ".prose a": {
    textDecoration: "underline",
  },
};
```

Use `.import()` when you want to register external CSS files or global rule
objects incrementally:

```ts
styles.import("./src/reset.css");
styles.import({ path: "./src/theme.css", layer: "theme" });
styles.import({
  layer: "utilities",
  rules: {
    ".u-stack": {
      display: "grid",
      gap: "1rem",
    },
  },
});
```

### Root variables

Use `root` for explicit custom properties, optionally under a CSS layer.

```ts
import ct from "@kt-tools/css-ts";

const styles = new ct();

styles.root = [
  {
    "--space": "1rem",
    "--radius": "0.75rem",
  },
  {
    layer: "theme",
    vars: {
      "--accent": "#2563eb",
    },
  },
];
```

### Reusable declarations and `@apply`

`@apply` merges plain declarations, declaration arrays, named utilities from
`css.config.ts`, and Tailwind markers.

```ts
import ct, { tw } from "@kt-tools/css-ts";

const surface = {
  backgroundColor: "#111827",
  color: "white",
};

const interactive = {
  transition: ["background-color 150ms ease", "color 150ms ease"],
  hover: { opacity: 0.9 },
};

const styles = new ct();

styles.base = {
  card: {
    "@apply": [surface, interactive, "cardBase"],
    padding: "1rem",
  },
  chip: {
    "@apply": tw("inline-flex items-center gap-2 rounded-full px-3 py-1"),
  },
};
```

### Breakpoints, containers, layers, and utilities in `css.config.ts`

Put project-wide config in the repository root:

```ts
// css.config.ts
import "./src/global.css";

export default {
  include: ["./packages/ui"],
  imports: ["./src/theme.css"],
  layers: ["reset", "theme", "components", "utilities"],
  defaultUnit: "rem",
  resolution: "hybrid",
  breakpoints: {
    sm: "40rem",
    md: "48rem",
    lg: "64rem",
  },
  containers: {
    card: {
      type: "inline-size",
      rule: "width < 30rem",
    },
  },
  utilities: {
    cardBase: {
      borderRadius: "1rem",
      boxShadow: "0 12px 40px rgb(0 0 0 / 0.12)",
    },
  },
};
```

Then consume those aliases in your builder:

```ts
import ct from "@kt-tools/css-ts";

const styles = new ct();

styles.base = {
  card: {
    "@apply": ["cardBase"],
    "@set": "card",
    display: "grid",
    gap: 1,
    padding: 1,
    "@md": {
      gridTemplateColumns: ["1fr", "1fr"],
    },
    "@card": {
      gap: 0.75,
    },
  },
};
```

What each config field does:

- `layers` emits the CSS layer order prelude
- `defaultUnit` changes the unit appended to numeric values
- `breakpoints` powers `@md`, `!@md`, and `@(sm,lg)`
- `containers` powers `@set`, `@card`, and container ranges
- `utilities` creates global `.u-*` utility classes and named `@apply` targets
- `imports` and side-effect CSS imports become `@import` rules in the virtual stylesheet

### Runtime container registration

If a container preset only exists at runtime, register it on the builder:

```ts
const styles = new ct();

styles.addContainer({
  name: "card",
  type: "inline-size",
  rule: "width < 30rem",
});

styles.base = {
  shell: {
    "@set": "card",
  },
  section: {
    "@card": {
      padding: "0.75rem",
    },
  },
};
```

### Small conveniences

`css-ts` also supports a few common quality-of-life features:

- Arrays become space-delimited or comma-delimited CSS values depending on the property
- `font([...])` quotes font family names correctly
- Image-capable properties such as `backgroundImage` auto-wrap imported assets in `url(...)`

```ts
import ct, { font } from "@kt-tools/css-ts";
import heroImage from "./hero.png";

const styles = new ct();

styles.base = {
  hero: {
    backgroundImage: heroImage,
    backgroundSize: "cover",
    fontFamily: font(["IBM Plex Sans", "system-ui", "sans-serif"]),
    gridTemplateColumns: ["auto", "1fr"],
    transition: ["opacity 150ms ease", "transform 150ms ease"],
  },
};
```

## Object shorthand

`ct({ ... })` still exists for compact one-shot declarations:

```ts
import ct from "@kt-tools/css-ts";

const styles = ct({
  base: {
    card: {
      display: "grid",
      gap: "1rem",
    },
  },
});
```

Use it when a single object is genuinely clearer. The builder is still the
recommended API for anything non-trivial.

## How extraction works

- Static `ct({ ... })` calls and module-level `new ct()` assignments are
  extracted by the Vite plugin
- Extracted rules are emitted through `virtual:css-ts/styles.css`
- Dynamic cases still work at runtime by injecting styles in the browser
- `resolution: "static"` makes unresolved patterns fail the build instead of
  falling back to runtime
- `resolution: "hybrid"` is the default for non-Astro files
- Astro defaults to static resolution unless you override it

## Build-time limits

The parser handles the common, maintainable cases well:

- object literals
- local `const` style objects
- imported `const` style objects from relative files and configured aliases
- `new ct()` followed by module-level property assignments
- `@apply`, `tw(...)`, theme helpers, arrays, and nested selectors

It does not try to execute arbitrary runtime logic. Spreads, conditional object
construction, non-const bindings, and arbitrary function calls fall back to
runtime unless you force `resolution: "static"`.
