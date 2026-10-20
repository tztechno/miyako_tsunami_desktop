use std::path::Path;
use tauri::ipc::{InvokeBody, Request};
use tauri::Manager;

/// Save raw bytes (e.g. CSV export) into the user's Downloads folder.
#[tauri::command]
fn save_bytes(app: tauri::AppHandle, request: Request<'_>) -> Result<String, String> {
  let InvokeBody::Raw(data) = request.body() else {
    return Err("expected raw bytes".into());
  };
  let name = request
    .headers()
    .get("x-file-name")
    .and_then(|v| v.to_str().ok())
    .ok_or("missing file name")?
    .to_string();
  let file = Path::new(&name)
    .file_name()
    .and_then(|f| f.to_str())
    .filter(|f| !f.is_empty() && *f == name)
    .ok_or_else(|| format!("invalid file name: {name}"))?;
  let dir = app.path().download_dir().map_err(|e| e.to_string())?;
  let (stem, ext) = match file.rfind('.') {
    Some(i) if i > 0 => (&file[..i], &file[i..]),
    _ => (file, ""),
  };
  let mut path = dir.join(file);
  let mut n = 2;
  while path.exists() {
    path = dir.join(format!("{stem} ({n}){ext}"));
    n += 1;
  }
  std::fs::write(&path, data).map_err(|e| e.to_string())?;
  Ok(path.display().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![save_bytes])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
