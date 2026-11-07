//! Dashboard settings: the glass theme's background image and how it is drawn.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::{Store, StoreError};

/// Largest accepted background image; keeps the database and page loads reasonable.
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// Settings row holding [`BackgroundSettings`] as JSON.
const BACKGROUND_KEY: &str = "background";

/// Image row holding the background picture.
const BACKGROUND_IMAGE: &str = "background";

/// Where the background image is anchored (CSS `background-position`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundPosition {
    #[default]
    Center,
    Top,
    Bottom,
    Left,
    Right,
}

/// How the background image is scaled (CSS `background-size`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundSize {
    /// Fill the screen, cropping if needed.
    #[default]
    Cover,
    /// Show the whole image.
    Contain,
    /// Original size.
    Auto,
}

/// How the background image is drawn; defaults match Kav-UI's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackgroundSettings {
    /// Strength of the image over the theme colors, 0–100 percent.
    pub opacity: u8,
    pub position: BackgroundPosition,
    pub size: BackgroundSize,
}

impl Default for BackgroundSettings {
    fn default() -> Self {
        Self {
            opacity: 18,
            position: BackgroundPosition::default(),
            size: BackgroundSize::default(),
        }
    }
}

/// A stored image without its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageInfo {
    pub content_type: String,
    pub bytes: usize,
    pub updated_at: String,
}

/// A stored image with its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Image {
    pub content_type: String,
    pub data: Vec<u8>,
    pub updated_at: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("the file must be a PNG, JPEG, WebP, GIF or AVIF image")]
    Unsupported,
    #[error("the image is {0} bytes; the limit is {MAX_IMAGE_BYTES} bytes")]
    TooLarge(usize),
    #[error(transparent)]
    Store(#[from] StoreError),
}

/// Identifies a supported raster image from its first bytes, ignoring any claimed type.
///
/// SVG is deliberately unsupported because it can carry scripts.
pub fn sniff_image_type(data: &[u8]) -> Option<&'static str> {
    match data {
        [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n', ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', b'7' | b'9', b'a', ..] => Some("image/gif"),
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => Some("image/webp"),
        [
            _,
            _,
            _,
            _,
            b'f',
            b't',
            b'y',
            b'p',
            b'a',
            b'v',
            b'i',
            b'f' | b's',
            ..,
        ] => Some("image/avif"),
        _ => None,
    }
}

impl Store {
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn background_settings(&self) -> Result<BackgroundSettings, StoreError> {
        let value: Option<String> = self
            .conn()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [BACKGROUND_KEY],
                |r| r.get(0),
            )
            .optional()?;
        // A row written by a future version that no longer parses falls back to defaults.
        Ok(value
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    /// # Errors
    ///
    /// [`StoreError::Invalid`] when the opacity is above 100.
    pub fn set_background_settings(&self, settings: &BackgroundSettings) -> Result<(), StoreError> {
        if settings.opacity > 100 {
            return Err(StoreError::Invalid(format!(
                "opacity must be 0-100, got {}",
                settings.opacity
            )));
        }
        let json =
            serde_json::to_string(settings).map_err(|e| StoreError::Invalid(e.to_string()))?;
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![BACKGROUND_KEY, json],
        )?;
        Ok(())
    }

    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn background_image(&self) -> Result<Option<Image>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT content_type, data, updated_at FROM images WHERE name = ?1",
                [BACKGROUND_IMAGE],
                |r| {
                    Ok(Image {
                        content_type: r.get(0)?,
                        data: r.get(1)?,
                        updated_at: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Describes the stored background image without loading its bytes.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn background_image_info(&self) -> Result<Option<ImageInfo>, StoreError> {
        Ok(self
            .conn()
            .query_row(
                "SELECT content_type, length(data), updated_at FROM images WHERE name = ?1",
                [BACKGROUND_IMAGE],
                |r| {
                    let bytes: i64 = r.get(1)?;
                    Ok(ImageInfo {
                        content_type: r.get(0)?,
                        // Stored images are capped at MAX_IMAGE_BYTES, so this always fits.
                        bytes: usize::try_from(bytes).unwrap_or(usize::MAX),
                        updated_at: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// Stores (or replaces) the background image after checking its format and size.
    ///
    /// # Errors
    ///
    /// [`ImageError::TooLarge`] above [`MAX_IMAGE_BYTES`], [`ImageError::Unsupported`]
    /// for anything that is not a PNG, JPEG, WebP, GIF or AVIF file.
    pub fn set_background_image(&self, data: &[u8]) -> Result<ImageInfo, ImageError> {
        if data.len() > MAX_IMAGE_BYTES {
            return Err(ImageError::TooLarge(data.len()));
        }
        let content_type = sniff_image_type(data).ok_or(ImageError::Unsupported)?;
        // Read the stored time in the same statement: another process may replace or
        // delete the image as soon as this one returns.
        let updated_at: String = self
            .conn()
            .query_row(
                "INSERT INTO images (name, content_type, data, updated_at)
                 VALUES (?1, ?2, ?3, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                 ON CONFLICT (name) DO UPDATE SET content_type = excluded.content_type,
                    data = excluded.data, updated_at = excluded.updated_at
                 RETURNING updated_at",
                params![BACKGROUND_IMAGE, content_type, data],
                |r| r.get(0),
            )
            .map_err(StoreError::from)?;
        Ok(ImageInfo {
            content_type: content_type.to_owned(),
            bytes: data.len(),
            updated_at,
        })
    }

    /// Removes the background image; returns whether there was one.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn delete_background_image(&self) -> Result<bool, StoreError> {
        let removed = self
            .conn()
            .execute("DELETE FROM images WHERE name = ?1", [BACKGROUND_IMAGE])?;
        Ok(removed > 0)
    }
}
