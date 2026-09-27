# The NixOS module end to end: diffd shared on the network for a named host,
# reachable from another machine for the pages but not for MCP.
self:
{ pkgs, ... }:
pkgs.testers.runNixOSTest {
  name = "diffd";

  nodes.server = {
    imports = [ self.nixosModules.default ];
    services.diffd = {
      enable = true;
      bind = "0.0.0.0";
      allowedHosts = [ "server" ];
      publicUrl = "http://server:3433";
      openFirewall = true;
    };
  };

  nodes.client = { };

  testScript = ''
    import json

    start_all()
    server.wait_for_unit("diffd.service")
    server.wait_for_open_port(3433)

    # Reviews go to /var/lib/diffd.
    server.succeed("test -f /var/lib/diffd/diffd.db")

    # Another machine gets the pages by the allowed name...
    client.wait_for_unit("multi-user.target")
    client.succeed("curl -fsS -o page.html http://server:3433/ && grep -q '<' page.html")
    client.succeed("curl -fsS http://server:3433/api/reviews")
    # ...but not by an address it wasn't told about, and never MCP.
    client.fail("curl -fsS -H 'Host: elsewhere' http://server:3433/")
    client.fail("curl -fsS -X POST http://server:3433/mcp -H 'Content-Type: application/json' -d '{}'")

    # MCP works locally.
    init = {
        "jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
    }
    out = server.succeed(
        "curl -fsS -X POST http://localhost:3433/mcp "
        "-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' "
        f"-d '{json.dumps(init)}'"
    )
    assert "diffd" in out, out

    # A stop (SIGTERM) is clean and the service comes back.
    server.succeed("systemctl restart diffd.service")
    server.wait_for_open_port(3433)
    server.fail("journalctl -u diffd.service | grep -q 'stopping with connections still open'")
  '';
}
