//! Generate every shipped icon from the single branding source:
//!   ../assets/branding/weport-icon.jpg
//!
//! Outputs (derived only — never edit by hand):
//!   icons/icon.ico, 16x16.png, 32x32.png, 48x48.png, 128x128.png,
//!   128x128@2x.png, icon.png, tray-16.png, tray-32.png, icon.icns
//!   OUT_DIR/window-icon.png  (embedded by gui.rs)
//!   OUT_DIR/tray-32.png      (embedded by tray.rs)

use std::env;
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let branding = manifest_dir
        .join("..")
        .join("assets")
        .join("branding")
        .join("weport-icon.jpg");
    let branding = branding.canonicalize().unwrap_or(branding);

    println!("cargo:rerun-if-changed={}", branding.display());
    println!("cargo:rerun-if-changed=build.rs");

    if !branding.is_file() {
        panic!(
            "Missing branding icon: {}\nPlace the app icon at assets/branding/weport-icon.jpg",
            branding.display()
        );
    }

    let src = image::open(&branding)
        .unwrap_or_else(|e| panic!("Failed to open {}: {e}", branding.display()))
        .into_rgba8();

    let icons_dir = manifest_dir.join("icons");
    fs::create_dir_all(&icons_dir).expect("create icons dir");

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    // Standard PNG sizes for Windows / Tauri conf / tray.
    write_png(&icons_dir.join("16x16.png"), &resize(&src, 16));
    write_png(&icons_dir.join("32x32.png"), &resize(&src, 32));
    write_png(&icons_dir.join("48x48.png"), &resize(&src, 48));
    write_png(&icons_dir.join("128x128.png"), &resize(&src, 128));
    write_png(&icons_dir.join("128x128@2x.png"), &resize(&src, 256));
    write_png(&icons_dir.join("icon.png"), &resize(&src, 256));
    // Tray copies (same art — no alternate plate).
    write_png(&icons_dir.join("tray-16.png"), &resize(&src, 16));
    write_png(&icons_dir.join("tray-32.png"), &resize(&src, 32));

    // Window / tray embeds via OUT_DIR (single compile-time path).
    write_png(&out_dir.join("window-icon.png"), &resize(&src, 256));
    write_png(&out_dir.join("tray-32.png"), &resize(&src, 32));

    // Multi-size ICO for exe resource + NSIS.
    let ico_path = icons_dir.join("icon.ico");
    write_ico(
        &ico_path,
        &[
            resize(&src, 16),
            resize(&src, 32),
            resize(&src, 48),
            resize(&src, 64),
            resize(&src, 128),
            resize(&src, 256),
        ],
    );

    // Minimal ICNS for completeness (PNG entries).
    write_icns(
        &icons_dir.join("icon.icns"),
        &[
            (128, resize(&src, 128)),
            (256, resize(&src, 256)),
            (512, resize(&src, 512)),
        ],
    );

    // Also refresh assets/icons/icon.png for any non-OUT_DIR consumers.
    let assets_icons = manifest_dir.join("..").join("assets").join("icons");
    let _ = fs::create_dir_all(&assets_icons);
    write_png(&assets_icons.join("icon.png"), &resize(&src, 512));

    #[cfg(windows)]
    {
        let mut res = winresource::WindowsResource::new();
        res.set_icon(ico_path.to_str().unwrap());
        res.set("ProductName", "Weport");
        res.set("FileDescription", "Weport — WeChat chat history exporter");
        res.set("CompanyName", "Weport");
        res.set("LegalCopyright", "Copyright © Weport");
        if let Err(e) = res.compile() {
            eprintln!("cargo:warning=winresource failed: {e}");
        }
    }
    println!("cargo:rerun-if-changed={}", ico_path.display());
}

fn resize(src: &image::RgbaImage, size: u32) -> image::RgbaImage {
    image::imageops::resize(src, size, size, image::imageops::FilterType::Lanczos3)
}

fn write_png(path: &Path, img: &image::RgbaImage) {
    img.save(path)
        .unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

/// Build a PNG-compressed multi-size ICO (Vista+).
fn write_ico(path: &Path, images: &[image::RgbaImage]) {
    let mut entries = Vec::new();
    let mut blobs = Vec::new();
    let header_size = 6usize;
    let dir_entry = 16usize;
    let mut offset = header_size + dir_entry * images.len();

    for img in images {
        let mut png = Vec::new();
        {
            let mut cursor = Cursor::new(&mut png);
            let dynimg = image::DynamicImage::ImageRgba8(img.clone());
            dynimg
                .write_to(&mut cursor, image::ImageFormat::Png)
                .expect("encode png for ico");
        }
        let size = img.width();
        let mut entry = [0u8; 16];
        entry[0] = if size >= 256 { 0 } else { size as u8 };
        entry[1] = if size >= 256 { 0 } else { size as u8 };
        entry[2] = 0;
        entry[3] = 0;
        entry[4] = 1; // planes
        entry[5] = 0;
        entry[6] = 32; // bit count
        entry[7] = 0;
        let len = png.len() as u32;
        entry[8..12].copy_from_slice(&len.to_le_bytes());
        entry[12..16].copy_from_slice(&(offset as u32).to_le_bytes());
        offset += png.len();
        entries.push(entry);
        blobs.push(png);
    }

    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type = icon
    out.extend_from_slice(&(images.len() as u16).to_le_bytes());
    for e in &entries {
        out.extend_from_slice(e);
    }
    for b in &blobs {
        out.extend_from_slice(b);
    }
    fs::write(path, out).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}

fn write_icns(path: &Path, images: &[(u32, image::RgbaImage)]) {
    // Map sizes to OSType
    fn ostype(size: u32) -> Option<&'static [u8; 4]> {
        match size {
            128 => Some(b"ic07"),
            256 => Some(b"ic08"),
            512 => Some(b"ic09"),
            64 => Some(b"ic12"),
            _ => None,
        }
    }
    let mut body = Vec::new();
    for (size, img) in images {
        let Some(tag) = ostype(*size) else { continue };
        let mut png = Vec::new();
        {
            let mut cursor = Cursor::new(&mut png);
            let dynimg = image::DynamicImage::ImageRgba8(img.clone());
            dynimg
                .write_to(&mut cursor, image::ImageFormat::Png)
                .expect("png for icns");
        }
        let len = (png.len() + 8) as u32;
        body.extend_from_slice(tag);
        body.extend_from_slice(&len.to_be_bytes());
        body.extend_from_slice(&png);
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"icns");
    out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(&body);
    fs::write(path, out).unwrap_or_else(|e| panic!("write {}: {e}", path.display()));
}
