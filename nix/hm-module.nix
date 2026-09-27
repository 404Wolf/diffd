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
      (lib.optionalAttrs (options ? programs.mcp) {
        programs.mcp.servers = lib.mkIf cfg.mcp.enable {
          diffd.url = "http://localhost:${toString cfg.port}/mcp";
        };
      })
    ]
  );
}
