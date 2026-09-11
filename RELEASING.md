# Releasing

Five artifacts, three registries, one repo. Nothing here publishes on its own —
each registry needs a deliberate command, and a published version cannot be
withdrawn, only deprecated.

| Artifact | Registry | Directory |
|---|---|---|
| `@chasky/botsmith` | npm | `js/` |
| `@chasky/botsmith-admin` | npm | `js/admin/` |
| `github.com/chaskyapp/botsmith-sdk/go` | Go modules (a git tag) | `go/` |
| `chasky-botsmith` | PyPI | `python/` |
| `chasky-botsmith-admin` | PyPI | `python/admin/` |

## Prerequisites outside this repo

None of these is code, and each one blocks a registry on its own:

- **GitHub**: `chaskyapp/botsmith-sdk` exists, is **public**, and this repo is pushed
  to it. The Go module path *is* that repo — without it there is nothing to tag.
  Fix `.env.example` before the first push: the repo is public from then on.
- **npm**: the publishing account is a member of the `chasky` organization. Check
  with `npm org ls chasky`; a 403 means it is not.
- **PyPI**: an API token configured for `twine` on the publishing machine. Never
  in this repo, never pasted into a chat.

## Order

1. **Runtime first**: `@chasky/botsmith` (npm) and `chasky-botsmith` (PyPI). They
   depend only on the Bot API and a bot token.
2. **Administration after the server**: `@chasky/botsmith-admin` and
   `chasky-botsmith-admin` wait until the developer-key delta (server delta 22) is
   deployed, the admin smokes pass against it, and the clients manage keys
   (issue, list, revoke) — not only authenticate with one.
3. **Go last of the first wave**: runtime and administration are ONE module, so
   `go/v0.1.0` would ship the admin package too. The Go tag waits for step 2's
   key management, even though the runtime half is ready earlier.

## License

Apache-2.0. The text is at the repo root and **copied into every artifact
directory** (`js`, `js/admin`, `go`, `python`, `python/admin`), because each
registry packages only its own directory. The copies must stay identical:

```bash
for d in js js/admin go python python/admin; do cmp LICENSE "$d/LICENSE" || echo "DIFFERS: $d"; done
```

## Before anything

Conformance is the gate. All three must be green, against the **shared** cases:

```bash
cd js     && npm run typecheck && npm run conformance
cd go     && go vet ./... && go test ./conformance/ -count=1
cd python && .venv/bin/python -m unittest conformance.test_conformance
```

`-count=1` is not optional for Go: its test cache does not hash the shared case
files, so without it a changed case reports `ok (cached)` having run nothing.

## npm

Both packages are marked `"private": true`, **and that is the safety catch**.
Removing it is the first deliberate step of a release, not a leftover — while it
is there, `npm publish` refuses.

```bash
cd js
# remove "private": true from package.json
npm run build          # tsc -p tsconfig.build.json -> dist/
npm pack --dry-run     # inspect what would ship BEFORE publishing
npm publish --access public
```

`prepublishOnly` runs typecheck, conformance and build, so a broken tree cannot
be published even by accident. `files` ships `dist` and the README only —
`conformance/`, `scripts/` and the fixtures stay out.

Then the same for `js/admin`, whose `exports` maps the `browser` condition to
`null`. **Do not remove that**: it is what makes a bundler refuse to resolve the
package for a client build, and it is the only guard on the developer key that
fails before the code ships.

## Go

There is nothing to build. A Go module is published by pushing a tag, and the
tag **must** carry the subdirectory prefix:

```bash
git tag go/v0.1.0
git push origin go/v0.1.0
```

`v0.1.0` without the prefix does not publish this module — it publishes nothing,
confusingly. Verify from a clean directory:

```bash
GOPROXY=proxy.golang.org go install github.com/chaskyapp/botsmith-sdk/go@v0.1.0
```

The `admin` package ships inside the same module. A bot author importing
`.../go` does not pull it in — Go compiles only what is imported — so the split
that npm and PyPI need packages for, Go gets for free.

## PyPI

```bash
cd python
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m build         # sdist + wheel into dist/
.venv/bin/twine check dist/*
.venv/bin/twine upload dist/*
```

Then the same in `python/admin`. Two distributions, two uploads: PyPI has no
subpath, so the separation that npm expresses with a second package name is the
only way to keep the admin client out of what a bot author installs.

## Versions

Independent per language (D11), with the contract version declared separately.
A packaging fix in Python does not force an empty release of TypeScript and Go.

Tags: `js/v0.1.0`, `go/v0.1.0`, `python/v0.1.0`.

## The one thing to check by hand

`npm pack --dry-run` and `twine check` both print what would ship. **Read the
file list.** A `.env` has never been in a package here, and the way it stays
that way is somebody looking at the list before the upload, not the `.gitignore`
alone — an ignored file that is nonetheless in `files` still ships.
