# Terminal recording used by docs/assets/demo.gif.
#
#   make up            # kind + Cilium + images + deploy
#   make demo-gif      # requires vhs: https://github.com/charmbracelet/vhs
#
# The recording is deliberately unedited: it runs the same script a reader runs.

Output docs/assets/demo.gif

Set Shell "bash"
Set FontFamily "JetBrains Mono, SFMono-Regular, Menlo, monospace"
Set FontSize 14
Set Width 1180
Set Height 680
Set Padding 20
Set Theme "GitHub Dark"
Set Framerate 30
Set TypingSpeed 35ms

Hide
Type "make demo-session"
Enter

Show
Sleep 45s
