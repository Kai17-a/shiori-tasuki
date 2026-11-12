//! GitHub integration through the `gh` CLI, which keeps authentication out of this program.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::Actor;
use crate::store::{IssueRecord, MAX_TITLE_CHARS, Scope, Store, StoreError, Upsert};
use crate::task::{GithubLink, Status, Task};

/// The most results GitHub's search API returns for one query.
const SEARCH_LIMIT: usize = 1000;

const ISSUE_QUERY: &str = r"query($q: String!, $cursor: String) {
  search(query: $q, type: ISSUE, first: 100, after: $cursor) {
    nodes { __typename ... on Issue {
      number title body state url repository { nameWithOwner } createdAt closedAt
      parent { number repository { nameWithOwner } }
    } }
    pageInfo { hasNextPage endCursor }
  }
}";

#[derive(Debug, Deserialize)]
struct Response {
    data: ResponseData,
    #[serde(default)]
    errors: Vec<serde_json::Value>,
}
#[derive(Debug, Deserialize)]
struct ResponseData {
    search: Search,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Search {
    nodes: Vec<serde_json::Value>,
    page_info: PageInfo,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    has_next_page: bool,
    end_cursor: Option<String>,
}

/// Failure of a single `gh` invocation.
#[derive(Debug, thiserror::Error)]
pub enum GhError {
    #[error("could not run gh (is the GitHub CLI installed and on PATH?): {0}")]
    Spawn(#[from] std::io::Error),
    #[error("gh failed: {0}")]
    Failed(String),
}

#[derive(Debug, thiserror::Error)]
pub enum GithubError {
    #[error(transparent)]
    Gh(#[from] GhError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("{0}")]
    Invalid(String),
    #[error("unexpected gh output: {0}")]
    Output(String),
}

/// Runs `gh` with the given arguments and returns its stdout.
///
/// A trait so tests can substitute a fake; the real implementation is [`GhCli`].
pub trait GhRunner {
    /// # Errors
    ///
    /// Fails when `gh` cannot be started or exits unsuccessfully.
    fn run(&self, args: &[String]) -> Result<String, GhError>;
}

/// Invokes the `gh` binary found on `PATH`, using its stored login.
#[derive(Debug, Clone, Copy, Default)]
pub struct GhCli;

/// Longest one `gh` call may take. A call that hangs (a stalled connection, a prompt)
/// would otherwise leave the sync running forever and keep the process from exiting.
const GH_TIMEOUT: Duration = Duration::from_secs(120);

impl GhRunner for GhCli {
    fn run(&self, args: &[String]) -> Result<String, GhError> {
        run_with_timeout(Command::new("gh").args(args), GH_TIMEOUT)
    }
}

/// Reads a child's pipe to its end on another thread.
fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            // Whatever arrived before a read error is still worth reporting.
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

/// Runs `command` to the end and returns its stdout, killing it after `timeout`.
fn run_with_timeout(command: &mut Command, timeout: Duration) -> Result<String, GhError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // Read both pipes while waiting, so a large reply never blocks the child.
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(GhError::Failed(format!(
                    "timed out after {} seconds",
                    timeout.as_secs()
                )));
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        Err(GhError::Failed(
            String::from_utf8_lossy(&stderr).trim().to_owned(),
        ))
    }
}

/// Counts of tasks changed by [`sync_issues`]; unchanged issues are not counted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
pub struct ImportReport {
    pub created: u32,
    pub updated: u32,
}

#[derive(Debug, Deserialize)]
struct Issue {
    number: u32,
    parent: Option<Parent>,
    title: String,
    #[serde(default)]
    body: String,
    state: String,
    url: String,
    repository: Repository,
    #[serde(rename = "createdAt")]
    created_at: Option<String>,
    #[serde(rename = "closedAt")]
    closed_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Parent {
    number: u32,
    repository: Repository,
}

#[derive(Debug, Deserialize)]
struct Repository {
    #[serde(rename = "nameWithOwner")]
    name_with_owner: String,
}

impl Issue {
    fn is_closed(&self) -> bool {
        self.state.eq_ignore_ascii_case("closed")
    }
}

/// Mirrors the signed-in `gh` user's issues, open or closed, preserving parent relations
/// between imported issues. Pull requests are not included.
///
/// Two searches decide what is the user's:
/// - issues the user wrote in repositories the account owns, except archived ones, since
///   personal repositories are the user's own work whether or not anyone is assigned;
/// - issues assigned to the user anywhere, including issues other people opened that the
///   user took on by assigning themselves.
///
/// Issues other people opened and nobody assigned to the user are left out: anyone can
/// open an issue in a public repository, and imported text reaches AI agents as a task.
///
/// Repositories the user chose to ignore ([`Store::ignore_repo`]) are skipped. Each
/// search returns its newest activity first, up to the 1000 results GitHub search
/// allows. Existing local progress is retained unless the issue closes or reopens, and
/// tasks whose issue no longer matches are kept.
///
/// # Errors
///
/// Fails when `gh` fails, its output is unexpected, or on storage errors.
pub fn sync_issues(
    store: &Store,
    gh: &(impl GhRunner + ?Sized),
) -> Result<ImportReport, GithubError> {
    let login = signed_in_login(gh)?;
    let mut issues = fetch_issues(
        gh,
        &format!("user:{login} author:{login} is:issue archived:false sort:updated-desc"),
    )?;
    let mut seen: HashSet<(String, u32)> = issues
        .iter()
        .map(|i| (i.repository.name_with_owner.clone(), i.number))
        .collect();
    for issue in fetch_issues(gh, "assignee:@me is:issue sort:updated-desc")? {
        if seen.insert((issue.repository.name_with_owner.clone(), issue.number)) {
            issues.push(issue);
        }
    }
    let ignored = store.ignored_repos()?;
    issues.retain(|issue| {
        !ignored
            .iter()
            .any(|r| r.eq_ignore_ascii_case(&issue.repository.name_with_owner))
    });
    let mut report = ImportReport::default();
    let mut outcomes = HashMap::new();
    for issue in &issues {
        let repo = issue.repository.name_with_owner.as_str();
        validate_repo(repo)?;
        let record = IssueRecord {
            link: GithubLink {
                repo: repo.to_owned(),
                number: issue.number,
                url: issue.url.clone(),
            },
            title: fit_title(&issue.title),
            body: &issue.body,
            closed: issue.is_closed(),
            created_at: issue.created_at.as_deref(),
            closed_at: issue.closed_at.as_deref(),
        };
        let outcome = store.upsert_github_issue(&record)?;
        outcomes.insert((repo.to_owned(), issue.number), outcome);
        match outcome {
            Upsert::Created => report.created += 1,
            Upsert::Updated => report.updated += 1,
            Upsert::Unchanged => {}
        }
    }
    let linked_updates = link_parents(store, &issues, &outcomes)?;
    report.updated += linked_updates;
    Ok(report)
}

/// The login of the account `gh` is signed in as, checked so it can go into a search.
fn signed_in_login(gh: &(impl GhRunner + ?Sized)) -> Result<String, GithubError> {
    let args = ["api", "user", "--jq", ".login"].map(str::to_owned);
    let login = gh.run(&args)?.trim().to_owned();
    let valid = !login.is_empty()
        && !login.starts_with('-')
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if valid {
        Ok(login)
    } else {
        Err(GithubError::Output(format!(
            "unexpected GitHub login {login:?}"
        )))
    }
}

/// Issues matching the GitHub search `query`, newest activity first, up to
/// [`SEARCH_LIMIT`]; repositories are validated before anything is stored.
fn fetch_issues(gh: &(impl GhRunner + ?Sized), query: &str) -> Result<Vec<Issue>, GithubError> {
    let mut issues = Vec::new();
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    loop {
        let mut args = vec![
            "api".into(),
            "graphql".into(),
            "-f".into(),
            format!("query={ISSUE_QUERY}"),
            "-f".into(),
            format!("q={query}"),
        ];
        if let Some(cursor) = &cursor {
            args.extend(["-f".into(), format!("cursor={cursor}")]);
        }
        let response: Response = serde_json::from_str(&gh.run(&args)?)
            .map_err(|e| GithubError::Output(e.to_string()))?;
        if !response.errors.is_empty() {
            let messages: Vec<&str> = response
                .errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()))
                .take(3)
                .collect();
            let detail = if messages.is_empty() {
                "(no message)".to_owned()
            } else {
                messages.join("; ")
            };
            return Err(GithubError::Output(format!(
                "GraphQL returned errors: {detail}"
            )));
        }
        for node in response.data.search.nodes {
            if node.is_null()
                || node
                    .get("__typename")
                    .and_then(|n| n.as_str())
                    .is_some_and(|n| n != "Issue")
            {
                continue;
            }
            let issue: Issue =
                serde_json::from_value(node).map_err(|e| GithubError::Output(e.to_string()))?;
            validate_repo(&issue.repository.name_with_owner)?;
            if let Some(parent) = &issue.parent {
                validate_repo(&parent.repository.name_with_owner)?;
            }
            issues.push(issue);
            if issues.len() == SEARCH_LIMIT {
                break;
            }
        }
        let page = response.data.search.page_info;
        if !page.has_next_page || issues.len() == SEARCH_LIMIT {
            break;
        }
        let next = page
            .end_cursor
            .filter(|c| !c.is_empty())
            .ok_or_else(|| GithubError::Output("missing pagination cursor".into()))?;
        if !seen_cursors.insert(next.clone()) {
            return Err(GithubError::Output("repeated pagination cursor".into()));
        }
        cursor = Some(next);
    }

    Ok(issues)
}

/// Mirrors parent relations between imported issues and returns how many tasks whose
/// issue was otherwise unchanged got a new parent.
fn link_parents(
    store: &Store,
    issues: &[Issue],
    outcomes: &HashMap<(String, u32), Upsert>,
) -> Result<u32, GithubError> {
    let mut linked_updates = HashSet::new();
    // A former ancestor may move below its child. Retry deferred cycle checks after
    // other edges have moved, so stale relations cannot make the result order matter.
    // Bounded passes: a cycle the checks cannot settle must not loop forever.
    for _ in 0..=issues.len() {
        let mut changed = false;
        for issue in issues {
            let task = store
                .find_by_github(&issue.repository.name_with_owner, issue.number)?
                .ok_or_else(|| GithubError::Output("imported task disappeared".into()))?;
            let parent = match &issue.parent {
                Some(parent) => {
                    store.find_by_github(&parent.repository.name_with_owner, parent.number)?
                }
                None => None,
            };
            if store.sync_github_parent(task.id, parent.as_ref().map(|p| p.id))? {
                changed = true;
                if outcomes.get(&(issue.repository.name_with_owner.clone(), issue.number))
                    == Some(&Upsert::Unchanged)
                {
                    linked_updates.insert(task.id);
                }
            }
        }
        if !changed {
            break;
        }
    }
    // At most SEARCH_LIMIT issues, so the count always fits.
    Ok(u32::try_from(linked_updates.len()).unwrap_or(u32::MAX))
}

/// Creates a GitHub issue assigned to the signed-in user from a local task and links
/// the two, so later syncs keep it up to date. The task's history records that `actor`
/// published it.
///
/// The issue body is the task description followed by its subtasks as a checklist.
///
/// # Errors
///
/// Fails when the task is missing or already linked, the repository is invalid, or
/// `gh` fails.
pub fn push_task(
    store: &Store,
    gh: &(impl GhRunner + ?Sized),
    id: i64,
    repo: &str,
    actor: &Actor,
) -> Result<Task, GithubError> {
    validate_repo(repo)?;
    let task = store.get(id)?.ok_or(StoreError::NotFound(id))?;
    if let Some(link) = &task.github {
        return Err(GithubError::Invalid(format!(
            "task {id} is already linked to {}#{}",
            link.repo, link.number
        )));
    }
    let body = issue_body(&task, &store.list(Scope::ChildrenOf(id))?);
    let args = [
        "issue",
        "create",
        "--repo",
        repo,
        "--assignee",
        "@me",
        "--title",
        &task.title,
        "--body",
        &body,
    ]
    .map(str::to_owned);
    let url = gh.run(&args)?.trim().to_owned();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| GithubError::Output(format!("expected an issue URL, got {url:?}")))?;
    Ok(store.link_github_as(
        id,
        &GithubLink {
            repo: repo.to_owned(),
            number,
            url,
        },
        actor,
    )?)
}

/// Shortens an issue title to the task limit, marking the cut with an ellipsis.
fn fit_title(title: &str) -> String {
    let title = title.trim();
    if title.chars().count() <= MAX_TITLE_CHARS {
        return title.to_owned();
    }
    let mut short: String = title.chars().take(MAX_TITLE_CHARS - 1).collect();
    short.push('…');
    short
}

fn issue_body(task: &Task, subtasks: &[Task]) -> String {
    let mut body = task.description.clone();
    if !subtasks.is_empty() {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str("## Subtasks\n\n");
        for sub in subtasks {
            let mark = if sub.status == Status::Done { 'x' } else { ' ' };
            let _ = writeln!(body, "- [{mark}] {}", sub.title);
        }
    }
    body
}

/// Accepts only `owner/name` made of the characters GitHub allows, so the value can
/// never be mistaken for a `gh` flag.
///
/// # Errors
///
/// Returns [`GithubError::Invalid`] for anything else.
pub fn validate_repo(repo: &str) -> Result<(), GithubError> {
    let valid_part = |part: &str| {
        !part.is_empty()
            && !part.starts_with(['-', '.'])
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    match repo.split_once('/') {
        Some((owner, name)) if valid_part(owner) && valid_part(name) => Ok(()),
        _ => Err(GithubError::Invalid(format!(
            "repository must look like owner/name, got {repo:?}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::{Command, Duration, GhError, run_with_timeout};

    #[cfg(unix)]
    #[test]
    fn a_command_that_hangs_is_stopped() {
        let err = run_with_timeout(Command::new("sleep").arg("30"), Duration::from_millis(100))
            .unwrap_err();
        assert!(
            matches!(&err, GhError::Failed(m) if m.contains("timed out")),
            "got {err:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn output_and_failures_are_reported() {
        let out = run_with_timeout(
            Command::new("sh").args(["-c", "echo hello"]),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(out, "hello\n");
        let err = run_with_timeout(
            Command::new("sh").args(["-c", "echo broken >&2; exit 3"]),
            Duration::from_secs(10),
        )
        .unwrap_err();
        assert!(
            matches!(&err, GhError::Failed(m) if m == "broken"),
            "got {err:?}"
        );
    }
}
