use shiori_tasuki::Store;
use shiori_tasuki::settings::{
    BackgroundPosition, BackgroundSettings, BackgroundSize, ImageError, MAX_IMAGE_BYTES,
    sniff_image_type,
};

/// Smallest byte strings that start like each supported format.
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";
const JPEG: &[u8] = b"\xff\xd8\xff\xe0\0\x10JFIF\0";
const GIF: &[u8] = b"GIF89a\x01\0\x01\0";
const WEBP: &[u8] = b"RIFF\x24\0\0\0WEBPVP8 ";
const AVIF: &[u8] = b"\0\0\0\x1cftypavif\0\0\0\0";

fn store() -> Store {
    Store::open_in_memory().expect("in-memory store opens")
}

#[test]
fn recognises_supported_images_by_their_bytes() {
    assert_eq!(sniff_image_type(PNG), Some("image/png"));
    assert_eq!(sniff_image_type(JPEG), Some("image/jpeg"));
    assert_eq!(sniff_image_type(GIF), Some("image/gif"));
    assert_eq!(sniff_image_type(WEBP), Some("image/webp"));
    assert_eq!(sniff_image_type(AVIF), Some("image/avif"));
    for other in [
        &b"<svg xmlns='http://www.w3.org/2000/svg'/>"[..],
        b"<html>",
        b"",
        b"\x89PN",
    ] {
        assert_eq!(sniff_image_type(other), None, "{other:?}");
    }
}

#[test]
fn background_settings_default_to_the_kav_ui_values() {
    let settings = store().background_settings().unwrap();
    assert_eq!(
        settings,
        BackgroundSettings {
            opacity: 18,
            position: BackgroundPosition::Center,
            size: BackgroundSize::Cover,
        }
    );
}

#[test]
fn saves_background_settings() {
    let store = store();
    let wanted = BackgroundSettings {
        opacity: 40,
        position: BackgroundPosition::Top,
        size: BackgroundSize::Contain,
    };

    store.set_background_settings(&wanted).unwrap();

    assert_eq!(store.background_settings().unwrap(), wanted);
}

#[test]
fn rejects_an_opacity_above_100() {
    let err = store()
        .set_background_settings(&BackgroundSettings {
            opacity: 101,
            ..BackgroundSettings::default()
        })
        .unwrap_err();
    assert!(err.to_string().contains("opacity"), "got {err}");
}

#[test]
fn stores_replaces_and_deletes_the_background_image() {
    let store = store();
    assert!(store.background_image().unwrap().is_none());

    let first = store.set_background_image(PNG).unwrap();
    assert_eq!(first.content_type, "image/png");
    assert_eq!(first.bytes, PNG.len());
    let image = store.background_image().unwrap().unwrap();
    assert_eq!(image.data, PNG);

    store.set_background_image(JPEG).unwrap();
    let image = store.background_image().unwrap().unwrap();
    assert_eq!(
        (image.content_type.as_str(), image.data.as_slice()),
        ("image/jpeg", JPEG)
    );

    assert!(store.delete_background_image().unwrap());
    assert!(store.background_image().unwrap().is_none());
    assert!(!store.delete_background_image().unwrap());
}

#[test]
fn refuses_files_that_are_not_supported_images_or_too_large() {
    let store = store();

    let err = store
        .set_background_image(b"<svg onload='alert(1)'/>")
        .unwrap_err();
    assert!(matches!(err, ImageError::Unsupported), "got {err:?}");

    let mut huge = PNG.to_vec();
    huge.resize(MAX_IMAGE_BYTES + 1, 0);
    let err = store.set_background_image(&huge).unwrap_err();
    assert!(matches!(err, ImageError::TooLarge(_)), "got {err:?}");

    assert!(
        store.background_image().unwrap().is_none(),
        "nothing stored"
    );
}

#[test]
fn settings_survive_reopening_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.db");
    {
        let store = Store::open(&path).unwrap();
        store.set_background_image(WEBP).unwrap();
        store
            .set_background_settings(&BackgroundSettings {
                opacity: 55,
                ..BackgroundSettings::default()
            })
            .unwrap();
    }

    let store = Store::open(&path).unwrap();
    assert_eq!(store.background_settings().unwrap().opacity, 55);
    assert_eq!(
        store.background_image().unwrap().unwrap().content_type,
        "image/webp"
    );
}
