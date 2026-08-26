# Upstream

This plugin was vendored from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop)
at commit `6d538555cb151d4121ed51a27db81890eacf8ae9` using its `install-anti-slop` skill.

The files are local project code after installation. Review upstream changes before replacing them.

## Local adaptations

- Recognize a `SAFETY:` comment immediately before an exported variable declaration that contains a type assertion. The rule checks only the `ExportNamedDeclaration` wrapper for exported `VariableDeclaration` nodes, preserving the existing comment ownership boundaries elsewhere.
