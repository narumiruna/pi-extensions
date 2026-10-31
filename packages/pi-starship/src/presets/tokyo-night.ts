export const TOKYO_NIGHT_PRESET = `# Pi-native adaptation of Tokyo Night.
# Source: https://starship.rs/presets/tokyo-night
# Original configuration: https://starship.rs/presets/toml/tokyo-night.toml
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Replace OS and language probes with Pi and the selected model. Use the final dark block for context and the clock.

format = "[░▒▓](lead)$brand$directory([](fg:prev_bg bg:git)$git_branch$git_status)([](fg:prev_bg bg:model)$model$thinking)([](fg:prev_bg bg:meter)$context$time)[](fg:prev_bg)(\\n$extension_status)"
palette = "tokyo_night"

[palettes.tokyo_night]
lead = "#a3aed2"
ink = "#090c0c"
blue = "#769ff0"
fg = "#e3e5e5"
git = "#394260"
model = "#212736"
meter = "#1d2230"
muted = "#a0a9cb"

[brand]
format = "[ $symbol ]($style)"
style = "bold fg:ink bg:lead"
symbol = "π"

[directory]
format = "([](fg:prev_bg bg:blue)[ $symbol $path ]($style))"
style = "bold fg:ink bg:blue"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "([ $symbol $branch ]($style))"
style = "fg:blue bg:git"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:blue bg:git"

[model]
format = "([ $symbol $model ]($style))"
style = "fg:blue bg:model"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([ $level ]($style))"
style = "fg:muted bg:model"

[context]
format = "([ ctx $percentage ]($style))"

[[context.display]]
threshold = 0
style = "fg:muted bg:meter"
hidden = false

[time]
format = "[ $time ]($style)"
style = "fg:muted bg:meter"
time_format = "%H:%M"

[extension_status]
format = "([$statuses]($style))"
style = "fg:muted"
separator = " · "
max_statuses = 2
icons = { fallback = "" }
`;
