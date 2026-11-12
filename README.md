# shiori-tasuki

AI エージェントに作業を頼むための個人用タスク管理アプリ。AI は頼まれたタスクだけを進めて報告し、ユーザーが承認するまで完了にならない。

コマンドは `stk`。ダッシュボード、MCP サーバー、GitHub Issue 連携、CLI を含む。

## インストール

```sh
mise use -g github:Kai17-a/shiori-tasuki
```

ソースから入れる場合:

```sh
cargo install --path .
```

GitHub 連携には `gh auth login` 済みの [GitHub CLI](https://cli.github.com/) が必要。

## 使い方

### ダッシュボード

```sh
stk serve   # http://127.0.0.1:7878/
```

### AI に頼む

MCP サーバーとして登録する。

```sh
claude mcp add --scope user shiori-tasuki -- /path/to/stk mcp
```

agent skill は `skills/shiori-tasuki/` にある。

```sh
gh skill install Kai17-a/shiori-tasuki shiori-tasuki --agent claude-code --scope user
```

「shiori-tasuki の #12 をやって」と頼むと、AI は作業して「確認中」として報告する。承認と差し戻しはダッシュボードか会話で行う。

MCP を使わない AI には `stk guide` で手順を渡す。Claude Code・Codex・Gemini CLI・Cursor は自動で見分ける。それ以外の AI は `--as 名前` を付ける。

### CLI

```sh
stk create '認証機能を追加' --body 'GitHub OAuth でログイン'
stk list --status todo
stk view 12
stk done 12 --summary '実装し、cargo test で確認した'
stk approve 12
```

コマンドの一覧は `stk --help`。`--json` で JSON を出力する。

## GitHub 連携

`serve` と `mcp` は、起動時と 5 分ごとに次の Issue を取り込む。同じ DB を使うプロセスが複数あっても、取り込みは全体で 5 分に 1 回になる。

- 自分のリポジトリで、自分が作った Issue
- 自分が担当の Issue

取り込みから外すリポジトリは、設定画面か `stk gh ignore add OWNER/NAME` で指定する。外したリポジトリの取り込み済みタスクは削除される。

取り込んだタスクの題名と説明は GitHub で編集する。

`stk gh push 12 owner/name` でタスクから Issue を作る。

## データ

SQLite の `~/.local/share/shiori-tasuki/tasks.db` に保存する（`XDG_DATA_HOME` があればその下）。`--db` か `SHIORI_TASUKI_DB` で変更できる。ダッシュボードと MCP には同じ DB を指定する。

ダッシュボードの API には認証がない。既定の待ち受けは `127.0.0.1` で、変えずに使う。

## 開発

```sh
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
```

リリースは、`Cargo.toml` の `version` と同じタグ（例: `v0.1.0`）を push する。GitHub Actions が Linux・Windows 向けにビルドして GitHub Release に載せる。
