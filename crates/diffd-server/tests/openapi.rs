//! The page's API client is generated from `web/openapi.json` (`just types`):
//! the file must match the API the server actually serves.

use std::path::Path;

#[test]
fn the_checked_in_openapi_matches_the_server() {
    let spec = diffd_server::adapters::http::openapi().to_pretty_json().expect("the spec serializes") + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/openapi.json");
    if std::env::var_os("DIFFD_UPDATE_OPENAPI").is_some() {
        std::fs::write(&path, &spec).expect("writing web/openapi.json");
        return;
    }
    let checked_in = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(checked_in == spec, "web/openapi.json is out of date: run `just types`");
}
