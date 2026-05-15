set shell := ["bash", "-euo", "pipefail", "-c"]

caffeinate := "@narumitw/pi-caffeinate"
chrome_devtools := "@narumitw/pi-chrome-devtools"
firecrawl := "@narumitw/pi-firecrawl"
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
# Usage: just doctor @narumitw/pi-chrome-devtools
doctor package="@narumitw/pi-chrome-devtools":
    @echo "package: {{package}}"
    npm whoami
    npm config get registry
    npm access get status {{package}} || true
    npm dist-tag ls {{package}} || true
    npm view {{package}} version || true

# Show npm visibility/version information for all packages
doctor-all:
    just doctor {{caffeinate}}
    just doctor {{chrome_devtools}}
    just doctor {{firecrawl}}
    just doctor {{goal}}
    just doctor {{retry}}

# Make a scoped npm package public after publish if npm registry returns 404
# Usage: just npm-public @narumitw/pi-goal 123456
npm-public package="@narumitw/pi-goal" otp="":
    otp_arg=""; if [ -n "{{otp}}" ]; then otp_arg="--otp={{otp}}"; fi; npm access set status=public {{package}} $otp_arg
    npm view {{package}} version

# Preview the caffeinate package that npm would publish
pack-caffeinate:
    npm run pack:caffeinate

# Preview the chrome-devtools package that npm would publish
pack-chrome-devtools:
    npm run pack:chrome-devtools

# Preview the firecrawl package that npm would publish
pack-firecrawl:
    npm run pack:firecrawl

# Preview the goal package that npm would publish
pack-goal:
    npm run pack:goal

# Preview the retry package that npm would publish
pack-retry:
    npm run pack:retry

# Try caffeinate from this working tree as a temporary pi package
try-caffeinate:
    pi -e ./extensions/pi-caffeinate

# Try chrome-devtools from this working tree as a temporary pi package
try-chrome-devtools:
    pi -e ./extensions/pi-chrome-devtools

# Try firecrawl from this working tree as a temporary pi package
try-firecrawl:
    pi -e ./extensions/pi-firecrawl

# Try goal from this working tree as a temporary pi package
try-goal:
    pi -e ./extensions/pi-goal

# Try retry from this working tree as a temporary pi package
try-retry:
    pi -e ./extensions/pi-retry

# Install caffeinate through pi, falling back to the local workspace if unpublished
install-caffeinate:
    if npm view {{caffeinate}} version >/dev/null 2>&1; then pi install npm:{{caffeinate}}; else echo "{{caffeinate}} is not published; installing local workspace package instead."; pi install ./extensions/pi-caffeinate; fi

# Install chrome-devtools through pi, falling back to the local workspace if unpublished
install-chrome-devtools:
    if npm view {{chrome_devtools}} version >/dev/null 2>&1; then pi install npm:{{chrome_devtools}}; else echo "{{chrome_devtools}} is not published; installing local workspace package instead."; pi install ./extensions/pi-chrome-devtools; fi

# Install firecrawl through pi, falling back to the local workspace if unpublished
install-firecrawl:
    if npm view {{firecrawl}} version >/dev/null 2>&1; then pi install npm:{{firecrawl}}; else echo "{{firecrawl}} is not published; installing local workspace package instead."; pi install ./extensions/pi-firecrawl; fi

# Install the published goal package through pi
install-goal:
    pi install npm:{{goal}}

# Install the published retry package through pi
install-retry:
    pi install npm:{{retry}}

# Publish caffeinate to npm, skipping if the current version already exists
# Usage with 2FA: just publish-caffeinate 123456
publish-caffeinate otp="":
    version="$(node -p "require('./extensions/pi-caffeinate/package.json').version")"; otp_arg=""; if [ -n "{{otp}}" ]; then otp_arg="--otp={{otp}}"; fi; if npm view {{caffeinate}}@"$version" version >/dev/null 2>&1; then echo "{{caffeinate}}@$version already exists; skipping publish."; else npm --workspace {{caffeinate}} pack --dry-run; npm --workspace {{caffeinate}} publish --access public $otp_arg; fi

# Publish chrome-devtools to npm, skipping if the current version already exists
# Usage with 2FA: just publish-chrome-devtools 123456
publish-chrome-devtools otp="":
    version="$(node -p "require('./extensions/pi-chrome-devtools/package.json').version")"; otp_arg=""; if [ -n "{{otp}}" ]; then otp_arg="--otp={{otp}}"; fi; if npm view {{chrome_devtools}}@"$version" version >/dev/null 2>&1; then echo "{{chrome_devtools}}@$version already exists; skipping publish."; else npm --workspace {{chrome_devtools}} pack --dry-run; npm --workspace {{chrome_devtools}} publish --access public $otp_arg; fi

# Publish firecrawl to npm, skipping if the current version already exists
# Usage with 2FA: just publish-firecrawl 123456
publish-firecrawl otp="":
    version="$(node -p "require('./extensions/pi-firecrawl/package.json').version")"; otp_arg=""; if [ -n "{{otp}}" ]; then otp_arg="--otp={{otp}}"; fi; if npm view {{firecrawl}}@"$version" version >/dev/null 2>&1; then echo "{{firecrawl}}@$version already exists; skipping publish."; else npm --workspace {{firecrawl}} pack --dry-run; npm --workspace {{firecrawl}} publish --access public $otp_arg; fi

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
    just publish-caffeinate {{otp}}
    just publish-chrome-devtools {{otp}}
    just publish-firecrawl {{otp}}
    just publish-goal {{otp}}
    just publish-retry {{otp}}

# Install all published extension packages through pi
install-all:
    just install-caffeinate
    just install-chrome-devtools
    just install-firecrawl
    just install-goal
    just install-retry

# Bump one workspace package without creating a git tag
# Usage: just bump @narumitw/pi-goal patch
bump package part="patch":
    npm --workspace {{package}} version {{part}} --no-git-tag-version
