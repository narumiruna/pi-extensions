export const CATPPUCCIN_TMUX_PRESET = `# Pi-native adaptation of Catppuccin Tmux.
# Source: https://github.com/catppuccin/tmux
# Original configuration: https://github.com/catppuccin/tmux/blob/main/catppuccin_options_tmux.conf
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Use the rounded window style and colored status labels on one logical status row.
# Replace CPU, RAM, and uptime with model, thinking, context, and time.

format = "$brand$directory$git_branch$git_status\${fill}$model$thinking$activity$context$time(\\n$extension_status)"
palette = "catppuccin_mocha"

[palettes.catppuccin_mocha]
base = "#1e1e2e"
surface = "#313244"
text = "#cdd6f4"
mauve = "#cba6f7"
blue = "#89b4fa"
green = "#a6e3a1"
peach = "#fab387"
yellow = "#f9e2af"
muted = "#a6adc8"

[brand]
format = "([](fg:mauve)[ $symbol ]($style)[](fg:mauve) )"
style = "bold fg:base bg:mauve"
symbol = "π"

[directory]
format = "([](blue)[ dir ](fg:base bg:blue)[ $path ]($style)[](surface) )"
style = "fg:text bg:surface"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "([](green)[ git ](fg:base bg:green)[ $branch ]($style)[](surface) )"
style = "fg:text bg:surface"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:peach"

[activity]
format = "[$text ]($style)"
style = "fg:peach"
symbol = "●"

[model]
format = "([](mauve)[ ai ](fg:base bg:mauve)[ $model ]($style)[](surface) )"
style = "fg:text bg:surface"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([](yellow)[ think ](fg:base bg:yellow)[ $level ]($style)[](surface) )"
style = "fg:text bg:surface"

[context]
format = "([](blue)[ ctx ](fg:base bg:blue)[ $percentage ]($style)[](surface) )"

[[context.display]]
threshold = 0
style = "fg:text bg:surface"
hidden = false

[time]
format = "([](peach)[ time ](fg:base bg:peach)[ $time ]($style)[](surface))"
style = "fg:text bg:surface"
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
