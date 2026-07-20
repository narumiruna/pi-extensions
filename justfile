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
    @printf 'package: %s\n' {{quote(package)}}
    npm whoami || true
    npm config get registry
    npm access get status {{quote(package)}} || true
    npm dist-tag ls {{quote(package)}} || true
    npm view {{quote(package)}} version || true

# Show npm visibility/version information for all extension packages
doctor-all:
    for package_json in extensions/*/package.json; do package="$(node -p "require('./$package_json').name")"; just doctor "$package"; done

# Make an already-published scoped npm package public if npm view returns 404
# This does not create a package. For a brand-new package, first run:
#   npm publish --workspace @narumitw/pi-subagents --access public
# Usage for existing packages: just npm-public @narumitw/pi-goal
npm-public package="@narumitw/pi-goal":
    npm access set status=public {{quote(package)}}
    npm view {{quote(package)}} version

_validate-extension-name name:
    @[[ {{quote(name)}} =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { printf 'invalid extension name: %s\n' {{quote(name)}} >&2; exit 2; }

# Preview the package that npm would publish
# Usage: just pack subagents
pack name: (_validate-extension-name name)
    name={{quote(name)}}; package="$(node -p "require('./extensions/pi-' + process.argv[1] + '/package.json').name" "$name")"; npm --workspace "$package" pack --dry-run

# Try a package from this working tree as a temporary pi package
# Usage: just try subagents
try name: (_validate-extension-name name)
    name={{quote(name)}}; pi -e "./extensions/pi-$name"

# Start a fresh Pi session with every local extension loaded
try-all:
    args=(); for dir in ./extensions/pi-*; do args+=(-e "$dir"); done; pi -ne "${args[@]}"

# Install a package through pi, falling back to the local workspace if unpublished
# Usage: just install subagents
install name: (_validate-extension-name name)
    name={{quote(name)}}; package="$(node -p "require('./extensions/pi-' + process.argv[1] + '/package.json').name" "$name")"; if npm view "$package" version >/dev/null 2>&1; then pi install "npm:$package"; else echo "$package is not published; installing local workspace package instead."; pi install "./extensions/pi-$name"; fi

# Manually publish one production or experimental package, skipping an existing version
# Usage: just publish subagents [otp]
publish name otp="": (_validate-extension-name name)
    name={{quote(name)}}; otp={{quote(otp)}}; package_json="./extensions/pi-$name/package.json"; if [[ ! -f "$package_json" ]]; then package_json="./extensions/experimental/pi-$name/package.json"; fi; [[ -f "$package_json" ]] || { echo "extension package not found for: $name" >&2; exit 2; }; if [[ "$package_json" == ./extensions/experimental/* ]]; then echo "WARNING: manually publishing experimental Pi extension pi-$name; automated workflows exclude it." >&2; fi; package="$(node -p "require(process.argv[1]).name" "$package_json")"; version="$(node -p "require(process.argv[1]).version" "$package_json")"; if npm view "$package@$version" version >/dev/null 2>&1; then echo "$package@$version already exists; skipping publish."; else otp_flag=(); [[ -z "$otp" ]] || otp_flag=(--otp "$otp"); npm --workspace "$package" pack --dry-run; npm --workspace "$package" publish --access public "${otp_flag[@]}"; fi

# Publish all production extension packages to npm; experimental packages are excluded
publish-all:
    for package_json in extensions/*/package.json; do dir="$(basename "$(dirname "$package_json")")"; just publish "${dir#pi-}"; done

# Preview individual packages that npm would publish
pack-btw:
    just pack btw

pack-caffeinate:
    just pack caffeinate

pack-chrome-devtools:
    just pack chrome-devtools

pack-codex-accounts:
    just pack codex-accounts

pack-codex-usage:
    just pack codex-usage

pack-firecrawl:
    just pack firecrawl

pack-github-pr:
    just pack github-pr

pack-google-genai:
    just pack google-genai

pack-goal:
    just pack goal

pack-image-drop:
    just pack image-drop

pack-langfuse:
    just pack langfuse

pack-lsp:
    just pack lsp

pack-plan-mode:
    just pack plan-mode

pack-retry:
    just pack retry

pack-starship:
    just pack starship

pack-statusline:
    just pack statusline

pack-sync:
    just pack sync

pack-subagents:
    just pack subagents

pack-webui:
    just pack webui

# Try individual packages from this working tree as temporary pi packages
try-btw:
    just try btw

try-caffeinate:
    just try caffeinate

try-chrome-devtools:
    just try chrome-devtools

try-codex-accounts:
    just try codex-accounts

try-codex-usage:
    just try codex-usage

try-firecrawl:
    just try firecrawl

try-github-pr:
    just try github-pr

try-google-genai:
    just try google-genai

try-goal:
    just try goal

try-image-drop:
    just try image-drop

try-langfuse:
    just try langfuse

try-lsp:
    just try lsp

try-plan-mode:
    just try plan-mode

try-retry:
    just try retry

try-starship:
    just try starship

try-statusline:
    just try statusline

try-sync:
    just try sync

try-subagents:
    just try subagents

try-webui:
    just try webui

# Install individual packages through pi
install-btw:
    just install btw

install-caffeinate:
    just install caffeinate

install-chrome-devtools:
    just install chrome-devtools

install-codex-accounts:
    just install codex-accounts

install-codex-usage:
    just install codex-usage

install-firecrawl:
    just install firecrawl

install-github-pr:
    just install github-pr

install-google-genai:
    just install google-genai

install-goal:
    just install goal

install-image-drop:
    just install image-drop

install-langfuse:
    just install langfuse

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

install-webui:
    just install webui

# Publish individual packages to npm
publish-btw:
    just publish btw

publish-caffeinate:
    just publish caffeinate

publish-chrome-devtools:
    just publish chrome-devtools

publish-codex-accounts:
    just publish codex-accounts

publish-codex-usage:
    just publish codex-usage

publish-firecrawl:
    just publish firecrawl

publish-github-pr:
    just publish github-pr

publish-google-genai:
    just publish google-genai

publish-goal:
    just publish goal

publish-image-drop:
    just publish image-drop

publish-langfuse:
    just publish langfuse

publish-lsp:
    just publish lsp

publish-plan-mode:
    just publish plan-mode

publish-retry:
    just publish retry

publish-starship:
    just publish starship

publish-statusline:
    just publish statusline

publish-sync:
    just publish sync

publish-subagents:
    just publish subagents

publish-webui:
    just publish webui

# Bump one workspace package without creating a git tag
# Usage: just bump @narumitw/pi-goal patch
bump package part="patch":
    npm --workspace {{quote(package)}} version {{quote(part)}} --no-git-tag-version
