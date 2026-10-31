export const PASTEL_POWERLINE_PRESET = `# Pi-native adaptation of Pastel Powerline.
# Source: https://starship.rs/presets/pastel-powerline
# Original configuration: https://starship.rs/presets/toml/pastel-powerline.toml
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Replace username, languages, and Docker with Pi, model, thinking, and context. Retain the six-color sequence.

format = "[](magenta)$brand$directory([](fg:prev_bg bg:peach)$git_branch$git_status)$model$thinking([](fg:prev_bg bg:navy)$context$time)[](fg:prev_bg)(\\n$extension_status)"
palette = "pastel_powerline"

[palettes.pastel_powerline]
ink = "#202331"
white = "#ffffff"
magenta = "#9A348E"
coral = "#DA627D"
peach = "#FCA17D"
blue = "#86BBD8"
teal = "#06969A"
navy = "#33658A"
muted = "#a0a9cb"

[brand]
format = "[ $symbol ]($style)"
style = "bold fg:white bg:magenta"
symbol = "π"

[directory]
format = "([](fg:prev_bg bg:coral)[ $symbol $path ]($style))"
style = "bold fg:ink bg:coral"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "([ $symbol $branch ]($style))"
style = "fg:ink bg:peach"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:ink bg:peach"

[model]
format = "([](fg:prev_bg bg:blue)[ $symbol $model ]($style))"
style = "bold fg:ink bg:blue"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([](fg:prev_bg bg:teal)[ $level ]($style))"
style = "fg:white bg:teal"

[context]
format = "([ ctx $percentage ]($style))"

[[context.display]]
threshold = 0
style = "fg:white bg:navy"
hidden = false

[time]
format = "[ $time ]($style)"
style = "fg:white bg:navy"
time_format = "%H:%M"

[extension_status]
format = "([$statuses]($style))"
style = "fg:muted"
separator = " · "
max_statuses = 2
icons = { fallback = "" }
`;
