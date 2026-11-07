//! Keeps GitHub issues assigned to the user mirrored in the background.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::github::{self, GhRunner, ImportReport};
use crate::store::Store;

/// How often the background sync runs; fixed so every process stays consistent.
pub const SYNC_INTERVAL: Duration = Duration::from_secs(300);

/// Outcome of the most recent sync runs, shown on the dashboard.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct SyncStatus {
    pub running: bool,
    /// Unix seconds of the last finished run, successful or not.
    pub last_finished_at: Option<u64>,
    /// Unix seconds of the last successful run.
    pub last_success_at: Option<u64>,
    /// Result of the last successful run.
    pub last_report: Option<ImportReport>,
    /// Error of the last run, cleared by the next success.
    pub last_error: Option<String>,
    pub interval_secs: u64,
}

/// Runs [`github::sync_assigned`] and remembers how it went; cheap to clone.
#[derive(Clone)]
pub struct Syncer {
    store: Store,
    gh: Arc<dyn GhRunner + Send + Sync>,
    status: Arc<Mutex<SyncStatus>>,
}

impl std::fmt::Debug for Syncer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The gh runner is a trait object without Debug; the status says what matters.
        f.debug_struct("Syncer")
            .field("status", &self.status())
            .finish_non_exhaustive()
    }
}

impl Syncer {
    /// A syncer for `store` that calls GitHub through `gh`; nothing runs until
    /// [`Syncer::run_once`] or [`Syncer::spawn`].
    pub fn new(store: Store, gh: Arc<dyn GhRunner + Send + Sync>) -> Self {
        Self {
            store,
            gh,
            status: Arc::new(Mutex::new(SyncStatus {
                interval_secs: SYNC_INTERVAL.as_secs(),
                ..SyncStatus::default()
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SyncStatus> {
        self.status.lock().expect("sync status lock poisoned")
    }

    /// A copy of how the recent runs went.
    pub fn status(&self) -> SyncStatus {
        self.lock().clone()
    }

    /// Syncs once, blocking; skipped when another run is still in progress.
    pub fn run_once(&self) {
        {
            let mut status = self.lock();
            if status.running {
                return;
            }
            status.running = true;
        }
        // Clears `running` even if the sync panics, so later runs are not skipped forever.
        let _running = RunningGuard(self);
        let result = github::sync_assigned(&self.store, self.gh.as_ref());
        let now = unix_now();
        let mut status = self.lock();
        status.last_finished_at = Some(now);
        match result {
            Ok(report) => {
                status.last_success_at = Some(now);
                status.last_report = Some(report);
                status.last_error = None;
            }
            Err(err) => {
                eprintln!("task-tool: GitHub sync failed: {err}");
                status.last_error = Some(err.to_string());
            }
        }
    }

    /// Syncs now and then every [`SYNC_INTERVAL`] on the current Tokio runtime.
    pub fn spawn(self) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(SYNC_INTERVAL);
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticker.tick().await;
                let syncer = self.clone();
                if let Err(err) = tokio::task::spawn_blocking(move || syncer.run_once()).await {
                    eprintln!("task-tool: GitHub sync task stopped unexpectedly: {err}");
                }
            }
        })
    }
}

/// Marks the sync as no longer running when dropped.
struct RunningGuard<'a>(&'a Syncer);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        // A poisoned lock means another thread already panicked; nothing is left to reset.
        if let Ok(mut status) = self.0.status.lock() {
            status.running = false;
        }
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
