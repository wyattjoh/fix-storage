# fix-storage demo: scan, browse into a folder, find a culprit, clear caches.
# Drives scripts/demo.tsx, the real UI over a made-up disk: nothing on the
# real disk is read or changed, and HOME is set to /Users/you so no real
# folder names appear. Render from the repo root with: vhs docs/fix-storage-demo.tape
# Still images are cut from the MP4 with ffmpeg (VHS Screenshot timing is unreliable here).

Output docs/fix-storage-demo.gif
Output .scratch/fix-storage-demo.mp4

Set Shell "bash"
Set FontSize 15
Set Width 1500
Set Height 860
Set Padding 16
Set Theme "Builtin Dark"
Set Framerate 24
Set TypingSpeed 40ms
Set WaitTimeout 20s
Set CursorBlink false

Require bun

Hide
Type "export PS1='$ ' && clear"
Enter
Type "HOME=/Users/you DEMO_SCAN_MS=5000 bun scripts/demo.tsx"
Enter
Wait+Screen /measuring/
Show

# The scan streams in: the bar grows and ripples, the path updates on the left of the spinner.
Sleep 2.5s
Wait+Screen /scan complete/
Sleep 1.5s

# Into Documents, then into the projects folder.
Down 4
Sleep 800ms
Right
Sleep 1.2s
Enter
Wait+Screen /ml-experiments/
Sleep 1.8s

# Jump to where the space actually is.
Type "g"
Sleep 2s

# Back out to the categories and clear Caches (two presses).
Escape
Sleep 600ms
Escape
Sleep 600ms
Escape
Sleep 600ms
Tab
Sleep 500ms
Down 3
Sleep 1s
Type "c"
Sleep 1.2s
Type "c"
Sleep 1.2s
Sleep 2.5s
Type "q"
Sleep 300ms
