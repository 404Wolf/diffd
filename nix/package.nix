# The diffd binary with its web page baked in, and git + difftastic on hand.
{
  lib,
  rustPlatform,
  buildNpmPackage,
  importNpmLock,
  nodejs_22,
  makeWrapper,
  git,
  difftastic,
}:
let
  src = lib.cleanSource ../.;

  # web/dist/index.html: the whole page, scripts and styles inlined.
  web = buildNpmPackage {
    pname = "diffd-web";
    version = "0.1.0";
    src = lib.cleanSource ../web;
    nodejs = nodejs_22;
    # Fetches each package by the integrity hash in package-lock.json, so no
    # separate dependency hash needs updating when dependencies change.
    npmDeps = importNpmLock { npmRoot = lib.cleanSource ../web; };
    npmConfigHook = importNpmLock.npmConfigHook;
    npmBuildScript = "build";
    # Playwright is only for the end-to-end tests; never fetch browsers here.
    env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      cp dist/index.html $out/
      runHook postInstall
    '';
  };
in
rustPlatform.buildRustPackage {
  pname = "diffd";
  version = "0.1.0";
  inherit src;

  cargoLock.lockFile = ../Cargo.lock;
  cargoBuildFlags = [ "-p" "diffd" ];

  nativeBuildInputs = [ makeWrapper ];

  env = {
    # Queries are checked against the committed .sqlx data instead of a live database.
    SQLX_OFFLINE = "true";
    DIFFD_WEB_DIST = "${web}";
  };

  # The test suite shells out to git and writes generated TypeScript into the
  # source tree; it runs in CI and `just test` instead.
  doCheck = false;

  postInstall = ''
    wrapProgram $out/bin/diffd \
      --suffix PATH : ${lib.makeBinPath [ git ]} \
      --set-default DIFFD_DIFFT ${lib.getExe difftastic}
  '';

  passthru = { inherit web; };

  meta = {
    description = "Live code review of your agent's changes, in your browser";
    homepage = "https://github.com/404Wolf/diffd";
    license = lib.licenses.mit;
    mainProgram = "diffd";
  };
}
