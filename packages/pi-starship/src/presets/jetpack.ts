export const JETPACK_PRESET = `# Pi-native adaptation of Starship's Jetpack preset.
# Left-side session activity and right-side workspace context meet at $fill.
format = "$activity$context$fill$directory$git_branch$git_state$git_status$time"

[activity]
format = "[◄ $text ]($style)"
symbol = ""
style = "italic white"

[context]
format = "[◯ $percentage]($style) "
symbol = ""

[[context.display]]
threshold = 0
style = "bold purple"
hidden = false

[fill]
symbol = " "
style = "none"

[directory]
format = "[$path]($style) "
symbol = ""
style = "italic blue"
truncation_length = 2
truncation_symbol = "□ "
home_symbol = "⌂"

[git_branch]
format = "[$symbol$branch]($style)"
symbol = "△ "
style = "italic bright-blue"
truncation_length = 11
truncation_symbol = "⋯"

[git_state]
format = "([⎪$state( $progress_current/$progress_total)⎥]($style))"
symbol = ""
style = "italic bright-purple"

[git_status]
format = "([⎪$all_status$ahead_behind⎥]($style))"
style = "bold italic bright-blue"

[time]
format = "[ $time]($style)"
symbol = ""
style = "italic dimmed white"
`;
