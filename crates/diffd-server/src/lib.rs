//! diffd's server. [`app`] holds the use cases; [`ports`] are the traits they
//! depend on; [`adapters`] implement those traits and expose the app over
//! HTTP, WebSocket and MCP.

pub mod adapters;
pub mod app;
pub mod config;
pub mod ports;

pub use app::{App, AppError};
