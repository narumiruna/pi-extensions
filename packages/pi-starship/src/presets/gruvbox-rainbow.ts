export const GRUVBOX_RAINBOW_PRESET = `# Pi-native adaptation of Gruvbox Rainbow.
# Source: https://starship.rs/presets/gruvbox-rainbow
# Original configuration: https://starship.rs/presets/toml/gruvbox-rainbow.toml
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Keep Gruvbox color order. Move activity, tokens, context, and time to a second footer row instead of a shell input line.

format = "[](orange)$brand$directory([](fg:prev_bg bg:aqua)$git_branch$git_status)$model$thinking[](fg:prev_bg)\\n$activity\${fill}$tokens$context$time(\\n$extension_status)"
palette = "gruvbox_dark"

[palettes.gruvbox_dark]
fg = "#fbf1c7"
bg = "#282828"
bg1 = "#3c3836"
bg3 = "#665c54"
orange = "#d65d0e"
yellow = "#d79921"
aqua = "#689d6a"
blue = "#458588"
green = "#b8bb26"
red = "#fb4934"
muted = "#a89984"

[brand]
format = "[ $symbol ]($style)"
style = "bold fg:fg bg:orange"
symbol = "π"

[directory]
format = "([](fg:prev_bg bg:yellow)[ $path ]($style))"
style = "bold fg:bg bg:yellow"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "([ $symbol $branch ]($style))"
style = "fg:bg bg:aqua"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:bg bg:aqua"

[model]
format = "([](fg:prev_bg bg:blue)[ $model ]($style))"
style = "bold fg:fg bg:blue"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([](fg:prev_bg bg:bg3)[ $level ]($style))"
style = "fg:fg bg:bg3"

[activity]
format = "[ $text ]($style)"
style = "fg:yellow"
symbol = "●"

[tokens]
format = "[↑$input ↓$output  ]($style)"
style = "fg:aqua"

[context]
format = "[ctx $percentage  ]($style)"

[[context.display]]
threshold = 0
style = "fg:green"
hidden = false

[time]
format = "[$time ]($style)"
style = "fg:muted"
time_format = "%H:%M"

[fill]
style = "fg:muted"
symbol = " "

[extension_status]
format = "([$statuses]($style))"
style = "fg:muted"
separator = " · "
max_statuses = 2
icons = { fallback = "" }
`;
