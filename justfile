set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available commands
default:
    @just --list

# Run build, formatting, boundary, and type checks
check:
    npm run check

# Run all active tests
test:
    npm test

# Format all files with Biome
format:
    npm run format

_require-clean-worktree:
    @[[ -z "$(git status --porcelain)" ]] || { printf 'dependency updates require a clean worktree\n' >&2; exit 2; }

# Update dependency manifests and lockfile
update-lock: _require-clean-worktree
    npm exec -- npm-check-updates --workspaces --root -u
    npm install --package-lock-only --ignore-scripts

# Verify dependency updates from the exact clean lockfile installation
verify-update:
    npm ci
    # Rebuild generated web assets only in workspaces that provide build:web
    npm --workspaces --if-present run build:web
    npm run check
    npm test
    npm pack --workspaces --dry-run

# Update, clean-install, rebuild, test, and pack all npm workspaces
update: update-lock verify-update

# Install Husky Git hooks
hooks:
    npm run prepare

# Run the pre-commit checks
pre-commit:
    npm run precommit

# Show npm account/registry/package visibility information for one package
# Usage: just doctor @narumitw/pi-chrome-devtools
doctor package="@narumitw/pi-chrome-devtools":
    @printf 'package: %s\n' {{ quote(package) }}
    npm whoami || true
    npm config get registry
    npm access get status {{ quote(package) }} || true
    npm dist-tag ls {{ quote(package) }} || true
    npm view {{ quote(package) }} version || true

# Show npm visibility/version information for all publishable packages
doctor-all:
    shopt -s nullglob; for package_json in packages/*/package.json; do package="$(node -p "require('./$package_json').name")"; just doctor "$package"; done

# Make an already-published scoped npm package public if npm view returns 404
# This does not create a package. For a brand-new package, first run:
#   npm publish --workspace @narumitw/pi-subagents --access public
# Usage for existing packages: just npm-public @narumitw/pi-goal
npm-public package="@narumitw/pi-goal":
    npm access set status=public {{ quote(package) }}
    npm view {{ quote(package) }} version

_validate-package-name name:
    @[[ {{ quote(name) }} =~ ^[a-z0-9]+(-[a-z0-9]+)*$ ]] || { printf 'invalid package name: %s\n' {{ quote(name) }} >&2; exit 2; }

# Preview the package that npm would publish
# Usage: just pack subagents
pack name: (_validate-package-name name)
    npm --workspace {{ quote("@narumitw/pi-" + name) }} pack --dry-run

# Open the private Pi TUI Kit showcase extension from this working tree
showcase-tui-kit:
    npm --workspace @narumitw/pi-tui-kit run build
    pi --no-extensions --no-skills -e ./packages/pi-tui-kit-showcase

# Run Pi Chat's opt-in real local DHT and process-boundary smoke
smoke-chat-network:
    npm run smoke:chat-network

# Preview or explicitly run the pi-codex-compact live-provider benchmark
benchmark-codex-compact *args:
    node packages/pi-codex-compact/benchmark/run.mjs {{ args }}

# Preview or explicitly run the pi-cbmem retrieval benchmark
benchmark-cbmem *args:
    node packages/pi-cbmem/benchmark/run.mjs {{ args }}

# Install dependencies, build local package artifacts, and start every local extension package
# pi-statusline and pi-tui-kit are intentionally excluded from Pi extension loading
# PI_TIMING reports startup timing and PI_CODING_AGENT_DIR isolates local development state
dev:
    npm install
    npm run build
    PI_TIMING=1 PI_CODING_AGENT_DIR=.pi/agent pi

# Install a package through pi, falling back to the local workspace if unpublished
# Usage: just install subagents
install name: (_validate-package-name name)
    name={{ quote(name) }}; package="@narumitw/pi-$name"; if npm view "$package" version >/dev/null 2>&1; then pi install "npm:$package"; else pi install "./packages/pi-$name"; fi

# Add release intent for independently versioned packages
changeset:
    npm run changeset

# Show the pending independent release plan
changeset-status:
    npm run changeset:status
