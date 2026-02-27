---
trigger: always_on
---

Dev tools are installed via mise-en-place.

# Dev Scripts

`mise run` to access predefined dev scripts

- build | Build the Projet | Deno Script
- publish | Publish the Package to JSR Registry
- publish:test | Publish Dry Run
- test | Run Pre-Build Unit Test Suite
- test:all | Run Full Test Suite (Pre-Build + Shim Smoke)
- test:shim | Test Post-Build Shim Compatibilty

## Available Tools

- deno@latest
- jj@latest
- node@latest

Preferred javascript runtime for project is deno.

## Additional tooling.

If access is needed to a command that is not pre-installed in the dev environment, one shot commands can be run via `mise x [tool]@[version] -- command`

Example:

`mise x deno@latest -- deno run --allow-all sv create`