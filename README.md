# shiori-tasuki

自分のタスクを 1 か所にまとめ、その中から AI エージェントに作業を頼むためのタスク管理アプリ。AI は頼まれたタスクだけを進め、何をしたかを記録して報告する。報告された作業は、自分で確認して承認するまで完了にならない。

コマンドは `stk`。1 つのバイナリに次の機能が入っている。

- ブラウザで使うダッシュボード
- AI エージェント向けの MCP サーバー
- GitHub Issue の取り込みと作成
- コマンドライン（CLI）

## インストール

[mise](https://mise.jdx.dev/) で、リリースのビルド済みのバイナリを入れる。

```sh
mise use -g github:Kai17-a/shiori-tasuki
```

ソースからビルドするときは次のとおり。

```sh
cargo install --path .
```

GitHub と連携するには、`gh auth login` 済みの [GitHub CLI](https://cli.github.com/) が必要。

## 使い方

### ダッシュボード

```sh
stk serve   # http://127.0.0.1:7878/ を開く
```

タスクの登録・編集と、ボードでの状態の整理ができる。AI の作業中のタスク、確認待ちのタスク、作業の記録もここで確かめる。

### AI に頼む

Claude Code に MCP サーバーとして登録する。

```sh
claude mcp add --scope user shiori-tasuki -- /path/to/stk mcp
```

登録したら、新しいセッションを開いて「shiori-tasuki の #12 をやって」と頼む。AI は次の流れで進める。

1. タスクと過去の履歴（差し戻しの理由を含む）を読む
2. 着手を記録し、必要なら子タスクに分ける
3. 経過をメモに残す
4. やったことと確かめた方法を報告する。タスクは「確認中」になる

報告を確かめたら、ダッシュボードで承認するか、理由を付けて差し戻す。会話で「OK」や「ここを直して」と伝えても、AI がその言葉を引用して記録する。

Git リポジトリで作業した場合は、ブランチ、コミット、変更したファイルも自動で記録する。

Codex など、MCP を使わずに CLI で操作する AI には、`stk guide` で同じ手順を示せる。Codex は `--as codex` を付けて実行する。

AI に作業の進め方を教える agent skill も、このリポジトリの `skills/shiori-tasuki/` にある。[GitHub CLI](https://cli.github.com/) で入れる。

```sh
gh skill install Kai17-a/shiori-tasuki shiori-tasuki --agent claude-code --scope user
```

Codex には `--agent codex` を指定する。

### CLI

```sh
stk create '認証機能を追加' --body 'GitHub OAuth でログイン'
stk list --status todo
stk view 12
stk done 12 --summary '実装し、cargo test で確認した'
stk approve 12
```

すべてのコマンドは `stk --help` で確認できる。`--json` を付けると JSON で出力する。

## GitHub 連携

`serve` と `mcp` は起動したときと 5 分ごとに、次の Issue をタスクとして取り込む。

- 自分のリポジトリで、自分が作った Issue
- 自分が担当の Issue（リポジトリは問わない）

他の人が立てて、自分が担当でない Issue は取り込まない。取り込んだ本文は AI にも渡るため、他人が書いた指示が AI に届かないようにしている。

取り込みたくないリポジトリは設定画面か `stk gh ignore add OWNER/NAME` で外せる。外すと、そのリポジトリから取り込み済みのタスクは削除される。

取り込んだタスクの題名と説明は GitHub で編集する。状態、メモ、子タスクはこのアプリで管理する。

`stk gh push 12 owner/name` で、タスクから Issue を作ることもできる。

## データの保存先

データは SQLite で `~/.local/share/shiori-tasuki/tasks.db`（`XDG_DATA_HOME` があればその下）に保存する。別の場所を使うときは `--db` か環境変数 `SHIORI_TASUKI_DB` で指定する。ダッシュボードと MCP には同じ場所を指定すること。

## API のログイン

ダッシュボードの API にはログインがない。既定では `127.0.0.1` だけで待ち受けるので、このアドレスのまま使うこと。

## 開発

```sh
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
```

リリースするときは、`Cargo.toml` の `version` を上げてから、同じ版のタグ（例: `v0.1.0`）を push する。GitHub Actions が Linux・Windows 向けにビルドし、GitHub Release に載せる。
