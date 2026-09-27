# diffd as a Claude Code plugin and a Codex plugin: the hooks that wake an
# idle agent when you leave feedback, and optionally the MCP server, packaged
# so they come and go with the plugin instead of being merged into your own
# config. `diffd plugin` writes them (the same files `diffd install` does).
{
  lib,
  runCommand,
  diffd,
  port ? 3433,
  withMcp ? true,
}:
let
  exe = lib.getExe diffd;
  plugin =
    agent:
    # Named like the manifest: home-manager's Codex module requires it.
    runCommand "diffd" { passthru = { inherit agent; }; } ''
      ${exe} plugin ${agent} --out $out --program ${exe} --port ${toString port} ${lib.optionalString (!withMcp) "--no-mcp"}
    '';
in
{
  claude = plugin "claude";
  codex = plugin "codex";
}
