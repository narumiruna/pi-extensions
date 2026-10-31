export const POWERLEVEL10K_LEAN_PRESET = `# Pi-native adaptation of Powerlevel10k Lean.
# Source: https://github.com/romkatv/powerlevel10k#readme
# Original configuration: https://github.com/romkatv/powerlevel10k/blob/master/config/p10k-lean.zsh
# Font: Standard Unicode. See NOTICES.md for attribution and license terms.
# Keep Lean's path/Git row, open spacing, and lower prompt mark. The lower row is a footer, not a shell input line; Pi wraps instead of hiding overlaps.

format = "$directory$git_branch$git_status\${fill}$context$time\\n$brand$model$thinking\${fill}$activity$tokens(\\n$extension_status)"
palette = "lean"

[palettes.lean]
path = "#00afff"
green = "#5fd700"
violet = "#8787af"
red = "#ff0000"
yellow = "#ffff00"
text = "#d7d7d7"
muted = "#808080"
cyan = "#00d7d7"

[directory]
format = "[$path  ]($style)"
style = "bold fg:path"
symbol = "dir"
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "[on $branch ]($style)"
style = "fg:green"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:red"

[brand]
format = "[$symbol ]($style)"
style = "bold fg:green"
symbol = "❯"

[model]
format = "[$model ]($style)"
style = "fg:text"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "[$level ]($style)"
style = "fg:violet"

[activity]
format = "[$text  ]($style)"
style = "fg:yellow"
symbol = "●"

[tokens]
format = "[↑$input ↓$output]($style)"
style = "fg:cyan"

[context]
format = "[ctx $percentage  ]($style)"

[[context.display]]
threshold = 0
style = "fg:muted"
hidden = false

[time]
format = "[$time]($style)"
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
