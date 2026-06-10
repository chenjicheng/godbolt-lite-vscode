Godbolt Lite looks for project build metadata before falling back to its default compiler arguments.

- `compile_commands.json` is preferred for full project flags.
- `compile_flags.txt` works well for smaller projects.
- Assembly filters hide common metadata noise while keeping labels and useful compiler comments.
