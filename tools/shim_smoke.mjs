import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ct from "../dist/index.js";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertDistGuards() {
  const viteDistPath = path.resolve("dist/vite.js");
  const code = fs.readFileSync(viteDistPath, "utf8");

  assert(!code.includes('require("npm:typescript'), "dist/vite.js must not require npm:typescript");
  assert(!code.includes("require('npm:typescript"), "dist/vite.js must not require npm:typescript");
  assert(code.includes('nodeRequire("typescript")'), "dist/vite.js must load typescript via nodeRequire");
}

function asHook(hook) {
  if (typeof hook === "function") {
    return hook;
  }
  if (hook && typeof hook === "object" && "handler" in hook) {
    return hook.handler;
  }
  throw new Error("Expected plugin hook");
}

function runTransformCase(stylesheetSource, expectedCssPattern) {
  const plugin = ct.vite();
  const transform = asHook(plugin.transform);
  const load = asHook(plugin.load);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "css-ts-shim-"));
  try {
    const libDir = path.join(root, "src", "lib");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "stylesheet.ts"), stylesheetSource, "utf8");

    const moduleCode =
      'import ct from "css-ts";\n' +
      'import { blue } from "$lib/stylesheet";\n' +
      "const styles = new ct();\n" +
      "styles.base = { header: { borderBottom: \"2px solid currentColor\" } };\n" +
      "styles.variant = { theme: { dark: { header: { borderBottomColor: blue.l300 } } } };\n" +
      "styles.defaults = { theme: \"dark\" };\n";

    const transformed = transform(moduleCode, path.join(root, "src", "routes", "+page.ts"));
    assert(transformed && typeof transformed === "object" && "code" in transformed, "Expected transformed output");

    const css = load("\0virtual:css-ts/styles.css");
    assert(typeof css === "string", "Expected virtual stylesheet contents");
    assert(expectedCssPattern.test(css), "Expected compiled CSS to include resolved helper color");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function main() {
  assertDistGuards();

  runTransformCase(
    [
      "const colorUtils = {",
      "  oklch: (l: number, c: number, h: number) => `oklch(${l}% ${c} ${h})`,",
      "};",
      "export const blue = {",
      "  l300: colorUtils.oklch(70, 0.1679, 242.04),",
      "};",
      "",
    ].join("\n"),
    /\.ct_[a-z0-9]+\{border-bottom-color:oklch\(70% 0\.1679 242\.04\)\}/,
  );

  runTransformCase(
    [
      "function oklch(l: number, c: number, h: number) {",
      "  return `oklch(${l}% ${c} ${h})`;",
      "}",
      "export const blue = {",
      "  l300: oklch(70, 0.1679, 242.04),",
      "};",
      "",
    ].join("\n"),
    /\.ct_[a-z0-9]+\{border-bottom-color:oklch\(70% 0\.1679 242\.04\)\}/,
  );

  console.log("shim smoke checks passed");
}

main();
