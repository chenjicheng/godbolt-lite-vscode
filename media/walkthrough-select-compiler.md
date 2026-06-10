Godbolt Lite runs a compiler from the VS Code extension host. Use a compiler that can read the same files as the workspace.

On Windows, a typical LLVM install path is:

```text
C:\Program Files\LLVM\bin\clang.exe
```

Remote SSH, Dev Containers, and WSL use the remote environment, so select a compiler path from that environment.
