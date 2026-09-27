# services.diffd for NixOS: a system service, reviews in /var/lib/diffd.
#
# diffd reads the repositories it reviews and starts language servers in
# them, so it has to run as a user who can read them: set `user` to your own
# account to review your checkouts. The default `diffd` user suits a shared
# box where repositories are group-readable.
self:
{
  config,
  lib,
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

      user = mkOption {
        type = types.str;
        default = "diffd";
        description = "User diffd runs as; it must be able to read the reviewed repositories.";
      };

      group = mkOption {
        type = types.str;
        default = "diffd";
        description = "Group diffd runs as.";
      };

      dataDir = mkOption {
        type = types.path;
        default = "/var/lib/diffd";
        description = "Where the SQLite database (diffd.db) lives.";
      };

      openFirewall = mkOption {
        type = types.bool;
        default = false;
        description = "Open `port` in the firewall (only useful with a non-loopback `bind`).";
      };
    };

  config = lib.mkIf cfg.enable {
    users.users = lib.mkIf (cfg.user == "diffd") {
      diffd = {
        isSystemUser = true;
        inherit (cfg) group;
        home = cfg.dataDir;
      };
    };
    users.groups = lib.mkIf (cfg.group == "diffd") { diffd = { }; };

    systemd.tmpfiles.settings.diffd.${cfg.dataDir}.d = {
      inherit (cfg) user group;
      mode = "0750";
    };

    systemd.services.diffd = {
      description = "diffd: live code review of your agent's changes";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      path = cfg.extraPackages;
      environment = {
        DIFFD_DB = "${cfg.dataDir}/diffd.db";
        HOME = cfg.dataDir;
      };
      serviceConfig = {
        ExecStart = "${lib.getExe cfg.package} serve --config ${diffdLib.configFile cfg}";
        User = cfg.user;
        Group = cfg.group;
        Restart = "on-failure";
        RestartSec = 2;
        NoNewPrivileges = true;
        PrivateTmp = true;
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
