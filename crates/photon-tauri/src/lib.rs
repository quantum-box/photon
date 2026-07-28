//! Photon Engine as a Tauri plugin.
//!
//! Registers under the name `photon` so a Tauri host can do:
//!
//! ```ignore
//! tauri::Builder::default().plugin(photon_tauri::init())
//! ```
//!
//! Today the plugin only reserves the integration point. It is also the
//! future home of a Tauri-native SQLite [`photon_client::StorageAdapter`], so
//! desktop and mobile shells can persist the op-log outside the webview.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

pub use photon_client::{PhotonClient, PhotonClientBuilder};

/// Initialize the `photon` Tauri plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("photon").build()
}

#[cfg(test)]
mod tests {
    #[test]
    fn plugin_registers_with_a_mock_app() {
        let app = tauri::test::mock_builder()
            .plugin(super::init())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("app builds with the photon plugin");
        drop(app);
    }
}
