export const LUALINE_SLANTED_GAPS_PRESET = `# Pi-native adaptation of Lualine Slanted Gaps.
# Source: https://github.com/nvim-lualine/lualine.nvim/blob/master/examples/slanted-gaps.lua
# Original configuration: https://raw.githubusercontent.com/nvim-lualine/lualine.nvim/master/examples/slanted-gaps.lua
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Keep the light surface and opposing slopes. Replace editor mode, filename, and cursor location with Pi, workspace, model, and context.

format = "[$brand$directory$git_branch$git_status\${fill}$model$thinking$context](fg:black bg:white)(\\n$extension_status)"
palette = "slanted_gaps"

[palettes.slanted_gaps]
red = "#ca1243"
grey = "#a0a1a7"
black = "#383a42"
white = "#f3f3f3"
light_green = "#83a598"
orange = "#fe8019"
green = "#8ec07c"
muted = "#626574"

[brand]
format = "[ $symbol ]($style)[](fg:black bg:white) "
style = "bold fg:white bg:black"
symbol = "π"

[directory]
format = "([ $path ]($style)[](fg:grey bg:white) )"
style = "fg:black bg:grey"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "([ $symbol $branch ]($style)[](fg:light_green bg:white) )"
style = "fg:black bg:light_green"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style)[](fg:red bg:white) )"
style = "fg:white bg:red"

[model]
format = "([](fg:black bg:white)[ $model ]($style) )"
style = "fg:white bg:black"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([](fg:orange bg:white)[ $level ]($style) )"
style = "fg:black bg:orange"

[context]
format = "([](fg:black bg:white)[ ctx $percentage ]($style))"

[[context.display]]
threshold = 0
style = "bold fg:white bg:black"
hidden = false

[fill]
format = "[$symbol]($style)"
style = "bg:white"
symbol = " "

[extension_status]
format = "([$statuses]($style))"
style = "fg:muted"
separator = " · "
max_statuses = 2
icons = { fallback = "" }
`;
