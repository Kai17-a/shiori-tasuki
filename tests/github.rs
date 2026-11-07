use std::cell::RefCell;
use std::collections::VecDeque;

use task_tool::github::{self, GhError, GhRunner, GithubError};
use task_tool::{Actor, NewSubtask, NewTask, Status, Store, TaskUpdate};

/// Plays `gh` signed in as `me`.
///
/// The login lookup always answers `me`. The search of `me`'s own repositories answers
/// from `own` (no issues once it runs out) and is recorded in `own_calls`. Every other
/// call, such as the search of issues assigned elsewhere, answers from `replies` in turn
/// and is recorded in `calls`.
#[derive(Default)]
struct FakeGh {
    calls: RefCell<Vec<Vec<String>>>,
    replies: RefCell<VecDeque<Result<String, GhError>>>,
    own_calls: RefCell<Vec<Vec<String>>>,
    own: RefCell<VecDeque<String>>,
}

impl FakeGh {
    fn replying(replies: impl IntoIterator<Item = String>) -> Self {
        Self {
            replies: RefCell::new(replies.into_iter().map(Ok).collect()),
            ..Self::default()
        }
    }
}

impl GhRunner for FakeGh {
    fn run(&self, args: &[String]) -> Result<String, GhError> {
        if args == ["api", "user", "--jq", ".login"] {
            return Ok("me\n".into());
        }
        if args.iter().any(|a| a.starts_with("q=user:me ")) {
            self.own_calls.borrow_mut().push(args.to_vec());
            return Ok(self
                .own
                .borrow_mut()
                .pop_front()
                .unwrap_or_else(|| results(&[])));
        }
        self.calls.borrow_mut().push(args.to_vec());
        self.replies
            .borrow_mut()
            .pop_front()
            .expect("test queued a reply for every gh call")
    }
}

/// One GraphQL Issue node.
fn issue(repo: &str, number: u32, title: &str, state: &str) -> String {
    format!(
        r#"{{"number": {number}, "title": "{title}", "body": "body of {number}", "state": "{state}",
            "url": "https://github.com/{repo}/issues/{number}",
            "repository": {{"name": "x", "nameWithOwner": "{repo}"}}}}"#
    )
}

fn results(items: &[String]) -> String {
    format!(
        r#"{{"data":{{"search":{{"nodes":[{}],"pageInfo":{{"hasNextPage":false,"endCursor":null}}}}}}}}"#,
        items.join(",")
    )
}

fn sync(store: &Store, reply: String) -> github::ImportReport {
    github::sync_issues(store, &FakeGh::replying([reply])).expect("sync succeeds")
}

#[test]
fn fetches_every_issue_assigned_to_me_across_repositories() {
    let store = Store::open_in_memory().unwrap();
    let gh = FakeGh::replying([results(&[
        issue("o/api", 1, "Open bug", "open"),
        issue("other/web", 7, "Closed one", "closed"),
    ])]);

    let report = github::sync_issues(&store, &gh).unwrap();

    assert_eq!((report.created, report.updated), (2, 0));
    assert_eq!(&gh.calls.borrow()[0][..2], ["api", "graphql"]);
    assert!(
        gh.calls.borrow()[0]
            .iter()
            .any(|a| a.contains("assignee:@me"))
    );
    let bug = store.find_by_github("o/api", 1).unwrap().unwrap();
    assert_eq!(bug.title, "Open bug");
    assert_eq!(bug.description, "body of 1");
    assert_eq!(bug.status, Status::Todo);
    assert_eq!(bug.created_by, "github");
    let closed = store.find_by_github("other/web", 7).unwrap().unwrap();
    assert_eq!(closed.status, Status::Done);
    assert_eq!(
        closed.github.unwrap().url,
        "https://github.com/other/web/issues/7"
    );
}

#[test]
fn uses_github_timestamps_so_the_dashboard_reflects_real_activity() {
    let store = Store::open_in_memory().unwrap();
    let closed = r#"[{"number": 4, "title": "old", "body": "", "state": "closed",
        "url": "https://github.com/o/r/issues/4", "repository": {"nameWithOwner": "o/r"},
        "createdAt": "2025-01-02T03:04:05Z", "closedAt": "2025-02-03T04:05:06Z"}]"#;

    sync(
        &store,
        results(&[closed
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned()]),
    );

    let task = store.find_by_github("o/r", 4).unwrap().unwrap();
    assert_eq!(task.created_at, "2025-01-02T03:04:05Z");
    assert_eq!(task.completed_at.as_deref(), Some("2025-02-03T04:05:06Z"));
    let stats = store.stats().unwrap();
    assert_eq!(stats.completed_last_7_days, 0, "closed long ago");
    assert_eq!(stats.daily.last().unwrap().created, 0);
}

#[test]
fn an_unchanged_issue_is_left_alone_so_recent_activity_stays_meaningful() {
    let store = Store::open_in_memory().unwrap();
    let reply = results(&[issue("o/r", 1, "Same", "open")]);
    sync(&store, reply.clone());
    let before = store.find_by_github("o/r", 1).unwrap().unwrap();
    // Make a later write distinguishable from the first one.
    store
        .update(
            before.id,
            &TaskUpdate {
                status: Some(Status::InProgress),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    let before = store.get(before.id).unwrap().unwrap();

    let report = sync(&store, reply);

    assert_eq!((report.created, report.updated), (0, 0));
    assert_eq!(store.get(before.id).unwrap().unwrap(), before);
}

#[test]
fn same_number_in_different_repositories_are_different_tasks() {
    let store = Store::open_in_memory().unwrap();

    let report = sync(
        &store,
        results(&[
            issue("a/one", 1, "A", "open"),
            issue("b/two", 1, "B", "open"),
        ]),
    );

    assert_eq!(report.created, 2);
    assert_eq!(
        store.find_by_github("a/one", 1).unwrap().unwrap().title,
        "A"
    );
    assert_eq!(
        store.find_by_github("b/two", 1).unwrap().unwrap().title,
        "B"
    );
}

#[test]
fn resync_updates_instead_of_duplicating_and_keeps_local_progress() {
    let store = Store::open_in_memory().unwrap();
    sync(&store, results(&[issue("o/r", 1, "Old", "open")]));
    let bug = store.find_by_github("o/r", 1).unwrap().unwrap();
    store
        .update(
            bug.id,
            &TaskUpdate {
                status: Some(Status::InProgress),
                ..TaskUpdate::default()
            },
        )
        .unwrap();

    let report = sync(
        &store,
        results(&[issue("o/r", 1, "Renamed", "open").replace("body of 1", "Updated body")]),
    );

    assert_eq!((report.created, report.updated), (0, 1));
    let bug = store.get(bug.id).unwrap().unwrap();
    assert_eq!(bug.title, "Renamed");
    assert_eq!(bug.description, "Updated body");
    assert_eq!(bug.status, Status::InProgress, "local progress is kept");
    assert_eq!(store.stats().unwrap().total, 1);
}

#[test]
fn closing_on_github_marks_the_task_done_and_reopening_resets_it() {
    let store = Store::open_in_memory().unwrap();
    let status = || store.find_by_github("o/r", 5).unwrap().unwrap();

    sync(&store, results(&[issue("o/r", 5, "t", "open")]));
    sync(&store, results(&[issue("o/r", 5, "t", "closed")]));
    assert_eq!(status().status, Status::Done);
    assert!(status().completed_at.is_some());
    sync(&store, results(&[issue("o/r", 5, "t", "open")]));
    assert_eq!(status().status, Status::Todo);
    assert!(status().completed_at.is_none());
}

#[test]
fn long_issue_titles_are_shortened_instead_of_failing_the_sync() {
    let store = Store::open_in_memory().unwrap();
    let long = "あ".repeat(300);

    sync(&store, results(&[issue("o/r", 8, &long, "open")]));

    let task = store.find_by_github("o/r", 8).unwrap().unwrap();
    assert_eq!(task.title.chars().count(), 200);
    assert!(task.title.ends_with('…'));
}

#[test]
fn rejects_repo_names_that_could_be_read_as_flags() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "t".into(),
            ..NewTask::default()
        })
        .unwrap();
    let gh = FakeGh::default();
    for repo in ["--help", "owner", "a/b/c", "o/r;rm", ""] {
        let err = github::push_task(&store, &gh, task.id, repo).unwrap_err();
        assert!(matches!(err, GithubError::Invalid(_)), "{repo:?}: {err:?}");
    }
    assert!(gh.calls.borrow().is_empty(), "gh is never called");
}

#[test]
fn pushes_a_local_task_assigned_to_me_with_its_subtasks_as_a_checklist() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Ship v1".into(),
            description: "Final checks".into(),
            ..NewTask::default()
        })
        .unwrap();
    let subtasks = store
        .create_subtasks(
            task.id,
            &[
                NewSubtask {
                    title: "Docs".into(),
                    description: String::new(),
                },
                NewSubtask {
                    title: "Tag".into(),
                    description: String::new(),
                },
            ],
            &Actor::from("ai"),
        )
        .unwrap();
    store
        .update(
            subtasks[0].id,
            &TaskUpdate {
                status: Some(Status::Done),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    let gh = FakeGh::replying(["https://github.com/o/r/issues/42\n".to_owned()]);

    let linked = github::push_task(&store, &gh, task.id, "o/r").unwrap();

    let link = linked.github.unwrap();
    assert_eq!((link.repo.as_str(), link.number), ("o/r", 42));
    assert_eq!(
        gh.calls.borrow()[0],
        [
            "issue",
            "create",
            "--repo",
            "o/r",
            "--assignee",
            "@me",
            "--title",
            "Ship v1",
            "--body",
            "Final checks\n\n## Subtasks\n\n- [x] Docs\n- [ ] Tag\n"
        ],
        "assigned to me so the next sync keeps it up to date"
    );
}

#[test]
fn refuses_to_push_a_task_that_is_already_linked() {
    let store = Store::open_in_memory().unwrap();
    sync(&store, results(&[issue("o/r", 1, "x", "open")]));
    let bug = store.find_by_github("o/r", 1).unwrap().unwrap();
    let gh = FakeGh::default();

    let err = github::push_task(&store, &gh, bug.id, "o/r").unwrap_err();

    assert!(matches!(err, GithubError::Invalid(_)), "got {err:?}");
    assert!(gh.calls.borrow().is_empty());
}

#[test]
fn reports_gh_failures() {
    let store = Store::open_in_memory().unwrap();
    let gh = FakeGh {
        replies: RefCell::new(VecDeque::from([Err(GhError::Failed(
            "HTTP 401: Bad credentials".into(),
        ))])),
        ..FakeGh::default()
    };

    let err = github::sync_issues(&store, &gh).unwrap_err();

    assert!(err.to_string().contains("HTTP 401"), "got {err}");
}

#[test]
fn sync_changes_are_recorded_in_the_task_history_as_github() {
    let store = Store::open_in_memory().unwrap();
    sync(&store, results(&[issue("o/r", 3, "t", "open")]));
    sync(&store, results(&[issue("o/r", 3, "t", "closed")]));
    sync(&store, results(&[issue("o/r", 3, "t", "closed")]));

    let task = store.find_by_github("o/r", 3).unwrap().unwrap();
    let history = store.events_for(task.id, 10).unwrap();
    let kinds: Vec<_> = history.iter().map(|e| (e.kind, e.actor.as_str())).collect();
    assert_eq!(
        kinds,
        vec![
            (task_tool::activity::EventKind::Status, "github"),
            (task_tool::activity::EventKind::Created, "github"),
        ],
        "an unchanged issue adds nothing"
    );
    assert_eq!(history[0].to_status, Some(Status::Done));
}

#[test]
fn a_task_finished_locally_stays_done_while_its_issue_is_still_open() {
    let store = Store::open_in_memory().unwrap();
    sync(&store, results(&[issue("o/r", 9, "t", "open")]));
    let task = store.find_by_github("o/r", 9).unwrap().unwrap();
    store
        .update(
            task.id,
            &TaskUpdate {
                status: Some(Status::Done),
                ..TaskUpdate::default()
            },
        )
        .unwrap();

    sync(&store, results(&[issue("o/r", 9, "t", "open")]));

    assert_eq!(
        store.get(task.id).unwrap().unwrap().status,
        Status::Done,
        "only a real reopen (closed -> open) moves it back, or the runner would redo it forever"
    );
}

fn child(number: u32, parent: Option<u32>) -> String {
    let mut value: serde_json::Value =
        serde_json::from_str(&issue("o/r", number, "t", "OPEN")).expect("issue fixture is JSON");
    value["parent"] = parent.map_or(
        serde_json::Value::Null,
        |n| serde_json::json!({"number": n, "repository": {"nameWithOwner":"o/r"}}),
    );
    value.to_string()
}

#[test]
fn github_relations_follow_changes_without_completing_parents() {
    let store = Store::open_in_memory().unwrap();
    let report = sync(
        &store,
        results(&[child(2, Some(1)), child(1, None), child(3, None)]),
    );
    let task = |n| store.find_by_github("o/r", n).unwrap().unwrap();
    assert_eq!(task(2).parent_id, Some(task(1).id));
    assert_eq!(report.created, 3);
    assert_eq!(task(1).status, Status::Todo);
    assert_eq!(
        sync(
            &store,
            results(&[child(2, Some(3)), child(1, None), child(3, None)])
        )
        .updated,
        1
    );
    assert_eq!(task(2).parent_id, Some(task(3).id));
    sync(&store, results(&[child(2, None)]));
    assert_eq!(task(2).parent_id, None);
    sync(&store, results(&[child(2, Some(99))]));
    assert_eq!(task(2).parent_id, None);
    assert!(store.find_by_github("o/r", 99).unwrap().is_none());
    let events = store.events_for(task(2).id, 20).unwrap();
    assert!(
        events
            .iter()
            .any(|e| e.actor == "github" && e.message == "GitHubの親子関係を解除")
    );
    // The parent is named by its GitHub issue, not by the local task id.
    assert!(
        events
            .iter()
            .any(|e| e.message == "GitHubの親子関係を反映（親: o/r#3）")
    );
}

#[test]
fn pagination_uses_cursor_and_ignores_non_issues() {
    let store = Store::open_in_memory().unwrap();
    let first = results(&[child(2, Some(1))])
        .replace("\"hasNextPage\":false", "\"hasNextPage\":true")
        .replace("\"endCursor\":null", "\"endCursor\":\"next\"");
    let gh = FakeGh::replying([
        first,
        results(&[
            child(1, None),
            "null".into(),
            r#"{"__typename":"PullRequest"}"#.into(),
        ]),
    ]);
    github::sync_issues(&store, &gh).unwrap();
    assert!(gh.calls.borrow()[1].iter().any(|a| a == "cursor=next"));
    assert_eq!(
        store.find_by_github("o/r", 2).unwrap().unwrap().parent_id,
        Some(store.find_by_github("o/r", 1).unwrap().unwrap().id)
    );
}

#[test]
fn local_hierarchy_is_preserved_and_linking_does_not_complete_parent() {
    let store = Store::open_in_memory().unwrap();
    sync(&store, results(&[child(1, None)]));
    let parent = store.find_by_github("o/r", 1).unwrap().unwrap();
    let local = store
        .create(&NewTask {
            title: "local".into(),
            parent_id: Some(parent.id),
            ..NewTask::default()
        })
        .unwrap();
    let local_parent = store
        .create(&NewTask {
            title: "local parent".into(),
            ..NewTask::default()
        })
        .unwrap();
    let protected = store
        .create(&NewTask {
            title: "t".into(),
            parent_id: Some(local_parent.id),
            ..NewTask::default()
        })
        .unwrap();
    store
        .link_github(
            protected.id,
            &task_tool::GithubLink {
                repo: "o/r".into(),
                number: 3,
                url: "https://github.com/o/r/issues/3".into(),
            },
        )
        .unwrap();
    let mut closed: serde_json::Value = serde_json::from_str(&child(2, Some(1))).unwrap();
    closed["state"] = "CLOSED".into();
    sync(
        &store,
        results(&[closed.to_string(), child(3, Some(1)), child(1, None)]),
    );
    assert_eq!(
        store.get(local.id).unwrap().unwrap().parent_id,
        Some(parent.id)
    );
    assert_eq!(
        store.get(protected.id).unwrap().unwrap().parent_id,
        Some(local_parent.id)
    );
    assert_eq!(store.get(parent.id).unwrap().unwrap().status, Status::Todo);
    assert_eq!(
        store.find_by_github("o/r", 2).unwrap().unwrap().status,
        Status::Done
    );
    sync(&store, results(&[child(3, None)]));
    assert_eq!(
        store.get(protected.id).unwrap().unwrap().parent_id,
        Some(local_parent.id)
    );
}

#[test]
fn cycles_are_rejected_and_missing_imported_parent_is_cleared() {
    let store = Store::open_in_memory().unwrap();
    sync(
        &store,
        results(&[child(1, Some(2)), child(2, Some(1)), child(3, Some(3))]),
    );
    let a = store.find_by_github("o/r", 1).unwrap().unwrap();
    let b = store.find_by_github("o/r", 2).unwrap().unwrap();
    assert!(!(a.parent_id == Some(b.id) && b.parent_id == Some(a.id)));
    assert_eq!(
        store.find_by_github("o/r", 3).unwrap().unwrap().parent_id,
        None
    );
    store.delete(b.id).unwrap();
    // A deleted parent's cascade may remove its children; a later sync restores only assigned issues.
    sync(&store, results(&[child(1, Some(2))]));
    assert_eq!(
        store.find_by_github("o/r", 1).unwrap().unwrap().parent_id,
        None
    );
}

#[test]
fn caps_search_at_one_thousand_and_validates_parent_repository() {
    let store = Store::open_in_memory().unwrap();
    let pages = (0..10).map(|page| {
        results(
            &(1..=100)
                .map(|n| child(page * 100 + n, None))
                .collect::<Vec<_>>(),
        )
        .replace("\"hasNextPage\":false", "\"hasNextPage\":true")
        .replace(
            "\"endCursor\":null",
            &format!("\"endCursor\":\"page{page}\""),
        )
    });
    let gh = FakeGh::replying(pages);
    assert_eq!(github::sync_issues(&store, &gh).unwrap().created, 1000);
    assert_eq!(gh.calls.borrow().len(), 10);
    let mut invalid: serde_json::Value = serde_json::from_str(&child(1001, Some(1))).unwrap();
    invalid["parent"]["repository"]["nameWithOwner"] = "--bad/repo".into();
    assert!(
        github::sync_issues(&store, &FakeGh::replying([results(&[invalid.to_string()])])).is_err()
    );
}

#[test]
fn reversing_existing_hierarchy_is_independent_of_result_order() {
    for reversed in [false, true] {
        let store = Store::open_in_memory().unwrap();
        sync(&store, results(&[child(1, None), child(2, Some(1))]));
        let mut next = vec![child(1, Some(2)), child(2, None)];
        if reversed {
            next.reverse();
        }
        assert_eq!(sync(&store, results(&next)).updated, 2);
        let a = store.find_by_github("o/r", 1).unwrap().unwrap();
        let b = store.find_by_github("o/r", 2).unwrap().unwrap();
        assert_eq!(a.parent_id, Some(b.id));
        assert_eq!(b.parent_id, None);
    }
}

#[test]
fn imports_every_issue_of_my_own_repositories_and_only_my_share_elsewhere() {
    let store = Store::open_in_memory().unwrap();
    let gh = FakeGh::replying([results(&[
        issue("org/team", 5, "Assigned to me", "open"),
        // Also found by the own-repository search; imported once.
        issue("me/tool", 1, "Unassigned idea", "open"),
    ])]);
    gh.own.borrow_mut().push_back(results(&[
        issue("me/tool", 1, "Unassigned idea", "open"),
        issue("me/site", 2, "Old fix", "closed"),
    ]));

    let report = github::sync_issues(&store, &gh).unwrap();

    assert_eq!((report.created, report.updated), (3, 0));
    let own = &gh.own_calls.borrow()[0];
    assert!(
        own.iter()
            .any(|a| a == "q=user:me is:issue archived:false sort:updated-desc"),
        "{own:?}"
    );
    let elsewhere = &gh.calls.borrow()[0];
    assert!(
        elsewhere
            .iter()
            .any(|a| a == "q=assignee:@me is:issue -user:me sort:updated-desc"),
        "{elsewhere:?}"
    );
    assert!(store.find_by_github("me/tool", 1).unwrap().is_some());
    assert_eq!(
        store.find_by_github("me/site", 2).unwrap().unwrap().status,
        Status::Done
    );
    assert!(store.find_by_github("org/team", 5).unwrap().is_some());
}

#[test]
fn refuses_a_login_that_could_change_the_search() {
    struct OddLogin;
    impl GhRunner for OddLogin {
        fn run(&self, _: &[String]) -> Result<String, GhError> {
            Ok("me is:pr".into())
        }
    }
    let store = Store::open_in_memory().unwrap();
    let err = github::sync_issues(&store, &OddLogin).unwrap_err();
    assert!(err.to_string().contains("unexpected GitHub login"), "{err}");
}

#[test]
fn ignoring_a_repository_deletes_its_tasks_and_skips_it_from_then_on() {
    let store = Store::open_in_memory().unwrap();
    sync(
        &store,
        results(&[
            issue("o/noise", 1, "Not mine to track", "open"),
            issue("o/keep", 2, "Mine", "open"),
        ]),
    );
    let noisy = store.find_by_github("o/noise", 1).unwrap().unwrap();
    store
        .create_subtasks(
            noisy.id,
            &[NewSubtask {
                title: "Local step".into(),
                description: String::new(),
            }],
            &Actor::User,
        )
        .unwrap();

    // GitHub compares repository names without case, and so does the ignore list.
    assert_eq!(store.repo_task_count("O/Noise").unwrap(), 2);
    assert_eq!(store.ignore_repo("O/Noise").unwrap(), 2);
    assert!(store.find_by_github("o/noise", 1).unwrap().is_none());
    assert!(store.find_by_github("o/keep", 2).unwrap().is_some());
    assert_eq!(store.ignored_repos().unwrap(), ["O/Noise"]);
    assert_eq!(store.ignore_repo("o/noise").unwrap(), 0, "already ignored");
    assert_eq!(
        store.ignored_repos().unwrap().len(),
        1,
        "no duplicate entry"
    );

    let report = sync(
        &store,
        results(&[
            issue("o/noise", 1, "Not mine to track", "open"),
            issue("o/noise", 3, "New noise", "open"),
        ]),
    );
    assert_eq!(report.created, 0, "ignored issues are not imported");
    assert!(store.find_by_github("o/noise", 3).unwrap().is_none());

    assert!(store.unignore_repo("o/noise").unwrap());
    assert!(!store.unignore_repo("o/noise").unwrap(), "already imported");
    sync(&store, results(&[issue("o/noise", 3, "New noise", "open")]));
    assert!(store.find_by_github("o/noise", 3).unwrap().is_some());

    assert!(store.ignore_repo("not a repo").is_err());
}
