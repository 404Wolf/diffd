{
  description = "diffd: live code review of your agent's changes, in your browser";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        diffd = pkgs.callPackage ./nix/package.nix { };
      in
      {
        packages = {
          inherit diffd;
          default = diffd;
          web = diffd.web;
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

        formatter = pkgs.nixfmt-rfc-style;
      }
    );
}
