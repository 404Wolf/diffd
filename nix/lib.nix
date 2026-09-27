# Shared by the modules: the config file and the command line for a service.
{ lib, pkgs }:
{
  configFile =
    cfg:
    (pkgs.formats.toml { }).generate "diffd.toml" (
      lib.recursiveUpdate cfg.settings {
        server = {
          inherit (cfg) port bind;
          allowed_hosts = cfg.allowedHosts;
          public_url = cfg.publicUrl;
        };
      }
    );
}
