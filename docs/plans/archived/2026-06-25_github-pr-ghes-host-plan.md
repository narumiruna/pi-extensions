## Goal

Make `pi-github-pr` work with GitHub Enterprise Server without requiring users to set `GH_HOST`, while keeping github.com behavior unchanged.

## Context

`extensions/pi-github-pr/src/github-pr.ts` runs `gh pr view`, then runs `gh api graphql` for comment/review counts. `gh pr view` can infer the host from the current repository, but `gh api graphql` defaults to `github.com` unless `--hostname` or `GH_HOST` is provided. The PR URL returned by `gh pr view` already contains the host.

## Plan

- [x] Extend `parsePrCoordinates` in `extensions/pi-github-pr/src/github-pr.ts` to return the PR URL hostname along with owner, repo name, and number; verified by `npm test` covering `https://github.example.com/org/repo/pull/123` and expecting `--hostname github.example.com`.
- [x] Pass `--hostname <hostname>` to the `gh api graphql` call in `runGhPrCountQuery` so count queries target the same host as the PR URL; verified with `npm test` that mocked `gh api graphql` args include `--hostname` for both github.com and enterprise URLs.
- [x] Update `extensions/pi-github-pr/README.md` to say GitHub Enterprise works through `gh auth login --hostname <host>` and no manual `GH_HOST` is required; verified by reading the Prerequisites and Known limits sections.
- [x] Run package checks for the extension; verified with `npm run check --workspace @narumitw/pi-github-pr`.

## Risks

- Mitigated: installed `gh api --help | rg -- '--hostname'` reports `--hostname string       The GitHub hostname for the request (default "github.com")`.

## Completion Checklist

- [x] `gh api graphql` uses the PR URL host instead of defaulting to `github.com`, verified by unit-test expected exec args in `extensions/pi-github-pr/test/github-pr.test.ts` and `npm test`.
- [x] GitHub Enterprise usage is documented, verified by `extensions/pi-github-pr/README.md` mentioning `gh auth login --hostname <host>` and no `GH_HOST` requirement.
- [x] The extension still passes its checks, verified by `npm run check --workspace @narumitw/pi-github-pr` and full `npm run check`.
