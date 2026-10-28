# Contributing

Branch, build and approval rules are in `AGENTS.md` at the repository root. Read [UPSTREAM.md](UPSTREAM.md) before editing a Halvard skill.

Keep the engine generic: languages, check commands and formatters belong in the consuming repository's configuration or extensions. Do not use `any` or compiler suppression comments; take `unknown` at system boundaries and run it through the existing validation. `adapters/pi-peer.d.ts` is a hand-written copy of the Pi host API, so check it against an installed Pi when you change the Pi adapter. Add a regression test for each behaviour change, including hostile flags and paths. Imports point down the layers that `tests/layers.test.ts` lists: only entry points in `bin/`, `adapters/` and `scripts/` import `core/runtime.ts`, so a core module that needs a helper from it moves the helper down instead.

## Checks

```sh
npm ci --omit=peer
npm run format:check
npm test
npm run verify-install
npm pack --dry-run
```

Prettier owns TypeScript formatting; run `npm run format` before committing. Node runs the TypeScript directly, so Claude Code, Codex and Pi install from a clone with nothing to build. `npm test` typechecks and runs `tests/*.test.ts` against real temporary Git repositories. Reviewer tests use fake provider executables, so they check routing and state, not model quality. `verify-install` installs the packed tarball and runs every packaged suite from it, then checks manifest entry points and documentation links.

`node scripts/verify-hosts.ts` is an optional check against the Claude and Codex CLIs installed on your machine. Add `--pi-loader /path/to/pi/dist/core/extensions/loader.js` to include Pi. It sends no model prompts, changes no trust settings and skips hosts that are missing.

## Before a release

Bump the version in `package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `.grok-plugin/plugin.json` together and add a CHANGELOG entry. Run the checks on the final tree and read the packed file list, looking for private paths or details from other projects. A new document linked from README must also go in the `files` list of `package.json`.

Load the plugin in each supported harness with hook trust approved, and check four things: the startup context appears, a read works on a protected branch, a write is denied there, and a write works on a feature branch. When hook command paths change, Claude Code and Codex ask for hook trust again; approve it by hand and never edit trust settings from code.
