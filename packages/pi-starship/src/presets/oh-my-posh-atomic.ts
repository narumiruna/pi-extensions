export const OH_MY_POSH_ATOMIC_PRESET = `# Pi-native adaptation of Oh My Posh Atomic.
# Source: https://ohmyposh.dev/docs/themes#atomic
# Original configuration: https://github.com/JanDeDobbeleer/oh-my-posh/blob/main/themes/atomic.omp.json
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Replace shell and execution time with Pi and real activity; use model, thinking, and context instead of runtime/cloud/battery probes. Git background is fixed, not template-driven.

format = "[╭─](blue)$brand$directory([](fg:prev_bg bg:gold)$git_branch$git_status)$activity[](fg:prev_bg)\${fill}$context$time\\n[╰─❯ ](teal)$model$thinking\${fill}$tokens(\\n$extension_status)"
palette = "atomic"

[palettes.atomic]
blue = "#0077c2"
white = "#ffffff"
orange = "#FF9248"
ink = "#2d3436"
gold = "#FFFB38"
git_ink = "#011627"
violet = "#83769c"
cyan = "#40c4ff"
teal = "#21c7c7"
muted = "#b2bec3"

[brand]
format = "[ $symbol ]($style)"
style = "bold fg:white bg:blue"
symbol = "π"

[directory]
format = "([](fg:prev_bg bg:orange)[ $symbol $path ]($style))"
style = "fg:ink bg:orange"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "([ $symbol $branch ]($style))"
style = "fg:git_ink bg:gold"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:git_ink bg:gold"

[activity]
format = "([](fg:prev_bg bg:violet)[ $text ]($style))"
style = "fg:white bg:violet"
symbol = "●"

[context]
format = "([](fg:cyan)[ ctx $percentage ]($style)[](fg:cyan) )"

[[context.display]]
threshold = 0
style = "bold fg:ink bg:cyan"
hidden = false

[time]
format = "([](fg:blue)[ $time ]($style)[](fg:blue) )"
style = "fg:white bg:blue"
time_format = "%H:%M"

[model]
format = "([](fg:blue)[ $model ]($style)[](fg:blue) )"
style = "fg:white bg:blue"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([](fg:violet)[ $level ]($style)[](fg:violet) )"
style = "fg:white bg:violet"

[tokens]
format = "[↑$input ↓$output]($style)"
style = "fg:muted"

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
