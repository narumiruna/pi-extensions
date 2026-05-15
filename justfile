set shell := ["bash", "-euo", "pipefail", "-c"]

goal := "@narumitw/pi-goal"
retry := "@narumitw/pi-retry"

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
# Usage: just doctor @narumitw/pi-goal
doctor package="@narumitw/pi-goal":
    @echo "package: {{package}}"
    npm whoami
    npm config get registry
    npm access get status {{package}} || true
    npm dist-tag ls {{package}} || true
    npm view {{package}} version || true

# Show npm visibility/version information for all packages
doctor-all:
    just doctor {{goal}}
    just doctor {{retry}}

# Make a scoped npm package public after publish if npm registry returns 404
# Usage: just npm-public @narumitw/pi-goal
npm-public package="@narumitw/pi-goal":
    npm access public {{package}}
    npm view {{package}} version

# Preview the goal package that npm would publish
pack-goal:
    npm run pack:goal

# Preview the retry package that npm would publish
pack-retry:
    npm run pack:retry

# Try goal from this working tree as a temporary pi package
try-goal:
    pi -e ./extensions/pi-goal

# Try retry from this working tree as a temporary pi package
try-retry:
    pi -e ./extensions/pi-retry

# Install the published goal package through pi
install-goal:
    pi install npm:{{goal}}

# Install the published retry package through pi
install-retry:
    pi install npm:{{retry}}

# Publish goal to npm, skipping if the current version already exists
# Usage with 2FA: just publish-goal 123456
publish-goal otp="":
    version="$(node -p "require('./extensions/pi-goal/package.json').version")"; otp_arg=""; if [ -n "{{otp}}" ]; then otp_arg="--otp={{otp}}"; fi; if npm view {{goal}}@"$version" version >/dev/null 2>&1; then echo "{{goal}}@$version already exists; skipping publish."; else npm --workspace {{goal}} pack --dry-run; npm --workspace {{goal}} publish --access public $otp_arg; fi

# Publish retry to npm, skipping if the current version already exists
# Usage with 2FA: just publish-retry 123456
publish-retry otp="":
    version="$(node -p "require('./extensions/pi-retry/package.json').version")"; otp_arg=""; if [ -n "{{otp}}" ]; then otp_arg="--otp={{otp}}"; fi; if npm view {{retry}}@"$version" version >/dev/null 2>&1; then echo "{{retry}}@$version already exists; skipping publish."; else npm --workspace {{retry}} pack --dry-run; npm --workspace {{retry}} publish --access public $otp_arg; fi

# Publish all extension packages to npm
# Usage with 2FA: just publish-all 123456
publish-all otp="":
    just publish-goal {{otp}}
    just publish-retry {{otp}}

# Install all published extension packages through pi
install-all:
    just install-goal
    just install-retry

# Bump one workspace package without creating a git tag
# Usage: just bump @narumitw/pi-goal patch
bump package part="patch":
    npm --workspace {{package}} version {{part}} --no-git-tag-version
