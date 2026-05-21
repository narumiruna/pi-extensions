set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available commands
default:
    @just --list

# Run formatter, linter, and typechecks for all packages
check:
    npm run check

# Format all files with Biome
format:
    npm run format

# Install pre-commit hooks
hooks:
    pre-commit install

# Run pre-commit hooks against all files
pre-commit:
    pre-commit run --all-files

# Show npm account/registry/package visibility information for one package
# Usage: just doctor @narumitw/pi-chrome-devtools
doctor package="@narumitw/pi-chrome-devtools":
    @echo "package: {{package}}"
    npm whoami
    npm config get registry
    npm access get status {{package}} || true
    npm dist-tag ls {{package}} || true
    npm view {{package}} version || true

# Show npm visibility/version information for all extension packages
doctor-all:
    for package_json in extensions/*/package.json; do package="$(node -p "require('./$package_json').name")"; just doctor "$package"; done

# Make an already-published scoped npm package public if npm view returns 404
# This does not create a package. For a brand-new package, first run:
#   npm publish --workspace @narumitw/pi-subagents --access public
# Usage for existing packages: just npm-public @narumitw/pi-goal
npm-public package="@narumitw/pi-goal":
    npm access set status=public {{package}}
    npm view {{package}} version

# Preview the package that npm would publish
# Usage: just pack subagents
pack name:
    package="$(node -p "require('./extensions/pi-{{name}}/package.json').name")"; npm --workspace "$package" pack --dry-run

# Try a package from this working tree as a temporary pi package
# Usage: just try subagents
try name:
    pi -e ./extensions/pi-{{name}}

# Install a package through pi, falling back to the local workspace if unpublished
# Usage: just install subagents
install name:
    package="$(node -p "require('./extensions/pi-{{name}}/package.json').name")"; if npm view "$package" version >/dev/null 2>&1; then pi install "npm:$package"; else echo "$package is not published; installing local workspace package instead."; pi install ./extensions/pi-{{name}}; fi

# Publish one package to npm, skipping if the current version already exists
# Usage: just publish subagents
publish name:
    package="$(node -p "require('./extensions/pi-{{name}}/package.json').name")"; version="$(node -p "require('./extensions/pi-{{name}}/package.json').version")"; if npm view "$package@$version" version >/dev/null 2>&1; then echo "$package@$version already exists; skipping publish."; else npm --workspace "$package" pack --dry-run; npm --workspace "$package" publish --access public; fi

# Publish all extension packages to npm
publish-all:
    for package_json in extensions/*/package.json; do dir="$(basename "$(dirname "$package_json")")"; just publish "${dir#pi-}"; done

# Install all active extension packages through pi
install-all:
    for package_json in extensions/*/package.json; do dir="$(basename "$(dirname "$package_json")")"; just install "${dir#pi-}"; done

# Preview individual packages that npm would publish
pack-btw:
    just pack btw

pack-caffeinate:
    just pack caffeinate

pack-chrome-devtools:
    just pack chrome-devtools

pack-codex-usage:
    just pack codex-usage

pack-firecrawl:
    just pack firecrawl

pack-goal:
    just pack goal

pack-lsp:
    just pack lsp

pack-plan-mode:
    just pack plan-mode

pack-retry:
    just pack retry

pack-statusline:
    just pack statusline

pack-sync:
    just pack sync

pack-subagents:
    just pack subagents

# Try individual packages from this working tree as temporary pi packages
try-btw:
    just try btw

try-caffeinate:
    just try caffeinate

try-chrome-devtools:
    just try chrome-devtools

try-codex-usage:
    just try codex-usage

try-firecrawl:
    just try firecrawl

try-goal:
    just try goal

try-lsp:
    just try lsp

try-plan-mode:
    just try plan-mode

try-retry:
    just try retry

try-statusline:
    just try statusline

try-sync:
    just try sync

try-subagents:
    just try subagents

# Install individual packages through pi
install-btw:
    just install btw

install-caffeinate:
    just install caffeinate

install-chrome-devtools:
    just install chrome-devtools

install-codex-usage:
    just install codex-usage

install-firecrawl:
    just install firecrawl

install-goal:
    just install goal

install-lsp:
    just install lsp

install-plan-mode:
    just install plan-mode

install-retry:
    just install retry

install-statusline:
    just install statusline

install-sync:
    just install sync

install-subagents:
    just install subagents

# Publish individual packages to npm
publish-btw:
    just publish btw

publish-caffeinate:
    just publish caffeinate

publish-chrome-devtools:
    just publish chrome-devtools

publish-codex-usage:
    just publish codex-usage

publish-firecrawl:
    just publish firecrawl

publish-goal:
    just publish goal

publish-lsp:
    just publish lsp

publish-plan-mode:
    just publish plan-mode

publish-retry:
    just publish retry

publish-statusline:
    just publish statusline

publish-sync:
    just publish sync

publish-subagents:
    just publish subagents

# Bump one workspace package without creating a git tag
# Usage: just bump @narumitw/pi-goal patch
bump package part="patch":
    npm --workspace {{package}} version {{part}} --no-git-tag-version
