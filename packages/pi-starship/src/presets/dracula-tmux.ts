export const DRACULA_TMUX_PRESET = `# Pi-native adaptation of Dracula Tmux.
# Source: https://draculatheme.com/tmux
# Original configuration: https://github.com/dracula/tmux/blob/master/scripts/dracula.sh
# Font: Standard Unicode. See NOTICES.md for attribution and license terms.
# Use Dracula's non-Powerline rectangular treatment. Replace system and weather plugins with local Pi activity, model, thinking, and context.

format = "[$brand$directory$git_branch$git_status\${fill}$activity$model$thinking$context$time](bg:bg)(\\n$extension_status)"
palette = "dracula"

[palettes.dracula]
bg = "#282a36"
gray = "#44475a"
white = "#f8f8f2"
purple = "#bd93f9"
cyan = "#8be9fd"
green = "#50fa7b"
pink = "#ff79c6"
yellow = "#f1fa8c"
muted = "#6272a4"

[brand]
format = "[ $symbol ]($style)"
style = "bold fg:bg bg:purple"
symbol = "π"

[directory]
format = "[ $path ]($style)"
style = "fg:white bg:gray"
symbol = "dir"
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "[ $symbol:$branch ]($style)"
style = "fg:pink bg:gray"
symbol = "git"
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:yellow bg:gray"

[activity]
format = "[ $state ]($style)"
style = "bold fg:bg bg:green"

[model]
format = "[ $model ]($style)"
style = "bold fg:bg bg:cyan"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "[ $level ]($style)"
style = "fg:bg bg:purple"

[context]
format = "[ ctx $percentage ]($style)"

[[context.display]]
threshold = 0
style = "bold fg:bg bg:pink"
hidden = false

[time]
format = "[ $time ]($style)"
style = "fg:white bg:gray"
time_format = "%H:%M"

[fill]
format = "[$symbol]($style)"
style = "bg:bg"
symbol = " "

[extension_status]
format = "([$statuses]($style))"
style = "fg:muted"
separator = " · "
max_statuses = 2
icons = { fallback = "" }
`;
