# Releasing

Five artifacts, three registries, one repo. Nothing here publishes on its own —
each registry needs a deliberate command, and a published version cannot be
withdrawn, only deprecated.

| Artifact | Registry | Directory |
|---|---|---|
| `@chasky/botsmith-sdk` | npm | `js/` |
| `@chasky/botsmith-sdk-admin` | npm | `js/admin/` |
| `github.com/chaskyapp/botsmith-sdk/go` | Go modules (a git tag) | `go/` |
| `chasky-botsmith-sdk` | PyPI | `python/` |
| `chasky-botsmith-sdk-admin` | PyPI | `python/admin/` |

## Prerequisites outside this repo

None of these is code, and each one blocks a registry on its own:

- **GitHub**: `chaskyapp/botsmith-sdk` exists, is **public**, and this repo is pushed
  to it. The Go module path *is* that repo — without it there is nothing to tag.
  Nothing here needs an env file: the repo ships no examples or smoke programs.
- **npm**: the token that publishes the first version belongs to a member of the
  `chasky` organization and has read and write on the `@chasky` scope. npm hides a
  write it refuses: the publish fails with **404 Not Found**, not 403. `npm org ls
  chasky` does not settle it either way — it answers 403 to any token without
  organization access, member or not.
- **PyPI**: a trusted publisher per project (see *One-time setup* below). No token
  is stored anywhere.

## Order

1. **Runtime first**: `@chasky/botsmith-sdk` (npm) and `chasky-botsmith-sdk` (PyPI).
   They depend only on the Bot API and a bot token.
2. **Administration after the server**: `@chasky/botsmith-sdk-admin` and
   `chasky-botsmith-sdk-admin` wait until the developer-key delta (server delta 22) is
   deployed and verified against a real instance, and the clients manage keys
   (issue, list, revoke) — not only authenticate with one.
3. **Go ships both halves at once**: runtime and administration are ONE module,
   so a Go tag carries the admin package whether or not step 2 has happened.
   `go/v0.1.0` was tagged on 2026-09-11, before the server delta was deployed, so
   `.../go/admin` is already public and calls endpoints a deployed server does not
   answer yet. That is the cost of the module being the unit: from here on, a Go
   tag is a decision about **both** surfaces.

## How a release happens

Automated by `.github/workflows/publish.yml`, and triggered the way nexus is: by
**publishing a GitHub Release**, not by pushing a tag. A tag pushed by mistake
would otherwise publish, and a published version can only be deprecated.

1. In a commit on `main`, set the version in the manifest. For an npm package,
   also remove `"private": true` — deliberately, in that same commit. Wait for CI.
2. Tag it with the artifact's prefix and push the tag:

   ```bash
   git tag js/v0.1.0 && git push origin js/v0.1.0
   ```

3. Publish a GitHub Release for that tag, with notes.

**The tag must sit on a commit that already contains `publish.yml`.** A Release
runs the workflow **as it exists in the tagged commit**, not as it exists on
`main`. `go/v0.1.0` points at `1d4a0f7`, which predates the workflow, so
publishing that Release triggered nothing at all — no failure, no run, no notice.
The Go module reached the proxy anyway, because a Go tag *is* the publication.
For npm and PyPI the same mistake means silence and no package.

**Never move a tag that has already published.** The Go proxy caches a version
permanently; retagging produces a module whose contents disagree with what the
proxy serves. Cut a new version instead.

The workflow then resolves which artifact the tag names, refuses to publish if
the tag and the manifest disagree or the package is still marked private, runs
conformance, publishes, and posts to Discord.

| Tag | Publishes |
|---|---|
| `go/vX.Y.Z` | the Go module — asks the proxy to fetch it; there is nothing to build |
| `js/vX.Y.Z` | `@chasky/botsmith-sdk` |
| `js-admin/vX.Y.Z` | `@chasky/botsmith-sdk-admin` |
| `python/vX.Y.Z` | `chasky-botsmith-sdk` |
| `python-admin/vX.Y.Z` | `chasky-botsmith-sdk-admin` |

### One-time setup

- **PyPI**, for `chasky-botsmith-sdk` and for `chasky-botsmith-sdk-admin`: add a *pending*
  trusted publisher — owner `chaskyapp`, repository `botsmith-sdk`, workflow
  `publish.yml`, environment `pypi`. It works before the project exists, which is
  what npm cannot do. The project name is the distribution name as PyPI
  normalises it: `chasky-botsmith-sdk`, the name in `pyproject.toml`, **not** the
  import name. Check it appears under *Pending publishers* afterwards — a form
  that was filled but not submitted fails at release time with
  `invalid-publisher`, and the claims printed in that error are what GitHub sent,
  not what PyPI has. A pending publisher does **not** reserve the name: until the
  first version is up, anyone can take it.
- **npm**, for each of the two packages: npm only lets a trusted publisher be
  configured on a package that already exists. So the **first** version ships
  with a repository secret `NPM_TOKEN`, and the token has to be exactly right:
  a granular token with **"Read and write (publish and stage)"** — *stage only*
  cannot publish a version directly, it only stages one for a maintainer to
  promote — and scoped to **`@chasky`**, not to selected packages, because the
  package does not exist yet. Anything else fails as **404**, which reads like a
  typo and is really a permission.

  Then, in the package's settings on npmjs.com, add a trusted publisher (GitHub
  Actions, `chaskyapp/botsmith-sdk`, `publish.yml`, environment `npm`) and tick
  **Allow `npm publish`** under *Allowed actions*. Without that tick the publisher
  can only stage, and this workflow runs `npm publish` — the next release would
  fail on permissions again. The connection **cannot be edited afterwards**: to
  change it, delete it and create it again.

  Finally **delete the secret**, revoke the token, and set *Publishing access* to
  *require 2FA and disallow bypass-2FA tokens*; trusted publishers keep working
  under that setting. From the next release on, no token exists — which is the
  point, since npm removes direct publishing with bypass-2FA tokens in January
  2027.
- **Discord**: a repository secret `DISCORD_WEBHOOK`. Without it the notice is
  skipped and the release still publishes.

## After publishing: conformance against the registry copy

Everything above proves the **artifact** is well formed — the right files, the
license in, no `.env`. It does not prove the **published code** still keeps the
guarantees, because conformance normally runs against the working tree. Run it
once more against what the registries actually serve.

The trick is the same in all three languages: move the runner OUT of the repo and
make it resolve the SDK from the registry. Every ecosystem silently prefers local
code, so a run left inside the repo measures the working tree while reporting
that it measured the release.

```bash
# Go — inside the module, the import resolves to local code no matter what.
# A separate module is what forces the proxy copy.
B=$(mktemp -d) && mkdir -p "$B/conformance" "$B/go"
cp -R conformance/cases "$B/conformance/cases"
cp -R go/conformance    "$B/go/conformance"
cd "$B/go"
printf 'module probe\n\ngo 1.23\n\nrequire github.com/chaskyapp/botsmith-sdk/go v0.1.0\n' > go.mod
GOFLAGS=-mod=mod go mod tidy
go list -m github.com/chaskyapp/botsmith-sdk/go        # must print v0.1.0
go test ./conformance/ -count=1 -v | grep -c '^    --- PASS'
```

```bash
# TypeScript — the adapter imports ../src/. Point it at the package instead.
B=$(mktemp -d) && cp -R conformance "$B/conformance" && cp -R js "$B/js"
cd "$B/js" && npm install @chasky/botsmith-sdk
# in conformance/sdk-adapter.ts, replace the three ../src/*.js imports with:
#   import { createBot, ChaskyApiError, polling, type Bot } from "@chasky/botsmith-sdk";
grep -n '\.\./src/' conformance/sdk-adapter.ts       # must print nothing
npx tsx conformance/run.ts
```

```bash
# Python — the runner imports by module name, so the danger is sys.path: run it
# from python/ and the local chasky_botsmith/ wins over the installed one.
R=$PWD && B=$(mktemp -d) && mkdir -p "$B/python"
cp -R conformance "$B/conformance"
cp -R python/conformance "$B/python/conformance"
cd "$B/python" && python3 -m venv .venv
.venv/bin/pip install chasky-botsmith-sdk
.venv/bin/pip install -e "$R/python/admin"            # not published yet
.venv/bin/python -c "import chasky_botsmith; print(chasky_botsmith.__file__)"
.venv/bin/python -m unittest conformance.test_conformance -v
```

**Check where the SDK came from before believing the result.** `go list -m` and
`chasky_botsmith.__file__` are the evidence; a green run proves nothing about the
release if the import quietly resolved to the repo.

**Count the cases too.** Go prints `ok` for a package that ran zero cases, and
unittest reports "3 tests" where there are 21 — it groups them. Count `--- PASS`
lines, or load the cases and print `len`. Expect **21**.

**Administration is only half covered** until the admin packages are published:
in npm and PyPI the M cases run against the repo, since the runner needs a client
that does not exist in the registry yet. Go is the exception — admin travels in
the same module, so all 21 come from the proxy. Rerun this after the admin
releases and all three are covered end to end.

The sections below are the manual fallback, for when the workflow cannot run.

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

Independent per artifact (D11, D14), with the contract version declared
separately. A packaging fix in Python does not force an empty release of
TypeScript and Go, and a change to the admin surface does not force a release of
the runtime. Go is the exception by construction: one module, one version for
both surfaces.

Tags: `go/v0.1.0`, `js/v0.1.0`, `js-admin/v0.1.0`, `python/v0.1.0`,
`python-admin/v0.1.0` — one prefix per artifact, because they ship at different
times.

## The one thing to check by hand

`npm pack --dry-run` and `twine check` both print what would ship. **Read the
file list.** A `.env` has never been in a package here, and the way it stays
that way is somebody looking at the list before the upload, not the `.gitignore`
alone — an ignored file that is nonetheless in `files` still ships.
