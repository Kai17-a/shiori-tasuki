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
    fn read(mut input: impl Read) -> String {
        let mut bytes = Vec::new();
        let mut buf = [0; 8192];
        while let Ok(n) = input.read(&mut buf) {
            if n == 0 {
                break;
            }
            let keep = n.min(131072usize.saturating_sub(bytes.len()));
            bytes.extend_from_slice(&buf[..keep]);
        }
        String::from_utf8_lossy(&bytes).trim().to_owned()
    }
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
            "-101",
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
    fn lines(s: String, truncated: &mut bool) -> Vec<String> {
        let all: Vec<_> = s.lines().map(str::to_owned).collect();
        *truncated |= all.len() > 100 || s.len() >= 131000;
        all.into_iter().take(100).collect()
    }
    g.commits = lines(commits, &mut g.truncated);
    g.files = lines(files, &mut g.truncated);
    g.uncommitted = lines(uncommitted, &mut g.truncated);
    g.untracked = lines(untracked, &mut g.truncated);
    Some(g)
}
