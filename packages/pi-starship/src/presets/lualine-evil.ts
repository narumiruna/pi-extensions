export const LUALINE_EVIL_PRESET = `# Pi-native adaptation of Lualine Eviline.
# Source: https://github.com/nvim-lualine/lualine.nvim/blob/master/examples/evil_lualine.lua
# Original configuration: https://raw.githubusercontent.com/nvim-lualine/lualine.nvim/master/examples/evil_lualine.lua
# Font: Standard Unicode. See NOTICES.md for attribution and license terms.
# Keep the flat layout and edge bars. Use thinking-level styles instead of Vim mode colors, and Pi activity instead of LSP state.

format = "[[▊ ](fg:blue bg:bg)$brand$model$thinking$activity\${fill}$directory$git_branch$git_status$context[ ▊](fg:blue bg:bg)](fg:fg bg:bg)(\\n$extension_status)"
palette = "evil"

[palettes.evil]
bg = "#202328"
fg = "#bbc2cf"
yellow = "#ECBE7B"
green = "#98be65"
orange = "#FF8800"
violet = "#a9a1e1"
magenta = "#c678dd"
blue = "#51afef"
red = "#ec5f67"
muted = "#7f8795"

[brand]
format = "[$symbol ]($style)"
style = "bold fg:red bg:bg"
symbol = "π"

[model]
format = "[$model ]($style)"
style = "bold fg:magenta bg:bg"
symbol = "◆"
shorten_model = true
truncation_length = 22
truncation_direction = "middle"

[thinking]
format = "[$level ]($style)"
style = "fg:green bg:bg"
style_high = "fg:yellow bg:bg"
style_xhigh = "fg:orange bg:bg"
style_max = "fg:red bg:bg"

[activity]
format = "[$text ]($style)"
style = "fg:yellow bg:bg"
symbol = "●"

[directory]
format = "[$path  ]($style)"
style = "fg:fg bg:bg"
symbol = "dir"
truncation_length = 2
truncation_symbol = "…/"

[git_branch]
format = "[$symbol:$branch ]($style)"
style = "fg:violet bg:bg"
symbol = "git"
truncation_length = 18

[git_status]
format = "([ $all_status$ahead_behind ]($style))"
style = "fg:orange bg:bg"

[context]
format = "[ctx $percentage]($style)"

[[context.display]]
threshold = 0
style = "fg:green bg:bg"
hidden = false

[[context.display]]
threshold = 60
style = "fg:yellow bg:bg"
hidden = false

[[context.display]]
threshold = 80
style = "bold fg:red bg:bg"
hidden = false

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
