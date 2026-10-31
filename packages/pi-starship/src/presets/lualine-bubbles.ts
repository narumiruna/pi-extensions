export const LUALINE_BUBBLES_PRESET = `# Pi-native adaptation of Lualine Bubbles.
# Source: https://github.com/nvim-lualine/lualine.nvim/blob/master/examples/bubbles.lua
# Original configuration: https://raw.githubusercontent.com/nvim-lualine/lualine.nvim/master/examples/bubbles.lua
# Font: Nerd Font. See NOTICES.md for attribution and license terms.
# Map editor mode to Pi, filename to workspace, filetype to model, and cursor progress to context usage. Pi has no Neovim mode.

format = "$brand$directory$git_branch$git_status[](grey)\${fill}$model$thinking$context(\\n$extension_status)"
palette = "bubbles"

[palettes.bubbles]
violet = "#d183e8"
blue = "#80a0ff"
cyan = "#79dac8"
black = "#080808"
white = "#c6c6c6"
red = "#ff5189"
grey = "#303030"
muted = "#a0a0a0"

[brand]
format = "[](violet)[ $symbol ]($style)[](fg:violet bg:grey)"
style = "bold fg:black bg:violet"
symbol = "π"

[directory]
format = "[ $path ]($style)"
style = "fg:white bg:grey"
symbol = ""
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "[ $symbol $branch ]($style)"
style = "fg:white bg:grey"
symbol = ""
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:red bg:grey"

[model]
format = "([](fg:grey)[ $model ]($style)[](fg:grey) )"
style = "fg:white bg:grey"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "([](fg:blue)[ $level ]($style)[](fg:blue) )"
style = "fg:black bg:blue"

[context]
format = "([](fg:cyan)[ ctx $percentage ]($style)[](fg:cyan) )"

[[context.display]]
threshold = 0
style = "bold fg:black bg:cyan"
hidden = false

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
