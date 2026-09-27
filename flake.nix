{
  description = "diffd: live code review of your agent's changes, in your browser";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    {
      # `services.diffd` for NixOS (system service, /var/lib/diffd) and
      # home-manager (user service); see the README.
      nixosModules.default = import ./nix/nixos-module.nix self;
      homeManagerModules.default = import ./nix/hm-module.nix self;
      overlays.default = final: _prev: { diffd = final.callPackage ./nix/package.nix { }; };
    }
    // flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        diffd = pkgs.callPackage ./nix/package.nix { };
        plugins = pkgs.callPackage ./nix/agent-plugins.nix { inherit diffd; };
      in
      {
        packages = {
          inherit diffd;
          default = diffd;
          web = diffd.web;
          # Standalone plugins (hooks + MCP on the default port), e.g.
          # `claude --plugin-dir $(nix build --print-out-paths .#claude-plugin)`.
          claude-plugin = plugins.claude;
          codex-plugin = plugins.codex;
        };

        apps.default = flake-utils.lib.mkApp { drv = diffd; };

        devShells.default = pkgs.mkShell {
          inputsFrom = [ diffd ];
          packages = with pkgs; [
            cargo
            rustc
            clippy
            rustfmt
            rust-analyzer
            sqlx-cli
            nodejs_22
            difftastic
            git
            just
            python3
          ];
          DATABASE_URL = "sqlite://target/sqlx-dev.db";
        };

        checks = pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          nixos-module = import ./nix/nixos-test.nix self { inherit pkgs; };
        };

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
