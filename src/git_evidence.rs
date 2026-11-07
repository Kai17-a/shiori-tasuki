//! Best-effort, bounded git evidence collected without a shell.
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Snapshot of repository identity and changes (lists are capped at 100 entries).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct GitEvidence {
    pub branch: String,
    pub head: Option<String>,
    pub commits: Vec<String>,
    pub files: Vec<String>,
    pub uncommitted: Vec<String>,
    pub untracked: Vec<String>,
    pub errors: Vec<String>,
    pub truncated: bool,
}

/// Most bytes kept from one git command's output.
const OUTPUT_LIMIT: usize = 128 * 1024;
/// Most entries kept in each evidence list.
const LIST_LIMIT: usize = 100;

/// Drains the whole pipe so git never blocks on a full buffer, keeping only the first
/// [`OUTPUT_LIMIT`] bytes.
fn read(mut input: impl Read) -> String {
    let mut bytes = Vec::new();
    let mut buf = [0; 8192];
    loop {
        match input.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let keep = n.min(OUTPUT_LIMIT.saturating_sub(bytes.len()));
                bytes.extend_from_slice(&buf[..keep]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    String::from_utf8_lossy(&bytes).trim().to_owned()
}

fn git(dir: &str, args: &[&str]) -> Result<String, String> {
    // Evidence is read-only: keep repository config from starting other programs
    // (fsmonitor hooks, external diff drivers, textconv filters).
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "core.fsmonitor=false", "-c", "diff.external="])
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;
    let out = std::thread::spawn(move || read(stdout));
    let err = std::thread::spawn(move || read(stderr));
    let deadline = Instant::now() + Duration::from_secs(2);
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err("git timed out or could not be waited for".to_owned());
            }
        }
    };
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    if status?.success() {
        Ok(stdout)
    } else {
        Err(stderr)
    }
}
/// The first [`LIST_LIMIT`] lines of `s`, marking `truncated` when lines or bytes were cut.
fn lines(s: &str, truncated: &mut bool) -> Vec<String> {
    // Output cut at OUTPUT_LIMIT may lose a little trailing space to trim().
    *truncated |= s.lines().count() > LIST_LIMIT || s.len() + 128 >= OUTPUT_LIMIT;
    s.lines().take(LIST_LIMIT).map(str::to_owned).collect()
}

/// Captures a repository, returning no evidence for a non-repository folder.
pub fn capture(workdir: Option<&str>, start: Option<&str>) -> Option<GitEvidence> {
    let dir = workdir?;
    if let Err(error) = git(dir, &["rev-parse", "--is-inside-work-tree"]) {
        if error.contains("not a git repository") {
            return None;
        }
        return Some(GitEvidence {
            errors: vec![error],
            ..GitEvidence::default()
        });
    }
    let mut g = GitEvidence::default();
    let mut run = |args: &[&str]| match git(dir, args) {
        Ok(v) => v,
        Err(e) => {
            g.errors.push(e);
            String::new()
        }
    };
    g.branch = run(&["branch", "--show-current"]);
    g.head = Some(run(&["rev-parse", "--verify", "HEAD"])).filter(|s| !s.is_empty());
    let commits = if let Some(start) = start {
        run(&[
            "log",
            "-101", // one more than LIST_LIMIT, so a longer log is marked truncated
            "--format=%H %s",
            &format!("{start}..HEAD"),
            "--",
        ])
    } else {
        String::new()
    };
    let files = if let Some(start) = start {
        run(&[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--numstat",
            &format!("{start}..HEAD"),
            "--",
        ])
    } else {
        String::new()
    };
    let uncommitted = run(&[
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--numstat",
        "HEAD",
        "--",
    ]);
    let untracked = run(&["ls-files", "--others", "--exclude-standard"]);
    g.commits = lines(&commits, &mut g.truncated);
    g.files = lines(&files, &mut g.truncated);
    g.uncommitted = lines(&uncommitted, &mut g.truncated);
    g.untracked = lines(&untracked, &mut g.truncated);
    Some(g)
}
