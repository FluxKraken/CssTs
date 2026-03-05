const scope = { AppStyles: { Colors: { red: "red" } } };
const source = `{ textAlign: center, color: AppStyles.Colors.red, padding: [1, 2] }`;

const proxyScope = new Proxy(scope, {
  has(target, key) {
    return true;
  },
  get(target, key) {
    if (key in target) return target[key];
    if (key === Symbol.unscopables) return undefined;
    if (typeof key === "string" && key in globalThis) {
      return globalThis[key];
    }
    return key;
  }
});

try {
  const fn = new Function("__scope", `with (__scope) { return (${source}); }`);
  console.log(fn(proxyScope));
} catch (err) {
  console.error(err);
}
