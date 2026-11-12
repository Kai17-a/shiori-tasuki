//! Dashboard settings: the glass theme's background image and how it is drawn, and the
//! GitHub repositories whose issues are not imported.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::store::{Store, StoreError, write_tx};

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

/// Settings row holding when a GitHub sync last started, in Unix seconds.
const SYNC_STARTED_KEY: &str = "github_sync_started_at";

impl Store {
    /// Records that a GitHub sync starts at `now` (Unix seconds), unless one started less
    /// than `min_gap_secs` ago. Returns whether the caller should sync.
    ///
    /// `serve` and every `mcp` process share one database and each keeps its own timer;
    /// this lets them take turns instead of all asking GitHub for the same issues.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn claim_sync(&self, now: u64, min_gap_secs: u64) -> Result<bool, StoreError> {
        let mut conn = self.conn();
        let tx = write_tx(&mut conn)?;
        let last: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [SYNC_STARTED_KEY],
                |r| r.get(0),
            )
            .optional()?;
        // A value that does not parse, or lies in the future, never blocks a sync.
        let recent = last
            .and_then(|v| v.parse::<u64>().ok())
            .is_some_and(|last| last <= now && now - last < min_gap_secs);
        if recent {
            return Ok(false);
        }
        tx.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![SYNC_STARTED_KEY, now.to_string()],
        )?;
        tx.commit()?;
        Ok(true)
    }
}

/// Settings row holding the repositories whose issues are not imported, as a JSON array.
const IGNORED_REPOS_KEY: &str = "github_ignored_repos";

/// Tasks imported from a repository (compared without case, as GitHub does) and all
/// their descendants, including local subtasks added under them.
const REPO_TASKS: &str = "WITH RECURSIVE doomed(id) AS (
    SELECT id FROM tasks WHERE gh_repo = ?1 COLLATE NOCASE
    UNION SELECT t.id FROM tasks t JOIN doomed d ON t.parent_id = d.id
)";

/// Accepts only `owner/name`, as the GitHub sync stores repositories.
fn checked_repo(repo: &str) -> Result<&str, StoreError> {
    let repo = repo.trim();
    crate::github::validate_repo(repo).map_err(|e| StoreError::Invalid(e.to_string()))?;
    Ok(repo)
}

impl Store {
    /// Repositories whose issues the GitHub sync skips, in the order they were added.
    ///
    /// # Errors
    ///
    /// Fails only on database errors.
    pub fn ignored_repos(&self) -> Result<Vec<String>, StoreError> {
        let value: Option<String> = self
            .conn()
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                [IGNORED_REPOS_KEY],
                |r| r.get(0),
            )
            .optional()?;
        Ok(value
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default())
    }

    /// How many tasks [`Store::ignore_repo`] would delete for `repo`: the tasks imported
    /// from it and everything under them.
    ///
    /// # Errors
    ///
    /// [`StoreError::Invalid`] unless `repo` looks like `owner/name`.
    pub fn repo_task_count(&self, repo: &str) -> Result<u32, StoreError> {
        let repo = checked_repo(repo)?;
        Ok(self.conn().query_row(
            &format!("{REPO_TASKS} SELECT COUNT(*) FROM doomed"),
            [repo],
            |r| r.get(0),
        )?)
    }

    /// Stops importing `repo` and deletes the tasks already imported from it, with
    /// their subtasks, in one transaction. Returns how many tasks were deleted; ignoring
    /// a repository again deletes nothing more.
    ///
    /// # Errors
    ///
    /// [`StoreError::Invalid`] unless `repo` looks like `owner/name`.
    pub fn ignore_repo(&self, repo: &str) -> Result<u32, StoreError> {
        let repo = checked_repo(repo)?;
        let mut repos = self.ignored_repos()?;
        if !repos.iter().any(|r| r.eq_ignore_ascii_case(repo)) {
            repos.push(repo.to_owned());
        }
        let mut conn = self.conn();
        let tx = write_tx(&mut conn)?;
        let deleted: u32 = tx.query_row(
            &format!("{REPO_TASKS} SELECT COUNT(*) FROM doomed"),
            [repo],
            |r| r.get(0),
        )?;
        // Subtasks go with their parents through ON DELETE CASCADE.
        tx.execute(
            "DELETE FROM tasks WHERE gh_repo = ?1 COLLATE NOCASE",
            [repo],
        )?;
        save_ignored(&tx, &repos)?;
        tx.commit()?;
        Ok(deleted)
    }

    /// Imports `repo` again from the next sync. Returns whether it was ignored.
    ///
    /// # Errors
    ///
    /// [`StoreError::Invalid`] unless `repo` looks like `owner/name`.
    pub fn unignore_repo(&self, repo: &str) -> Result<bool, StoreError> {
        let repo = checked_repo(repo)?;
        let mut repos = self.ignored_repos()?;
        let before = repos.len();
        repos.retain(|r| !r.eq_ignore_ascii_case(repo));
        if repos.len() == before {
            return Ok(false);
        }
        save_ignored(&self.conn(), &repos)?;
        Ok(true)
    }
}

fn save_ignored(conn: &rusqlite::Connection, repos: &[String]) -> Result<(), StoreError> {
    let json = serde_json::to_string(repos).map_err(|e| StoreError::Invalid(e.to_string()))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        params![IGNORED_REPOS_KEY, json],
    )?;
    Ok(())
}
