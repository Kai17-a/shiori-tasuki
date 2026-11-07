use std::sync::{Arc, Mutex};

use shiori_tasuki::Store;
use shiori_tasuki::github::{GhError, GhRunner};
use shiori_tasuki::sync::Syncer;

/// Replies with each queued result in turn and counts calls.
#[derive(Default)]
struct FakeGh {
    replies: Mutex<Vec<Result<String, GhError>>>,
}

impl GhRunner for FakeGh {
    fn run(&self, args: &[String]) -> Result<String, GhError> {
        // Signed in as `me`, whose own repositories have no issues; the queued results
        // answer the search of issues assigned elsewhere.
        if args == ["api", "user", "--jq", ".login"] {
            return Ok("me".into());
        }
        if args.iter().any(|a| a.starts_with("q=user:me ")) {
            return Ok(r#"{"data":{"search":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#.into());
        }
        self.replies.lock().expect("fake gh lock").remove(0)
    }
}

fn syncer(replies: Vec<Result<String, GhError>>) -> (Syncer, Store) {
    let store = Store::open_in_memory().expect("in-memory store opens");
    let gh = Arc::new(FakeGh {
        replies: Mutex::new(replies),
    });
    (Syncer::new(store.clone(), gh), store)
}

const ONE_ISSUE: &str = r#"{"data":{"search":{"nodes":[{"number": 1, "title": "t", "body": "", "state": "open",
    "url": "https://github.com/o/r/issues/1", "repository": {"nameWithOwner": "o/r"}}],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#;

#[test]
fn starts_without_any_result() {
    let (syncer, _) = syncer(vec![]);
    let status = syncer.status();
    assert!(!status.running);
    assert!(status.last_finished_at.is_none());
    assert!(status.last_report.is_none());
    assert_eq!(status.interval_secs, 300);
}

#[test]
fn records_a_successful_run() {
    let (syncer, store) = syncer(vec![Ok(ONE_ISSUE.into())]);

    syncer.run_once();

    let status = syncer.status();
    assert!(!status.running);
    assert_eq!(status.last_report.unwrap().created, 1);
    assert!(status.last_error.is_none());
    assert!(status.last_success_at.is_some());
    assert_eq!(status.last_finished_at, status.last_success_at);
    assert!(store.find_by_github("o/r", 1).unwrap().is_some());
}

#[test]
fn keeps_the_last_success_when_a_later_run_fails() {
    let (syncer, _) = syncer(vec![
        Ok(ONE_ISSUE.into()),
        Err(GhError::Failed("HTTP 502".into())),
    ]);

    syncer.run_once();
    let success = syncer.status().last_success_at;
    syncer.run_once();

    let status = syncer.status();
    assert!(status.last_error.unwrap().contains("HTTP 502"));
    assert_eq!(status.last_success_at, success);
    assert!(
        status.last_report.is_some(),
        "the last good result stays visible"
    );
}

#[test]
fn a_success_clears_an_earlier_error() {
    let (syncer, _) = syncer(vec![
        Err(GhError::Failed("offline".into())),
        Ok(
            r#"{"data":{"search":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}"#
                .into(),
        ),
    ]);

    syncer.run_once();
    assert!(syncer.status().last_error.is_some());
    syncer.run_once();
    assert!(syncer.status().last_error.is_none());
}
