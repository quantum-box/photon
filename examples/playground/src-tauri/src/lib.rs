use photon_engine::{projection::apply_operation, Operation, Record};

#[tauri::command]
fn photon_engine_apply_operation(
    current: Option<Record>,
    operation: Operation,
) -> Result<Record, String> {
    apply_operation(current, &operation).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![photon_engine_apply_operation])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
