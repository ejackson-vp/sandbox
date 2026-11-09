# Terminal recording used by docs/assets/demo.gif.
#
#   make up            # kind + Cilium + images + deploy
#   make demo-gif      # requires vhs: https://github.com/charmbracelet/vhs
#
# The recording is unedited: it runs the same script a reader runs via
# `make demo-session`.

Output docs/assets/demo.gif

Set Shell "bash"
Set FontFamily "JetBrains Mono, SFMono-Regular, Menlo, monospace"
Set FontSize 13
Set Width 1180
Set Height 720
Set Padding 20
Set Theme "GitHub Dark"
Set Framerate 24
Set TypingSpeed 40ms

Show
Type "./scripts/demo-session.sh"
Enter
Sleep 9s
