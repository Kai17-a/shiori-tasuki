use task_tool::{
    Actor, NewSubtask, NewTask, ReviewDecision, SessionOutcome, Status, Store, TaskUpdate,
};

#[test]
fn explicit_completion_finishes_ancestors_only_after_the_last_child() {
    let store = Store::open_in_memory().unwrap();
    let root = store
        .create(&NewTask {
            title: "Root".into(),
            ..NewTask::default()
        })
        .unwrap();
    let parent = store
        .create(&NewTask {
            title: "Parent".into(),
            parent_id: Some(root.id),
            ..NewTask::default()
        })
        .unwrap();
    let children = store
        .create_subtasks(
            parent.id,
            &[
                NewSubtask {
                    title: "One".into(),
                    description: String::new(),
                },
                NewSubtask {
                    title: "Two".into(),
                    description: String::new(),
                },
            ],
            &Actor::from("user"),
        )
        .unwrap();
    store
        .complete_task(
            children[0].id,
            &Actor::from("agent"),
            "Implemented and verified",
        )
        .unwrap();
    assert_ne!(store.get(parent.id).unwrap().unwrap().status, Status::Done);
    store
        .complete_task(
            children[1].id,
            &Actor::from("agent"),
            "Implemented and verified",
        )
        .unwrap();
    assert_ne!(store.get(parent.id).unwrap().unwrap().status, Status::Done);
    store
        .review_task(
            children[0].id,
            &Actor::from("user"),
            ReviewDecision::Approve,
            "",
        )
        .unwrap();
    assert_ne!(store.get(parent.id).unwrap().unwrap().status, Status::Done);
    store
        .review_task(
            children[1].id,
            &Actor::from("user"),
            ReviewDecision::Approve,
            "Verified",
        )
        .unwrap();
    assert_eq!(store.get(parent.id).unwrap().unwrap().status, Status::Done);
    assert_eq!(store.get(root.id).unwrap().unwrap().status, Status::Done);
    assert_eq!(
        store
            .events_for(children[1].id, 10)
            .unwrap()
            .iter()
            .filter(|e| e.message == "Implemented and verified")
            .count(),
        1
    );
}

#[test]
fn failure_records_reason_clears_assignee_and_leaves_task_for_user() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Task".into(),
            ..NewTask::default()
        })
        .unwrap();
    store
        .update_as(
            task.id,
            &TaskUpdate {
                status: Some(Status::InProgress),
                assignee: Some("agent".into()),
                ..TaskUpdate::default()
            },
            &Actor::from("agent"),
        )
        .unwrap();
    let task = store
        .fail_task(task.id, &Actor::from("agent"), "Missing credentials")
        .unwrap();
    assert_eq!(task.status, Status::Todo);
    assert!(task.assignee.is_none());
    assert!(
        store
            .events_for(task.id, 10)
            .unwrap()
            .iter()
            .any(|e| e.actor == "agent" && e.message == "Missing credentials")
    );
    assert_eq!(task.attempts, 0);
}

#[test]
fn invalid_reports_do_not_change_state() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Task".into(),
            ..NewTask::default()
        })
        .unwrap();
    assert!(
        store
            .complete_task(task.id, &Actor::from("agent"), " ")
            .is_err()
    );
    assert!(
        store
            .fail_task(task.id, &Actor::from("agent"), " ")
            .is_err()
    );
    assert_eq!(store.get(task.id).unwrap().unwrap().status, Status::Todo);
    assert!(
        store
            .complete_task(999, &Actor::from("agent"), "Done")
            .is_err()
    );
    assert!(
        store
            .fail_task(999, &Actor::from("agent"), "Failed")
            .is_err()
    );
}

#[test]
fn review_rejection_and_sessions_preserve_each_attempt() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Review".into(),
            workdir: Some(tempfile::tempdir().unwrap().path().display().to_string()),
            ..NewTask::default()
        })
        .unwrap();
    store
        .start_task(task.id, &Actor::from("agent"), None)
        .unwrap();
    store
        .start_task(task.id, &Actor::from("agent"), None)
        .unwrap();
    let sessions = store.sessions(task.id).unwrap();
    assert_eq!(sessions[0].outcome, SessionOutcome::Abandoned);
    let reported = store
        .complete_task(task.id, &Actor::from("agent"), "Tested report")
        .unwrap();
    assert_eq!(reported.status, Status::Review);
    assert!(
        store
            .review_task(task.id, &Actor::from("agent"), ReviewDecision::Approve, "")
            .is_err()
    );
    assert!(
        store
            .review_task(task.id, &Actor::from("user"), ReviewDecision::Reject, " ")
            .is_err()
    );
    let rejected = store
        .review_task(
            task.id,
            &Actor::from("user"),
            ReviewDecision::Reject,
            "Add regression coverage",
        )
        .unwrap();
    assert_eq!(rejected.status, Status::Todo);
    assert!(rejected.assignee.is_none());
    assert!(
        store
            .events_for(task.id, 100)
            .unwrap()
            .iter()
            .any(|e| e.kind == task_tool::activity::EventKind::Rejected
                && e.message == "Add regression coverage")
    );
    store
        .start_task(task.id, &Actor::from("agent"), None)
        .unwrap();
    store
        .fail_task(task.id, &Actor::from("agent"), "Blocked")
        .unwrap();
    assert_eq!(
        store.sessions(task.id).unwrap()[2].outcome,
        SessionOutcome::Failed
    );
    assert!(
        store
            .update_as(
                task.id,
                &TaskUpdate {
                    status: Some(Status::Done),
                    ..TaskUpdate::default()
                },
                &Actor::from("agent")
            )
            .is_err()
    );
    assert_eq!(
        store
            .complete_task(task.id, &Actor::from("user"), "Own task")
            .unwrap()
            .status,
        Status::Done
    );
}

#[test]
fn git_evidence_records_commits_files_and_dirty_work() {
    use std::process::Command;
    let dir = tempfile::tempdir().unwrap();
    let git = |args: &[&str]| {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir.path())
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    };
    git(&["init", "-q"]);
    git(&["config", "user.name", "Test"]);
    git(&["config", "user.email", "test@example.com"]);
    std::fs::write(dir.path().join("file.txt"), "one\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "initial"]);
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Git".into(),
            workdir: Some(dir.path().display().to_string()),
            ..NewTask::default()
        })
        .unwrap();
    store
        .start_task(task.id, &Actor::from("agent"), None)
        .unwrap();
    std::fs::write(dir.path().join("file.txt"), "one\ntwo\n").unwrap();
    git(&["add", "."]);
    git(&["commit", "-qm", "add line"]);
    std::fs::write(dir.path().join("file.txt"), "one\ntwo\ndirty\n").unwrap();
    std::fs::write(dir.path().join("new.txt"), "untracked").unwrap();
    store
        .complete_task(task.id, &Actor::from("agent"), "Verified")
        .unwrap();
    let session = store.sessions(task.id).unwrap().remove(0);
    let evidence = session.end_git.unwrap();
    assert_eq!(evidence.commits.len(), 1);
    assert!(evidence.commits[0].ends_with("add line"));
    assert_eq!(evidence.files, vec!["1\t0\tfile.txt"]);
    assert_eq!(evidence.uncommitted, vec!["1\t0\tfile.txt"]);
    assert_eq!(evidence.untracked, vec!["new.txt"]);
    assert_ne!(session.start_git.unwrap().head, evidence.head);
    let non_git = tempfile::tempdir().unwrap();
    assert!(task_tool::git_evidence::capture(non_git.path().to_str(), None).is_none());
    let plain = store
        .create(&NewTask {
            title: "Non git".into(),
            workdir: Some(non_git.path().display().to_string()),
            ..NewTask::default()
        })
        .unwrap();
    store
        .start_task(plain.id, &Actor::from("agent"), None)
        .unwrap();
    store
        .complete_task(plain.id, &Actor::from("agent"), "Verified outside git")
        .unwrap();
    let plain_session = store.sessions(plain.id).unwrap().remove(0);
    assert!(plain_session.start_git.is_none());
    assert!(plain_session.end_git.is_none());
}

#[test]
fn links_validate_and_family_timeline_is_ordered() {
    use task_tool::work::WorkLink;
    let store = Store::open_in_memory().unwrap();
    let root = store
        .create(&NewTask {
            title: "Root".into(),
            ..NewTask::default()
        })
        .unwrap();
    let child = store
        .create_subtasks(
            root.id,
            &[NewSubtask {
                title: "Child".into(),
                description: String::new(),
            }],
            &Actor::from("agent"),
        )
        .unwrap()
        .remove(0);
    store
        .start_task(child.id, &Actor::from("agent"), None)
        .unwrap();
    for url in [
        "javascript:alert(1)",
        "file:///tmp/test",
        "https:///",
        "ftp://example.com",
        "/relative",
    ] {
        assert!(
            store
                .add_link(
                    child.id,
                    &WorkLink {
                        url: url.into(),
                        label: None
                    }
                )
                .is_err(),
            "{url}"
        );
    }
    assert!(
        store
            .complete_with_links(
                child.id,
                &Actor::from("agent"),
                "Report",
                &[WorkLink {
                    url: "bad".into(),
                    label: None
                }]
            )
            .is_err()
    );
    assert_eq!(
        store.get(child.id).unwrap().unwrap().status,
        Status::InProgress
    );
    store
        .complete_with_links(
            child.id,
            &Actor::from("agent"),
            "Report",
            &[WorkLink {
                url: "https://example.com/pr/1".into(),
                label: Some("PR".into()),
            }],
        )
        .unwrap();
    assert_eq!(store.sessions(child.id).unwrap()[0].links.len(), 1);
    store
        .review_task(child.id, &Actor::from("user"), ReviewDecision::Approve, "")
        .unwrap();
    let items = store.timeline(child.id).unwrap();
    assert!(items.iter().any(|i| i.task_id == root.id));
    assert!(items.iter().any(|i| i.session.is_some()));
    let events: Vec<_> = items.iter().filter_map(|i| i.event.as_ref()).collect();
    assert!(
        events
            .windows(2)
            .all(|p| p[0].created_at <= p[1].created_at)
    );
    assert!(
        events
            .iter()
            .position(|e| e.kind == task_tool::activity::EventKind::Started)
            .unwrap()
            < events
                .iter()
                .position(|e| e.kind == task_tool::activity::EventKind::Reported)
                .unwrap()
    );
}

#[test]
fn start_records_the_thread_the_caller_names() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Threaded".into(),
            ..NewTask::default()
        })
        .unwrap();
    store
        .start_task(task.id, &Actor::from("agent"), Some("thread-42"))
        .unwrap();
    let sessions = store.sessions(task.id).unwrap();
    assert_eq!(sessions[0].thread_id.as_deref(), Some("thread-42"));
    assert_eq!(sessions[0].outcome, SessionOutcome::Running);
}

#[test]
fn a_review_for_the_user_needs_an_agent_their_words_and_a_report() {
    let store = Store::open_in_memory().unwrap();
    let task = store
        .create(&NewTask {
            title: "Work".into(),
            ..NewTask::default()
        })
        .unwrap();
    let agent = Actor::from("codex");
    assert!(
        store
            .review_for_user(task.id, &agent, ReviewDecision::Approve, "OK")
            .is_err(),
        "only a task under review"
    );
    store.start_task(task.id, &agent, None).unwrap();
    store.complete_task(task.id, &agent, "Done").unwrap();
    assert!(
        store
            .review_for_user(task.id, &Actor::User, ReviewDecision::Approve, "OK")
            .is_err(),
        "the user reviews directly"
    );
    assert!(
        store
            .review_for_user(task.id, &agent, ReviewDecision::Approve, "  ")
            .is_err(),
        "the user's words are required"
    );
    let done = store
        .review_for_user(task.id, &agent, ReviewDecision::Approve, "OK")
        .unwrap();
    assert_eq!(done.status, Status::Done);
}
