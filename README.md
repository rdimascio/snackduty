# Snackday

Snackday is the operating system for recreational youth sports: rosters and guardians, calendars, volunteer and snack schedules, team communication, compliance, and private team memories.

## Development

Requirements: Bun 1.3.5, Node.js 22 or newer, and Xcode for iOS development.

```sh
bun install
bun run gate
bun run --filter web dev
```

Lesto architecture and implementation live in the sibling `../crack` repository. The app consumes its published packages so transitive workspace dependencies resolve reproducibly.

The cross-repository platform boundaries and the July 16–18 proof plan are recorded in
[`docs/adr/`](docs/adr/) and [`docs/platform-mvp-sprint.md`](docs/platform-mvp-sprint.md).
