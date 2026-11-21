# Run the full gauntlet: format check, lint, typecheck, tests.
check:
    bun run format:check
    bun run lint
    bun run typecheck
    bun test
