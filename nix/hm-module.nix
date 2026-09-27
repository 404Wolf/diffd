# services.diffd for home-manager: a systemd user service running as you, so
# it can read your checkouts. Reviews live in ~/.local/share/diffd/diffd.db.
self:
{
  config,
  lib,
  options,
  pkgs,
  ...
}:
let
  cfg = config.services.diffd;
  diffdLib = import ./lib.nix { inherit lib pkgs; };
  inherit (lib) mkOption types;

  plugins = pkgs.callPackage ./agent-plugins.nix {
    diffd = cfg.package;
    inherit (cfg) port;
    # With programs.mcp on, every agent (these two included) already gets
    # diffd's MCP from there; the plugins then only carry the hooks.
    withMcp = !(cfg.mcp.enable && options ? programs.mcp);
  };

  agentDefault = name: lib.attrByPath [ "programs" name "enable" ] false config;

  # Language servers run inside the reviewed project's direnv environment
  # (`direnv exec . <server>`, from the project root diffd picks), so they get
  # the same toolchain as the agent working there.
  defaultServers =
    (builtins.fromTOML (builtins.readFile ../crates/diffd-server/config.default.toml)).lsp.servers;
  direnv = lib.getExe config.programs.direnv.package;
  viaDirenv = lib.mapAttrs (
    _: server:
    lib.mapAttrs (_: lib.mkDefault) {
      command = direnv;
      args = [
        "exec"
        "."
        server.command
      ]
      ++ (server.args or [ ]);
    }
  ) defaultServers;
in
{
  options.services.diffd =
    (import ./common-options.nix {
      inherit lib pkgs;
      package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    })
    // {
      enable = lib.mkEnableOption "diffd, live code review of your agent's changes";

      useProfilePath = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Give the service your profile's PATH (~/.nix-profile/bin and the
          system profile), so it finds the same language servers as your shell.
        '';
      };

      agents = {
        claude.enable = mkOption {
          type = types.bool;
          default = agentDefault "claude-code";
          defaultText = lib.literalExpression "config.programs.claude-code.enable";
          description = ''
            Install diffd as a Claude Code plugin (`programs.claude-code.plugins.diffd`):
            hooks that wake an idle Claude when you leave feedback, the same
            ones `diffd setup claude` adds, plus the MCP server when
            `mcp.enable` is off.
          '';
        };
        codex.enable = mkOption {
          type = types.bool;
          default = agentDefault "codex";
          defaultText = lib.literalExpression "config.programs.codex.enable";
          description = ''
            Install diffd as a Codex plugin (`programs.codex.plugins`): hooks
            that queue your feedback into an idle Codex session, plus the MCP
            server when `mcp.enable` is off. Codex runs new hooks only once
            you trust them (`/hooks` in Codex) unless it's started with
            `--dangerously-bypass-hook-trust`.
          '';
        };
      };

      lsp.direnv = mkOption {
        type = types.bool;
        default = lib.attrByPath [ "programs" "direnv" "enable" ] false config;
        defaultText = lib.literalExpression "config.programs.direnv.enable";
        description = ''
          Start the built-in language servers through `direnv exec .` in the
          reviewed project, so they use that project's devshell (its
          rust-analyzer, toolchain and so on), like the agent does. Projects
          without an .envrc just use the service's PATH.
        '';
      };

      mcp.enable = mkOption {
        type = types.bool;
        default = true;
        description = ''
          Register diffd's MCP endpoint in `programs.mcp.servers.diffd`, which
          Claude Code, Codex, OpenCode and others read when their home-manager
          MCP integration is on.
        '';
      };
    };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        # The CLI too: `diffd config`, `diffd hook wait` for other agents.
        home.packages = [ cfg.package ];

        services.diffd.settings.lsp.servers = lib.mkIf cfg.lsp.direnv viaDirenv;

        systemd.user.services.diffd = {
          Unit = {
            Description = "diffd: live code review of your agent's changes";
            After = [ "network.target" ];
          };
          Service = {
            ExecStart = "${lib.getExe cfg.package} serve --config ${diffdLib.configFile cfg}";
            Environment = [
              "PATH=${
                lib.concatStringsSep ":" (
                  lib.optional (cfg.extraPackages != [ ]) (lib.makeBinPath cfg.extraPackages)
                  ++ lib.optionals cfg.useProfilePath [
                    "${config.home.profileDirectory}/bin"
                    "/etc/profiles/per-user/${config.home.username}/bin"
                    "/run/current-system/sw/bin"
                    "/usr/local/bin"
                    "/usr/bin"
                    "/bin"
                  ]
                )
              }"
            ];
            Restart = "on-failure";
            RestartSec = 2;
          };
          Install.WantedBy = [ "default.target" ];
        };
      }
      (lib.optionalAttrs (options ? programs.claude-code.plugins) {
        programs.claude-code.plugins = lib.mkIf cfg.agents.claude.enable { diffd = plugins.claude; };
      })
      (lib.optionalAttrs (options ? programs.codex.plugins) {
        programs.codex.plugins = lib.mkIf cfg.agents.codex.enable [ plugins.codex ];
      })
      (lib.optionalAttrs (options ? programs.mcp) {
        programs.mcp.servers = lib.mkIf cfg.mcp.enable {
          diffd.url = "http://localhost:${toString cfg.port}/mcp";
        };
      })
    ]
  );
}
