set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Run the CI-equivalent checks
[group("Development")]
check:
    npm run check

# Format the repository
[group("Development")]
format:
    npm run format

# Run a local extension using its unscoped name
[group("Development")]
try name:
    npm --workspace {{ quote("@narumitw/pi-" + name) }} run build --if-present
    pi -e {{ quote("./packages/pi-" + name) }}

# Run all local extensions
[group("Development")]
try-all:
    shopt -s nullglob; args=(); for package_json in packages/pi-*/package.json; do if node -e 'const p = require(process.argv[1]); process.exit(p.pi?.extensions ? 0 : 1)' "$package_json"; then args+=(-e "$(dirname "$package_json")"); fi; done; pi -ne "${args[@]}"

# Update and verify all dependencies from a clean worktree
[group("Maintenance")]
update:
    @[[ -z "$(git status --porcelain)" ]] || { printf 'dependency updates require a clean worktree\n' >&2; exit 2; }
    npm exec -- npm-check-updates --workspaces --root -u
    npm install --package-lock-only --ignore-scripts
    npm ci
    npm --workspaces --if-present run build:web
    npm run check
    npm pack --workspaces --dry-run

# Install a published package, falling back to its local workspace
[group("Packages")]
install name:
    name={{ quote(name) }}; package="@narumitw/pi-$name"; if npm view "$package" version >/dev/null 2>&1; then pi install "npm:$package"; else pi install "./packages/pi-$name"; fi

# Preview a package using its unscoped name
[group("Packages")]
pack name:
    npm --workspace {{ quote("@narumitw/pi-" + name) }} pack --dry-run

# Add release intent
[group("Release")]
changeset:
    npm run changeset

# Make an existing scoped package public
[group("Release")]
npm-public package:
    npm access set status=public {{ quote(package) }}
    npm view {{ quote(package) }} version
