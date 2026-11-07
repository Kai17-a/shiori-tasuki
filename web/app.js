// Dashboard logic: renders tasks and stats from the JSON API into Kav-UI components.
(() => {
  'use strict';

  const STATUS_LABELS = { todo: '未着手', in_progress: '進行中', review: '確認中', done: '完了' };
  const STATUS_BADGES = {
    todo: 'badge badge-neutral rounded-pill fw-normal border',
    in_progress: 'badge badge-neutral',
    review: 'badge text-bg-warning',
    done: 'badge text-bg-success',
  };
  /**
   * Page heading per view. The overview and board are already named by the selected tab,
   * so their heading is kept only for screen readers and they show no description.
   */
  const VIEWS = {
    overview: { title: '概要', description: '', headingInTabs: true },
    board: { title: 'ボード', description: '', headingInTabs: true },
    activity: { title: 'アクティビティ', description: 'エージェントとあなたが、いつ、どのタスクに何をしたかを新しい順に表示します。' },
    settings: { title: '設定', description: '表示や背景画像の設定、GitHub との同期、AI への依頼方法を確認できます。' },
  };

  const ACTOR_LABELS = { user: 'あなた', github: 'GitHub' };
  const actorLabel = (actor) => ACTOR_LABELS[actor] ?? actor;
  const isAgentName = (actor) => !(actor in ACTOR_LABELS);
  const EVENT_ICONS = {
    created: 'mdi-plus', status: 'mdi-arrow-right', updated: 'mdi-pencil',
    assigned: 'mdi-account', note: 'mdi-message-text-outline', split: 'mdi-format-list-checks',
  };
  /** How often the page checks for changes made by agents in other processes. */
  const LIVE_POLL_MS = 10000;
  /** In-progress work without activity for this long is stalled; the server sends the real value. */
  let stallAfterMs = 2 * 60 * 60 * 1000;

  const $ = (selector, root = document) => root.querySelector(selector);
  const board = $('#board');
  const searchInput = $('#board-search');
  const sourceSelect = $('#board-source');
  let config = { mcp_command: null };
  let tasks = [];
  let openTaskId = null;
  let currentView = 'overview';

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

  /** Sets a select's value from code and updates Kav-UI's custom trigger to match. */
  const setSelectValue = (select, value) => {
    select.value = value;
    KavUI.sync(select);
  };

  async function api(method, path, body) {
    const response = await fetch(path, {
      method,
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 204) return null;
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  const notifyError = (title, error) =>
    KavUI.toast({ title, body: error.message, variant: 'danger' });
  const notifySuccess = (title, body) => KavUI.toast({ title, body, variant: 'success' });

  /** "3分前" style label for an RFC 3339 UTC timestamp. */
  function relativeTime(iso) {
    const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (Number.isNaN(seconds)) return '';
    if (seconds < 60) return 'たった今';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}分前`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}時間前`;
    if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}日前`;
    return new Date(iso).toLocaleDateString('ja-JP');
  }

  function cardMeta(task, { withRepo = true } = {}) {
    const parts = [`#${task.id}`];
    if (task.subtasks.total > 0) parts.push(`子タスク ${task.subtasks.done}/${task.subtasks.total}`);
    if (task.github && withRepo) parts.push(`${task.github.repo}#${task.github.number}`);
    if (task.created_by !== 'user') parts.push(`作成: ${task.created_by}`);
    return parts.map(escapeHtml).join(' · ');
  }

  function subtaskProgress(task) {
    if (task.subtasks.total === 0) return '';
    return `<progress class="ui-progress" max="${task.subtasks.total}" value="${task.subtasks.done}" aria-label="子タスクの進捗 ${task.subtasks.done}/${task.subtasks.total}"></progress>`;
  }

  /** Whether the person has not hidden the task (hiding a task hides its subtasks too). */
  const isShown = (task) => !task.hidden_at;

  /** Work in progress with no recent activity; a parent waiting for its subtasks is not stalled. */
  function isStalled(task) {
    return task.status === 'in_progress'
      && task.subtasks.done === task.subtasks.total
      && Date.now() - Date.parse(task.last_activity_at) > stallAfterMs;
  }

  /**
   * True only while an AI agent is doing this task right now. A person's in-progress work,
   * a parent waiting for its subtasks, and an agent run that has gone quiet are not.
   */
  function isAgentWorking(task) {
    return task.status === 'in_progress'
      && Boolean(task.assignee) && isAgentName(task.assignee)
      && task.subtasks.done === task.subtasks.total
      && !isStalled(task);
  }

  function actorBadge(actor) {
    const icon = isAgentName(actor) ? 'mdi-message-text-outline' : actor === 'github' ? 'mdi-link' : 'mdi-account';
    return `<span class="badge badge-neutral rounded-pill fw-normal border task-card-assignee" title="担当: ${escapeHtml(actorLabel(actor))}"><span icon="${icon}" aria-hidden="true"></span>${escapeHtml(actorLabel(actor))}</span>`;
  }

  /** One-line description of a history entry, from the actor's point of view. */
  function eventTitle(event) {
    const who = actorLabel(event.actor);
    switch (event.kind) {
      case 'started': return `${who}が着手`;
      case 'reported': return `${who}が完了を報告（確認待ち）`;
      // An agent records an approval or change request only when the person gave it in a conversation.
      case 'approved': return isAgentName(event.actor) ? `会話での承認を${who}が記録` : `${who}が承認`;
      case 'rejected': return isAgentName(event.actor) ? `会話での差し戻しを${who}が記録` : `${who}が差し戻し`;
      case 'failed': return `${who}が中止`;
      case 'created': return `${who}がタスクを作成`;
      case 'status': return `${who}が「${STATUS_LABELS[event.from_status] ?? '?'}」→「${STATUS_LABELS[event.to_status] ?? '?'}」に変更`;
      case 'updated': return `${who}が内容を編集`;
      case 'assigned':
        if (!event.message) return `${who}が担当を外しました`;
        return event.message === event.actor ? `${who}が担当になりました` : `${who}が担当を ${actorLabel(event.message)} に設定`;
      case 'note': return isAgentName(event.actor) ? `${who}の報告` : `${who}のコメント`;
      case 'split': return `${who}が${event.message}`;
      default: return who;
    }
  }

  function renderEvent(event, { withTask = false } = {}) {
    const done = event.kind === 'approved' || (event.kind === 'status' && event.to_status === 'done');
    const body = ['note', 'status', 'updated', 'reported', 'approved', 'rejected', 'failed'].includes(event.kind) && event.message
      ? `<p class="event-message">${escapeHtml(event.message)}</p>` : '';
    const task = withTask
      ? `<a class="type-caption" href="#task-${event.task_id}">#${event.task_id} ${escapeHtml(event.task_title)}</a>` : '';
    return `<li class="ui-timeline-item${done ? ' is-complete' : ''}${isAgentName(event.actor) ? ' is-agent' : ''}" data-event-id="${event.id}"${withTask ? ` data-select-task="${event.task_id}" tabindex="0"` : ''}>
      <span class="ui-timeline-marker" aria-hidden="true"><span icon="${done ? 'mdi-check' : EVENT_ICONS[event.kind] ?? 'mdi-information-outline'}" aria-hidden="true"></span></span>
      <div class="ui-timeline-content">
        <time class="ui-timeline-date" datetime="${escapeHtml(event.created_at)}" title="${escapeHtml(new Date(event.created_at).toLocaleString('ja-JP'))}">${escapeHtml(relativeTime(event.created_at))}</time>
        <h3 class="ui-timeline-title">${escapeHtml(eventTitle(event))}</h3>
        ${task}
        ${body}
      </div>
    </li>`;
  }

  // ---- Board -------------------------------------------------------------

  /** Number of family colors defined in app.css (`.family-0` … `.family-5`). */
  const FAMILY_COLORS = 6;
  /** Deepest indent applied to nested subtask cards. */
  const MAX_INDENT_DEPTH = 2;
  const showSubtasksInput = $('#board-subtasks');
  const showHiddenInput = $('#board-hidden');
  const subtaskLayout = $('#board-subtask-layout');
  const donePeriod = $('#board-done-period');
  const expandedStacks = new Set();
  try {
    const saved = localStorage.getItem('task-tool-done-period');
    if ([...donePeriod.options].some((option) => option.value === saved)) setSelectValue(donePeriod, saved);
  } catch { /* Storage is optional. */ }

  function withinDonePeriod(task, now = new Date()) {
    if (task.status !== 'done' || donePeriod.value === 'all') return true;
    const since = donePeriod.value === 'today'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
      : now.getTime() - Number(donePeriod.value) * 86400000;
    return Date.parse(task.completed_at ?? task.updated_at) >= since;
  }
  try {
    setSelectValue(subtaskLayout, localStorage.getItem('task-tool-subtask-layout') === 'stack' ? 'stack' : 'list');
  } catch { /* Storage is optional. */ }


  /**
   * Parent/child structure of all tasks: the root of each task, its depth, a stable
   * board order that keeps families together, and a color slot per family with children.
   */
  function taskTree() {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const children = new Map();
    for (const t of tasks) {
      if (t.parent_id !== null && byId.has(t.parent_id)) {
        if (!children.has(t.parent_id)) children.set(t.parent_id, []);
        children.get(t.parent_id).push(t);
      }
    }
    const roots = tasks.filter((t) => t.parent_id === null || !byId.has(t.parent_id));
    const info = new Map();
    let order = 0;
    let familySlot = 0;
    const visit = (task, root, depth, family) => {
      info.set(task.id, { root, depth, family, order: order++ });
      for (const child of children.get(task.id) ?? []) visit(child, root, depth + 1, family);
    };
    for (const root of roots) {
      const family = children.has(root.id) ? familySlot++ % FAMILY_COLORS : null;
      visit(root, root, 0, family);
    }
    return { byId, info };
  }

  function renderCard(task, tree, { stackWorking = false } = {}) {
    const { root, depth, family } = tree.info.get(task.id);
    const source = task.github
      ? `<span class="badge badge-neutral rounded-pill fw-normal border task-card-repo" title="${escapeHtml(task.github.repo)}#${task.github.number}">${escapeHtml(task.github.repo)}#${task.github.number}</span>`
      : '';
    const parent = task.parent_id === null ? null : tree.byId.get(task.parent_id);
    const parentLink = parent
      ? `<a class="task-card-parent" href="#task-${parent.id}" title="親タスク: ${escapeHtml(parent.title)}"><span icon="mdi-arrow-up" aria-hidden="true"></span><span class="visually-hidden">親タスク</span>#${parent.id} ${escapeHtml(parent.title)}</a>`
      : '';
    const classes = ['task-card'];
    if (!isShown(task)) classes.push('is-hidden');
    // Kav-UI's chasing light ring marks only the work an AI agent is doing right now.
    const agentWorking = isAgentWorking(task) || stackWorking;
    if (agentWorking) classes.push('is-running');
    if (family !== null) classes.push('has-family', `family-${family}`);
    if (parent) classes.push('is-subtask', `depth-${Math.min(depth, MAX_INDENT_DEPTH)}`);
    return `<article class="${classes.join(' ')}" data-ui-card="${task.id}" data-root="${root.id}" data-parent="${parent ? parent.id : ''}" draggable="true">
      ${parentLink}
      <h4 class="title"><a href="#task-${task.id}">${escapeHtml(task.title)}</a>${agentWorking ? `<span class="visually-hidden">（${stackWorking ? 'このまとまりのタスクを' : ''}AIが作業中）</span>` : ''}</h4>
      ${source || task.assignee || isStalled(task) ? `<div class="ui-cluster">${source}${task.assignee ? actorBadge(task.assignee) : ''}${isStalled(task) ? '<span class="badge text-bg-warning" title="2時間以上動きがありません">停滞</span>' : ''}</div>` : ''}
      ${task.status === 'review' ? '<span class="badge text-bg-warning">ユーザーの確認待ち</span>' : ''}
      ${isShown(task) ? '' : '<span class="badge badge-neutral rounded-pill fw-normal border"><span icon="mdi-eye-off" aria-hidden="true"></span>非表示</span>'}
      ${subtaskProgress(task)}
      <div class="task-card-foot">
        <p class="type-caption type-color-muted">${cardMeta(task, { withRepo: false })}</p>
        <select class="form-select form-select-sm" data-ui-move aria-label="#${task.id}の移動先" title="移動先">${statusOptions(task.status)}</select>
      </div>
    </article>`;
  }

  /** Group only the tasks present in this column; filters never change the family key. */
  function renderStacks(cards, tree, column) {
    const families = new Map();
    for (const task of cards) {
      const root = tree.info.get(task.id).root.id;
      if (!families.has(root)) families.set(root, []);
      families.get(root).push(task);
    }
    return [...families].map(([root, members]) => {
      if (members.length === 1) return renderCard(members[0], tree);
      const top = members.reduce((best, task) =>
        tree.info.get(task.id).depth < tree.info.get(best.id).depth ? task : best);
      const rest = members.filter((task) => task !== top);
      const key = `${root}-${column}`;
      const expanded = expandedStacks.has(key);
      return `<div class="task-stack${expanded ? ' is-expanded' : ''}" data-stack="${key}">
        <div class="task-stack-deck">
          <div class="task-stack-layers" aria-hidden="true"></div>
          ${renderCard(top, tree, { stackWorking: !expanded && rest.some(isAgentWorking) })}
        </div>
        <button type="button" class="btn btn-sm btn-outline-secondary task-stack-toggle" aria-expanded="${expanded}" aria-controls="stack-${key}">${expanded ? '閉じる' : `+${rest.length} 件`}<span class="visually-hidden">：#${root}の${STATUS_LABELS[column]}の子タスク</span></button>
        <div class="task-stack-rest" id="stack-${key}"${expanded ? '' : ' hidden inert aria-hidden="true"'}>${rest.map((task) => renderCard(task, tree)).join('')}</div>
      </div>`;
    }).join('');
  }

  /** Prefix of the board filter values that pick one GitHub repository. */
  const REPO_SOURCE = 'repo:';

  /**
   * Options for `owner/name` repositories, grouped under one heading per owner. Each option
   * shows the name only; the full name stays searchable through `data-ui-keywords`.
   */
  function repoOptionGroups(repos, value = (repo) => repo, suffix = () => '') {
    const owners = new Map();
    for (const repo of repos) {
      const owner = repo.split('/')[0];
      if (!owners.has(owner)) owners.set(owner, []);
      owners.get(owner).push(repo);
    }
    return [...owners.keys()]
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
      .map((owner) => `<optgroup label="${escapeHtml(owner)}">${owners.get(owner)
        .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }))
        .map((repo) => `<option value="${escapeHtml(value(repo))}" data-ui-keywords="${escapeHtml(repo)}">${escapeHtml(repo.slice(owner.length + 1) + suffix(repo))}</option>`)
        .join('')}</optgroup>`)
      .join('');
  }

  /**
   * Rebuilds the board's source filter with one entry per synced repository, keeping the
   * current choice; a repository that no longer has issues falls back to everything.
   */
  function renderSourceOptions() {
    const counts = new Map();
    for (const task of tasks) {
      if (task.github) counts.set(task.github.repo, (counts.get(task.github.repo) ?? 0) + 1);
    }
    const repos = [...counts.keys()];
    const html = '<option value="all">すべて</option><option value="local">ローカルのタスク</option>'
      + `<option value="github">GitHub: すべて（${tasks.filter((t) => t.github).length}）</option>`
      + repoOptionGroups(repos, (repo) => REPO_SOURCE + repo, (repo) => `（${counts.get(repo)}）`);
    if (sourceSelect.innerHTML === html) return;
    const current = sourceSelect.value;
    sourceSelect.innerHTML = html;
    const kept = ['all', 'local', 'github'].includes(current) || repos.some((repo) => REPO_SOURCE + repo === current);
    setSelectValue(sourceSelect, kept ? current : 'all');
  }

  function visibleTasks(tree) {
    const query = searchInput.value.trim().toLowerCase();
    const source = sourceSelect.value;
    const showSubtasks = showSubtasksInput.checked;
    const showHidden = showHiddenInput.checked;
    return tasks
      .filter((task) => {
        if (!showHidden && !isShown(task)) return false;
        if (!showSubtasks && task.parent_id !== null) return false;
        // A subtask belongs to the same source as the task at the top of its family.
        const repo = tree.info.get(task.id).root.github?.repo ?? null;
        if (source === 'github' && repo === null) return false;
        if (source === 'local' && repo !== null) return false;
        if (source.startsWith(REPO_SOURCE) && repo !== source.slice(REPO_SOURCE.length)) return false;
        if (!query) return true;
        const haystack = `${task.title} ${task.github?.repo ?? ''} #${task.id}`.toLowerCase();
        return haystack.includes(query);
      })
      .sort((a, b) => tree.info.get(a.id).order - tree.info.get(b.id).order);
  }

  /** Longest stagger before a card's entrance starts, so big boards still settle fast. */
  const MAX_ENTRANCE_DELAY_MS = 360;
  /** Time for one fast entrance animation to finish after its delay. */
  const ENTRANCE_SETTLE_MS = 350;
  /** Delay added per card within a column for the entrance cascade. */
  const ENTRANCE_STEP_MS = 45;
  const ANIMATION_CLASSES = ['ui-animate', 'ui-animate-fast', 'ui-animate-slide-up', 'ui-animate-zoom-in',
    'ui-animate-fade-in', 'ui-animate-pulse', 'ui-animate-shake'];
  /** Status of each card on the previous render, to animate what agents changed. */
  let renderedCardIds = null;

  /** Plays one Kav-UI animation preset on an element and cleans up afterwards. */
  function playOnce(element, effect, delayMs = 0) {
    element.classList.remove(...ANIMATION_CLASSES);
    element.style.removeProperty('--ui-animation-delay');
    void element.offsetWidth; // restart the animation when the same effect repeats
    if (delayMs) element.style.setProperty('--ui-animation-delay', `${delayMs}ms`);
    element.classList.add('ui-animate', 'ui-animate-fast', effect);
    element.addEventListener('animationend', () => {
      element.classList.remove(...ANIMATION_CLASSES);
      element.style.removeProperty('--ui-animation-delay');
    }, { once: true });
  }

  /**
   * Re-renders the board. `entrance` cascades every card in (opening the board),
   * `filter` fades the result in; otherwise only cards that were not shown before zoom in.
   */
  function renderBoard({ entrance = false, filter = false } = {}) {
    const tree = taskTree();
    const matching = visibleTasks(tree);
    const now = new Date();
    const shown = matching.filter((task) => withinDonePeriod(task, now));
    subtaskLayout.disabled = !showSubtasksInput.checked;
    clearFamilyTrace();
    KavUI.destroy(board);
    for (const column of board.querySelectorAll('[data-ui-column]')) {
      const cards = shown.filter((task) => task.status === column.dataset.uiColumn);
      $('[data-ui-cards]', column).innerHTML = showSubtasksInput.checked && subtaskLayout.value === 'stack'
        ? renderStacks(cards, tree, column.dataset.uiColumn)
        : cards.map((task) => renderCard(task, tree)).join('');
      setText(`[data-ui-column="${column.dataset.uiColumn}"] [data-ui-count]`, cards.length);
      $('[data-ui-empty]', column).hidden = cards.length > 0;
    }
    KavUI.init(board);
    const doneTotal = matching.filter((task) => task.status === 'done').length;
    const doneShown = shown.filter((task) => task.status === 'done').length;
    $('#board-done-count').textContent = `${doneShown} / ${doneTotal}`;
    $('#board-done-count').setAttribute('aria-label', `${doneTotal}件中${doneShown}件を表示`);
    $('#board-done-hidden').hidden = doneShown === doneTotal;
    $('#board-done-hidden span').textContent = `古い完了 ${doneTotal - doneShown} 件は非表示`;

    for (const card of board.querySelectorAll('[inert] [data-ui-card]')) card.draggable = false;
    const previous = renderedCardIds;
    renderedCardIds = new Map(shown.map((task) => [String(task.id), task.status]));
    for (const column of board.querySelectorAll('[data-ui-column]')) {
      column.querySelectorAll('[data-ui-card]').forEach((card, index) => {
        if (card.closest('[hidden]')) return;
        const before = previous?.get(card.dataset.uiCard);
        if (entrance || previous === null) {
          playOnce(card, 'ui-animate-slide-up', Math.min(index * ENTRANCE_STEP_MS, MAX_ENTRANCE_DELAY_MS));
        } else if (filter) {
          playOnce(card, 'ui-animate-fade-in');
        } else if (before === undefined) {
          playOnce(card, 'ui-animate-zoom-in');
        } else if (before !== column.dataset.uiColumn) {
          // An agent moved this task since the last look.
          playOnce(card, column.dataset.uiColumn === 'done' ? 'ui-animate-pulse' : 'ui-animate-zoom-in');
        }
      });
    }
    const counted = showHiddenInput.checked ? tasks : tasks.filter(isShown);
    const total = showSubtasksInput.checked ? counted.length : counted.filter((t) => t.parent_id === null).length;
    $('#board-summary').textContent = shown.length === total
      ? `${total}件`
      : `${total}件中 ${shown.length}件を表示`;
  }

  // ---- Parent/child connectors ---------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Inset of a same-column tree line from the parent's left edge; children are indented 12px. */
  const TREE_LINE_INSET = 6;
  /** Corner radius where a tree line turns into the child card. */
  const TREE_CORNER = 5;
  const linkLayer = document.createElementNS(SVG_NS, 'svg');
  linkLayer.classList.add('task-links');
  linkLayer.setAttribute('aria-hidden', 'true');
  board.prepend(linkLayer);
  let tracedCard = null;

  function clearFamilyTrace() {
    tracedCard = null;
    linkLayer.replaceChildren();
    board.classList.remove('is-tracing');
    for (const card of board.querySelectorAll('.is-family, .is-traced')) {
      card.classList.remove('is-family', 'is-traced');
    }
  }

  /** Vertical anchor of a connector on a card: near the title, not the card's middle. */
  const anchorY = (rect) => rect.top + Math.min(rect.height / 2, 28);

  /**
   * Connector from the parent card to the child card. Within one column it is a tree
   * line running down the indent gap below the parent; across columns it curves between
   * the facing edges. Returns the path and the point where it meets the child.
   */
  function connector(parentRect, childRect, sameColumn) {
    const py = anchorY(parentRect);
    const cy = anchorY(childRect);
    if (sameColumn) {
      const x = parentRect.left + TREE_LINE_INSET;
      return {
        d: `M ${x} ${parentRect.bottom} L ${x} ${cy - TREE_CORNER} Q ${x} ${cy}, ${x + TREE_CORNER} ${cy} L ${childRect.left} ${cy}`,
        end: [childRect.left, cy],
      };
    }
    const rightward = childRect.left > parentRect.left;
    const x1 = rightward ? parentRect.right : parentRect.left;
    const x2 = rightward ? childRect.left : childRect.right;
    const mid = (x1 + x2) / 2;
    return { d: `M ${x1} ${py} C ${mid} ${py}, ${mid} ${cy}, ${x2} ${cy}`, end: [x2, cy] };
  }

  /** Highlights the family of `card` and draws a connector from every parent to its child. */
  function traceFamily(card) {
    if (card === tracedCard) return;
    clearFamilyTrace();
    const members = [...board.querySelectorAll(`[data-ui-card][data-root="${card.dataset.root}"]`)].filter((member) => {
      if (member.closest('[hidden], [inert]')) return false;
      if (!matchMedia('(min-width: 768px)').matches) return true;
      const rect = member.getBoundingClientRect();
      const area = member.closest('[data-ui-cards]').getBoundingClientRect();
      // Require the entire card to be visible so every connector anchor is on screen.
      return rect.top >= area.top && rect.bottom <= area.bottom;
    });
    if (members.length < 2) return;
    tracedCard = card;
    board.classList.add('is-tracing');
    card.classList.add('is-traced');
    const origin = board.getBoundingClientRect();
    const relative = (el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - origin.left, right: r.right - origin.left,
        top: r.top - origin.top, bottom: r.bottom - origin.top, height: r.height,
      };
    };
    linkLayer.setAttribute('width', board.scrollWidth);
    linkLayer.setAttribute('height', board.scrollHeight);
    for (const member of members) {
      member.classList.add('is-family');
      const parent = member.dataset.parent && board.querySelector(`[data-ui-card="${member.dataset.parent}"]`);
      if (!parent || !members.includes(parent)) continue;
      const sameColumn = parent.closest('[data-ui-column]') === member.closest('[data-ui-column]');
      const { d, end } = connector(relative(parent), relative(member), sameColumn);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('pathLength', '1');
      path.setAttribute('class', `task-link ${[...card.classList].find((c) => c.startsWith('family-')) ?? ''}`);
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', end[0]);
      dot.setAttribute('cy', end[1]);
      dot.setAttribute('r', '3.5');
      dot.setAttribute('class', path.getAttribute('class'));
      linkLayer.append(path, dot);
    }
  }

  board.addEventListener('pointerover', (event) => {
    const card = event.target.closest('[data-ui-card]');
    if (card) traceFamily(card);
  });
  board.addEventListener('pointerleave', clearFamilyTrace);
  board.addEventListener('focusin', (event) => {
    const card = event.target.closest('[data-ui-card]');
    if (card) traceFamily(card);
  });
  board.addEventListener('focusout', (event) => {
    if (!board.contains(event.relatedTarget)) clearFamilyTrace();
  });
  window.addEventListener('resize', clearFamilyTrace);
  board.addEventListener('scroll', clearFamilyTrace, true);

  donePeriod.addEventListener('change', () => {
    try { localStorage.setItem('task-tool-done-period', donePeriod.value); } catch { /* Storage is optional. */ }
    renderBoard({ filter: true });
  });
  $('#board-show-all-done').addEventListener('click', () => {
    donePeriod.value = 'all';
    donePeriod.dispatchEvent(new Event('change'));
    donePeriod.focus();
  });

  searchInput.addEventListener('input', () => renderBoard({ filter: true }));
  sourceSelect.addEventListener('change', () => renderBoard({ filter: true }));
  showSubtasksInput.addEventListener('change', () => renderBoard({ filter: true }));
  showHiddenInput.addEventListener('change', () => renderBoard({ filter: true }));
  subtaskLayout.addEventListener('change', () => {
    try { localStorage.setItem('task-tool-subtask-layout', subtaskLayout.value); } catch { /* Storage is optional. */ }
    renderBoard({ filter: true });
  });
  board.addEventListener('click', (event) => {
    const button = event.target.closest('.task-stack-toggle');
    if (!button) return;
    const key = button.closest('[data-stack]').dataset.stack;
    const expanded = !expandedStacks.has(key);
    if (expanded) expandedStacks.add(key);
    else expandedStacks.delete(key);
    renderBoard();
    const stack = board.querySelector(`[data-stack="${key}"]`);
    stack.querySelector('.task-stack-toggle').focus({ preventScroll: true });
    if (expanded) playOnce(stack.querySelector('.task-stack-rest'), 'ui-animate-slide-up');
  });


  // ---- Dashboard widgets -------------------------------------------------

  function setText(selector, text) {
    const el = $(selector);
    if (el) el.textContent = text;
  }

  const renderedHtml = new WeakMap();
  function replaceRegion(root, html) {
    if (renderedHtml.get(root) === html) return;
    const expanded = new Set([...root.querySelectorAll('details[data-details-key][open]')]
      .map((details) => details.dataset.detailsKey));
    KavUI.destroy(root);
    root.innerHTML = html;
    for (const details of root.querySelectorAll('details[data-details-key]')) {
      details.open = expanded.has(details.dataset.detailsKey);
    }
    KavUI.init(root);
    renderedHtml.set(root, html);
  }
  /** Rows shown in each overview list before the rest is summarised as a link. */
  const OVERVIEW_LIST_LIMIT = 8;

  /**
   * A compact list for an overview card: number, title (two lines at most) and one line of
   * context. Long lists end with a link to the view that shows them all.
   */
  function overviewList(items, { meta, empty, more }) {
    if (!items.length) return `<p class="overview-empty">${empty}</p>`;
    const rows = items.slice(0, OVERVIEW_LIST_LIMIT).map((item) => {
      const task = item.task ?? item;
      return `<a class="ui-list-item overview-row" href="#task-${task.id}">
        <span class="overview-id">#${task.id}</span>
        <span class="ui-list-body">
          <span class="ui-list-title">${escapeHtml(task.title)}</span>
          <span class="ui-list-description">${meta(item)}</span>
        </span>
      </a>`;
    }).join('');
    const rest = items.length - OVERVIEW_LIST_LIMIT;
    const footer = rest > 0 ? `<a class="overview-more" href="${more}">ほか ${rest} 件を見る</a>` : '';
    return `<div class="ui-list-group ui-list-group-flush overview-list">${rows}</div>${footer}`;
  }

  /** Where a task comes from: its repository and issue, or "ローカル". */
  const taskSource = (task) => (task.github ? `${task.github.repo}#${task.github.number}` : 'ローカル');

  function renderMetrics(stats) {
    stallAfterMs = stats.stall_after_secs * 1000;
    const shownTasks = tasks.filter(isShown);
    const working = shownTasks.filter(isAgentWorking);
    const personal = shownTasks.filter((t) => t.status === 'todo' && (!t.assignee || t.assignee === 'user'));
    setText('[data-metric="working"]', working.length);
    setText('[data-metric-note="working"]', '会話で依頼したAIの作業');
    setText('[data-metric="personal"]', personal.length);
    setText('[data-metric="stalled"]', shownTasks.filter(isStalled).length);
    setText('[data-metric="today"]', stats.completed_today);
    setText('[data-nav-count="working"]', working.length);
    setText('[data-metric="review"]', stats.by_status.review);
    replaceRegion($('#review-list'), overviewList(stats.awaiting_review, {
      meta: (r) => `${escapeHtml(actorLabel(r.agent))} · ${escapeHtml(relativeTime(r.reported_at))}の報告 · ${escapeHtml((r.summary || '').split('\n')[0])}`,
      empty: '確認待ちはありません。',
      more: '#/board',
    }));
    replaceRegion($('#working-list'), overviewList(working, {
      meta: (t) => `${escapeHtml(actorLabel(t.assignee))} · ${escapeHtml(relativeTime(t.last_activity_at))}に更新`,
      empty: '作業中のAIはいません。',
      more: '#/board',
    }));
    replaceRegion($('#personal-list'), overviewList(personal, {
      meta: (t) => `${escapeHtml(taskSource(t))} · ${escapeHtml(relativeTime(t.updated_at))}に更新`,
      empty: '未着手のタスクはありません。',
      more: '#/board',
    }));
  }

  function renderStalled(stats) {
    $('#stalled-section').hidden = !stats.stalled.length;
    $('#stalled-list').innerHTML = `<div class="ui-list-group ui-list-group-flush">${stats.stalled.map((task) => `
      <a class="ui-list-item" href="#task-${task.id}">
        <span class="ui-list-body">
          <span class="ui-list-title">#${task.id} ${escapeHtml(task.title)}</span>
          <span class="ui-list-description">${task.assignee ? `担当: ${escapeHtml(actorLabel(task.assignee))}` : '担当なし'}</span>
        </span>
        <span class="ui-list-meta">最後の動き: ${escapeHtml(relativeTime(task.last_activity_at))}</span>
      </a>`).join('')}</div>`;
  }

  function renderAgentSummary(stats) {
    $('#agent-summary').innerHTML = stats.agents.length ? stats.agents.map((agent) => `
      <div class="ui-list-item"><span class="ui-list-body"><span class="ui-list-title">${escapeHtml(actorLabel(agent.name))} · ${agent.stalled ? '停滞あり' : agent.working ? '作業中' : '待機中'}</span>
      <span class="ui-list-description">作業中 ${agent.working} · 今日の完了 ${agent.done_today} · 最後の動き: ${agent.last_activity_at ? escapeHtml(relativeTime(agent.last_activity_at)) : 'なし'}</span></span></div>`).join('')
      : '<p class="type-caption type-color-muted">まだAIの作業はありません。</p>';
  }

  function renderCharts(stats) {
    const labels = stats.daily.map((d) => d.date.slice(5).replace('-', '/'));
    KavUI.chart('#trend-chart', {
      type: 'line',
      label: '直近14日の作成と完了',
      labels,
      series: [
        { name: '作成', values: stats.daily.map((d) => d.created) },
        { name: '完了', values: stats.daily.map((d) => d.completed) },
      ],
      unit: '件',
    });

    const statusChart = $('#status-chart');
    const hasTasks = stats.total > 0;
    statusChart.hidden = !hasTasks;
    $('[data-empty="status"]').hidden = hasTasks;
    if (hasTasks) {
      KavUI.chart(statusChart, {
        type: 'donut',
        label: '状態の内訳',
        labels: Object.values(STATUS_LABELS),
        series: [{ name: 'タスク', values: Object.keys(STATUS_LABELS).map((k) => stats.by_status[k]) }],
        unit: '件',
      });
    }
  }

  const STATS_REGIONS = ['#stalled-list', '#agent-summary'];
  async function loadStats({ quiet = false } = {}) {
    const stats = await api('GET', '/api/stats');
    renderMetrics(stats);
    if (quiet) return;
    for (const id of STATS_REGIONS) KavUI.destroy($(id));
    renderCharts(stats);
    renderStalled(stats);
    renderAgentSummary(stats);
    setText('[data-nav-count="open"]', tasks.filter((t) => isShown(t) && t.status !== 'done').length);
    for (const id of STATS_REGIONS) KavUI.init($(id));
    await loadLatestActivity();
  }

  // ---- Activity feed --------------------------------------------------------

  const ACTIVITY_PAGE = 50;
  const activityFeed = $('#activity-feed');
  const activityActor = $('#activity-actor');
  let activityEvents = [];
  let activityExhausted = false;

  async function loadLatestActivity() {
    const latest = await api('GET', '/api/activity?limit=8');
    const root = $('#latest-activity');
    KavUI.destroy(root);
    root.innerHTML = latest.length
      ? `<ol class="ui-timeline" role="list" aria-label="最新のアクティビティ">${latest.map((e) => renderEvent(e, { withTask: true })).join('')}</ol>`
      : '<p class="type-body type-color-muted sp-m-0">まだアクティビティはありません。</p>';
    KavUI.init(root);
  }

  function activityMatches(event) {
    const kind = $('#activity-kind').value;
    if (kind !== 'all' && event.kind !== kind) return false;
    const filter = activityActor.value;
    if (filter === 'all') return true;
    if (filter === 'agents') return isAgentName(event.actor);
    return event.actor === filter;
  }

  function renderActivityFeed() {
    const shown = activityEvents.filter(activityMatches);
    KavUI.destroy(activityFeed);
    activityFeed.innerHTML = shown.length
      ? shown.map((e) => renderEvent(e, { withTask: true })).join('')
      : '<li class="type-body type-color-muted">該当するアクティビティはありません。</li>';
    KavUI.init(activityFeed);
    $('#activity-more').hidden = activityExhausted;
    setText('#activity-summary', `${activityEvents.length}件中 ${shown.length}件を表示`);
  }

  /** Loads the newest page, or the next older page when `more` is set. */
  async function loadActivity({ more = false } = {}) {
    const before = more && activityEvents.length ? `&before=${activityEvents.at(-1).id}` : '';
    const page = await api('GET', `/api/activity?limit=${ACTIVITY_PAGE}${before}`);
    activityEvents = more ? [...activityEvents, ...page] : page;
    activityExhausted = page.length < ACTIVITY_PAGE;
    renderActivityFeed();
  }

  activityActor.addEventListener('change', renderActivityFeed);
  $('#activity-kind').addEventListener('change', renderActivityFeed);
  $('#activity-more').addEventListener('click', () => loadActivity({ more: true }).catch((err) => notifyError('アクティビティを読み込めませんでした', err)));

  async function refresh() {
    const error = $('#load-error');
    board.setAttribute('aria-busy', 'true');
    try {
      tasks = await api('GET', '/api/tasks?scope=all');
      renderSourceOptions();
      renderRepoOptions();
      renderBoard();
      await loadStats();
      if (currentView === 'activity') await loadActivity();
      error.hidden = true;
      if (openTaskId !== null && familyDialog.open) await openFamily(openTaskId);
    } catch (err) {
      $('[data-error-message]', error).textContent = err.message;
      error.hidden = false;
    } finally {
      board.removeAttribute('aria-busy');
    }
  }

  // ---- GitHub sync status -----------------------------------------------

  /** How often the page asks the server whether a background sync finished. */
  const SYNC_POLL_MS = 30000;
  let lastSyncFinishedAt;

  function renderSync(status) {
    const badge = $('#sync-badge');
    const errorBox = $('#sync-error');
    const finished = status.last_finished_at
      ? relativeTime(new Date(status.last_finished_at * 1000).toISOString())
      : null;
    let badgeClass = 'badge badge-neutral';
    let badgeText = '同期中';
    if (!status.running && status.last_error) {
      badgeClass = 'badge text-bg-danger';
      badgeText = '同期エラー';
    } else if (!status.running && status.last_success_at) {
      badgeClass = 'badge text-bg-success';
      badgeText = '同期済み';
    }
    badge.className = `${badgeClass} fx-shrink-0`;
    badge.textContent = badgeText;

    const report = status.last_report;
    const minutes = Math.round(status.interval_secs / 60);
    setText('#sync-detail', report
      ? `最終同期: ${finished ?? '—'}（新規 ${report.created} 件、更新 ${report.updated} 件）· ${minutes}分ごとに自動で同期します`
      : status.running ? '初回の同期をしています…' : `${minutes}分ごとに自動で同期します`);
    errorBox.hidden = !status.last_error;
    setText('[data-sync-error]', status.last_error ? ` ${status.last_error}` : '');
    const indicator = $('#header-sync');
    indicator.classList.toggle('sync-failed', Boolean(status.last_error));
    indicator.title = status.last_error
      ? `GitHub の最終同期に失敗: ${status.last_error}。押すと今すぐ同期します`
      : `押すと GitHub と今すぐ同期します（${minutes}分ごとにも自動で同期します）`;
    showSyncRunning(status.running);
    setText('[data-sync-summary]', status.running ? '同期中…'
      : status.last_error ? '同期エラー'
      : finished ? `同期: ${finished}` : '同期待ち');
  }

  async function loadSync() {
    try {
      const status = await api('GET', '/api/sync');
      renderSync(status);
      // Reload the dashboard once a background run has finished since the last look.
      if (lastSyncFinishedAt !== undefined && status.last_finished_at !== lastSyncFinishedAt) {
        await refresh();
      }
      lastSyncFinishedAt = status.last_finished_at;
      return status;
    } catch {
      setText('[data-sync-summary]', '同期: 不明');
      $('#header-sync').title = '同期の状態を取得できません';
      return null;
    }
  }

  /** Shows the progress bar at the top of the screen and locks the sync buttons while a run lasts. */
  function showSyncRunning(running) {
    $('#sync-progress').hidden = !running;
    for (const button of document.querySelectorAll('[data-action="sync-now"]')) {
      button.disabled = running;
      button.setAttribute('aria-busy', String(running));
    }
    if (running) followSync();
  }

  let following = false;
  /** Checks the sync every few seconds until the current run has finished. */
  async function followSync() {
    if (following) return;
    following = true;
    const FOLLOW_MS = 2000;
    try {
      for (let i = 0; i < 90; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, FOLLOW_MS));
        const status = await loadSync();
        if (status && !status.running) return;
      }
    } finally {
      following = false;
    }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="sync-now"]');
    if (!button || button.disabled) return;
    showSyncRunning(true);
    setText('[data-sync-summary]', '同期中…');
    try {
      renderSync(await api('POST', '/api/sync'));
      showSyncRunning(true);
    } catch (err) {
      showSyncRunning(false);
      notifyError('同期を始められませんでした', err);
    }
  });

  // ---- Background image settings -------------------------------------------

  const backgroundForm = $('#background-form');
  const backgroundFile = $('#background-file');
  const POSITION_LABELS = { center: '中央', top: '上', bottom: '下', left: '左', right: '右' };
  const SIZE_LABELS = { cover: '画面いっぱい', contain: '画像全体', auto: '元の大きさ' };
  /** Settings as saved on the server; the form may hold unsaved changes on top. */
  let savedBackground = null;
  let previewUrl = null;

  function formatBytes(bytes) {
    return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
  }

  /** Draws `background` behind the glass theme through Kav-UI's background variables. */
  function applyBackground({ imageUrl, opacity, position, size }) {
    const style = document.body.style;
    if (imageUrl) {
      style.setProperty('--ui-theme-background-image', `url("${imageUrl.replace(/"/g, '%22')}")`);
    } else {
      style.removeProperty('--ui-theme-background-image');
    }
    style.setProperty('--ui-theme-background-opacity', `${opacity}%`);
    style.setProperty('--ui-theme-background-position', position);
    style.setProperty('--ui-theme-background-size', size);
    const preview = $('#background-preview');
    preview.style.backgroundImage = imageUrl ? `url("${imageUrl.replace(/"/g, '%22')}")` : '';
    preview.style.backgroundPosition = position;
    preview.style.backgroundSize = size;
    preview.textContent = imageUrl ? '' : '背景画像は設定されていません。';
    preview.classList.toggle('is-empty', !imageUrl);
  }

  /** The background currently described by the form, including an unsaved file. */
  function formBackground() {
    return {
      imageUrl: previewUrl ?? savedBackground?.image?.url ?? null,
      opacity: Number($('#background-opacity').value),
      position: $('#background-position').value,
      size: $('#background-size').value,
    };
  }

  function clearPendingFile() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    if (backgroundFile.files.length) {
      backgroundFile.value = '';
      backgroundFile.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function showSavedBackground(view) {
    savedBackground = view.background;
    const bg = savedBackground;
    $('#background-opacity').value = bg.opacity;
    setText('#background-opacity-value', `${bg.opacity}%`);
    setSelectValue($('#background-position'), bg.position);
    setSelectValue($('#background-size'), bg.size);
    applyBackground({ imageUrl: bg.image?.url ?? null, opacity: bg.opacity, position: bg.position, size: bg.size });
    setText('#background-info', bg.image
      ? `${bg.image.content_type.replace('image/', '').toUpperCase()} · ${formatBytes(bg.image.bytes)} · 濃さ ${bg.opacity}% · ${POSITION_LABELS[bg.position]} · ${SIZE_LABELS[bg.size]} · 更新: ${relativeTime(bg.image.updated_at)}`
      : '背景画像は設定されていません。');
    $('[data-action="delete-background"]').disabled = !bg.image;
  }

  async function loadBackground() {
    try {
      const view = await api('GET', '/api/settings');
      showSavedBackground(view);
      renderIgnoredRepos(view.github.ignored_repos);
    } catch {
      // The theme's own gradient stays as the background.
    }
  }

  // ---- Repositories the GitHub sync skips ----------------------------------

  let ignoredRepos = [];
  const ignoreForm = $('#ignore-repo-form');
  const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

  /** Offers the imported repositories that are not ignored yet. */
  function renderRepoOptions() {
    const select = $('#ignore-repo');
    const repos = [...new Set(tasks.filter((t) => t.github).map((t) => t.github.repo))]
      .filter((repo) => !ignoredRepos.some((r) => sameRepo(r, repo)));
    const current = select.value;
    const html = `<option value="">${repos.length ? '選んでください' : '取り込み済みのリポジトリはありません'}</option>`
      + repoOptionGroups(repos);
    if (select.innerHTML !== html) select.innerHTML = html;
    select.disabled = repos.length === 0;
    ignoreForm.querySelector('[type="submit"]').disabled = repos.length === 0;
    setSelectValue(select, repos.includes(current) ? current : '');
  }

  function renderIgnoredRepos(repos) {
    ignoredRepos = repos;
    replaceRegion($('#ignored-repos'), repos.length
      ? repos.map((repo) => `<li class="ignored-repo">
          <code>${escapeHtml(repo)}</code>
          <button type="button" class="btn btn-sm btn-ghost-secondary" data-unignore="${escapeHtml(repo)}">取り込みを再開</button>
        </li>`).join('')
      : '<li class="type-caption type-color-muted">ありません</li>');
    renderRepoOptions();
  }

  ignoreForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#ignore-repo');
    const repo = input.value;
    if (!repo) {
      notifyError('追加できませんでした', new Error('リポジトリを選んでください。'));
      return;
    }
    const button = ignoreForm.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    try {
      const preview = await api('GET', `/api/settings/github/ignored?repo=${encodeURIComponent(repo)}`);
      const warning = preview.tasks > 0
        ? `\n\n取り込み済みのタスク ${preview.tasks} 件（子タスクを含む）を削除します。メモや AI の作業記録も消え、元に戻せません。`
        : '';
      if (!window.confirm(`${repo} の Issue を取り込まないようにします。${warning}`)) return;
      const result = await api('POST', '/api/settings/github/ignored', { repo });
      renderIgnoredRepos(result.settings.github.ignored_repos);
      await refresh();
      notifySuccess('取り込まないリポジトリに追加しました', result.deleted > 0 ? `タスク ${result.deleted} 件を削除しました。` : '');
    } catch (err) {
      notifyError('追加できませんでした', err);
    } finally {
      renderRepoOptions();
    }
  });

  $('#ignored-repos').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-unignore]');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
      const view = await api('DELETE', '/api/settings/github/ignored', { repo: button.dataset.unignore });
      renderIgnoredRepos(view.github.ignored_repos);
      notifySuccess('取り込みを再開します', 'いまから同期して取り込み直します。');
      followSync();
    } catch (err) {
      notifyError('取り込みを再開できませんでした', err);
      if (button.isConnected) button.disabled = false;
    }
  });

  backgroundFile.addEventListener('change', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const file = backgroundFile.files[0];
    previewUrl = file ? URL.createObjectURL(file) : null;
    applyBackground(formBackground());
  });

  // Card opacity is a per-browser display preference from 0% to 100%. KavUI.setSurfaceOpacity()
  // and its saved value stop at the theme default (52%), so the app saves its own value and sets
  // the variable directly; app.css lifts the theme's lower limit (Kai17-a/Custom-UI#128).
  const SURFACE_OPACITY_KEY = 'task-tool-surface-opacity';
  const surfaceOpacity = $('#surface-opacity');
  const applySurfaceOpacity = (value) => {
    surfaceOpacity.value = value;
    document.body.style.setProperty('--ui-theme-surface-opacity', `${surfaceOpacity.value}%`);
    setText('#surface-opacity-value', `${surfaceOpacity.value}%`);
  };
  {
    let saved = null;
    try {
      saved = localStorage.getItem(SURFACE_OPACITY_KEY);
      // Carry over a value saved through Kav-UI before, and stop Kav-UI restoring it.
      const kavSaved = localStorage.getItem('kav-ui-surface-opacity');
      if (saved === null && kavSaved !== null) {
        saved = kavSaved;
        localStorage.setItem(SURFACE_OPACITY_KEY, kavSaved);
      }
      localStorage.removeItem('kav-ui-surface-opacity');
    } catch { /* Storage is optional. */ }
    const number = Number(saved);
    applySurfaceOpacity(saved !== null && saved.trim() !== '' && Number.isFinite(number) ? number : 52);
  }
  surfaceOpacity.addEventListener('input', () => {
    applySurfaceOpacity(surfaceOpacity.value);
    try { localStorage.setItem(SURFACE_OPACITY_KEY, surfaceOpacity.value); } catch { /* Storage is optional. */ }
  });

  backgroundForm.addEventListener('input', (event) => {
    if (event.target.id === 'background-opacity') {
      setText('#background-opacity-value', `${event.target.value}%`);
    }
    if (event.target !== backgroundFile) applyBackground(formBackground());
  });
  backgroundForm.addEventListener('change', (event) => {
    if (event.target.matches('select')) applyBackground(formBackground());
  });

  backgroundForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = backgroundForm.querySelector('[type="submit"]');
    KavUI.loading(button, true);
    try {
      const file = backgroundFile.files[0];
      if (file) {
        const response = await fetch('/api/settings/background/image', {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      }
      const { opacity, position, size } = formBackground();
      const view = await api('PATCH', '/api/settings/background', { opacity, position, size });
      clearPendingFile();
      showSavedBackground(view);
      notifySuccess('背景を保存しました', file ? '新しい画像を設定しました。' : '表示の設定を更新しました。');
    } catch (err) {
      notifyError('背景を保存できませんでした', err);
    } finally {
      KavUI.loading(button, false);
    }
  });

  backgroundForm.addEventListener('click', async (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'reset-background') {
      clearPendingFile();
      if (savedBackground) showSavedBackground({ background: savedBackground });
    } else if (action === 'delete-background') {
      if (!window.confirm('背景画像を削除します。よろしいですか？')) return;
      try {
        clearPendingFile();
        showSavedBackground(await api('DELETE', '/api/settings/background/image'));
        notifySuccess('背景画像を削除しました', 'テーマの標準の背景に戻しました。');
      } catch (err) {
        notifyError('背景画像を削除できませんでした', err);
      }
    }
  });

  // ---- Family relationship modal -------------------------------------------

  /** Agent-tree states for each status. */
  const NODE_STATES = { todo: 'pending', in_progress: 'pending', review: 'review', done: 'complete' };
  /** Kav-UI's running state is kept for tasks an AI agent is doing right now. */
  const nodeState = (task) => (isAgentWorking(task) ? 'running' : NODE_STATES[task.status]);
  const familyDialog = $('#family-dialog');
  const familyBody = $('#family-body');

  /** The root and descendants of a task, including a single task without relatives. */
  function familyOf(taskId) {
    const tree = taskTree();
    const info = tree.info.get(taskId);
    if (!info) return null;
    const children = new Map();
    for (const t of tasks) {
      if (t.parent_id !== null && tree.info.get(t.id)?.root.id === info.root.id) {
        if (!children.has(t.parent_id)) children.set(t.parent_id, []);
        children.get(t.parent_id).push(t);
      }
    }
    const members = tasks.filter((t) => tree.info.get(t.id)?.root.id === info.root.id);
    return { root: info.root, children, members, family: info.family };
  }

  function renderFamilyNode(task, family, currentId) {
    const kids = family.children.get(task.id) ?? [];
    const current = task.id === currentId;
    const meta = [`#${task.id}`];
    if (task.subtasks.total > 0) meta.push(`子タスク ${task.subtasks.done}/${task.subtasks.total}`);
    if (task.github) meta.push(`${task.github.repo}#${task.github.number}`);
    return `<li>
      <div class="ui-agent-node${current ? ' is-current' : ''}" data-state="${nodeState(task)}"${current ? ' aria-current="true"' : ''}>
        <span class="ui-agent-state">${STATUS_LABELS[task.status]}</span>
        <strong><a href="#task-${task.id}" data-action="open-task">${escapeHtml(task.title)}</a></strong>
        <small>${meta.map(escapeHtml).join(' · ')}</small>
      </div>
      ${kids.length ? `<ul>${kids.map((k) => renderFamilyNode(k, family, currentId)).join('')}</ul>` : ''}
    </li>`;
  }

  /** Short subtitle under the modal title: the task's status and where it sits in its family. */
  function renderFamilyLead(family, task) {
    const parent = task.parent_id != null ? tasks.find((t) => t.id === task.parent_id) : null;
    const descendants = family.members.length - 1;
    const place = parent
      ? `<a href="#task-${parent.id}">#${parent.id} ${escapeHtml(parent.title)}</a> の子タスク`
      : descendants > 0 ? `子タスク ${descendants} 件` : '';
    const github = task.github && /^https:\/\//.test(task.github.url)
      ? `<a href="${escapeHtml(task.github.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(task.github.repo)}#${escapeHtml(task.github.number)}</a>` : '';
    const hidden = isShown(task) ? '' : '<span class="family-lead-status"><span icon="mdi-eye-off" aria-hidden="true"></span>非表示</span>';
    const parts = [`<span class="family-lead-status"><span class="dot dot-${task.status}" aria-hidden="true"></span>${STATUS_LABELS[task.status]}</span>`, hidden, place, github].filter(Boolean);
    return `<p class="family-lead">${parts.join('<span aria-hidden="true">·</span>')}</p>`;
  }

  function renderFamily(family, currentId) {
    const descendants = family.members.filter((t) => t.id !== family.root.id);
    const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((k) => [k, 0]));
    for (const t of descendants) counts[t.status] += 1;
    const total = descendants.length;
    const summary = Object.entries(counts).map(([k, n]) => `${STATUS_LABELS[k]} ${n}件`).join('、');
    const segments = Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `<span class="family-meter-${k}" style="flex-grow:${n}"></span>`)
      .join('');
    const progress = total > 0 ? `<div class="family-progress">
        <div class="family-meter" role="img" aria-label="${summary}">${segments}</div>
        <ul class="family-legend" role="list">
          ${Object.entries(counts).map(([k, n]) => `<li><span class="dot dot-${k}" aria-hidden="true"></span>${STATUS_LABELS[k]}<span class="family-legend-count">${n}</span></li>`).join('')}
        </ul>
      </div>` : '';
    return `<section class="family-section family-${family.family ?? 0}" aria-labelledby="family-tree-title">
      <div class="family-section-head">
        <h3 id="family-tree-title">${total > 0 ? '子タスク' : 'タスクのつながり'}</h3>
        ${total > 0 ? `<span class="family-section-meta">完了 ${counts.done}/${total}</span>` : ''}
      </div>
      ${progress}
      ${family.members.some(isAgentWorking)
        ? `<div class="ui-agent-workflow ui-agent-flowing" data-ui-agent-flow>
        <label class="ui-agent-motion"><input type="checkbox" checked>接続線を動かす</label>`
        : '<div class="ui-agent-workflow">'}
        <div class="ui-agent-canvas" tabindex="0" role="region" aria-label="タスクの親子関係の図。横スクロール可能">
          <ul class="ui-agent-tree">${renderFamilyNode(family.root, family, currentId)}</ul>
        </div>
      </div>
    </section>`;
  }

  function statusOptions(status) {
    return Object.entries(STATUS_LABELS).map(([value, label]) => `<option value="${value}"${status === value ? ' selected' : ''}>${label}</option>`).join('');
  }

  /** Local date and time for an RFC 3339 timestamp, e.g. "2026/11/6 9:10". */
  const localTime = (iso) => new Date(iso).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  /** A commit id short enough to read, as git shows it. */
  const shortHash = (hash) => (hash ? hash.slice(0, 7) : '');

  /** One `git --numstat` line ("added<TAB>removed<TAB>path") as "+1 −0 path"; binary files show "-". */
  function numstatLine(line) {
    const [added, removed, ...path] = line.split('\t');
    if (!path.length) return line;
    const count = (n, sign) => (n === '-' ? '-' : `${sign}${n}`);
    return `${count(added, '+')} ${count(removed, '−')} ${path.join('\t')}`;
  }

  /** A titled list that shows the first three entries and folds the rest. */
  function evidenceList(title, values = [], format = (v) => v) {
    if (!values.length) return '';
    const item = (v) => `<li><code>${escapeHtml(format(v))}</code></li>`;
    const rest = values.length > 3
      ? `<details><summary>残り${values.length - 3}件を表示</summary><ul>${values.slice(3).map(item).join('')}</ul></details>`
      : '';
    return `<div class="evidence-group"><p>${title}（${values.length}件）</p><ul>${values.slice(0, 3).map(item).join('')}</ul>${rest}</div>`;
  }

  const SESSION_OUTCOMES = { running: '作業中', reported: '報告済み', failed: '中止', abandoned: '再着手で終了' };

  /**
   * One AI work session: what it says it did first, then a one-line record of when and where,
   * then the git evidence folded away for when the user wants to check it.
   */
  function renderSession(r, key) {
    const g = r.end_git || r.start_git;
    const totals = (g?.files || []).reduce((sum, line) => { const [added, removed] = line.split('\t'); sum[0] += Number(added) || 0; sum[1] += Number(removed) || 0; return sum; }, [0, 0]);
    const time = `<time datetime="${escapeHtml(r.started_at)}">${escapeHtml(localTime(r.started_at))}</time> → ${r.ended_at ? `<time datetime="${escapeHtml(r.ended_at)}">${escapeHtml(localTime(r.ended_at))}</time>` : '作業中'}`;
    const start = shortHash(r.start_git?.head);
    const end = shortHash(r.end_git?.head);
    const heads = start && end && start !== end ? `${start} → ${end}` : end || start;
    const where = [
      g?.branch ? `ブランチ ${escapeHtml(g.branch)}` : '',
      heads ? `<code>${escapeHtml(heads)}</code>` : '',
      g ? `変更 ${g.files.length} ファイル +${totals[0]} −${totals[1]}` : 'Git の記録なし',
      r.workdir ? escapeHtml(r.workdir) : '',
    ].filter(Boolean);
    const evidence = g ? `${evidenceList('コミット', g.commits)}${evidenceList('変更したファイル', g.files, numstatLine)}${evidenceList('コミットしていない変更', g.uncommitted, numstatLine)}${evidenceList('git に未登録のファイル', g.untracked)}${g.truncated ? '<p>記録は100件まで表示しています。</p>' : ''}${g.errors?.length ? `<p>${escapeHtml(g.errors.join('\n'))}</p>` : ''}` : '';
    const hasEvidence = /<li>/.test(evidence) || r.thread_id;
    return `<article class="work-session">
      <p class="work-session-head">${actorBadge(r.agent)}<span>${SESSION_OUTCOMES[r.outcome] || escapeHtml(r.outcome)}</span><span>${time}</span></p>
      ${r.summary ? `<p class="work-session-summary">${escapeHtml(r.summary)}</p>` : ''}
      ${r.links.length ? `<ul class="work-session-links" role="list">${r.links.map((l) => `<li><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer"><span icon="mdi-open-in-new" aria-hidden="true"></span>${escapeHtml(l.label || l.url)}</a></li>`).join('')}</ul>` : ''}
      <p class="work-session-meta">${where.join('<span aria-hidden="true">·</span>')}</p>
      ${hasEvidence ? `<details class="work-session-evidence" data-details-key="evidence-${key}"><summary>変更の記録</summary>
        <div class="work-session-evidence-body">
          ${r.thread_id ? `<div class="evidence-group"><p>T3 スレッド ID</p><p class="work-session-thread"><code>${escapeHtml(r.thread_id)}</code><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon-only" data-ui-copy="${escapeHtml(r.thread_id)}" aria-label="T3 スレッド ID をコピー"></button></p></div>` : ''}
          ${evidence}
        </div>
      </details>` : ''}
    </article>`;
  }

  /** Earlier sessions, newest first; the one under review is shown in the review panel instead. */
  function renderSessions(sessions, skipLatest) {
    const list = [...sessions].reverse().slice(skipLatest ? 1 : 0);
    if (skipLatest && !list.length) return '';
    return `<section class="family-section work-record" aria-labelledby="work-record-title">
      <h3 id="work-record-title">${skipLatest ? 'これまでの AI の作業' : 'AI の作業記録'}</h3>
      ${list.length ? list.map((r, i) => renderSession(r, `${r.started_at}-${i}`)).join('') : '<p class="family-empty">まだ着手の記録がありません</p>'}
    </section>`;
  }

  /**
   * The review moment: what the AI reports it did, its evidence, and the user's two decisions
   * side by side. A task can also be put up for review by hand, without a report.
   */
  function renderReview(sessions) {
    const latest = sessions.at(-1);
    const report = latest && latest.outcome === 'reported' ? latest : null;
    return `<section class="review-panel" aria-labelledby="review-title">
      <div class="family-section-head">
        <h3 id="review-title"><span class="dot dot-review" aria-hidden="true"></span>確認待ち</h3>
        <span class="family-section-meta">${report ? `${escapeHtml(actorLabel(report.agent))}の報告` : '報告なし'}</span>
      </div>
      ${report ? renderSession(report, 'review') : '<p class="family-empty">AI の報告はありません。内容を確かめて、承認か差し戻しを選びます。</p>'}
      <div class="review-decisions">
        <form class="review-decision" data-task-form="approve">
          <label for="approve-comment">承認のコメント（任意）</label>
          <textarea class="form-control" id="approve-comment" name="comment" rows="2"></textarea>
          <div><button class="btn btn-primary" type="submit" icon="mdi-check">承認</button></div>
        </form>
        <form class="review-decision" data-task-form="reject">
          <label for="reject-reason">差し戻しの理由（必須）</label>
          <textarea class="form-control" id="reject-reason" name="comment" rows="2" required maxlength="4000"></textarea>
          <div><button class="btn btn-outline-danger" type="submit" icon="mdi-undo">差し戻し</button></div>
        </form>
      </div>
      <p class="type-caption type-color-muted sp-m-0">会話で AI に「OK」や「ここを直して」と伝えても、AI がその言葉で承認・差し戻しを記録します。</p>
    </section>`;
  }

  /** Events that say what happened; status and assignee changes they cause are folded into them. */
  const STEP_KINDS = new Set(['started', 'reported', 'approved', 'rejected', 'failed']);
  /** How close a status change must be to a step of the same task and actor to count as part of it. */
  const STEP_WINDOW_MS = 2000;

  /**
   * The family's history as steps: how the work was split and carried out. The full record of
   * each task stays in its own history and work record.
   */
  function timelineSteps(items = []) {
    const events = items.filter((item) => item.event).map((item) => item.event);
    const steps = events.filter((e) => STEP_KINDS.has(e.kind));
    const partOfStep = (e) => steps.some((step) => step.task_id === e.task_id && step.actor === e.actor
      && Math.abs(Date.parse(step.created_at) - Date.parse(e.created_at)) <= STEP_WINDOW_MS);
    return events.filter((e) => e.kind !== 'assigned' && !(e.kind === 'status' && partOfStep(e)));
  }

  /**
   * A task alone has nothing to show beyond its own history, so the family-wide steps appear
   * only when the task has a parent or children.
   */
  const hasFamily = (task) => task.parent_id != null || task.subtasks.total > 0;

  function renderTimeline(items = []) {
    const steps = timelineSteps(items);
    return `<section class="family-section" aria-labelledby="timeline-title"><h3 id="timeline-title">作業の経過</h3>${steps.length
      ? `<ol class="ui-timeline ui-timeline-compact family-events" role="list">${steps.map((event) => renderEvent(event, { withTask: true })).join('')}</ol>`
      : '<p class="family-empty">まだ記録がありません</p>'}</section>`;
  }

  function renderHistory(task, history, folded) {
    const list = `<ol class="ui-timeline ui-timeline-compact family-events" role="list">${history.map((e) => renderEvent(e)).join('')}</ol>`;
    return folded
      ? `<section class="family-section"><details data-details-key="history-${task.id}"><summary>このタスクの履歴（${history.length}件）</summary>${list}</details></section>`
      : `<section class="family-section" aria-labelledby="history-title"><h3 id="history-title">タスクの履歴</h3>${list}</section>`;
  }

  function renderTaskDetails(data) {
    const task = data.task;
    const github = task.github && /^https:\/\//.test(task.github.url)
      ? `<a href="${escapeHtml(task.github.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(task.github.repo)}#${escapeHtml(task.github.number)}</a>` : '';
    const reviewing = task.status === 'review';
    return `<div class="task-details">
      ${renderSessions(data.sessions, reviewing && data.sessions.at(-1)?.outcome === 'reported')}
      ${hasFamily(task) ? renderTimeline(data.timeline) : ''}
      <section class="family-section" aria-labelledby="edit-title-heading">
        <h3 id="edit-title-heading">編集</h3>
        <form class="task-edit" data-task-form="edit" data-ui-validate novalidate>
          <div class="field" data-ui-field><label for="edit-title">題名</label><input class="form-control" id="edit-title" name="title" required maxlength="200" pattern=".*\\S.*" value="${escapeHtml(task.title)}"${task.github ? ' readonly' : ''}><small class="ui-invalid-feedback" data-ui-error hidden></small></div>
          <div class="field"><label for="edit-description">説明</label><textarea class="form-control" id="edit-description" name="description" rows="4"${task.github ? ' readonly' : ''}>${escapeHtml(task.description)}</textarea>${task.github ? `<small>題名と説明は GitHub で編集します（${github}）</small>` : ''}</div>
          <div class="task-edit-row">
            <div class="field"><label for="edit-status">状態</label><select class="form-select" id="edit-status" name="status">${statusOptions(task.status)}</select></div>
            <dl class="task-edit-facts">
              <div><dt>担当</dt><dd>${task.assignee ? actorBadge(task.assignee) : 'なし'}</dd></div>
              <div><dt>作業フォルダ</dt><dd>${task.workdir ? `<code>${escapeHtml(task.workdir)}</code>` : '未設定'}</dd></div>
            </dl>
          </div>
          <div><button class="btn btn-primary" type="submit">変更を保存</button></div>
        </form>
        <form class="task-edit" data-task-form="note" data-ui-validate novalidate>
          <div class="field" data-ui-field><label for="task-note">メモ</label><textarea class="form-control" id="task-note" name="message" required maxlength="4000" rows="2"></textarea><small class="ui-invalid-feedback" data-ui-error hidden></small></div>
          <div><button class="btn btn-outline-secondary" type="submit">メモを追加</button></div>
        </form>
        <details data-details-key="subtask-${task.id}"><summary>子タスクを追加</summary>
          <form class="task-edit" data-task-form="subtask" data-ui-validate novalidate>
            <div class="field" data-ui-field><label for="subtask-title">題名（必須）</label><input class="form-control" id="subtask-title" name="title" required maxlength="200" pattern=".*\\S.*"><small class="ui-invalid-feedback" data-ui-error hidden></small></div>
            <div class="field"><label for="subtask-description">説明</label><textarea class="form-control" id="subtask-description" name="description" rows="2"></textarea></div>
            <div><button class="btn btn-outline-secondary" type="submit">子タスクを追加</button></div>
          </form>
        </details>
        <div class="task-visibility">${isShown(task)
          ? '<button class="btn btn-outline-secondary" type="button" data-action="hide-task" icon="mdi-eye-off">非表示にする</button><p class="type-caption type-color-muted">子タスクも一緒に非表示になります。ボードの「非表示も表示」で見つけて、元に戻せます。</p>'
          : '<button class="btn btn-outline-secondary" type="button" data-action="unhide-task" icon="mdi-eye">表示に戻す</button><p class="type-caption type-color-muted">子タスクも一緒に表示に戻ります。</p>'}</div>
      </section>
      ${renderHistory(task, data.history, hasFamily(task))}
    </div>`;
  }

  /** Opens the modal that shows how `taskId` is connected and how far its family has got. */
  let familyRequest = 0;
  let familyOpener = null;
  async function openFamily(taskId, opener) {
    const request = ++familyRequest;
    openTaskId = taskId;
    const family = familyOf(taskId);
    if (!family) {
      notifyError('タスクを読み込めませんでした', new Error('タスクが見つかりません。'));
      openTaskId = null;
      history.replaceState(null, '', `#/${currentView}`);
      return;
    }
    if (!familyDialog.open) {
      familyOpener = opener ?? document.activeElement;
      // Keep the Kav-UI opener outside replaced regions; restore actual focus on close.
      KavUI.show('#family-dialog', $('main'));
    }
    try {
      const [data, timeline] = await Promise.all([api('GET', `/api/tasks/${taskId}`), api('GET', `/api/tasks/${taskId}/timeline`)]);
      data.timeline = timeline;
      if (request !== familyRequest || openTaskId !== taskId || !familyDialog.open) return;
      const task = data.task;
      setText('#family-title', `#${task.id} ${task.title}`);
      $('#family-trace').dataset.id = String(taskId);
      const scrollTop = familyDialog.scrollTop;
      replaceRegion(familyBody, renderFamilyLead(family, task)
        + (task.status === 'review' ? renderReview(data.sessions) : '')
        + renderFamily(family, taskId) + renderTaskDetails(data));
      familyDialog.scrollTop = scrollTop;
    } catch (err) { notifyError('タスクを読み込めませんでした', err); }
  }
  familyDialog.addEventListener('close', () => {
    openTaskId = null;
    familyRequest += 1;
    const target = familyOpener?.isConnected && !familyOpener.closest('[hidden], [inert]')
      ? familyOpener : (currentView === 'board' ? board : $('main'));
    if (!target.hasAttribute('tabindex') && !target.matches('a[href], button, input')) {
      target.setAttribute('tabindex', '-1');
    }
    target.focus({ preventScroll: true });
    familyOpener = null;
    if (location.hash.startsWith('#task-')) history.replaceState(null, '', `#/${currentView}`);
  });
  /**
   * Centres a card in its column's own scrolling list. scrollIntoView would also scroll the
   * column, which clips its overflow, whenever the list cannot scroll far enough by itself,
   * pushing the column heading out of sight.
   */
  function revealCard(card) {
    const list = card.closest('[data-ui-cards]');
    if (!list || getComputedStyle(list).overflowY === 'visible') {
      // Phones: columns do not scroll on their own, so let the page and board scroll.
      card.scrollIntoView({ block: 'center' });
      return;
    }
    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    list.scrollTop += cardRect.top - listRect.top - (listRect.height - cardRect.height) / 2;
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    // The column clips rather than scrolls, so undo any scroll the browser gave it.
    const column = card.closest('[data-ui-column]');
    if (column) column.scrollTop = 0;
  }

  familyDialog.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action="trace-on-board"]');
    if (!target) return;
    KavUI.hide('#family-dialog');
    history.replaceState(null, '', '#/board');
    showView('board');
    searchInput.value = '';
    setSelectValue(sourceSelect, 'all');
    showSubtasksInput.checked = true;
    renderBoard();
    const card = board.querySelector(`[data-ui-card="${target.dataset.id}"]`);
    if (card) revealCard(card);
    if (card) setTimeout(() => traceFamily(card), MAX_ENTRANCE_DELAY_MS + ENTRANCE_SETTLE_MS);
  });
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[href^="#task-"]');
    if (link) {
      event.preventDefault();
      history.pushState(null, '', link.getAttribute('href'));
      openFamily(Number(link.getAttribute('href').slice(6)), link);
      return;
    }
    const card = event.target.closest('[data-ui-card]');
    if (card && !event.target.closest('select, button, input, label, .ui-select')) {
      history.pushState(null, '', `#task-${card.dataset.uiCard}`);
      openFamily(Number(card.dataset.uiCard), card);
    }
  });

  // Explicit user writes are the only way the dashboard changes tasks.
  const newTaskDialog = $('#new-task-dialog');
  const newTaskForm = $('#new-task-form');
  document.addEventListener('click', (event) => {
    const opener = event.target.closest('[data-action="new-task"]');
    if (!opener) return;
    newTaskForm.reset();
    const select = $('#new-parent');
    KavUI.destroy(select.parentElement);
    select.innerHTML = '<option value="">なし</option>' + tasks.filter(isShown).map((t) => `<option value="${t.id}">#${t.id} ${escapeHtml(t.title)}</option>`).join('');
    KavUI.init(select.parentElement);
    KavUI.show(newTaskDialog, opener);
    $('#new-title').focus();
  });

  async function writeTask(form, method, path, body, message, after) {
    const button = form.querySelector('[type="submit"]');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    try {
      await api(method, path, body);
      after?.();
      await refresh();
      notifySuccess(message, '');
    } catch (error) { notifyError('保存できませんでした', error); }
    finally { if (button?.isConnected) button.disabled = false; }
  }

  newTaskForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!newTaskForm.reportValidity()) return;
    const values = Object.fromEntries(new FormData(newTaskForm));
    values.parent_id = values.parent_id ? Number(values.parent_id) : null;
    values.workdir = values.workdir.trim() || null;
    writeTask(newTaskForm, 'POST', '/api/tasks', values, 'タスクを作成しました', () => KavUI.hide(newTaskDialog));
  });

  familyBody.addEventListener('click', (event) => {
    const item = event.target.closest('[data-select-task]');
    if (item && !event.target.closest('a')) openFamily(Number(item.dataset.selectTask));
  });
  familyBody.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-select-task]')) {
      event.preventDefault(); openFamily(Number(event.target.dataset.selectTask));
    }
  });

  familyBody.addEventListener('submit', (event) => {
    const form = event.target.closest('[data-task-form]');
    if (!form) return;
    event.preventDefault();
    if (!form.reportValidity()) return;
    const kind = form.dataset.taskForm;
    const values = Object.fromEntries(new FormData(form));
    if (kind === 'approve' || kind === 'reject') {
      writeTask(form, 'POST', `/api/tasks/${openTaskId}/review`, {decision: kind, comment: values.comment}, kind === 'approve' ? '承認しました' : '差し戻しました');
      return;
    }
    if (kind === 'edit' && tasks.find((t) => t.id === openTaskId)?.github) {
      delete values.title;
      delete values.description;
    }
    const suffix = kind === 'subtask' ? '/subtasks' : kind === 'note' ? '/notes' : '';
    writeTask(form, kind === 'edit' ? 'PATCH' : 'POST', `/api/tasks/${openTaskId}${suffix}`, values,
      kind === 'note' ? 'メモを追加しました' : kind === 'subtask' ? '子タスクを追加しました' : '変更を保存しました');
  });

  familyBody.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action="hide-task"], [data-action="unhide-task"]');
    if (!button || button.disabled) return;
    const hide = button.dataset.action === 'hide-task';
    button.disabled = true;
    try {
      await api('POST', `/api/tasks/${openTaskId}/${hide ? 'hide' : 'unhide'}`, {});
      // A hidden task leaves the board, so close it unless hidden tasks are being shown.
      if (hide && !showHiddenInput.checked) KavUI.hide(familyDialog);
      await refresh();
      notifySuccess(hide ? 'タスクを非表示にしました' : 'タスクを表示に戻しました',
        hide ? 'ボードの「非表示も表示」で確認できます。' : '');
    } catch (error) { notifyError(hide ? '非表示にできませんでした' : '表示に戻せませんでした', error); }
    finally { if (button.isConnected) button.disabled = false; }
  });

  board.addEventListener('ui:move', async (event) => {
    const { card, to } = event.detail;
    try {
      await api('PATCH', `/api/tasks/${card.dataset.uiCard}`, { status: to });
      await refresh();
      notifySuccess('状態を変更しました', STATUS_LABELS[to]);
    } catch (error) {
      notifyError('状態を変更できませんでした', error);
      await refresh();
      renderBoard();
    }
  });

  function showView(name) {
    const previousView = currentView;
    currentView = name in VIEWS ? name : 'overview';
    if (currentView === 'board' && previousView !== 'board' && renderedCardIds !== null) {
      renderBoard({ entrance: true });
    }
    for (const view of document.querySelectorAll('[data-view]')) {
      view.hidden = view.dataset.view !== currentView;
    }
    for (const link of document.querySelectorAll('[data-nav]')) {
      if (link.dataset.nav === currentView) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (currentView === 'activity' && previousView !== 'activity') {
      loadActivity().catch((err) => notifyError('アクティビティを読み込めませんでした', err));
    }
    $('#activity-back').hidden = currentView !== 'activity';
    const view = VIEWS[currentView];
    setText('#view-title', view.title);
    $('#view-title').classList.toggle('visually-hidden', Boolean(view.headingInTabs));
    setText('#view-description', view.description);
    $('#view-description').hidden = !view.description;
    pageContent.querySelector('.ui-page-header').classList.toggle('is-tabs-only', Boolean(view.headingInTabs));
    document.title = `${VIEWS[currentView].title} · task-tool`;
    // app.css pins the heading and filter bar of the long views (board, activity).
    pageContent.dataset.currentView = currentView;
  }

  // The pinned filter bar sits right under the pinned heading, whose height follows its text.
  const pageContent = $('.app-content');
  new ResizeObserver(([entry]) => {
    pageContent.style.setProperty('--page-header-h', `${entry.target.getBoundingClientRect().height}px`);
  }).observe($('.app-content .ui-page-header'), { box: 'border-box' });
  new ResizeObserver(([entry]) => {
    pageContent.style.setProperty('--board-toolbar-h', `${entry.target.getBoundingClientRect().height}px`);
  }).observe($('[data-view="board"] > .ui-toolbar'), { box: 'border-box' });

  // "#/board" switches the view; "#task-12" opens a task over the current view.
  function routeFromHash() {
    const task = /^#task-(\d+)$/.exec(location.hash);
    if (task) {
      openFamily(Number(task[1]));
      return;
    }
    const legacy = { '#/github': '#/board', '#/agents': '#/settings' };
    const agentRedirect = location.hash === '#/agents';
    if (location.hash in legacy) history.replaceState(null, '', legacy[location.hash]);
    const view = /^#\/([a-z]+)$/.exec(location.hash);
    if (familyDialog.open) KavUI.hide('#family-dialog');
    showView(view ? view[1] : 'overview');
    if (view && !(view[1] in VIEWS)) history.replaceState(null, '', '#/overview');
    window.scrollTo(0, 0);
    if (agentRedirect) $('#agent-guide').focus();
  }

  // ---- Navigation and forms ----------------------------------------------

  for (const button of document.querySelectorAll('[data-action="reload"]')) {
    button.addEventListener('click', refresh);
  }

  // ---- Live updates -----------------------------------------------------------

  let lastEventId = null;

  /** Refreshes when an agent (or another tab) has changed anything since the last look. */
  async function pollChanges() {
    if (document.hidden) return;
    try {
      const { id } = await api('GET', '/api/activity/latest');
      if (lastEventId !== null && id !== lastEventId) await refresh();
      else await loadStats({ quiet: true });
      lastEventId = id;
    } catch {
      // A missed poll is retried on the next tick.
    }
  }

  async function start() {
    try {
      config = await api('GET', '/api/config');
    } catch {
      // The dashboard still works without the optional defaults.
    }
    if (config.mcp_command) $('#mcp-command').textContent = config.mcp_command;
    await loadBackground();
    await refresh();
    await pollChanges();
    setInterval(pollChanges, LIVE_POLL_MS);
    await loadSync();
    routeFromHash();
    setInterval(loadSync, SYNC_POLL_MS);
  }

  window.addEventListener('hashchange', routeFromHash);
  start();
})();
