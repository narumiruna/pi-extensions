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

# Update, install, rebuild, and verify dependencies across all npm workspaces
update:
    npx npm-check-updates --workspaces --root -u
    npm install
    # Rebuild generated web assets only in workspaces that provide build:web
    npm --workspaces --if-present run build:web
    npm run check

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

# Show npm visibility/version information for all publishable packages
doctor-all:
    shopt -s nullglob; for package_json in packages/*/package.json extensions/*/package.json experimental/*/package.json; do package="$(node -p "require('./$package_json').name")"; just doctor "$package"; done

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
    name={{quote(name)}}; package_json="./extensions/pi-$name/package.json"; if [[ ! -f "$package_json" ]]; then package_json="./experimental/pi-$name/package.json"; fi; [[ -f "$package_json" ]] || { echo "extension package not found for: $name" >&2; exit 2; }; package="$(node -p "require(process.argv[1]).name" "$package_json")"; npm --workspace "$package" pack --dry-run

# Try a package from this working tree as a temporary pi package
# Usage: just try subagents
try name: (_validate-extension-name name)
    name={{quote(name)}}; extension_dir="./extensions/pi-$name"; if [[ ! -d "$extension_dir" ]]; then extension_dir="./experimental/pi-$name"; fi; [[ -d "$extension_dir" ]] || { echo "extension package not found for: $name" >&2; exit 2; }; pi -e "$extension_dir"

# Start a fresh Pi session with every local extension package loaded
try-all:
    shopt -s nullglob; args=(); for package_json in ./extensions/pi-*/package.json ./experimental/pi-*/package.json; do args+=(-e "$(dirname "$package_json")"); done; pi -ne "${args[@]}"

# Install a package through pi, falling back to the local workspace if unpublished
# Usage: just install subagents
install name: (_validate-extension-name name)
    name={{quote(name)}}; extension_dir="./extensions/pi-$name"; if [[ ! -d "$extension_dir" ]]; then extension_dir="./experimental/pi-$name"; fi; package_json="$extension_dir/package.json"; [[ -f "$package_json" ]] || { echo "extension package not found for: $name" >&2; exit 2; }; package="$(node -p "require(process.argv[1]).name" "$package_json")"; if npm view "$package" version >/dev/null 2>&1; then pi install "npm:$package"; else echo "$package is not published; installing local workspace package instead."; pi install "$extension_dir"; fi

_publish-package-json package_json:
    package_json={{quote(package_json)}}; if [[ "$package_json" == ./experimental/* ]]; then echo "WARNING: publishing experimental Pi extension $(basename "$(dirname "$package_json")")." >&2; fi; package="$(node -p "require(process.argv[1]).name" "$package_json")"; version="$(node -p "require(process.argv[1]).version" "$package_json")"; if npm view "$package@$version" version >/dev/null 2>&1; then echo "$package@$version already exists; skipping publish."; else npm --workspace "$package" pack --dry-run; npm --workspace "$package" publish --access public; fi

# Manually publish one production or experimental extension, skipping an existing version
# Usage: just publish subagents
publish name: (_validate-extension-name name)
    name={{quote(name)}}; package_json="./extensions/pi-$name/package.json"; if [[ ! -f "$package_json" ]]; then package_json="./experimental/pi-$name/package.json"; fi; [[ -f "$package_json" ]] || { echo "extension package not found for: $name" >&2; exit 2; }; just _publish-package-json "$package_json"

# Publish all libraries, production extensions, and experimental extensions to npm
publish-all:
    for package_json in packages/*/package.json extensions/*/package.json experimental/*/package.json; do just _publish-package-json "$package_json"; done

# Preview individual packages that npm would publish
pack-tui-kit:
    npm --workspace @narumitw/pi-tui-kit pack --dry-run

publish-tui-kit:
    just _publish-package-json ./packages/pi-tui-kit/package.json

pack-btw:
    just pack btw

pack-caffeinate:
    just pack caffeinate

pack-chrome-devtools:
    just pack chrome-devtools

pack-accounts:
    just pack accounts

pack-usage:
    just pack usage

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

pack-jupyter:
    just pack jupyter

pack-langfuse:
    just pack langfuse

pack-lsp:
    just pack lsp

pack-plan-mode:
    just pack plan-mode

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

pack-worktree:
    just pack worktree

# Try individual packages from this working tree as temporary pi packages
try-btw:
    just try btw

try-caffeinate:
    just try caffeinate

try-chrome-devtools:
    just try chrome-devtools

try-accounts:
    just try accounts

try-usage:
    just try usage

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

try-jupyter:
    just try jupyter

try-langfuse:
    just try langfuse

try-lsp:
    just try lsp

try-plan-mode:
    just try plan-mode

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

try-worktree:
    just try worktree

# Install individual packages through pi
install-btw:
    just install btw

install-caffeinate:
    just install caffeinate

install-chrome-devtools:
    just install chrome-devtools

install-accounts:
    just install accounts

install-usage:
    just install usage

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

install-jupyter:
    just install jupyter

install-langfuse:
    just install langfuse

install-lsp:
    just install lsp

install-plan-mode:
    just install plan-mode

install-statusline:
    just install statusline

install-sync:
    just install sync

install-subagents:
    just install subagents

install-webui:
    just install webui

install-worktree:
    just install worktree

# Publish individual packages to npm
publish-btw:
    just publish btw

publish-caffeinate:
    just publish caffeinate

publish-chrome-devtools:
    just publish chrome-devtools

publish-accounts:
    just publish accounts

publish-usage:
    just publish usage

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

publish-jupyter:
    just publish jupyter

publish-langfuse:
    just publish langfuse

publish-lsp:
    just publish lsp

publish-plan-mode:
    just publish plan-mode

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

publish-worktree:
    just publish worktree

# Bump one workspace package without creating a git tag
# Usage: just bump @narumitw/pi-goal patch
bump package part="patch":
    npm --workspace {{quote(package)}} version {{quote(part)}} --no-git-tag-version
