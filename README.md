# task-tool

自分の作業を整理するためのタスク管理アプリです。ダッシュボードやCLIで整理し、会話でAIに依頼すると、エージェントがMCPで経過と結果を報告します。タスクを登録しただけでは実行されません。1 つのバイナリで、次の 4 つの使い方ができます。

- ブラウザの管理画面（Kav-UI のダッシュボード。glassmorphism テーマ）
- AI エージェント向けの MCP サーバー（stdio）
- GitHub Issue の自動同期（自分のリポジトリで自分が作った Issue と、自分が担当の Issue）と Issue の作成（`gh` コマンドを使用）
- コマンドラインからの操作

データは SQLite に保存します。保存先は `--db` → `TASK_TOOL_DB` → `$XDG_DATA_HOME/task-tool/tasks.db` → `$HOME/.local/share/task-tool/tasks.db` の順に決まります（未設定・空の XDG_DATA_HOME はスキップ）。親フォルダは初回利用時に作成します。既存の `.task-tool/tasks.db` は自動移行しません。同じ DB を使うすべてのプロセスに、同じ保存先を指定してください。

## ビルド

```sh
cargo build --release
cargo install --path .  # task-tool を PATH に追加
```

管理画面の HTML と Kav-UI の CSS・JS はバイナリに埋め込まれます。実行時に `web/` フォルダは不要です。

## 管理画面

```sh
task-tool serve        # http://127.0.0.1:7878/
```

ダッシュボードでタスクを作成・編集し、ボードで状態を整理します。AIに任せたい作業は、Claude CodeやT3 Codeの会話で「#12をやって」と依頼してください。AIの着手・メモ・完了報告はMCP経由で記録され、ダッシュボードに表示されます。サーバーはエージェントを起動しません。

| 画面 | 内容 |
| --- | --- |
| 概要（`#/overview`） | AIが作業中・確認待ち・自分の未着手・今日の完了・停滞の件数、タスク一覧、最新の履歴、チャート |
| ボード（`#/board`） | 状態別のタスク。検索、作成元の絞り込み、子タスク表示切り替え。カードのドラッグまたは移動先選択で状態を変更。AIの報告も反映 |
| アクティビティ（`#/activity`） | 作成・状態変更・担当・報告などの履歴と、実行者による絞り込み |
| 設定（`#/settings`） | 表示モード（ライト・ダーク）、カードの濃さ、背景画像、GitHub の同期状態、CLI・スキルと MCP の接続案内 |

ヘッダー左のタブで概要・ボードを切り替え、右の歯車から設定を開きます。アクティビティは概要の「すべて見る」、背景だけの表示はヘッダー（スマートフォンでは非表示）と設定から開けます。エージェントごとの状況は概要で確認できます。旧 `#/github` はボード、旧 `#/agents` は設定へ移動します。ボードでリポジトリを選び、完了を「すべて」にすると過去の完了 Issue も表示できます。

どの画面でもタスクをクリックすると、親子関係の図と編集フォームを同じモーダルに表示します。親子がないタスクも 1 ノードの図で表示します。図の別のタスクを押すと、モーダル内の選択と詳細が切り替わります。題名・説明・状態を編集し、子タスク・メモを追加できます。タスクは削除できず、「非表示にする」で子タスクごとボード・概要・統計から外します。履歴や作業記録は残り、ボードの「非表示も表示」で見つけて「表示に戻す」で戻せます。GitHub の同期は非表示の状態を変えないので、非表示にした Issue が戻ってくることはありません。GitHub連携済みの題名と説明は同期元を優先するため読み取り専用です。担当・作業フォルダ・GitHubリンク・変更履歴も確認できます。`#task-12` のような直接リンクにも対応し、閉じると元の画面へ戻ります。見出しの横の「ボードで表示」でそのタスクのまとまりを表示します。確認中のタスクは、AI の報告と承認・差し戻しをモーダルの最初に表示します。

ボードの親子には同じ色の帯を付け、カードに触れるかフォーカスすると線でつなぎます。状態変更と新しいカードはアニメーションで示します。OS の「動きを減らす」設定にも従います。

「新しいタスク」から題名・説明・作業フォルダ・親タスクを指定できます。作業フォルダはAIが作業する場所で、子タスクは未指定なら親から引き継ぎます。最後の子を完了にすると親も完了します。10 秒ごとに変化を確認し、開いているモーダルも更新します。進行中で 2 時間以上履歴が増えていないタスクは「停滞」として表示します。

API にはログインがありません。既定では 127.0.0.1 で待ち受け、`Host` が localhost 以外のリクエストを拒否します。ほかのアドレスで起動すると警告を表示し、この制限を外します。書き込みはJSON本文を要求し、OriginがあればHostと一致するHTTPオリジンだけを許可します。背景画像のバイナリアップロードはJSON要件の例外ですが、Originは検証します。

### 表示モード

画面右上の月（ダークへ）・太陽（ライトへ）のボタンで、ライトとダークを切り替えます。設定画面では「システム」も選べ、OS の明暗の設定に合わせて切り替わります。選んだモードはブラウザに保存され、次に開いたときも保たれます。

### 背景画像

設定画面で、画面の背景に表示する画像を設定できます。

- 対応形式は PNG・JPEG・WebP・GIF・AVIF で、5MB までです。形式はファイルの中身で判定します。SVG は扱いません。
- 画像の濃さ（0〜100%）、位置（中央・上・下・左・右）、大きさ（画面いっぱい・画像全体・元の大きさ）を選べます。
- 画像と設定は SQLite に保存するので、どのブラウザで開いても同じ背景になります。保存する前でも、選んだ画像や設定は開いている画面にすぐ反映されて確かめられます。
- 「画像を削除」で、テーマの標準の背景に戻ります。

## AI エージェントとの連携（MCP）

Claude Code に登録する例です。`--db` には、ダッシュボードと同じ DB を絶対パスで指定します（省略すると、上記の共通保存先を使います）。

```sh
claude mcp add --scope user task-tool -- /path/to/task-tool --db /path/to/.task-tool/tasks.db --repo owner/name mcp
```

`--scope user` にすると、どのフォルダで起動したセッションからも使えます。既定の local スコープは、登録したフォルダでしか使えません。

**T3 Code から使う場合**: T3 Code が起動する Claude Code は `CLAUDE_CONFIG_DIR=~/.claude` で動くため、設定ファイルとして `~/.claude/.claude.json` を読みます。普通のターミナルで登録すると `~/.claude.json` に書かれるので、T3 Code のセッションからは見えません。次のように、T3 Code と同じ設定先に登録してください。

```sh
CLAUDE_CONFIG_DIR=~/.claude claude mcp add --scope user task-tool -- /path/to/task-tool --db /path/to/.task-tool/tasks.db mcp
CLAUDE_CONFIG_DIR=~/.claude claude mcp list   # task-tool が ✔ Connected になれば完了
```

登録後は、新しいセッションを始めると使えます。実行中のセッションには反映されません。

| ツール | 内容 |
| --- | --- |
| `list_tasks` | 最上位のタスク、または `parent_id` の子タスクを一覧にする（`status`、`assignee` で絞り込み可。`assignee: "me"` で自分の担当） |
| `get_task` | タスク 1 件と、その直下の子タスク、最近の履歴、作業セッションを返す |
| `create_task` | タスクを作成し、エージェントのフォルダを workdir に記録する |
| `start_task` | 着手する。進行中にし、自分を担当にする |
| `add_note` | 経過・発見・詰まっていることを報告する |
| `complete_task` | 結果と任意の `links: [{url, label?}]` を報告し、確認中にする |
| `fail_task` | 理由をメモに残し、未着手に戻して担当を解除する。再着手には会話で依頼が必要 |
| `create_subtasks` | タスクを子タスクに分解する。複数件を一度に登録し、1 件でも不正なら何も登録しない |
| `update_task` | 題名・説明・状態を変える |
| `get_stats` | ダッシュボードと同じ集計を返す |
| `push_task_to_github` | タスクから Issue を作り（担当者は自分）、タスクと関連付ける |

AIはユーザーが会話で依頼したタスクだけを扱います。`get_task`で履歴を読み、`start_task`で着手し、`add_note`で経過を記録します。完了時は`complete_task`で実施内容と検証結果を報告します。大きな作業は`create_subtasks`で分割でき、最後の子をユーザーが承認すると祖先も完了します。

エージェントが作ったタスクには、作成者としてクライアント名が記録されます。

## 確認の流れと AI の作業記録

AI は着手前に履歴の差し戻し理由を読み、報告には実施内容・検証結果・PRなどのリンクを添えます。AI の `complete_task` / `done` は「確認中」にし、ユーザーが承認して初めて完了します。ユーザー自身の `done` は直接完了します。AI の `update_task` / `edit --status done` は拒否します。

ユーザーが会話で承認や修正を指示したときは、AI がそれを記録できます（MCP の `record_user_review`、CLI では AI の名前での `approve` / `reject`）。画面で操作し直す必要はありません。AI はユーザーの言葉を引用して記録し、自分の判断では使いません。履歴には記録した AI の名前とユーザーの言葉が残り、画面では「会話での承認を claude-code が記録」のように、自分で押した承認と区別して表示します。差し戻したときは、AI がそのまま着手し直して修正します。

```sh
task-tool --as codex done 12 --summary '実装・検証結果' --link https://example.com/pull/12
task-tool --as codex link 12 https://example.com/results --label '検証結果'
task-tool --as user approve 12 --comment '確認しました'
task-tool --as user reject 12 --reason '境界条件のテストを追加してください'
task-tool --as codex approve 12 --comment 'OK、これで完了で'   # 会話での承認を AI が記録
```

`approve --comment` はユーザーには任意、AI にはユーザーの言葉として必須です。`reject --reason` は必須で、どちらも `-` で標準入力を読めます。差し戻しは未着手に戻して担当を解除し、理由を履歴に残します。親はすべての子が完了したときだけ自動完了し、確認中の子がある間は開いたままです。確認中は停滞に数えません。

`start_task` / `start` ごとに作業セッションを開き、報告または中止で閉じます。開いたまま再着手すると前のセッションは abandoned になります。担当・開始終了時刻・結果・作業フォルダ・環境変数 `T3CODE_THREAD_ID` を記録します。環境IDの信頼できる取得元を確認できないため、T3スレッドはURLを推測せず、モーダルにコピーできるIDとして表示します。

Gitリポジトリでは着手時と報告・中止時のブランチとHEAD、開始後のコミット、ファイルごとの追加・削除行数、未コミット差分、未追跡ファイルを自動記録します。各リストは100件まで、gitコマンドは2秒で打ち切り、失敗も記録して報告を続けます。非GitフォルダにはGit記録を付けません。成果物リンクはHTTP(S)のみです。

モーダルの「AI の作業記録」で各セッションを確認でき、「作業の経過」は親子全体の履歴とセッションを古い順に表示します。項目から対象タスクへ切り替えられます。確認中のタスクは同じモーダルから承認・差し戻しできます。`view` と `view --json` もセッションを含みます。API は `GET /api/tasks/{id}` に `sessions`、`GET /api/tasks/{id}/timeline` に親子全体の経過を返します。`POST /api/tasks/{id}/review` は `{decision: "approve"|"reject", comment}` を受け取ります。

スキーマ6は新しい `work_sessions` を追加し、廃止機能の `task_runs` は変更せず履歴互換性を保ちます。既存イベントも保存して、承認・差し戻し・報告・着手・中止を区別します。

## GitHub 連携

`gh auth login` 済みの `gh` コマンドを使います。このアプリ自体はトークンを持ちません。

### 自動同期

`serve` と `mcp` は、起動した直後と、その後 5 分ごとに、自分の Issue を自動で取得します。対象や件数は選べず、常に次の 2 つの検索で取得します。どちらもオープンとクローズの両方を含み、PR は対象外です。

- **自分のアカウントのリポジトリで自分が作った Issue**：担当者を付けていなくても取得します。個人のリポジトリの Issue は、自分の作業だからです。アーカイブしたリポジトリは除きます（`user:<ログイン名> author:<ログイン名> is:issue archived:false`）。
- **自分が担当の Issue**：リポジトリを問わず取得します（`assignee:@me is:issue`）。組織のリポジトリや、他の人が立てた Issue は、自分を担当者にすると取り込まれます。
- 他の人が立てて、自分が担当でない Issue は取り込みません。公開リポジトリには誰でも Issue を立てられ、取り込んだ本文はタスクとして AI エージェントにも渡るためです。
- ログイン名は `gh api user` で調べます。それぞれの検索で、更新の新しい順に、GitHub の検索 API の上限の 1000 件まで取得します。
- 条件から外れた Issue（担当を外れた、リポジトリをアーカイブした など）のタスクは削除せず、そのまま残します。
- **取り込まないリポジトリ**：設定の「GitHub との同期」で取り込み済みのリポジトリから選ぶか、`task-tool gh ignore add OWNER/NAME` で追加すると、そのリポジトリの Issue は取り込みません。追加したときに、そのリポジトリから取り込み済みのタスク（子タスクを含む）を削除します。CLI では、削除するタスクがあると `--yes` が必要です。`gh ignore remove` で外すと次の同期で取り込み直し（設定の画面で外したときは、すぐに同期します）、`gh ignore list` で一覧を表示します。リポジトリ名の大文字・小文字は区別しません。

取得した Issue は、次のようにタスクへ反映します。

- Issue は最上位のタスクになります。2 回目以降は、題名・本文・開閉状態が変わったときだけ更新します。変化のない Issue は更新日時も変えないので、「最近の更新」が同期のたびに埋まることはありません。
  - Issue がクローズされていれば、タスクを「完了」にします。
  - 再オープンされていれば、「完了」のタスクを「未着手」に戻します。
  - それ以外の場合は、こちらで管理している状態を保ちます。
- 作成日時と完了日時には、Issue の作成日時とクローズ日時を使います。そのため、ダッシュボードのチャートは取り込んだ日ではなく、実際に作業した日を表します。
- Issue ごとの反映は 1 つのトランザクションで行います。`serve` と `mcp` が同じ DB を同時に同期しても、タスクは重複しません。
- 同期の結果は、ヘッダーの同期表示と設定の「GitHub との同期」に表示します（`GET /api/sync`）。失敗した場合はエラーを表示し、5 分後に再試行します。
- 待たずに同期したいときは、ヘッダーの同期表示か、設定の「今すぐ同期」を押します（`POST /api/sync`）。同期している間は、画面の一番上に進捗バーを表示します。

### Issue の作成

```sh
task-tool gh push 12 owner/name
```

- 作成先のリポジトリを指定します（`--repo` / `TASK_TOOL_REPO` で既定値を設定できます）。MCP の `push_task_to_github` からも作成できます。
- 担当者は自分になるので、自動同期の対象にも入ります。説明の後に、子タスクをチェックリストとして入れます。同じタスクから 2 回は作成できません。
- タスクを完了にしても、GitHub の Issue は自動ではクローズしません。

## エージェント向け CLI

MCP と CLI は同じ Store を使います。ユーザーに依頼されたタスクだけを扱い、履歴を確認してから着手し、経過・結果を記録します。`task-tool guide` で MCP と共通の手順を表示します。

```sh
export TASK_TOOL_ACTOR=codex  # または各コマンドに --as codex
task-tool list --status todo --json id,title
task-tool view 12
task-tool start 12
task-tool note 12 - <<'NOTE'
実装を進めています。
次に検証します。
NOTE
task-tool done 12 --summary '実装し、cargo test で検証しました'
```

実行者は `--as NAME` → `TASK_TOOL_ACTOR` → 自動判定の順です。`CLAUDECODE=1` なら `claude-code`、それ以外は `user` です。Codex は環境・ラッパーに依存しない信頼できる識別子を確認できなかったため、自動判定しません。`--as codex` または `TASK_TOOL_ACTOR=codex` を指定してください。着手時の担当者と、作成・編集・メモ・分割・完了・失敗の履歴に実行者を記録します。

```sh
task-tool create '認証機能を追加' -b 'GitHub OAuth でログイン'
task-tool create 'コールバックを実装' --parent 1
task-tool split 1 '実装する' '検証する'
task-tool list --all --status todo --status review --assignee codex --limit 50
task-tool list --all --repo owner/name --search OAuth
task-tool list --all --local  # 最上位の親に GitHub リンクがないタスクの家族
task-tool list --parent 1
task-tool view 1 --history 40 --json task,subtasks,history,sessions
task-tool edit 1 --title '認証を実装' --body '完了条件' --assignee ''
task-tool fail 2 --reason '依存する API が未完成'  # todo に戻し担当を解除
task-tool activity --task 1 --limit 30 --json
task-tool stats --json
task-tool hide 1     # 子タスクごと非表示。削除はしない（unhide で戻す、list --hidden で一覧）
task-tool gh push 1 owner/name --json
```

`split` はタイトルのみを受け取り、説明は空で作成します。後から `edit --body` で説明を追加できます。トップレベルの `create` は現在のフォルダを workdir とし、子タスクは親から引き継ぎます。`--workdir` で明示できます。すべての子がユーザーの承認で `done` になると祖先も完了します。GitHub と連携したタスクの題名・説明は CLI から編集できますが、次の同期で上書きされる旨を stderr に警告します。

説明 (`--body`)、完了報告 (`--summary`)、失敗理由 (`--reason`)、メモの値を `-` にすると標準入力を読みます。対話プロンプトはありません。失敗は stderr と終了コード 1 で返します。旧コマンド `add`、`show`、`update`、`comment`、`rm` は表示付きの別名として使えます。旧 `--description` と `create -d` も使えます。

データを返すコマンドは `--json`（全フィールド）または `--json id,title,status`（トップレベルのフィールド選択）に対応します。配列では各要素に選択を適用します。`view` のトップレベルは `task,subtasks,history,sessions`、`note` は作成した履歴を返します。不明なフィールドは有効な名前を示して、変更前にエラーにします。`--json` はコマンドの最後に付けてください。JSON は stdout、警告・エラーは stderr に出します。JSON を指定しない場合、端末では桁を揃え、パイプではヘッダーなしの TSV を出力します。TSV 内の改行・タブ・バックスラッシュは `\n`・`\t`・`\\` にエスケープします。

CLAUDE.md / AGENTS.md に貼る例:

```text
ユーザーのタスク管理には PATH 上の task-tool を使う。
ユーザーが依頼したタスクだけを扱い、task-tool guide に従う。
着手前に view ID で内容・workdir・履歴（過去の差し戻し理由を含む）を読み、start ID で担当を記録する。
Codex は TASK_TOOL_ACTOR=codex を設定する（Claude Code は自動判定）。
経過は note ID、完了は done ID --summary、未完了は fail ID --reason で報告する。
構造化出力には --json を使い、長い本文は - で標準入力から渡す。
```

## 開発

```sh
cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test
```

`web/vendor/kav-ui/` は Kav-UI の配布物です。GitHub Releases の ZIP（版は `web/vendor/kav-ui/VERSION`）を展開した `kav-ui/assets` の中身で、取得元と更新手順は `web/vendor/kav-ui/SOURCE.md` に書いてあります。このフォルダのファイルは直接編集しません。画面固有のスタイルは `web/app.css` に書きます。

ボードで「子タスクを表示」がオンのとき、「並べる／重ねる」を選べます。
「重ねる」は列ごとに同じ親のカードをまとめ、「+N 件」で展開できます。表示方法はブラウザに保存されます。
