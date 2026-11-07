use shiori_tasuki::{Actor, NewSubtask, NewTask, Scope, Status, Store, StoreError, TaskUpdate};

fn store() -> Store {
    Store::open_in_memory().expect("in-memory store opens")
}

fn new_task(title: &str) -> NewTask {
    NewTask {
        title: title.to_owned(),
        ..NewTask::default()
    }
}

#[test]
fn creates_a_local_task_with_defaults() {
    let store = store();
    let task = store.create(&new_task("  Write docs  ")).unwrap();

    assert_eq!(task.title, "Write docs", "title is trimmed");
    assert_eq!(task.status, Status::Todo);
    assert_eq!(task.created_by, "user");
    assert!(task.parent_id.is_none());
    assert!(task.github.is_none());
    assert_eq!(store.get(task.id).unwrap().unwrap(), task);
}

#[test]
fn rejects_an_empty_title() {
    let err = store().create(&new_task("   ")).unwrap_err();
    assert!(matches!(err, StoreError::Invalid(_)), "got {err:?}");
}

#[test]
fn rejects_a_missing_parent() {
    let err = store()
        .create(&NewTask {
            parent_id: Some(99),
            ..new_task("child")
        })
        .unwrap_err();
    assert!(matches!(err, StoreError::NotFound(99)), "got {err:?}");
}

#[test]
fn creates_subtasks_atomically_and_counts_them_on_the_parent() {
    let store = store();
    let parent = store.create(&new_task("Release v1")).unwrap();

    let children = store
        .create_subtasks(
            parent.id,
            &[
                NewSubtask {
                    title: "Write changelog".into(),
                    description: "list user-facing changes".into(),
                },
                NewSubtask {
                    title: "Tag release".into(),
                    description: String::new(),
                },
            ],
            &Actor::from("claude-code"),
        )
        .unwrap();

    assert_eq!(children.len(), 2);
    assert!(children.iter().all(|c| c.parent_id == Some(parent.id)));
    assert!(children.iter().all(|c| c.created_by == "claude-code"));

    store
        .update(
            children[0].id,
            &TaskUpdate {
                status: Some(Status::Done),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    let parent = store.get(parent.id).unwrap().unwrap();
    assert_eq!(parent.subtasks.total, 2);
    assert_eq!(parent.subtasks.done, 1);
}

#[test]
fn subtask_batch_with_an_invalid_item_creates_nothing() {
    let store = store();
    let parent = store.create(&new_task("Parent")).unwrap();

    let err = store
        .create_subtasks(
            parent.id,
            &[
                NewSubtask {
                    title: "ok".into(),
                    description: String::new(),
                },
                NewSubtask {
                    title: " ".into(),
                    description: String::new(),
                },
            ],
            &Actor::from("ai"),
        )
        .unwrap_err();

    assert!(matches!(err, StoreError::Invalid(_)), "got {err:?}");
    assert!(store.list(Scope::ChildrenOf(parent.id)).unwrap().is_empty());
}

#[test]
fn subtasks_require_an_existing_parent_and_at_least_one_item() {
    let store = store();
    let err = store
        .create_subtasks(7, &[], &Actor::from("ai"))
        .unwrap_err();
    assert!(matches!(err, StoreError::Invalid(_)), "got {err:?}");

    let err = store
        .create_subtasks(
            7,
            &[NewSubtask {
                title: "x".into(),
                description: String::new(),
            }],
            &Actor::from("ai"),
        )
        .unwrap_err();
    assert!(matches!(err, StoreError::NotFound(7)), "got {err:?}");
}

#[test]
fn lists_by_scope() {
    let store = store();
    let a = store.create(&new_task("A")).unwrap();
    let b = store.create(&new_task("B")).unwrap();
    store
        .create(&NewTask {
            parent_id: Some(a.id),
            ..new_task("A-1")
        })
        .unwrap();

    let top: Vec<_> = store
        .list(Scope::TopLevel)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(top, vec![a.id, b.id]);
    assert_eq!(store.list(Scope::All).unwrap().len(), 3);
    assert_eq!(store.list(Scope::ChildrenOf(a.id)).unwrap()[0].title, "A-1");
}

#[test]
fn updates_fields_and_reports_missing_tasks() {
    let store = store();
    let task = store.create(&new_task("Old")).unwrap();

    let updated = store
        .update(
            task.id,
            &TaskUpdate {
                title: Some("New".into()),
                description: Some("details".into()),
                status: Some(Status::InProgress),
                assignee: None,
            },
        )
        .unwrap();
    assert_eq!(updated.title, "New");
    assert_eq!(updated.description, "details");
    assert_eq!(updated.status, Status::InProgress);

    let err = store.update(404, &TaskUpdate::default()).unwrap_err();
    assert!(matches!(err, StoreError::NotFound(404)), "got {err:?}");
}

#[test]
fn hiding_a_parent_hides_its_subtasks_and_keeps_everything() {
    let store = store();
    let parent = store.create(&new_task("Parent")).unwrap();
    let child = store
        .create(&NewTask {
            parent_id: Some(parent.id),
            ..new_task("Child")
        })
        .unwrap();
    let other = store.create(&new_task("Other")).unwrap();

    let hidden = store.hide(parent.id, &Actor::User).unwrap();
    assert!(hidden.hidden_at.is_some());
    let child = store.get(child.id).unwrap().expect("hidden, not deleted");
    assert!(
        child.hidden_at.is_some(),
        "subtasks are hidden with their parent"
    );
    assert!(store.get(other.id).unwrap().unwrap().hidden_at.is_none());

    // Statistics leave hidden tasks out; the task list still has them.
    assert_eq!(store.stats().unwrap().total, 1);
    assert_eq!(store.list(Scope::All).unwrap().len(), 3);

    // A subtask added under a hidden parent starts hidden.
    let late = store
        .create(&NewTask {
            parent_id: Some(parent.id),
            ..new_task("Late")
        })
        .unwrap();
    assert!(late.hidden_at.is_some());

    let shown = store.unhide(parent.id, &Actor::User).unwrap();
    assert!(shown.hidden_at.is_none());
    assert!(store.get(late.id).unwrap().unwrap().hidden_at.is_none());
    assert_eq!(store.stats().unwrap().total, 4);

    let events = store.events_for(parent.id, 10).unwrap();
    assert!(events.iter().any(|e| e.message.starts_with("非表示にした")));
    assert!(events.iter().any(|e| e.message.starts_with("表示に戻した")));
    assert!(matches!(
        store.hide(404, &Actor::User).unwrap_err(),
        StoreError::NotFound(404)
    ));
}

#[test]
fn status_round_trips_through_strings() {
    for status in [
        Status::Todo,
        Status::InProgress,
        Status::Review,
        Status::Done,
    ] {
        assert_eq!(status.as_str().parse::<Status>().unwrap(), status);
    }
    assert!("doing".parse::<Status>().is_err());
}

#[test]
fn persists_to_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested").join("tasks.db");
    let id = Store::open(&path)
        .unwrap()
        .create(&new_task("Persisted"))
        .unwrap()
        .id;

    let reopened = Store::open(&path).unwrap();
    assert_eq!(reopened.get(id).unwrap().unwrap().title, "Persisted");
}

fn set_status(store: &Store, id: i64, status: Status) -> shiori_tasuki::Task {
    store
        .update(
            id,
            &TaskUpdate {
                status: Some(status),
                ..TaskUpdate::default()
            },
        )
        .expect("status changes")
}

#[test]
fn records_when_a_task_is_completed_and_clears_it_on_reopen() {
    let store = store();
    let task = store.create(&new_task("Finish")).unwrap();
    assert!(task.completed_at.is_none());

    let done = set_status(&store, task.id, Status::Done);
    let completed_at = done.completed_at.expect("set when done");

    let edited = store
        .update(
            task.id,
            &TaskUpdate {
                title: Some("Finish it".into()),
                ..TaskUpdate::default()
            },
        )
        .unwrap();
    assert_eq!(edited.completed_at.as_deref(), Some(completed_at.as_str()));

    assert!(
        set_status(&store, task.id, Status::Review)
            .completed_at
            .is_none()
    );

    let created_done = store
        .create(&NewTask {
            status: Some(Status::Done),
            ..new_task("Already done")
        })
        .unwrap();
    assert!(created_done.completed_at.is_some());
}

#[test]
fn migrates_a_version_1_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("v1.db");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
                title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'todo', created_by TEXT NOT NULL DEFAULT 'user',
                gh_repo TEXT, gh_number INTEGER, gh_url TEXT,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                UNIQUE (gh_repo, gh_number));
             INSERT INTO tasks (title, status, created_at, updated_at)
                VALUES ('old done', 'done', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
             PRAGMA user_version = 1;",
        )
        .unwrap();
    }

    let store = Store::open(&path).unwrap();
    let task = store.get(1).unwrap().unwrap();
    let history = store.events_for(1, 10).unwrap();
    assert_eq!(
        history.len(),
        1,
        "existing tasks get their creation as history"
    );
    assert_eq!(history[0].created_at, "2026-01-01T00:00:00Z");

    assert_eq!(
        task.completed_at.as_deref(),
        Some("2026-01-02T00:00:00Z"),
        "done tasks are backfilled from updated_at"
    );
}

#[test]
fn summarises_tasks_for_the_dashboard() {
    let store = store();
    let parent = store.create(&new_task("Parent")).unwrap();
    let kids = store
        .create_subtasks(
            parent.id,
            &[
                NewSubtask {
                    title: "k1".into(),
                    description: String::new(),
                },
                NewSubtask {
                    title: "k2".into(),
                    description: String::new(),
                },
            ],
            &Actor::from("claude-code"),
        )
        .unwrap();
    set_status(&store, kids[0].id, Status::Done);
    let review = store.create(&new_task("Review me")).unwrap();
    set_status(&store, review.id, Status::Review);
    let linked = store.create(&new_task("From GitHub")).unwrap();
    store
        .link_github(
            linked.id,
            &shiori_tasuki::GithubLink {
                repo: "o/r".into(),
                number: 1,
                url: "https://github.com/o/r/issues/1".into(),
            },
        )
        .unwrap();

    let stats = store.stats().unwrap();

    assert_eq!(stats.total, 5);
    assert_eq!(stats.by_status.todo, 3);
    assert_eq!(stats.by_status.review, 1);
    assert_eq!(stats.by_status.done, 1);
    assert_eq!(stats.completed_last_7_days, 1);

    assert_eq!(stats.daily.len(), 14);
    let today = stats.daily.last().unwrap();
    assert_eq!((today.created, today.completed), (5, 1));
    assert!(stats.daily.windows(2).all(|w| w[0].date < w[1].date));

    let repos: Vec<_> = stats
        .by_repo
        .iter()
        .map(|r| (r.repo.as_deref(), r.open, r.done))
        .collect();
    assert_eq!(
        repos,
        vec![(None, 2, 0), (Some("o/r"), 1, 0)],
        "top-level only"
    );

    let agent = stats
        .by_creator
        .iter()
        .find(|c| c.created_by == "claude-code")
        .unwrap();
    assert_eq!(agent.count, 2);

    assert_eq!(stats.recent.len(), 5);
    assert_eq!(stats.recent[0].id, linked.id, "most recently updated first");

    let progress: Vec<_> = stats.with_subtasks.iter().map(|t| t.id).collect();
    assert_eq!(progress, vec![parent.id]);
}

#[test]
fn opening_existing_database_preserves_historical_execution_data() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("existing.db");
    let store = Store::open(&path).unwrap();
    let task = store.create(&new_task("Historical task")).unwrap();
    drop(store);
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute("UPDATE tasks SET attempts = 3 WHERE id = ?1", [task.id])
            .unwrap();
        conn.execute("INSERT INTO task_runs(task_id, agent, workdir, output) VALUES (?1, 'agent', '/work', 'historical output')", [task.id]).unwrap();
    }
    let store = Store::open(&path).unwrap();
    assert_eq!(store.get(task.id).unwrap().unwrap().attempts, 3);
    drop(store);
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT output FROM task_runs", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "historical output"
    );
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        7
    );
}

#[test]
fn github_content_is_owned_by_source_even_for_published_local_tasks() {
    let store = store();
    let task = store.create(&new_task("Original")).unwrap();
    let task = store
        .link_github(
            task.id,
            &shiori_tasuki::GithubLink {
                repo: "o/r".into(),
                number: 1,
                url: "https://github.com/o/r/issues/1".into(),
            },
        )
        .unwrap();
    for update in [
        TaskUpdate {
            title: Some("Changed".into()),
            ..Default::default()
        },
        TaskUpdate {
            description: Some("Changed".into()),
            ..Default::default()
        },
    ] {
        assert!(matches!(
            store.update(task.id, &update),
            Err(StoreError::ExternalContent)
        ));
        assert_eq!(store.get(task.id).unwrap().unwrap(), task);
    }
    let updated = store
        .update(
            task.id,
            &TaskUpdate {
                title: Some(task.title.clone()),
                description: Some(task.description),
                status: Some(Status::InProgress),
                assignee: Some("codex".into()),
            },
        )
        .unwrap();
    assert_eq!(updated.status, Status::InProgress);
    assert_eq!(updated.assignee.as_deref(), Some("codex"));
}
