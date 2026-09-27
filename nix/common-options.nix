# Options shared by the NixOS and home-manager modules.
{
  lib,
  pkgs,
  package,
}:
let
  inherit (lib) mkOption types;
  toml = pkgs.formats.toml { };
in
{
  package = mkOption {
    type = types.package;
    default = package;
    defaultText = lib.literalExpression "diffd.packages.\${system}.default";
    description = "The diffd package.";
  };

  port = mkOption {
    type = types.port;
    default = 3433;
    description = "Port the review server listens on.";
  };

  bind = mkOption {
    type = types.str;
    default = "127.0.0.1";
    example = "0.0.0.0";
    description = ''
      Address to listen on. Keep the default unless you share diffd over a
      network you trust; review comments become input for your agents. MCP
      (`/mcp`) always answers localhost only.
    '';
  };

  allowedHosts = mkOption {
    type = types.listOf types.str;
    default = [ ];
    example = [
      "mybox"
      "mybox.tailnet.ts.net"
    ];
    description = ''
      Host names the review pages answer to besides localhost: the names you
      open diffd by from other machines. Other hosts are refused.
    '';
  };

  publicUrl = mkOption {
    type = types.str;
    default = "";
    example = "https://mybox.tailnet.ts.net:3433";
    description = ''
      Base of the review links agents hand out. Empty means
      `http://localhost:<port>`.
    '';
  };

  extraPackages = mkOption {
    type = types.listOf types.package;
    default = [ ];
    example = lib.literalExpression "[ pkgs.rust-analyzer pkgs.nil ]";
    description = "Put on the service's PATH, e.g. the language servers diffd should use.";
  };

  settings = mkOption {
    inherit (toml) type;
    default = { };
    example = {
      lsp.servers.yaml.enabled = false;
    };
    description = ''
      diffd's config.toml, merged over its defaults (see `diffd config`). The
      server.* options above take precedence.
    '';
  };
}
