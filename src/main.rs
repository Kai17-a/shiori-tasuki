mod cli;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Context, Result};
use clap::Parser;
use shiori_tasuki::Store;
use shiori_tasuki::github::{GhCli, GhRunner};
use shiori_tasuki::mcp::McpServer;
use shiori_tasuki::sync::Syncer;
use shiori_tasuki::web::{self, AppState, HostPolicy};

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let cli = match cli::Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => {
            let code = i32::from(error.use_stderr());
            error.print()?;
            std::process::exit(code);
        }
    };
    cli.validate_output()?;
    if matches!(cli.command, cli::Command::Guide) {
        return cli.print_guide();
    }
    let db = cli.database()?;
    let store = Store::open(&db).with_context(|| format!("opening database {}", db.display()))?;
    match cli.command {
        cli::Command::Serve { addr } => serve(store, addr, &db, cli.repo).await?,
        cli::Command::Mcp => {
            let gh: Arc<dyn GhRunner + Send + Sync> = Arc::new(GhCli);
            Syncer::new(store.clone(), Arc::clone(&gh)).spawn();
            let server = McpServer::new(store, gh, cli.repo);
            tokio::task::spawn_blocking(move || server.serve_stdio()).await??;
        }
        _ => cli.execute(&store)?,
    }
    Ok(())
}

async fn serve(store: Store, addr: SocketAddr, db: &Path, repo: Option<String>) -> Result<()> {
    let hosts = if addr.ip().is_loopback() {
        HostPolicy::LoopbackOnly
    } else {
        eprintln!(
            "warning: listening on {addr}; the API has no login, so anyone who can reach it can change tasks"
        );
        HostPolicy::Any
    };
    let gh: Arc<dyn GhRunner + Send + Sync> = Arc::new(GhCli);
    let sync = Syncer::new(store.clone(), gh);
    sync.clone().spawn();
    let state = AppState {
        sync,
        store,
        mcp_command: Some(mcp_command(db, repo.as_deref())),
        hosts,
    };
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .with_context(|| format!("listening on {addr}"))?;
    println!("shiori-tasuki admin page: http://{addr}/");
    axum::serve(listener, web::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

/// The `claude mcp add` command that points an agent at this database.
///
/// User scope makes the server available from any folder, which matters for tools such as
/// T3 Code that run each session in its own working directory.
fn mcp_command(db: &Path, repo: Option<&str>) -> String {
    let exe = std::env::current_exe().map_or_else(|_| "stk".into(), |p| p.display().to_string());
    let db = std::path::absolute(db).unwrap_or_else(|_| db.to_path_buf());
    let repo = repo.map_or_else(String::new, |r| format!(" --repo {}", shell_quote(r)));
    format!(
        "claude mcp add --scope user shiori-tasuki -- {} --db {}{repo} mcp",
        shell_quote(&exe),
        shell_quote(&db.display().to_string())
    )
}

fn shell_quote(value: &str) -> String {
    let safe = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "/._-:=@+".contains(c));
    if safe && !value.is_empty() {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', r"'\''"))
    }
}
