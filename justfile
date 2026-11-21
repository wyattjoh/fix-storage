# Run the full gauntlet: format check, lint, typecheck, tests.
check:
    bun run format:check
    bun run lint
    bun run typecheck
    bun test

# Run the UI over a made-up disk (no real disk access), as the recordings do.
demo:
    HOME=/Users/you bun scripts/demo.tsx

# Re-record docs/fix-storage-demo.gif and cut the stills from it. Needs vhs, ttyd and ffmpeg.
record:
    vhs docs/fix-storage-demo.tape
    ffmpeg -loglevel error -y -ss 2.6 -i .scratch/fix-storage-demo.mp4 -frames:v 1 docs/scanning.png
    ffmpeg -loglevel error -y -ss 9.8 -i .scratch/fix-storage-demo.mp4 -frames:v 1 docs/browse.png
    ffmpeg -loglevel error -y -ss 18.3 -i .scratch/fix-storage-demo.mp4 -frames:v 1 docs/clearing.png
