# diffd as a Claude Code plugin and a Codex plugin: the hooks that wake an
# idle agent when you leave feedback (what `diffd setup claude|codex` adds to
# your settings), and optionally the MCP server, packaged so they come and go
# with the plugin instead of being merged into your own config.
#
# Both agents read the same layout: a manifest (.claude-plugin/plugin.json or
# .codex-plugin/plugin.json), hooks/hooks.json and .mcp.json.
{
  lib,
  runCommand,
  writeText,
  diffd,
  port ? 3433,
  withMcp ? true,
}:
let
  version = diffd.version or "0.1.0";
  exe = lib.getExe diffd;
  hook = args: "${exe} hook${lib.optionalString (port != 3433) " --port ${toString port}"} ${args}";
  mcpUrl = agent: "http://localhost:${toString port}/mcp?agent=${agent}";

  # Wait for feedback in the background whenever a session starts, the user
  # writes, or a turn ends (an interrupted turn runs no Stop hook), and wake
  # the agent when it arrives; stop waiting when the session ends.
  wakeHooks =
    agent: wait:
    let
      waiting = [ { hooks = [ wait ]; } ];
    in
    {
      hooks = {
        SessionStart = waiting;
        UserPromptSubmit = waiting;
        Stop = waiting;
        SessionEnd = [
          {
            hooks = [
              {
                type = "command";
                command = hook "end ${agent}";
                timeout = 3;
              }
            ];
          }
        ];
      };
    };

  plugin =
    {
      agent,
      manifestDir,
      manifest,
      hooks,
      mcpServer,
    }:
    let
      json = name: value: writeText name (builtins.toJSON value);
    in
    # Named like the manifest: home-manager's Codex module requires it.
    runCommand "diffd" { passthru = { inherit agent; }; } (
      ''
        install -Dm644 ${json "plugin.json" manifest} $out/${manifestDir}/plugin.json
        install -Dm644 ${json "hooks.json" hooks} $out/hooks/hooks.json
      ''
      + lib.optionalString withMcp ''
        install -Dm644 ${json "mcp.json" { mcpServers.diffd = mcpServer; }} $out/.mcp.json
      ''
    );

  manifest = {
    name = "diffd";
    inherit version;
    description = "Live code review of your changes in the browser; wakes you when the user leaves feedback";
    homepage = "https://github.com/404Wolf/diffd";
    license = "MIT";
  };
in
{
  claude = plugin {
    agent = "claude";
    manifestDir = ".claude-plugin";
    inherit manifest;
    # Runs in the background; exit 2 wakes Claude with the notice.
    hooks = wakeHooks "claude" {
      type = "command";
      command = hook "claude";
      async = true;
      asyncRewake = true;
    };
    mcpServer = {
      type = "http";
      url = mcpUrl "claude";
    };
  };

  codex = plugin {
    agent = "codex";
    manifestDir = ".codex-plugin";
    manifest =
      manifest
      // {
        hooks = "./hooks/hooks.json";
      }
      // lib.optionalAttrs withMcp { mcpServers = "./.mcp.json"; };
    # Runs in the background; queues the notice into the session with `codex queue`.
    hooks = wakeHooks "codex" {
      type = "command";
      command = hook "codex";
      async = true;
      timeout = 86400;
    };
    mcpServer.url = mcpUrl "codex";
  };
}
