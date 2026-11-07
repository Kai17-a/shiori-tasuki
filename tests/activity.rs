use shiori_tasuki::activity::EventKind;
use shiori_tasuki::{
    Actor, NewSubtask, NewTask, ReviewDecision, Status, Store, StoreError, TaskUpdate,
};

fn store() -> Store {
    Store::open_in_memory().expect("in-memory store opens")
}

fn task(store: &Store, title: &str) -> shiori_tasuki::Task {
    store
        .create(&NewTask {
            title: title.into(),
            ..NewTask::default()
        })
        .expect("test task is created")
}

fn status(s: Status) -> TaskUpdate {
    TaskUpdate {
        status: Some(s),
        ..TaskUpdate::default()
    }
}

#[test]
fn records_who_created_and_changed_a_task() {
    let store = store();
    let t = task(&store, "Write report");

    store
        .update_as(
            t.id,
            &status(Status::InProgress),
            &Actor::from("claude-code"),
        )
        .unwrap();
    store
        .update_as(
            t.id,
            &TaskUpdate {
                title: Some("Write the report".into()),
                ..TaskUpdate::default()
            },
            &Actor::from("user"),
        )
        .unwrap();

    let events = store.events_for(t.id, 10).unwrap();
    let summary: Vec<_> = events.iter().map(|e| (e.kind, e.actor.as_str())).collect();
    assert_eq!(
        summary,
        vec![
            (EventKind::Updated, "user"),
            (EventKind::Status, "claude-code"),
            (EventKind::Created, "user"),
        ],
        "newest first"
    );
    let moved = &events[1];
    assert_eq!(
        (moved.from_status, moved.to_status),
        (Some(Status::Todo), Some(Status::InProgress))
    );
    assert_eq!(moved.task_title, "Write the report");
}

#[test]
fn an_update_that_changes_nothing_records_nothing() {
    let store = store();
    let t = task(&store, "Same");
    store
        .update_as(t.id, &status(Status::Todo), &Actor::from("user"))
        .unwrap();
    assert_eq!(store.events_for(t.id, 10).unwrap().len(), 1, "only created");
}

#[test]
fn assigns_and_clears_the_assignee() {
    let store = store();
    let t = task(&store, "Fix bug");

    let assigned = store
        .update_as(
            t.id,
            &TaskUpdate {
                assignee: Some("codex".into()),
                ..TaskUpdate::default()
            },
            &Actor::from("codex"),
        )
        .unwrap();
    assert_eq!(assigned.assignee.as_deref(), Some("codex"));

    let cleared = store
        .update_as(
            t.id,
            &TaskUpdate {
                assignee: Some(String::new()),
                ..TaskUpdate::default()
            },
            &Actor::from("user"),
        )
        .unwrap();
    assert!(cleared.assignee.is_none());
    let kinds: Vec<_> = store
        .events_for(t.id, 10)
        .unwrap()
        .iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(
        kinds,
        vec![EventKind::Assigned, EventKind::Assigned, EventKind::Created]
    );
}

#[test]
fn notes_are_validated_and_recorded() {
    let store = store();
    let t = task(&store, "Investigate");

    let note = store
        .add_note(
            t.id,
            &Actor::from("claude-code"),
            "  3 tests fail in auth  ",
        )
        .unwrap();
    assert_eq!(note.kind, EventKind::Note);
    assert_eq!(note.message, "3 tests fail in auth");

    assert!(matches!(
        store
            .add_note(t.id, &Actor::from("user"), "   ")
            .unwrap_err(),
        StoreError::Invalid(_)
    ));
    assert!(matches!(
        store.add_note(404, &Actor::from("user"), "hi").unwrap_err(),
        StoreError::NotFound(404)
    ));
}

#[test]
fn splitting_a_task_is_recorded_on_the_parent_and_each_child() {
    let store = store();
    let parent = task(&store, "Release");
    let kids = store
        .create_subtasks(
            parent.id,
            &[
                NewSubtask {
                    title: "a".into(),
                    description: String::new(),
                },
                NewSubtask {
                    title: "b".into(),
                    description: String::new(),
                },
            ],
            &Actor::from("claude-code"),
        )
        .unwrap();

    let parent_events = store.events_for(parent.id, 10).unwrap();
    assert_eq!(parent_events[0].kind, EventKind::Split);
    assert_eq!(parent_events[0].actor, "claude-code");
    assert!(parent_events[0].message.contains('2'));
    assert_eq!(
        store.events_for(kids[0].id, 10).unwrap()[0].kind,
        EventKind::Created
    );
}

#[test]
fn activity_feed_pages_backwards_and_reports_the_latest_id() {
    let store = store();
    let a = task(&store, "A");
    let b = task(&store, "B");
    store
        .add_note(a.id, &Actor::from("codex"), "progress")
        .unwrap();

    let latest = store.latest_event_id().unwrap();
    let page = store.activity(2, None).unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].id, latest);
    assert_eq!(page[0].message, "progress");
    assert_eq!(page[1].task_id, b.id);

    let older = store.activity(10, Some(page[1].id)).unwrap();
    assert_eq!(older.len(), 1);
    assert_eq!(older[0].task_id, a.id);
}

#[test]
fn hiding_a_task_keeps_its_history() {
    let store = store();
    let t = task(&store, "Temp");
    store.add_note(t.id, &Actor::from("user"), "x").unwrap();
    store.hide(t.id, &Actor::User).unwrap();
    let notes: Vec<_> = store
        .events_for(t.id, 10)
        .unwrap()
        .into_iter()
        .map(|e| e.message)
        .collect();
    assert!(notes.contains(&"x".to_owned()), "{notes:?}");
}

#[test]
fn summarises_agents_and_stalled_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("tasks.db");
    let store = Store::open(&path).unwrap();
    let busy = task(&store, "Busy");
    let stuck = task(&store, "Stuck");
    let finished = task(&store, "Finished");
    store
        .start_task(busy.id, &Actor::from("claude-code"), None)
        .unwrap();
    store
        .start_task(stuck.id, &Actor::from("codex"), None)
        .unwrap();
    store
        .start_task(finished.id, &Actor::from("claude-code"), None)
        .unwrap();
    store
        .complete_task(finished.id, &Actor::from("claude-code"), "Verified")
        .unwrap();
    store
        .review_task(
            finished.id,
            &Actor::from("user"),
            ReviewDecision::Approve,
            "",
        )
        .unwrap();
    // Make the "stuck" task look untouched for three hours.
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute(
            "UPDATE task_events SET created_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours')
             WHERE task_id = ?1",
            [stuck.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE tasks SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 hours')
             WHERE id = ?1",
            [stuck.id],
        )
        .unwrap();
    }

    let stats = store.stats().unwrap();

    assert_eq!(stats.completed_today, 1);
    let stalled: Vec<_> = stats.stalled.iter().map(|t| t.id).collect();
    assert_eq!(stalled, vec![stuck.id]);

    let claude = stats
        .agents
        .iter()
        .find(|a| a.name == "claude-code")
        .expect("claude-code is listed");
    assert_eq!((claude.working, claude.done_today), (1, 1));
    let codex = stats.agents.iter().find(|a| a.name == "codex").unwrap();
    assert_eq!((codex.working, codex.stalled), (1, 1));
    assert!(
        stats
            .agents
            .iter()
            .all(|a| a.name != "user" && a.name != "github"),
        "people and the GitHub sync are not agents"
    );

    let busy_task = store.get(busy.id).unwrap().unwrap();
    assert_eq!(busy_task.assignee.as_deref(), Some("claude-code"));
    assert!(!busy_task.last_activity_at.is_empty());
}

#[test]
fn work_finished_by_the_user_counts_as_done_for_the_assigned_agent() {
    let store = store();
    let t = task(&store, "Upgrade deps");
    store
        .start_task(t.id, &Actor::from("claude-code"), None)
        .unwrap();
    // A person can finish work that was assigned to an agent.
    store
        .update_as(t.id, &status(Status::Done), &Actor::from("user"))
        .unwrap();

    let stats = store.stats().unwrap();
    let claude = stats
        .agents
        .iter()
        .find(|a| a.name == "claude-code")
        .unwrap();
    assert_eq!((claude.working, claude.done_today), (0, 1));
    assert!(
        stats.agents.iter().all(|a| a.name != "user"),
        "the user is not an agent"
    );
}
