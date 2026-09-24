#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::{Arc, Mutex};
use std::os::windows::process::CommandExt;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use base64::prelude::*;

const CREATE_NO_WINDOW: u32 = 0x08000000;

fn apply_stealth_mode(window: &WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
    
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            // Hides the window from Zoom/Teams/Meet screen sharing
            let _ = SetWindowDisplayAffinity(HWND(hwnd.0 as _), WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

#[tauri::command]
fn capture_screen() -> Result<String, String> {
    use xcap::Monitor;
    use std::io::Cursor;

    let monitors = Monitor::all().map_err(|e| e.to_string())?;
    let monitor = monitors.first().ok_or("No monitor found")?;
    
    let image = monitor.capture_image().map_err(|e| e.to_string())?;
    
    // 1. Use PNG instead of JPEG to support the Rgba8 color format
    let mut buffer = Cursor::new(Vec::new());
    image.write_to(&mut buffer, image::ImageFormat::Png).map_err(|e| e.to_string())?;
    
    let b64 = BASE64_STANDARD.encode(buffer.into_inner());
    // 2. Update the MIME type string to image/png
    Ok(format!("data:image/png;base64,{}", b64))
}

fn main() {
    tauri::Builder::default()
        // 2. Register the command right above .setup()
        .invoke_handler(tauri::generate_handler![capture_screen])
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            // 2. Register the global toggle shortcut (Ctrl + Shift + Space)
            let toggle_shortcut: Shortcut = "Ctrl+Shift+Space".parse().unwrap();
            
            app.global_shortcut().on_shortcut(toggle_shortcut, |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) {
                            let _ = window.hide();
                        } else {
                            let _ = window.show();
                            let _ = window.set_focus(); // Forces the window to the foreground
                        }
                    }
                }
            }).expect("Failed to register global shortcut");

            // 3. Make window stealthy
            let main_window = app.get_webview_window("main").unwrap();
            apply_stealth_mode(&main_window);

            // 4. Use CARGO_MANIFEST_DIR for bulletproof absolute paths
            let tauri_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
            let binaries_dir = tauri_dir.join("binaries");
            let exe_path = binaries_dir.join("llama-server-x86_64-pc-windows-msvc.exe");
            let model_path = tauri_dir.join("models").join("qwen2.5-coder-1.5b-instruct-q4_k_m.gguf");

            // 5. Start AI server invisibly in the background
            let child = Command::new(&exe_path)
                .current_dir(&binaries_dir)
                .arg("-m")
                .arg(&model_path)
                .arg("--port")
                .arg("8080")
                .arg("--ctx-size")
                .arg("4096")
                .arg("--n-gpu-layers")
                .arg("99")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .expect("Failed to start AI server in the background");

            let child_arc = Arc::new(Mutex::new(Some(child)));
            let child_clone = Arc::clone(&child_arc);

            // 6. Kill the AI server automatically when the app is closed
            main_window.on_window_event(move |event| {
                if let tauri::WindowEvent::Destroyed = event {
                    if let Ok(mut lock) = child_clone.lock() {
                        if let Some(mut child_process) = lock.take() {
                            let _ = child_process.kill();
                        }
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}