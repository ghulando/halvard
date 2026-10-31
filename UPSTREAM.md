# Adapted upstream skills

The Halvard skills are rewritten from these pinned sources and ship with this package.

| Source | Pinned commit | Used for |
|---|---|---|
| [Pstack](https://github.com/cursor/plugins/tree/4dd1d05818d19792e7cd6e818f1667f95f7e1dbe/pstack) | `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe` | Investigation, architecture, impact, verification, verified slices, benchmark vetting, enforcing corrections |
| [Matt Pocock skills](https://github.com/mattpocock/skills/tree/a496f5513d4a4cf889bc48e189e579f4b0bdf6aa) | `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` | Requirements, specs, slices, debugging, tests, review, handoffs, setup |
| [asd-ste100-skill](https://github.com/danyuchn/asd-ste100-skill/tree/3944283c183eea13fe5bd902b572da3b4de8bf44) | `3944283c183eea13fe5bd902b572da3b4de8bf44` | Writing for agents and parsers |

`third-party/sources.json` maps each original file to the skills adapted from it, with its SHA-256. The MIT notices are in `third-party/`.

The adaptations drop Cursor-only tools, fixed model names, automatic commits and shipping, mandatory parallel agents and issue-tracker publishing. halvard-write drops the asd-ste100 Python linter, because the package ships only Node.

To take an upstream change, fetch the new commit, compare each mapped skill, port what is useful, update the commit, hashes and this table, then rerun the behaviour checks. Installing the package never fetches upstream content.
