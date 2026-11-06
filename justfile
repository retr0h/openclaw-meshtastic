set allow-duplicate-variables

# Optional modules: import? allows `just fetch` to work before .just/remote/ exists.

import? '.just/remote/md.just'
import? '.just/remote/just.just'

# No documentation site, so md formats every markdown file in the repository.

md_site_dir := ""

# --- Fetch ---

# Fetch shared justfiles from osapi-justfiles
fetch:
    mkdir -p .just/remote
    curl -sSfL https://raw.githubusercontent.com/osapi-io/osapi-justfiles/refs/heads/main/md/md.just -o .just/remote/md.just
    curl -sSfL https://raw.githubusercontent.com/osapi-io/osapi-justfiles/refs/heads/main/just/just.just -o .just/remote/just.just

# --- Top-level orchestration ---

# Run all checks
test:
    just just-fmt-check
    just md-fmt-check

# Format before committing
ready:
    just just-fmt
    just md-fmt
