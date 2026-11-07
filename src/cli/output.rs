use std::io::{self, IsTerminal, Write};

use anyhow::{Result, bail};
use serde_json::{Map, Value};

use super::{Command, GhCommand, IgnoreCommand};

const TASK_FIELDS: &str = "id,parent_id,title,description,status,created_by,github,subtasks,created_at,updated_at,completed_at,assignee,last_activity_at,workdir,attempts,hidden_at";
const EVENT_FIELDS: &str =
    "id,task_id,task_title,actor,kind,message,from_status,to_status,created_at";

/// How plain-text output is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Layout {
    /// Padded columns and headings for a person at a terminal.
    Aligned,
    /// One tab-separated record per line for scripts and pipes.
    Tabs,
}

fn fields(command: &Command) -> &'static str {
    match command {
        Command::View { .. } => "task,subtasks,history,sessions",
        Command::Note { .. } | Command::Activity { .. } => EVENT_FIELDS,
        Command::Link { .. } => "sessions",
        Command::Guide => "instructions",
        Command::Stats => {
            "total,by_status,completed_last_7_days,daily,by_repo,by_creator,recent,with_subtasks,completed_today,stalled,agents,stall_after_secs,awaiting_review"
        }
        Command::Serve { .. } | Command::Mcp => "",
        Command::Gh(GhCommand::Ignore(IgnoreCommand::Add { .. })) => "repo,deleted",
        Command::Gh(GhCommand::Ignore(IgnoreCommand::Remove { .. })) => "repo,removed",
        Command::Gh(GhCommand::Ignore(IgnoreCommand::List)) => "ignored_repos",
        _ => TASK_FIELDS,
    }
}

pub(super) fn validate(json: Option<&str>, command: &Command) -> Result<()> {
    let Some(selection) = json else {
        return Ok(());
    };
    let valid = fields(command);
    if valid.is_empty() {
        bail!("--json is not available for serve or mcp");
    }
    for field in selection.split(',').filter(|_| !selection.is_empty()) {
        if !valid.split(',').any(|v| v == field) {
            bail!(
                "unknown JSON field {field:?}; valid fields: {}",
                valid.replace(',', ", ")
            );
        }
    }
    Ok(())
}

pub(super) fn print(value: &Value, json: Option<&str>, command: &Command) -> Result<()> {
    let stdout = io::stdout();
    let layout = if stdout.is_terminal() {
        Layout::Aligned
    } else {
        Layout::Tabs
    };
    let mut out = stdout.lock();
    if let Some(selection) = json {
        let selected = if selection.is_empty() {
            value.clone()
        } else {
            select(value, selection)
        };
        serde_json::to_writer_pretty(&mut out, &selected)?;
        writeln!(out)?;
        return Ok(());
    }
    match command {
        Command::Guide => writeln!(
            out,
            "{}",
            value["instructions"].as_str().unwrap_or_default()
        )?,
        Command::View { .. } => {
            tasks(&mut out, &[&value["task"]], layout)?;
            if layout == Layout::Aligned {
                writeln!(
                    out,
                    "\nDescription:\n{}\nWorkdir: {}",
                    value["task"]["description"].as_str().unwrap_or_default(),
                    value["task"]["workdir"].as_str().unwrap_or_default()
                )?;
            } else {
                writeln!(out, "description\t{}", cell(&value["task"]["description"]))?;
                writeln!(out, "workdir\t{}", cell(&value["task"]["workdir"]))?;
            }
            if !value["task"]["github"].is_null() {
                writeln!(out, "github\t{}", cell(&value["task"]["github"]["url"]))?;
            }
            if layout == Layout::Aligned {
                writeln!(out, "\nSubtasks:")?;
            }
            tasks(&mut out, &items(&value["subtasks"]), layout)?;
            if layout == Layout::Aligned {
                writeln!(out, "\nHistory:")?;
            }
            events(&mut out, &items(&value["history"]), layout)?;
            writeln!(
                out,
                "\nAI の作業記録:\n{}",
                serde_json::to_string_pretty(&value["sessions"])?
            )?;
        }
        Command::Link { .. } => {
            writeln!(out, "{}", serde_json::to_string_pretty(&value["sessions"])?)?;
        }
        Command::Note { .. } | Command::Activity { .. } => {
            events(&mut out, &items(value), layout)?;
        }
        Command::Stats => {
            let rows: Vec<Vec<String>> = value
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| vec![k.clone(), cell(v)])
                .collect();
            table(&mut out, &rows, layout)?;
        }
        Command::Gh(GhCommand::Ignore(command)) => ignored(&mut out, command, value, layout)?,
        _ => tasks(&mut out, &items(value), layout)?,
    }
    Ok(())
}

/// Plain-text result of `gh ignore add`, `remove` and `list`.
fn ignored(
    out: &mut impl Write,
    command: &IgnoreCommand,
    value: &Value,
    layout: Layout,
) -> Result<()> {
    match command {
        IgnoreCommand::Add { .. } if layout == Layout::Aligned => writeln!(
            out,
            "Ignoring {}; deleted {} imported tasks",
            cell(&value["repo"]),
            value["deleted"]
        )?,
        IgnoreCommand::Add { .. } => {
            writeln!(
                out,
                "{}\tignored\t{}",
                cell(&value["repo"]),
                value["deleted"]
            )?;
        }
        IgnoreCommand::Remove { .. } => {
            let state = if value["removed"] == true {
                "imported again"
            } else {
                "was not ignored"
            };
            writeln!(out, "{}\t{state}", cell(&value["repo"]))?;
        }
        IgnoreCommand::List => {
            for repo in items(&value["ignored_repos"]) {
                writeln!(out, "{}", cell(repo))?;
            }
        }
    }
    Ok(())
}

fn select(value: &Value, selection: &str) -> Value {
    if let Value::Array(values) = value {
        return Value::Array(values.iter().map(|v| select(v, selection)).collect());
    }
    Value::Object(
        selection
            .split(',')
            .map(|key| (key.to_owned(), value[key].clone()))
            .collect::<Map<_, _>>(),
    )
}

fn items(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(values) => values.iter().collect(),
        _ => vec![value],
    }
}

// Keep every record on one line, including user-provided multiline text.
fn cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s
            .replace('\\', "\\\\")
            .replace('\t', "\\t")
            .replace('\r', "\\r")
            .replace('\n', "\\n"),
        _ => value.to_string(),
    }
}

fn tasks(out: &mut impl Write, values: &[&Value], layout: Layout) -> Result<()> {
    let rows: Vec<Vec<String>> = values
        .iter()
        .map(|v| {
            ["id", "status", "title", "assignee"]
                .map(|k| cell(&v[k]))
                .to_vec()
        })
        .collect();
    table(out, &rows, layout)
}

fn events(out: &mut impl Write, values: &[&Value], layout: Layout) -> Result<()> {
    let rows: Vec<Vec<String>> = values
        .iter()
        .map(|v| {
            [
                "created_at",
                "actor",
                "kind",
                "task_id",
                "message",
                "from_status",
                "to_status",
            ]
            .map(|k| cell(&v[k]))
            .to_vec()
        })
        .collect();
    table(out, &rows, layout)
}

fn table(out: &mut impl Write, rows: &[Vec<String>], layout: Layout) -> Result<()> {
    if layout == Layout::Tabs {
        for row in rows {
            writeln!(out, "{}", row.join("\t"))?;
        }
        return Ok(());
    }
    let columns = rows.first().map_or(0, Vec::len);
    let widths: Vec<usize> = (0..columns)
        .map(|i| {
            rows.iter()
                .map(|row| row[i].chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    for row in rows {
        for (i, value) in row.iter().enumerate() {
            write!(out, "{value}")?;
            if i + 1 < columns {
                write!(out, "{}", " ".repeat(widths[i] - value.chars().count() + 2))?;
            }
        }
        writeln!(out)?;
    }
    Ok(())
}
