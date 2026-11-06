/* Kav-UI: dependency-free data attributes. Load once with defer. */
(() => {
  'use strict';
  if (window.KavUI) return;
  const doc = document;
  const openers = new WeakMap();
  const timers = new WeakMap();
  // Scope teardown is additive: static HTML keeps the existing automatic boot.
  const disposers=new WeakMap();
  function onDispose(element,callback){const callbacks=disposers.get(element)||[];callbacks.push(callback);disposers.set(element,callbacks);}
  function scopedEvents(element){
    const controller=new AbortController();onDispose(element,()=>controller.abort());
    return (target,type,callback,options={})=>target?.addEventListener(type,callback,{...(typeof options==='boolean'?{capture:options}:options),signal:controller.signal});
  }
  function scopeOwns(scope,node){const owner=node.closest?.('[data-kav-ui-vue]');return !owner||owner===scope||owner.contains(scope);}
  function destroy(scope){
    if(typeof scope==='string')scope=query(scope);if(!scope?.querySelectorAll)return;
    const within=node=>node&&(node===scope||scope.contains(node))&&scopeOwns(scope,node);
    if(tooltip&&within(tooltip.trigger))hideTooltip();
    if(openSelect&&within(openSelect.select))openSelect.close();
    if(activeInputPicker&&within(activeInputPicker.input))activeInputPicker.close();
    if(activeDatepicker&&within(activeDatepicker.root))closeDatepicker(activeDatepicker);
    for(const popup of [...openPopups])if(within(popup)||within(popupStates.get(popup)?.trigger))closePopup(popup);
    if(splitterDrag&&within(splitterDrag.state.root))splitFinish(true);
    const sidebars=[...(scope.matches?.('[data-ui-sidebar]')?[scope]:[]),...all(scope,'[data-ui-sidebar]')];
    sidebars.filter(root=>scopeOwns(scope,root)).forEach(root=>{const state=responsiveSidebarStates.get(root);if(state?.overlay)sidebarClose(state,false);});
    for(const panel of all(doc,'dialog[open]'))if(within(panel)||within(openers.get(panel)))hide(panel);
    if(dragging&&within(dragging.board))endDrag();
    for(const element of [scope,...all(scope,'*')].filter(element=>scopeOwns(scope,element)).reverse()){
      cancelExit(element);clearTimeout(timers.get(element));elementMotions.get(element)?.cancel();
      const callbacks=disposers.get(element);disposers.delete(element);callbacks?.forEach(callback=>callback());
    }
    emit(scope,'destroyed');
  }

  const pageStates = new WeakMap();
  let sequence = 0;
  let tooltip = null;
  let dragging = null;
  const all = (scope, selector) => [...scope.querySelectorAll(selector)];
  const closest = (node, selector) => node instanceof Element ? node.closest(selector) : null;
  const owned = (scope, selector, owner) => all(scope, selector).filter(item => item.closest(owner) === scope);
  const emit = (element, name, detail = {}, cancelable = false) => element.dispatchEvent(new CustomEvent('ui:' + name, {bubbles:true, cancelable, detail}));
  const disabled = element => element.disabled || element.getAttribute('aria-disabled') === 'true';
  // Browsers can retain :focus-visible when an already-focused control is clicked.
  // Track the last input method without blurring or moving the user's focus.
  doc.addEventListener('pointerdown',()=>{doc.documentElement.dataset.uiFocusModality='pointer';},true);
  doc.addEventListener('keydown',event=>{
    if(!['Shift','Control','Alt','Meta'].includes(event.key))doc.documentElement.dataset.uiFocusModality='keyboard';
  },true);
  // Motion never delays state, focus or application events.
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const motionAnimations = new Set();
  const elementMotions = new WeakMap();
  const exitVisuals = new WeakMap();
  function motion(element, frames, duration = 'base', easing = 'out', options = {}) {
    if (!element?.isConnected || !element.animate || reducedMotion.matches) return null;
    elementMotions.get(element)?.cancel();
    const style = getComputedStyle(element);
    const timing = style.getPropertyValue('--motion-duration-' + duration).trim();
    const milliseconds = parseFloat(timing) * (timing.endsWith('ms') ? 1 : 1000);
    if (!milliseconds) return null;
    const animation = element.animate(frames, {duration:milliseconds, easing:style.getPropertyValue('--motion-ease-' + easing).trim(), ...options});
    elementMotions.set(element, animation);
    motionAnimations.add(animation);
    const cleanup = () => {
      motionAnimations.delete(animation);
      if (elementMotions.get(element) === animation) elementMotions.delete(element);
    };
    animation.finished.then(cleanup, cleanup);
    return animation;
  }
  reducedMotion.addEventListener('change', event => {
    if (event.matches) for (const animation of motionAnimations) animation.cancel();
  });
  function cancelExit(element) {
    const visual = exitVisuals.get(element);
    if (visual) { visual.animation.cancel(); visual.host.remove(); exitVisuals.delete(element); }
  }
  // Scope scroll-triggered closes to this synchronous operation only.
  let immediateExit = false;
  function withoutExitMotion(close) {
    const previous = immediateExit;
    immediateExit = true;
    try { close(); } finally { immediateExit = previous; }
  }
  function prepareExit(element) {
    // Only out-of-flow surfaces retain an inert visual. Normal-flow content
    // disappears immediately so it cannot paint over the reflowed document.
    if (!element || element.matches('dialog, [popover]') || reducedMotion.matches || !element.isConnected || !element.animate) return () => {};
    // Bound style-copy work for remaining tooltip/toast exit visuals.
    const descendants = [];
    const walker = doc.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      if (descendants.length === 100) return () => {};
      descendants.push(walker.currentNode);
    }
    const timing = getComputedStyle(element);
    const region = element.matches('.ui-toast') ? element.closest('.ui-toasts') : null;
    if (!region && !['fixed','absolute'].includes(timing.position)) return () => {};
    const bounds = element.getBoundingClientRect();
    const opacity = Number(timing.opacity);
    const destination = '0 5px';
    const parent = (region || element).parentElement?.closest('dialog[open]') || doc.body;
    if (!bounds.width || !bounds.height || opacity < .01) return () => {};
    // A closed shadow contains a frozen, inert visual copy. No duplicate IDs,
    // controls, live regions or UI selectors enter the application document.
    const host = doc.createElement('div');
    host.setAttribute('data-ui-motion-ghost', '');
    host.setAttribute('aria-hidden', 'true');
    host.inert = true;
    Object.assign(host.style, {position:'fixed',left:bounds.left+'px',top:bounds.top+'px',width:bounds.width+'px',height:bounds.height+'px',pointerEvents:'none',zIndex:'2147483000',margin:'0'});
    // The toast region is bottom-anchored and shrinks when a note leaves, so the
    // copy stays at fixed viewport coordinates one layer below the region.
    if (region) {
      const layer = parseInt(getComputedStyle(region).zIndex, 10);
      host.style.zIndex = String(Number.isFinite(layer) ? layer - 1 : 0);
    }
    const shadow = host.attachShadow({mode:'closed'});
    const clone = element.cloneNode(true);
    const originals = [element, ...descendants];
    const copies = [clone, ...all(clone, '*')];
    originals.forEach((original, index) => {
      const copy = copies[index];
      if (copy.matches('script, style, iframe, object, embed, audio, video') || (original !== element && original.matches('[popover], .ui-tooltip'))) { copy.remove(); return; }
      const style = getComputedStyle(original);
      for (const property of style) copy.style.setProperty(property, style.getPropertyValue(property));
      for (const attribute of [...copy.attributes]) {
        if (attribute.name === 'id' || attribute.name === 'popover' || attribute.name.startsWith('on') || attribute.name.startsWith('data-ui-')) copy.removeAttribute(attribute.name);
      }
      copy.style.setProperty('animation', 'none', 'important');
      copy.style.setProperty('transition', 'none', 'important');
      copy.style.pointerEvents = 'none';
      if (original.matches('input, textarea, select')) copy.value = original.value;
    });
    const surface = clone;
    surface.removeAttribute('hidden');
    Object.assign(surface.style, {position:'relative',inset:'auto',margin:'0',width:'100%',height:'100%',minWidth:'0',minHeight:'0',maxWidth:'none',maxHeight:'none',boxSizing:'border-box',opacity:'1',transform:'none',translate:'none',scale:'none'});
    shadow.append(surface);
    const scrollPositions = originals.map(original => [original.scrollLeft, original.scrollTop]);
    // Keep component-level timing overrides when the visual leaves its subtree.
    for (const token of ['--motion-duration-fast','--motion-ease-in']) host.style.setProperty(token,timing.getPropertyValue(token));
    return () => {
      if (reducedMotion.matches) return;
      cancelExit(element);
      parent.append(host);
      copies[0] = surface;
      copies.forEach((copy,index) => { copy.scrollLeft=scrollPositions[index][0]; copy.scrollTop=scrollPositions[index][1]; });
      const animation = motion(host, [{opacity,translate:'0 0'},{opacity:0,translate:destination}], 'fast', 'in');
      if (!animation) { host.remove(); return; }
      exitVisuals.set(element, {host, animation});
      const cleanup = () => { host.remove(); if (exitVisuals.get(element)?.host === host) exitVisuals.delete(element); };
      animation.finished.then(cleanup, cleanup);

    };
  }
  function exitMotion(element) {
    if (immediateExit) {
      cancelExit(element);
      if (element.matches('[popover]')) {
        element.setAttribute('data-ui-motion-immediate','');
        // Commit suppression before hidePopover starts its discrete transition.
        getComputedStyle(element).transitionProperty;
      }
      return;
    }
    prepareExit(element)();
  }
  doc.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') event.target.removeAttribute('data-ui-motion-immediate');
  }, true);
  // A shrinking region would clip survivors that slide in from above its new edge.
  const toastOverflowHolds = new WeakMap();
  function holdToastOverflow(region, animations) {
    if (!animations.length) return;
    let hold = toastOverflowHolds.get(region);
    if (!hold) { hold = {count:0, previous:region.style.overflow}; toastOverflowHolds.set(region, hold); region.style.overflow = 'visible'; }
    hold.count++;
    Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
      if (--hold.count) return;
      region.style.overflow = hold.previous;
      toastOverflowHolds.delete(region);
    });
  }
  function toastReflow(note, remove) {
    const region = note.closest('.ui-toasts');
    const remaining = region ? all(region, ':scope > .ui-toast').filter(item=>item!==note) : [];
    const before = remaining.map(item=>item.getBoundingClientRect());
    const fits = region && region.scrollHeight <= region.clientHeight;
    exitMotion(note);
    remove();
    const animations = remaining.map((item,index)=>{
      elementMotions.get(item)?.cancel();
      const after = item.getBoundingClientRect();
      const dx = before[index].left-after.left, dy = before[index].top-after.top;
      return dx || dy ? motion(item,[{transform:'translate('+dx+'px, '+dy+'px)'},{transform:'translate(0, 0)'}]) : null;
    }).filter(Boolean);
    if (fits) holdToastOverflow(region, animations);
  }
  function enterMotion(element) { motion(element, [{opacity:.25},{opacity:1}]); }

  function id(element) {
    if (!element.id) {
      do { element.id = 'ui-' + (++sequence); } while (doc.getElementById(element.id) && doc.getElementById(element.id) !== element);
    }
    return element.id;
  }
  function query(selector) {
    if (!selector) return null;
    try { return doc.querySelector(selector); } catch { return null; }
  }
  function target(trigger) {
    const selector = trigger.getAttribute('data-ui-target');
    if (selector) return query(selector);
    return doc.getElementById(trigger.getAttribute('aria-controls'));
  }
  // Mistyped names and selectors otherwise fail silently. Warn once per value.
  const warned = new Set();
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    globalThis.console?.warn?.('Kav-UI: ' + message);
  }
  function activatedTarget(button) {
    const panel = target(button);
    const selector = button.getAttribute('data-ui-target');
    if (!panel && selector) warnOnce('target:' + selector, 'data-ui-target "' + selector + '" matched no element.');
    return panel;
  }
  function describedBy(element, reference, add) {
    const tokens = new Set((element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    if (add) tokens.add(reference); else tokens.delete(reference);
    if (tokens.size) element.setAttribute('aria-describedby', [...tokens].join(' '));
    else element.removeAttribute('aria-describedby');
  }
  function sync(panel) {
    for (const button of all(doc, '[data-ui-toggle="collapse"], [data-ui-toggle="sidebar"]')) {
      if (target(button) !== panel) continue;
      button.setAttribute('aria-controls', id(panel));
      button.setAttribute('aria-expanded', String(!panel.hidden));
      const label = button.getAttribute(panel.hidden ? 'data-ui-label-closed' : 'data-ui-label-open');
      if (label) button.textContent = label;
    }
    if (panel.matches('.app-sidebar')) {
      const shell = panel.closest('.app-shell');
      if (shell) shell.dataset.sidebarCollapsed = String(panel.hidden);
    }
  }
  function focusAfterHide(panel, trigger) {
    if (!panel.contains(doc.activeElement)) return;
    const explicit = query(trigger?.getAttribute('data-ui-focus'));
    const controls = all(doc, 'button, a[href], input, select, textarea, [tabindex]').filter(item => !disabled(item) && !item.closest('[hidden], [inert]') && item.tabIndex >= 0 && item.getClientRects().length > 0);
    const index = controls.indexOf(doc.activeElement);
    const linked = controls.find(item => !panel.contains(item) && target(item) === panel);
    const following = controls.slice(index + 1).find(item => !panel.contains(item));
    const previous = controls.slice(0, Math.max(0, index)).reverse().find(item => !panel.contains(item));
    (explicit || linked || following || previous)?.focus();
  }
  function show(panel, opener) {
    if (typeof panel === 'string') panel = query(panel);
    if (!panel) return;
    if (isPopup(panel)) {openPopup(panel,opener || doc.activeElement);return;}
    cancelExit(panel);
    if (panel.tagName === 'DIALOG') {
      if (panel.open) return;
      hideTooltip();
      const original = opener || doc.activeElement;
      // Menu items become hidden after selection; return to their visible trigger.
      const popup = original?.closest?.('[data-ui-dropdown], [data-ui-popover]');
      openers.set(panel, popupStates.get(popup)?.trigger || original);
      panel.showModal();
    } else {
      const opening = panel.hidden;
      const existingAnimation = getComputedStyle(panel).animationName;
      if (opening && existingAnimation === 'none') panel.classList.add('ui-reveal');
      panel.hidden = false;
      sync(panel);
      if (opening && existingAnimation !== 'none') enterMotion(panel);
      if (opening && panel.matches('.app-sidebar')) motion(panel,[{translate:'-12px 0'},{translate:'0 0'}]);
    }
    emit(panel, 'shown');
  }
  function hide(panel, trigger) {
    if (typeof panel === 'string') panel = query(panel);
    if (!panel) return;
    if (isPopup(panel)) {closePopup(panel,true);return;}
    for (const popup of openPopups) if (panel.contains(popup)) closePopup(popup);
    if (tooltip && panel.contains(tooltip.trigger)) hideTooltip();
    if (activeInputPicker && panel.contains(activeInputPicker.root)) activeInputPicker.close();
    if (panel.tagName === 'DIALOG') {
      if (panel.open) panel.close();
    } else {
      const close = () => {
        focusAfterHide(panel, trigger);
        panel.hidden = true;
        sync(panel);
        clearTimeout(timers.get(panel));
        emit(panel, 'hidden');
      };
      if (panel.matches('.ui-toast')) toastReflow(panel,close);
      else { exitMotion(panel); close(); }
    }
  }
  function hideTooltip() {
    if (!tooltip) return;
    describedBy(tooltip.trigger, tooltip.bubble.id, false);
    exitMotion(tooltip.bubble);
    tooltip.bubble.remove();
    tooltip = null;
  }
  function showTooltip(trigger) {
    if (disabled(trigger) || !trigger.dataset.uiTooltip) return;
    if (tooltip?.trigger === trigger) return;
    hideTooltip();
    const bubble = doc.createElement('span');
    bubble.className = 'ui-tooltip';
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = trigger.dataset.uiTooltip;
    // A tooltip inside a native modal must also be inside its top layer.
    (trigger.closest('dialog[open]') || doc.body).append(bubble);
    describedBy(trigger, id(bubble), true);
    const box = trigger.getBoundingClientRect();
    const bounds = bubble.getBoundingClientRect();
    const left = Math.max(8, Math.min(box.left, window.innerWidth - bounds.width - 8));
    const below = box.bottom + 8;
    const top = below + bounds.height <= window.innerHeight - 8 ? below : Math.max(8, box.top - bounds.height - 8);
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    tooltip = {trigger, bubble};
  }
  async function copy(text) {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable');
    await navigator.clipboard.writeText(String(text));
  }
  const copying = new WeakSet();
  const copyOutputs = new WeakMap();
  const copyIcons = new WeakMap();
  const copyResetTimers = new WeakMap();
  const copyPath = 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1m3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2m0 16H8V7h11v14z';
  const checkPath = 'M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z';
  function initCopyIcon(button) {
    if (!button.classList.contains('ui-copy-icon')) return null;
    if (copyIcons.has(button)) return copyIcons.get(button);
    const label = button.getAttribute('aria-label') || button.textContent.trim() || 'コピー';
    const title = button.getAttribute('title') || label;
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', copyPath);
    svg.append(path);
    button.replaceChildren(svg);
    button.classList.add('ui-copy-icon');
    button.setAttribute('aria-label', label);
    button.title = title;
    const feedback = button.closest('.ui-clipboard')?.querySelector('[data-ui-copy-status]');
    if (feedback) feedback.dataset.uiCopyFeedback = 'icon';
    const state = {label, title, path};
    copyIcons.set(button, state);
    return state;
  }
  function resetCopyIcon(button) {
    clearTimeout(copyResetTimers.get(button));
    const state = initCopyIcon(button);
    if (!state) return;
    state.path.setAttribute('d', copyPath);
    button.removeAttribute('data-ui-copy-state');
    button.setAttribute('aria-label', state.label);
    button.title = state.title;
  }
  function copiedIcon(button) {
    const state = initCopyIcon(button);
    if (!state) return;
    state.path.setAttribute('d', checkPath);
    button.dataset.uiCopyState = 'success';
    button.setAttribute('aria-label', 'コピーしました');
    button.title = 'コピーしました';
    copyResetTimers.set(button, setTimeout(() => resetCopyIcon(button), 2000));
  }

  async function copyFromButton(button) {
    if (disabled(button) || copying.has(button)) return;
    resetCopyIcon(button);
    const container = button.closest('.ui-clipboard, .ui-toast');
    let output = container?.querySelector('[data-ui-copy-status]') || copyOutputs.get(button);
    if (!output?.isConnected) {
      output = doc.createElement('span');
      output.className = 'ui-copy-status';
      output.setAttribute('data-ui-copy-status', '');
      output.setAttribute('role', 'status');
      button.after(output);
      copyOutputs.set(button, output);
    }
    if (button.classList.contains('ui-copy-icon')) output.dataset.uiCopyFeedback = 'icon';
    else output.removeAttribute('data-ui-copy-feedback');
    const previous = {busy:button.getAttribute('aria-busy'), disabled:button.getAttribute('aria-disabled')};
    copying.add(button);
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-disabled', 'true');
    output.dataset.uiCopyState = 'pending';
    output.textContent = 'コピー中…';
    emit(button, 'copying');
    let text;
    let error = null;
    try {
      if (button.hasAttribute('data-ui-copy-target')) {
        const source = query(button.dataset.uiCopyTarget);
        if (!source) throw new Error('Copy target not found');
        text = source.matches('input, textarea') ? source.value : source.textContent;
      } else text = button.getAttribute('data-ui-copy') ?? '';
      await copy(text);
      output.dataset.uiCopyState = 'success';
      output.textContent = 'コピーしました。';
      copiedIcon(button);
    } catch (failure) {
      error = failure;
      output.dataset.uiCopyState = 'error';
      output.textContent = 'コピーできませんでした。内容を選択して手動でコピーしてください。';
    } finally {
      for (const [name, value] of [['aria-busy', previous.busy], ['aria-disabled', previous.disabled]]) {
        if (value === null) button.removeAttribute(name); else button.setAttribute(name, value);
      }
      copying.delete(button);
    }
    emit(button, error ? 'copyerror' : 'copy', error ? {error} : {text});
  }
  doc.addEventListener('click', event => {
    const button = closest(event.target, 'button[data-ui-copy], button[data-ui-copy-target]');
    if (!button) return;
    event.preventDefault();
    copyFromButton(button);
  });

  const toastAnnouncers = new Map();
  function initToastAnnouncers() {
    for (const urgency of ['polite','assertive']) {
      // Recreate a region whose node was dropped, e.g. by a page swap that replaces body.
      const existing = toastAnnouncers.get(urgency);
      if (existing?.live.isConnected) continue;
      const live = doc.createElement('div');
      live.className = 'visually-hidden';
      live.setAttribute('aria-live', urgency);
      live.setAttribute('aria-atomic', 'true');
      doc.body.append(live);
      toastAnnouncers.set(urgency, {live, queue:existing?.queue || [], running:false});
    }
  }
  function announceToast(text, urgency) {
    initToastAnnouncers();
    const state = toastAnnouncers.get(urgency);
    state.queue.push(text);
    if (state.running) return;
    const next = () => {
      if (!state.queue.length) { state.running = false; return; }
      state.running = true;
      state.live.textContent = '';
      // Commit an empty live region before inserting even an identical message.
      setTimeout(() => {
        state.live.textContent = state.queue.shift();
        setTimeout(next, 50);
      }, 20);
    };
    next();
  }

  function toast(message = '', options = {}) {
    // Keep toast('message', options) working; structured notifications accept one object.
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) {
      options = {...message, ...options};
      message = '';
    }
    const title = options.title == null ? '' : String(options.title);
    const body = String(options.body ?? message ?? '');
    const meta = options.meta == null ? '' : String(options.meta);
    const variant = ['success','danger','warning','info'].includes(options.variant) ? options.variant : 'success';
    let region = doc.querySelector('.ui-toasts');
    if (!region) {
      region = doc.createElement('div');
      region.className = 'ui-toasts';
      doc.body.append(region);
    }
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', '通知');
    const note = doc.createElement('div');
    note.className = 'ui-toast notice alert alert-' + variant;
    const words = doc.createElement('span');
    words.className = 'words ui-toast-content';
    if (title || meta) {
      const header = doc.createElement('div');
      header.className = 'ui-toast-header';
      if (title) {
        const heading = doc.createElement('strong');
        heading.className = 'ui-toast-title';
        heading.textContent = title;
        header.append(heading);
      }
      if (meta) {
        const detail = doc.createElement('small');
        detail.className = 'ui-toast-meta';
        detail.textContent = meta;
        header.append(detail);
      }
      words.append(header);
    }
    if (body) {
      const content = doc.createElement('div');
      content.className = 'ui-toast-body';
      content.textContent = body;
      words.append(content);
    }
    if (options.copy === true) {
      const copyButton = doc.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'ui-copy-icon';
      copyButton.setAttribute('data-ui-copy', String(options.copyText ?? (body || title)));
      copyButton.setAttribute('aria-label', String(options.copyLabel ?? 'コピー'));
      initCopyIcon(copyButton);
      const status = doc.createElement('span');
      status.className = 'ui-copy-status';
      status.setAttribute('data-ui-copy-status', '');
      status.setAttribute('role', 'status');
      const message=words.querySelector('.ui-toast-body')||words.querySelector('.ui-toast-title')||words.querySelector('.ui-toast-meta')||words;
      const tail=doc.createElement('span');tail.className='ui-toast-copy-tail';
      const text=message.firstChild,value=text?.nodeType===Node.TEXT_NODE?text.data:'';
      if(value) {
        const start=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(value).containing(value.length-1).index:value.length-Array.from(value).at(-1).length;
        text.data=value.slice(0,start);tail.append(doc.createTextNode(value.slice(start)));
      }
      tail.append(copyButton);message.append(tail);
      words.append(status);
    }
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'btn-close';
    close.setAttribute('data-ui-dismiss', 'toast');
    close.setAttribute('aria-label', '通知を閉じる');
    note.append(words, close);
    region.append(note);
    announceToast([title, body, meta].filter(Boolean).join(' '), variant === 'danger' ? 'assertive' : 'polite');
    while (all(region, ':scope > .ui-toast').length > 5) {
      const first = region.querySelector(':scope > .ui-toast');
      if (first.contains(doc.activeElement)) break;
      clearTimeout(timers.get(first));
      toastReflow(first,()=>first.remove());
    }
    const requested = options.duration === undefined ? (variant === 'danger' ? 0 : 6000) : Number(options.duration);
    const duration = Number.isFinite(requested) ? Math.max(0, requested) : 6000;
    const remove = () => { toastReflow(note,()=>note.remove()); clearTimeout(timers.get(note)); };
    const pause = () => clearTimeout(timers.get(note));
    const resume = () => { pause(); if (duration && !note.contains(doc.activeElement) && !note.matches(':hover') && !note.querySelector('[data-ui-copy][aria-busy="true"]')) timers.set(note, setTimeout(remove, duration)); };
    note.addEventListener('pointerenter', pause);
    note.addEventListener('pointerleave', resume);
    note.addEventListener('focusin', pause);
    note.addEventListener('ui:copying', pause);
    note.addEventListener('ui:copy', resume);
    note.addEventListener('ui:copyerror', resume);
    note.addEventListener('focusout', () => setTimeout(resume, 0));
    resume();
    return note;
  }
  // Splitter: percentages describe panel space, excluding the resize handles.
  // Responsive application sidebars share the native drawer's focus and dismissal behavior.
  const responsiveSidebarStates=new WeakMap();
  const sidebarTablet=matchMedia('(width >= 768px)'),sidebarDesktop=matchMedia('(width >= 1024px)');
  function sidebarDevice(){return sidebarDesktop.matches?'desktop':sidebarTablet.matches?'tablet':'mobile';}
  function sidebarMode(root){
    const device=sidebarDevice(),value=root.getAttribute('data-ui-sidebar-'+device);
    const allowed=device==='mobile'?['drawer','collapse','top','bottom']:['expanded','rail','hidden','top','bottom'];
    return allowed.includes(value)?value:device==='mobile'?'drawer':'expanded';
  }
  function sidebarButtons(state){return all(doc,'[data-ui-toggle="sidebar-responsive"]').filter(button=>target(button)===state.root);}
  function sidebarFocusOut(state,trigger){
    if(!state.panel.contains(doc.activeElement))return;
    const button=[trigger,...sidebarButtons(state)].find(item=>item&&!state.panel.contains(item)&&!disabled(item)&&!item.closest('[hidden],[inert]')&&item.getClientRects().length);
    if(button)button.focus({preventScroll:true});else focusAfterHide(state.panel,trigger);
  }
  function sidebarSync(state){
    const {root,panel,mode}=state,expanded=state.open;
    root.dataset.uiSidebarMode=mode;
    root.dataset.uiSidebarState=state.overlay?'closed':expanded?'expanded':mode==='rail'?'rail':'closed';
    panel.hidden=!expanded && mode!=='rail';
    if(state.overlay)panel.hidden=false;
    for(const button of sidebarButtons(state)){
      if(!button.hasAttribute('data-ui-target'))button.setAttribute('data-ui-target','#'+id(root));
      button.setAttribute('aria-controls',id(panel));button.setAttribute('aria-expanded',String(expanded));
      const label=button.getAttribute(expanded?'data-ui-label-open':'data-ui-label-closed');
      if(label){button.setAttribute('aria-label',label);if(!button.hasAttribute('icon')&&!button.querySelector('svg,[icon]'))button.textContent=label;}
    }
    for(const item of all(panel,'a, summary')){
      const rail=!expanded&&mode==='rail';
      if(rail && !item.hasAttribute('title')){item.title=item.querySelector('.sidebar-label')?.textContent.trim()||item.textContent.trim();item.dataset.uiSidebarTitle='';}
      else if(!rail && item.hasAttribute('data-ui-sidebar-title')){item.removeAttribute('title');item.removeAttribute('data-ui-sidebar-title');}
    }
    if(state.panel.contains(doc.activeElement)&&!doc.activeElement.getClientRects().length)sidebarFocusOut(state);
  }
  function sidebarRestore(state){
    state.observer?.disconnect();state.observer=null;
    if(state.marker?.parentNode)state.marker.replaceWith(state.panel);
    state.marker=null;state.overlay=false;
  }
  function removeSidebarDialog(state,dialog, immediate=false){
    if(!dialog)return;
    // Restore the real sidebar immediately; only its closed native shell remains.
    getComputedStyle(dialog).display;
    const animations=immediate?[]:dialog.getAnimations();
    if(!animations.length){dialog.remove();return;}
    state.closingDialogs.add(dialog);
    Promise.allSettled(animations.map(animation=>animation.finished)).then(()=>{dialog.remove();state.closingDialogs.delete(dialog);});
  }
  function sidebarClose(state,restoreFocus=true){
    const dialog=state.dialog;
    if(dialog?.open){if(!restoreFocus)openers.delete(dialog);hide(dialog);}
    sidebarRestore(state);state.open=false;
    removeSidebarDialog(state,dialog,!restoreFocus);state.dialog=null;
    sidebarSync(state);
  }
  function responsiveSidebar(root,options){
    if(typeof root==='string')root=query(root);
    const state=initResponsiveSidebar(root);if(!state)return false;
    if(!options)return {mode:state.mode,open:state.open};
    const opening=options.open===undefined?!state.open:Boolean(options.open);
    if(opening===state.open)return {mode:state.mode,open:state.open};
    if(!opening){
      if(state.overlay)sidebarClose(state);
      else {sidebarFocusOut(state,options.trigger);state.open=false;sidebarSync(state);}
    }else{
      state.open=true;
      if(['drawer','top','bottom'].includes(state.mode)){
        const dialog=doc.createElement('dialog');state.dialog=dialog;state.overlay=true;
        dialog.className='ui-dialog ui-drawer ui-sidebar-dialog '+(state.mode==='top'?'ui-drawer-top':state.mode==='bottom'?'ui-drawer-bottom':root.dataset.uiSidebarSide==='end'?'':'ui-drawer-start');
        dialog.setAttribute('data-ui-dialog','');dialog.dir=getComputedStyle(root).direction;dialog.setAttribute('aria-label',state.panel.getAttribute('aria-label')||'ナビゲーション');
        state.marker=doc.createComment('responsive sidebar');state.panel.before(state.marker);
        const close=doc.createElement('button');close.type='button';close.className='btn btn-outline-secondary btn-icon-only ui-sidebar-dialog-close';close.setAttribute('icon','mdi-close');close.setAttribute('aria-label','メニューを閉じる');close.setAttribute('data-ui-dismiss','dialog');
        dialog.append(close,state.panel);doc.body.append(dialog);scanIcons(dialog);sidebarSync(state);
        dialog.addEventListener('close',()=>{if(state.dialog!==dialog)return;sidebarRestore(state);state.open=false;state.dialog=null;removeSidebarDialog(state,dialog);sidebarSync(state);emit(root,'sidebarchange',{mode:state.mode,open:false});});
        state.observer=new MutationObserver(()=>{if(!root.isConnected)sidebarClose(state,false);});state.observer.observe(doc.body,{childList:true,subtree:true});
        show(dialog,options.trigger);
      }else {sidebarSync(state);enterMotion(state.panel);}
    }
    emit(root,'sidebarchange',{mode:state.mode,open:state.open});
    return {mode:state.mode,open:state.open};
  }
  function initResponsiveSidebar(root){
    if(!root?.matches?.('.app-shell[data-ui-sidebar]'))return null;
    let state=responsiveSidebarStates.get(root);
    if(state){sidebarSync(state);return state;}
    const panel=root.querySelector(':scope > .app-sidebar');if(!panel)return null;
    const listen=scopedEvents(root),original={hidden:panel.hidden,mode:root.getAttribute('data-ui-sidebar-mode'),state:root.getAttribute('data-ui-sidebar-state')};
    const mode=sidebarMode(root);state={root,panel,mode,device:sidebarDevice(),open:mode==='expanded',overlay:false,closingDialogs:new Set()};responsiveSidebarStates.set(root,state);
    listen(panel,'click',event=>{
      const link=closest(event.target,'a[href]');
      if(link && !disabled(link) && !event.defaultPrevented && !link.matches('[data-ui-toggle], [data-ui-copy]') && !event.ctrlKey&&!event.metaKey&&!event.shiftKey&&!event.altKey && state.overlay){sidebarClose(state);emit(root,'sidebarchange',{mode:state.mode,open:false});}
      if(closest(event.target,'summary') && state.mode==='rail'&&!state.open)responsiveSidebar(root,{open:true});
    });
    listen(panel,'keydown',event=>{if(event.key==='Escape'&&state.mode==='collapse'&&state.open){event.preventDefault();responsiveSidebar(root,{open:false});}});
    onDispose(root,()=>{
      if(state.overlay)sidebarClose(state,false);
      for(const dialog of state.closingDialogs)dialog.remove();state.closingDialogs.clear();
      sidebarRestore(state);panel.hidden=original.hidden;
      for(const item of all(panel,'[data-ui-sidebar-title]')){item.removeAttribute('title');item.removeAttribute('data-ui-sidebar-title');}
      for(const [name,value] of [['data-ui-sidebar-mode',original.mode],['data-ui-sidebar-state',original.state]]){if(value===null)root.removeAttribute(name);else root.setAttribute(name,value);}
      responsiveSidebarStates.delete(root);
    });
    sidebarSync(state);return state;
  }
  function sidebarResize(){
    for(const root of all(doc,'.app-shell[data-ui-sidebar]')){
      const state=responsiveSidebarStates.get(root);if(!state)continue;
      const mode=sidebarMode(root),device=sidebarDevice();if(mode===state.mode&&device===state.device)continue;
      if(state.overlay)sidebarClose(state,false);
      state.mode=mode;state.device=device;state.open=mode==='expanded';
      if(!state.open && mode!=='rail')sidebarFocusOut(state);
      sidebarSync(state);emit(root,'sidebarchange',{mode,open:state.open});
    }
  }
  sidebarTablet.addEventListener('change',sidebarResize);sidebarDesktop.addEventListener('change',sidebarResize);

  const splitterStates=new WeakMap();
  const splitterMobile=matchMedia('(width < 768px)');
  const splitVertical=root=>root.dataset.uiOrientation==='vertical' || (root.classList.contains('ui-splitter-mobile-stack') && splitterMobile.matches);
  let splitterDrag=null;
  const splitRound=value=>Math.round(value*1e6)/1e6;
  function splitProject(values,meta) {
    if(!Array.isArray(values) || values.length!==meta.length || !values.every(value=>typeof value==='number' && Number.isFinite(value) && value>=0 && value<=100))return null;
    const sum=values.reduce((a,b)=>a+b,0);if(sum<=0)return null;
    const limits=meta.map((item,i)=>values[i]===0 && item.collapsible?{min:0,max:0}:item);
    if(limits.reduce((n,item)=>n+item.min,0)>100+1e-6 || limits.reduce((n,item)=>n+item.max,0)<100-1e-6)return null;
    const sizes=values.map((value,i)=>Math.max(limits[i].min,Math.min(limits[i].max,value/sum*100)));
    for(let pass=0;pass<=sizes.length;pass++) {
      const remaining=100-sizes.reduce((a,b)=>a+b,0);if(Math.abs(remaining)<1e-7)break;
      const adjustable=sizes.map((value,i)=>i).filter(i=>remaining>0?sizes[i]<limits[i].max-1e-7:sizes[i]>limits[i].min+1e-7);
      if(!adjustable.length)return null;
      for(const i of adjustable)sizes[i]=Math.max(limits[i].min,Math.min(limits[i].max,sizes[i]+remaining/adjustable.length));
    }
    const rounded=sizes.map(splitRound),remaining=splitRound(100-rounded.reduce((a,b)=>a+b,0));
    if(remaining!==0) {
      const index=rounded.findIndex((value,i)=>value+remaining>=limits[i].min && value+remaining<=limits[i].max);
      if(index<0)return sizes;
      rounded[index]=splitRound(rounded[index]+remaining);
    }
    return rounded;
  }
  function splitBounds(state,index) {
    const a=state.meta[index],b=state.meta[index+1],total=state.sizes[index]+state.sizes[index+1];
    const low=Math.max(a.min,total-b.max),high=Math.min(a.max,total-b.min);
    const zero=a.collapsible && total>=b.min-1e-6 && total<=b.max+1e-6;
    const full=b.collapsible && total>=a.min-1e-6 && total<=a.max+1e-6;
    return {low,high,zero,full,total,min:zero?0:low,max:full?total:high};
  }
  function splitRender(state) {
    const {root,panels,handles,meta,sizes}=state;
    state.vertical=splitVertical(root);
    panels.forEach((panel,i)=>{
      const collapsed=sizes[i]<=1e-6;
      if(collapsed && panel.contains(doc.activeElement))handles[Math.min(i,handles.length-1)]?.focus({preventScroll:true});
      panel.style.setProperty('--ui-splitter-size',String(sizes[i]));panel.toggleAttribute('data-ui-splitter-collapsed',collapsed);
      panel.inert=collapsed || state.original[i].inert;
      if(collapsed)panel.setAttribute('aria-hidden','true');else if(state.original[i].hidden===null)panel.removeAttribute('aria-hidden');else panel.setAttribute('aria-hidden',state.original[i].hidden);
      if(!collapsed)state.lastOpen[i]=sizes[i];
    });
    handles.forEach((handle,i)=>{
      const bounds=splitBounds(state,i),locked=root.hasAttribute('data-ui-splitter-disabled') || (bounds.max-bounds.min<1e-6 && !meta[i].collapsible);
      handle.tabIndex=locked?-1:0;handle.setAttribute('aria-disabled',String(locked));
      handle.setAttribute('aria-orientation',state.vertical?'horizontal':'vertical');
      handle.setAttribute('aria-valuemin',String(splitRound(Math.max(0,Math.min(sizes[i],bounds.min)))));handle.setAttribute('aria-valuemax',String(splitRound(Math.max(sizes[i],bounds.max))));
      handle.setAttribute('aria-valuenow',String(splitRound(sizes[i])));handle.setAttribute('aria-valuetext',splitRound(sizes[i])+'%'+(sizes[i]===0?'（折り畳み）':''));
    });
  }
  function splitSave(state) {
    const key=state.root.dataset.uiSplitterSave;if(!key)return;
    try {localStorage.setItem('kav-ui-splitter:'+key,JSON.stringify({version:1,orientation:state.vertical?'vertical':'horizontal',sizes:state.sizes}));}catch { /* Saving is optional. */ }
  }
  function splitApply(state,sizes,notify=true) {
    const changed=sizes.some((value,i)=>Math.abs(value-state.sizes[i])>1e-6);state.sizes=[...sizes];splitRender(state);
    if(changed && notify)emit(state.root,'splitterchange',{sizes:[...sizes]});return changed;
  }
  function splitEnd(state,cancelled=false) {if(!cancelled)splitSave(state);emit(state.root,'splitterend',{sizes:[...state.sizes],cancelled});}
  function splitPair(state,index,requested) {
    const {low,high,zero,full,total}=splitBounds(state,index),a=state.meta[index],b=state.meta[index+1];let value;
    if(zero && requested<a.min/2)value=0;
    else if(full && requested>total-b.min/2)value=total;
    else if(low<=high)value=Math.max(low,Math.min(high,requested));
    else return false;
    const sizes=[...state.sizes];sizes[index]=splitRound(value);sizes[index+1]=splitRound(total-value);return splitApply(state,sizes);
  }
  function splitToggle(state,index) {
    const item=state.meta[index];if(!item.collapsible)return false;
    const value=state.sizes[index]===0?Math.max(item.min,Math.min(item.max,state.lastOpen[index] || state.initial[index] || item.min)):0;
    const proposed=[...state.sizes];proposed[index]=value;
    const fixed=state.meta.map((entry,i)=>i===index?{...entry,min:value,max:value}:entry),sizes=splitProject(proposed,fixed);
    return sizes?splitApply(state,sizes):false;
  }
  function splitFinish(cancelled=false) {
    const drag=splitterDrag;if(!drag)return;splitterDrag=null;
    delete doc.documentElement.dataset.uiSplitterResizing;drag.handle.removeAttribute('data-ui-dragging');
    if(cancelled)splitApply(drag.state,drag.before);
    try {if(drag.handle.hasPointerCapture(drag.pointer))drag.handle.releasePointerCapture(drag.pointer);}catch { /* A cancelled pointer may already be released. */ }
    splitEnd(drag.state,cancelled);
  }
  function splitDispose(state) {
    if(state.disposed)return;state.disposed=true;
    if(splitterDrag?.state===state)splitFinish(true);
    state.controller.abort();state.handles.forEach(handle=>handle.remove());
    state.panels.forEach((panel,i)=>{
      const original=state.original[i];
      for(const [name,value] of [['inert',original.inertAttribute],['aria-hidden',original.hidden],['data-ui-splitter-collapsed',original.collapsed],['id',original.id]]){if(value===null)panel.removeAttribute(name);else panel.setAttribute(name,value);}
      if(original.size)panel.style.setProperty('--ui-splitter-size',original.size,original.priority);else panel.style.removeProperty('--ui-splitter-size');
      if(!original.styleAttribute&&!panel.getAttribute('style'))panel.removeAttribute('style');
      if(!original.panelClass)panel.classList.remove('ui-splitter-panel');
      if(!original.classAttribute&&!panel.getAttribute('class'))panel.removeAttribute('class');
    });
    if(!state.rootClass)state.root.classList.remove('ui-splitter');
    if(!state.rootClassAttribute&&!state.root.getAttribute('class'))state.root.removeAttribute('class');
    if(splitterStates.get(state.root)===state)splitterStates.delete(state.root);
  }
  function splitBind(state,handle,index) {
    const listen=(type,callback)=>handle.addEventListener(type,callback,{signal:state.controller.signal});
    listen('pointerdown',event=>{
      if(event.button!==0 || !event.isPrimary || splitterDrag || handle.getAttribute('aria-disabled')==='true')return;
      const axis=state.vertical?'height':'width',length=state.panels.reduce((sum,panel)=>sum+panel.getBoundingClientRect()[axis],0);if(length<=0)return;
      event.preventDefault();handle.focus({preventScroll:true});
      splitterDrag={state,handle,index,pointer:event.pointerId,start:state.vertical?event.clientY:event.clientX,length,before:[...state.sizes],rtl:!state.vertical && getComputedStyle(state.root).direction==='rtl'};
      try {handle.setPointerCapture(event.pointerId);}catch {splitterDrag=null;return;}
      handle.setAttribute('data-ui-dragging','');doc.documentElement.dataset.uiSplitterResizing=state.vertical?'vertical':'horizontal';
    });
    listen('pointermove',event=>{
      const drag=splitterDrag;if(!drag || drag.handle!==handle || drag.pointer!==event.pointerId)return;
      if(state.root.hasAttribute('data-ui-splitter-disabled') || !state.root.isConnected){splitFinish(true);return;}
      const position=state.vertical?event.clientY:event.clientX;
      splitPair(state,index,drag.before[index]+(position-drag.start)/drag.length*100*(drag.rtl?-1:1));
    });
    listen('pointerup',event=>{if(splitterDrag?.handle===handle && splitterDrag.pointer===event.pointerId)splitFinish();});
    for(const name of ['pointercancel','lostpointercapture'])listen(name,event=>{if(splitterDrag?.handle===handle && splitterDrag.pointer===event.pointerId)splitFinish(true);});
    listen('dblclick',event=>{
      if(handle.getAttribute('aria-disabled')==='true')return;event.preventDefault();
      if(state.meta[index].collapsible){if(splitToggle(state,index))splitEnd(state);}
      else {const total=state.sizes[index]+state.sizes[index+1],initial=state.initial[index]+state.initial[index+1];if(initial>0 && splitPair(state,index,total*state.initial[index]/initial))splitEnd(state);}
    });
    listen('keydown',event=>{
      if(event.key==='Escape' && splitterDrag?.state===state){event.preventDefault();splitFinish(true);return;}
      if(handle.getAttribute('aria-disabled')==='true')return;
      const rtl=!state.vertical && getComputedStyle(state.root).direction==='rtl';
      const less=state.vertical?'ArrowUp':rtl?'ArrowRight':'ArrowLeft',more=state.vertical?'ArrowDown':rtl?'ArrowLeft':'ArrowRight';
      const parsed=Number(state.root.dataset.uiSplitterStep),step=(parsed>0 && parsed<=100?parsed:2)*(event.shiftKey?5:1),bounds=splitBounds(state,index);
      let value=state.sizes[index],changed=false;
      if(event.key==='Enter'){event.preventDefault();changed=splitToggle(state,index);}
      else {
        if(event.key===less)value=value===bounds.total && state.meta[index+1].collapsible?bounds.high:value<=state.meta[index].min && bounds.zero?0:value-step;
        else if(event.key===more)value=value===0?bounds.low:value>=bounds.high && bounds.full?bounds.total:value+step;
        else if(event.key==='Home')value=bounds.min;
        else if(event.key==='End')value=bounds.max;
        else return;
        event.preventDefault();changed=splitPair(state,index,value);
      }
      if(changed)splitEnd(state);
    });
  }
  function initSplitter(root) {
    const panels=all(root,':scope > [data-ui-splitter-panel]');if(panels.length<2)return null;
    const number=(panel,key,fallback)=>panel.dataset[key]===undefined || panel.dataset[key]===''?fallback:Number(panel.dataset[key]);
    const meta=panels.map(panel=>({min:number(panel,'uiMin',10),max:number(panel,'uiMax',100),size:number(panel,'uiSize',null),collapsible:panel.hasAttribute('data-ui-collapsible')}));
    if(meta.some(item=>!Number.isFinite(item.min) || !Number.isFinite(item.max) || item.min<0 || item.max>100 || item.min>item.max || (item.size!==null && (!Number.isFinite(item.size) || item.size<0 || item.size>100))) || meta.reduce((sum,item)=>sum+item.min,0)>100+1e-6)return null;
    const remaining=Math.max(0,100-meta.reduce((sum,item)=>sum+(item.size??0),0)),missing=meta.filter(item=>item.size===null).length;
    const initial=splitProject(meta.map(item=>item.size??remaining/missing),meta);if(!initial)return null;
    let state=splitterStates.get(root);
    if(state && panels.length===state.panels.length && panels.every((panel,i)=>panel===state.panels[i])) {
      if(splitterDrag?.state===state)splitFinish(true);
      const sizes=splitProject(state.sizes,meta);if(!sizes)return null;state.meta=meta;state.initial=initial;splitApply(state,sizes,false);return state;
    }
    if(state)splitDispose(state);
    else onDispose(root,()=>{const current=splitterStates.get(root);if(current)splitDispose(current);});
    state={root,panels,meta,initial,sizes:[...initial],lastOpen:[...initial],handles:[],controller:new AbortController(),vertical:splitVertical(root),
      rootClass:root.classList.contains('ui-splitter'),rootClassAttribute:root.hasAttribute('class'),
      original:panels.map(panel=>({inert:panel.inert,inertAttribute:panel.getAttribute('inert'),hidden:panel.getAttribute('aria-hidden'),
        collapsed:panel.getAttribute('data-ui-splitter-collapsed'),id:panel.getAttribute('id'),
        size:panel.style.getPropertyValue('--ui-splitter-size'),priority:panel.style.getPropertyPriority('--ui-splitter-size'),styleAttribute:panel.hasAttribute('style'),
        panelClass:panel.classList.contains('ui-splitter-panel'),classAttribute:panel.hasAttribute('class')}))};
    try {
      const key=root.dataset.uiSplitterSave,saved=key?JSON.parse(localStorage.getItem('kav-ui-splitter:'+key)):null;
      if(saved?.version===1 && saved.orientation===(state.vertical?'vertical':'horizontal'))state.sizes=splitProject(saved.sizes,meta) || state.sizes;
    } catch { /* Invalid or unavailable storage keeps the defaults. */ }
    root.classList.add('ui-splitter');panels.forEach(panel=>panel.classList.add('ui-splitter-panel'));
    panels.slice(0,-1).forEach((panel,index)=>{
      const handle=doc.createElement('div');handle.className='ui-splitter-handle';handle.dataset.uiSplitterHandle='';handle.setAttribute('role','separator');handle.setAttribute('aria-controls',id(panel));
      const labelled=panel.getAttribute('aria-labelledby');if(labelled)handle.setAttribute('aria-labelledby',labelled);else handle.setAttribute('aria-label',panel.getAttribute('aria-label') || 'パネル'+(index+1)+'のサイズ');
      root.insertBefore(handle,panels[index+1]);state.handles.push(handle);splitBind(state,handle,index);
    });
    splitterStates.set(root,state);splitRender(state);return state;
  }
  function splitter(root,options={}) {
    if(typeof root==='string')root=query(root);if(!root?.matches?.('[data-ui-splitter]'))return false;
    const state=splitterStates.get(root) || initSplitter(root);if(!state)return false;
    if(options.reset && options.sizes!==undefined)return false;
    if(options.reset || options.sizes!==undefined) {
      const sizes=options.reset?[...state.initial]:splitProject(options.sizes,state.meta);if(!sizes)return false;
      if(splitterDrag?.state===state)splitFinish(true);
      if(splitApply(state,sizes))splitEnd(state);
    }
    return [...state.sizes];
  }
  // A component may be unmounted while its pointer is captured.
  doc.addEventListener('pointerup',event=>{if(splitterDrag?.pointer===event.pointerId)splitFinish(!splitterDrag.handle.isConnected);},true);
  doc.addEventListener('pointercancel',event=>{if(splitterDrag?.pointer===event.pointerId)splitFinish(true);},true);
  doc.addEventListener('lostpointercapture',event=>{if(splitterDrag?.pointer===event.pointerId && !splitterDrag.handle.isConnected)splitFinish(true);});
  doc.addEventListener('keydown',event=>{if(event.key==='Escape' && splitterDrag){event.preventDefault();splitFinish(true);}});
  doc.addEventListener('click',event=>{const button=closest(event.target,'[data-ui-splitter-reset]');if(button && !disabled(button)){event.preventDefault();splitter(button.dataset.uiSplitterReset,{reset:true});}});
  splitterMobile.addEventListener('change',()=>{if(splitterDrag)splitFinish(true);for(const root of all(doc,'[data-ui-splitter]')){const state=splitterStates.get(root);if(state)splitRender(state);}});
  window.addEventListener('resize',()=>{if(splitterDrag)splitFinish(true);});
  window.addEventListener('blur',()=>{if(splitterDrag)splitFinish(true);});
  const navbarStates = new WeakMap();
  const navbarBreakpoints = {tablet:matchMedia('(min-width: 768px)'),pc:matchMedia('(min-width: 1024px)')};
  function navbarCollapsed(root) { return !navbarBreakpoints[root.classList.contains('navbar-expand-tablet')?'tablet':'pc'].matches; }
  function syncNavbar(state, notify=false) {
    const {root,panel,toggles}=state,collapsed=navbarCollapsed(root),expanded=!collapsed || state.open;
    const wasHidden=panel.hidden,active=doc.activeElement;
    state.collapsed=collapsed;root.dataset.uiNavbarCollapsed=String(collapsed);
    for(const button of toggles) {button.hidden=!collapsed;if(!button.hasAttribute('data-ui-target'))button.setAttribute('data-ui-target','#'+id(root));
      button.setAttribute('aria-controls',id(panel));button.setAttribute('aria-expanded',String(expanded));}
    if(!expanded && !wasHidden) {
      for(const popup of openPopups)if(panel.contains(popup))closePopup(popup);
      if(openSelect && panel.contains(openSelect.select))openSelect.close();
      if(activeDatepicker && panel.contains(activeDatepicker.root))closeDatepicker(activeDatepicker);
      if(tooltip && panel.contains(tooltip.trigger))hideTooltip();
      if(activeInputPicker && panel.contains(activeInputPicker.root))activeInputPicker.close();
    }
    panel.hidden=!expanded;
    if(!expanded && panel.contains(active))toggles.find(button=>!disabled(button))?.focus();
    if(expanded && !collapsed && toggles.includes(active))all(panel,'a[href], button, input, select, [tabindex="0"]').find(item=>!disabled(item) && item.getClientRects().length)?.focus();
    if(notify && expanded && wasHidden)enterMotion(panel);
    if(notify)emit(root,'navtoggle',{expanded,collapsible:collapsed});
  }
  function initNavbar(root) {
    const panel=owned(root,'[data-ui-navbar-panel]','[data-ui-navbar]')[0],toggles=owned(root,'button[data-ui-navbar-toggle]','[data-ui-navbar]');
    if(!panel || !toggles.length)return;
    let state=navbarStates.get(root);
    if(!state || state.panel!==panel){state={root,panel,toggles,open:false};navbarStates.set(root,state);}
    else state.toggles=toggles;
    root.setAttribute('data-ui-navbar-ready','');syncNavbar(state);
  }
  Object.values(navbarBreakpoints).forEach(media=>media.addEventListener('change',()=>{
    for(const root of all(doc,'[data-ui-navbar]')) {
      const state=navbarStates.get(root);if(!state || state.collapsed===navbarCollapsed(root))continue;
      state.open=false;syncNavbar(state);
    }
  }));
  doc.addEventListener('click',event=>{
    const link=closest(event.target,'.nav-link[aria-disabled="true"], .ui-step-link[aria-disabled="true"], .pagination-link[aria-disabled="true"]');
    if(link)event.preventDefault();
  },true);
  doc.addEventListener('click',event=>{
    if(event.defaultPrevented)return;
    const root=closest(event.target,'[data-ui-navbar]'),state=navbarStates.get(root);if(!state)return;
    const toggle=closest(event.target,'button[data-ui-navbar-toggle]');
    if(toggle && state.toggles.includes(toggle) && !disabled(toggle) && state.collapsed) {
      event.preventDefault();state.open=!state.open;syncNavbar(state,true);
    } else {
      const link=closest(event.target,'a[href]');
      if(link && !link.matches('[data-ui-toggle], [data-ui-dismiss]') && !disabled(link) && state.panel.contains(link) && state.collapsed && state.open) {state.open=false;syncNavbar(state,true);}
    }
  });
  doc.addEventListener('keydown',event=>{
    if(event.defaultPrevented || event.key!=='Escape' || openSelect || activeInputPicker || activeDatepicker || tooltip || closest(event.target,'[data-ui-dropdown], [data-ui-popover]'))return;
    const state=navbarStates.get(closest(event.target,'[data-ui-navbar]'));
    if(state?.collapsed && state.open) {event.preventDefault();state.open=false;syncNavbar(state,true);state.toggles.find(button=>!disabled(button))?.focus();}
  });
  function tabData(group) {
    const tabs = owned(group, '[data-ui-toggle="tab"]', '[data-ui-tabs]');
    const panels = owned(group, '[data-ui-panel]', '[data-ui-tabs]');
    return {tabs, panels};
  }
  function tabPanel(tab, panels) {
    const key = tab.dataset.uiTarget;
    return panels.find(panel => panel.dataset.uiPanel === key || '#' + panel.id === key);
  }
  function activateTab(tab, notify = true) {
    const group = tab.closest('[data-ui-tabs]');
    if (!group || disabled(tab)) return;
    const {tabs, panels} = tabData(group);
    const selected = tabPanel(tab, panels);
    if (!selected) return;
    const previous = tabs.find(item => item.getAttribute('aria-selected') === 'true');
    const before = previous?.getBoundingClientRect();
    for (const item of tabs) {
      const panel = tabPanel(item, panels);
      if (!panel) continue;
      item.setAttribute('role','tab');
      item.setAttribute('aria-controls', id(panel));
      item.setAttribute('aria-selected', String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
      panel.setAttribute('role','tabpanel');
      panel.setAttribute('aria-labelledby', id(item));
      panel.tabIndex = 0;
      panel.hidden = panel !== selected;
    }
    const bar = tab.closest('.tabs');
    if (notify && before && previous !== tab && bar && !bar.matches('.tabs-pills')) {
      const after = tab.getBoundingClientRect();
      const vertical = bar.getAttribute('aria-orientation') === 'vertical';
      if (after.width && after.height) motion(tab, [
        {translate:(before.left-after.left)+'px '+(before.top-after.top)+'px', scale:vertical ? '1 '+before.height/after.height : before.width/after.width+' 1'},
        {translate:'0 0',scale:'1 1'}
      ], 'base', 'out', {pseudoElement:'::after'});
    }
    if (notify) emit(group, 'tabchange', {tab, panel:selected});
  }
  function renderPage(group, requested = 1, notify = true) {
    const items = owned(group, '[data-ui-page-item]', '[data-ui-pagination]');
    const parsed = Number(group.dataset.uiPageSize);
    const size = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 8;
    const count = Math.max(1, Math.ceil(items.length / size));
    const page = Math.max(1, Math.min(count, Math.floor(Number(requested)) || 1));
    const previousPage = pageStates.get(group);
    pageStates.set(group, page);
    items.forEach((item, index) => { item.hidden = index < (page - 1) * size || index >= page * size; });
    for (const button of owned(group, '[data-ui-page]', '[data-ui-pagination]')) {
      const value = Number(button.dataset.uiPage);
      if (value === page) button.setAttribute('aria-current','page'); else button.removeAttribute('aria-current');
      button.disabled = value < 1 || value > count;
    }
    for (const button of owned(group, '[data-ui-page-step]', '[data-ui-pagination]')) {
      button.disabled = page + Number(button.dataset.uiPageStep) < 1 || page + Number(button.dataset.uiPageStep) > count;
    }
    for (const status of owned(group, '[data-ui-page-status]', '[data-ui-pagination]')) {
      status.setAttribute('role','status');
      status.textContent = items.length ? `全${items.length}件のうち ${(page - 1) * size + 1}–${Math.min(page * size, items.length)}件を表示` : '0件';
    }
    if (notify && page !== previousPage) items.filter(item=>!item.hidden).forEach(enterMotion);
    if (notify) emit(group, 'pagechange', {page, pageSize:size, total:items.length});
  }
  const validationStates = new WeakMap();
  function fields(form) { return all(form, 'input, select, textarea').filter(field => field.willValidate && !field.closest('.ui-input-popup')); }
  function validateField(field) {
    const form=field.form;
    let state=validationStates.get(form);
    if(!state)validationStates.set(form,state={fields:new Map(),errors:new Map(),generated:new Set()});
    if(!state.fields.has(field))state.fields.set(field,rememberAttributes(field,['aria-invalid','aria-describedby']));
    const valid = field.checkValidity();
    if (!valid && field.getAttribute('aria-invalid') !== 'true') motion(field,[{translate:'-3px 0'},{translate:'3px 0'},{translate:'0 0'}], 'base');
    field.setAttribute('aria-invalid', String(!valid));
    const wrapper = field.closest('[data-ui-field]');
    let error = wrapper?.querySelector('[data-ui-error]') || (field.getAttribute('aria-describedby') || '').split(/\s+/).map(key => doc.getElementById(key)).find(node => node?.hasAttribute('data-ui-error'));
    if (!error && !valid) {
      error = doc.createElement('small');
      error.className = 'ui-invalid-feedback';
      error.setAttribute('data-ui-error','');
      field.after(error);state.generated.add(error);
    }
    if(error && !state.generated.has(error) && !state.errors.has(error)) {
      const restore=rememberAttributes(error,['id','hidden','aria-live']),text=error.textContent;
      state.errors.set(error,()=>{restore();error.textContent=text;});
    }
    if (error) {
      describedBy(field, id(error), true);
      error.setAttribute('aria-live','polite');
      error.hidden = valid;
      error.textContent = valid ? '' : field.dataset.uiMessage || field.validationMessage;
    }
    return valid;
  }
  function updateBoard(board) {
    for (const column of owned(board, '[data-ui-column]', '[data-ui-board]')) {
      const cards = all(column, '[data-ui-card]').filter(card => card.closest('[data-ui-column]') === column);
      const count = column.querySelector('[data-ui-count]');
      if (count) {
        const changed = count.textContent !== String(cards.length);
        count.textContent = String(cards.length);
        if (changed) enterMotion(count);
      }
      const empty = column.querySelector('[data-ui-empty]');
      if (empty) empty.hidden = cards.length > 0;
      cards.forEach(card => {
        card.draggable = true;
        all(card, '[data-ui-move]').forEach(select => { select.value = column.dataset.uiColumn; syncSelect(select); });
      });
    }
  }
  function moveCard(card, column) {
    const board = card.closest('[data-ui-board]');
    const from = card.closest('[data-ui-column]');
    if (!board || column.closest('[data-ui-board]') !== board || column === from) return;
    const before = card.getBoundingClientRect();
    elementMotions.get(card)?.cancel();
    (column.querySelector('[data-ui-cards]') || column).append(card);
    updateBoard(board);
    const after = card.getBoundingClientRect();
    motion(card,[{translate:(before.left-after.left)+'px '+(before.top-after.top)+'px',opacity:.6},{translate:'0 0',opacity:1}], 'slow');
    emit(board, 'move', {card, from:from?.dataset.uiColumn, to:column.dataset.uiColumn});
  }
  function endDrag() {
    if (!dragging) return;
    all(dragging.board, '.drop, .dragged').forEach(item => item.classList.remove('drop','dragged'));
    dragging = null;
  }
  // Calendar dates use local noon; date-only values never go through UTC parsing.
  const calendarStates = new WeakMap();
  function calendarDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
    if (!match || Number(match[1]) < 1) return null;
    const date = new Date(0);
    date.setHours(12,0,0,0);
    date.setFullYear(Number(match[1]), Number(match[2])-1, Number(match[3]));
    return date.getFullYear() === Number(match[1]) && date.getMonth() === Number(match[2])-1 && date.getDate() === Number(match[3]) ? date : null;
  }
  function calendarISO(date) {
    return String(date.getFullYear()).padStart(4,'0') + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
  }
  function calendarShift(date, days) { const next = new Date(date); next.setDate(next.getDate()+days); return next; }
  function calendarMonth(date, delta = 0) {
    const next = new Date(date); next.setDate(1); next.setMonth(next.getMonth()+delta); return next;
  }
  const calendarLabel = date => new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long',day:'numeric',weekday:'long'}).format(date);
  function calendarNode(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function calendarConfig(root) {
    const min = calendarDate(root.dataset.uiMin) || calendarDate('0001-01-01');
    const max = calendarDate(root.dataset.uiMax) || calendarDate('9999-12-31');
    const today = calendarDate(calendarISO(new Date()));
    return {min,max,today,start:root.dataset.uiWeekStart === 'monday' ? 1 : 0};
  }
  const calendarClamp = (date, config) => new Date(Math.max(config.min.getTime(),Math.min(config.max.getTime(),date.getTime())));
  function renderCalendar(root, restore = false) {
    const originalClass=root.classList.contains('ui-calendar');root.classList.add('ui-calendar');
    const config = calendarConfig(root);
    let state = calendarStates.get(root);
    if (!state) {
      const view = calendarNode('div','ui-calendar-view'); view.setAttribute('data-ui-calendar-view','');
      const status = calendarNode('span','visually-hidden'); status.setAttribute('role','status');
      root.append(view,status);
      state = {view,status,focus:'',events:new Map(),dialog:null,createdInput:null,hiddenLists:new Map()}; calendarStates.set(root,state);
      onDispose(root,()=>{state.view.remove();state.status.remove();state.dialog?.remove();state.createdInput?.remove();for(const [list,hidden] of state.hiddenLists)list.hidden=hidden;calendarStates.delete(root);if(!originalClass)root.classList.remove('ui-calendar');});
    }
    const active = state.view.contains(doc.activeElement) ? doc.activeElement : null;
    const activeAction = active?.dataset.uiCalendarAction;
    restore = restore || !!active;
    state.view.replaceChildren();
    if (config.min > config.max) {
      root.dataset.uiValue='';
      owned(root,'[data-ui-calendar-input]','[data-ui-calendar]').forEach(input=>{input.value='';});
      const error=calendarNode('p','alert alert-danger','選択可能な日付の範囲を確認してください。');
      error.setAttribute('role','alert');state.view.append(error);
      return;
    }
    const selected = calendarDate(root.dataset.uiValue);
    const value = selected && selected >= config.min && selected <= config.max ? calendarISO(selected) : '';
    root.dataset.uiValue = value;
    const requested = calendarDate((root.dataset.uiMonth || '') + '-01');
    const month = calendarMonth(calendarClamp(requested || selected || config.today,config));
    const monthKey = calendarISO(month).slice(0,7);
    root.dataset.uiMonth = monthKey;
    let input = owned(root,'[data-ui-calendar-input]','[data-ui-calendar]')[0];
    if (!input && root.dataset.uiName) {
      input = doc.createElement('input'); input.type='hidden'; input.setAttribute('data-ui-calendar-input',''); root.append(input);state.createdInput=input;
    }
    if (input) { input.value = value; if (root.dataset.uiName) input.name = root.dataset.uiName; }
    const events = new Map();
    for (const list of owned(root,'[data-ui-calendar-events]','[data-ui-calendar]')) {
      if(!state.hiddenLists.has(list))state.hiddenLists.set(list,list.hidden);list.hidden = true;
      for (const item of all(list,'[data-ui-date]')) {
        if (!calendarDate(item.dataset.uiDate)) continue;
        const group = events.get(item.dataset.uiDate) || [];
        group.push({text:item.textContent.trim(),variant:['success','warning','danger','info'].includes(item.dataset.uiVariant) ? item.dataset.uiVariant : 'info'});
        events.set(item.dataset.uiDate,group);
      }
    }
    state.events=events;
    const modalOption=root.getAttribute('data-ui-calendar-modal');
    const modalEnabled=modalOption!==null && modalOption!=='false';
    const toolbar = calendarNode('div','ui-calendar-toolbar');
    const title = calendarNode('h3','ui-calendar-title',new Intl.DateTimeFormat('ja-JP',{year:'numeric',month:'long'}).format(month));
    title.tabIndex = -1;
    const actions = calendarNode('div','ui-calendar-actions');
    for (const [action,label,name] of [['prev','‹','前の月'],['today','今日','今日へ移動'],['next','›','次の月']]) {
      const button = calendarNode('button','btn btn-sm btn-outline-secondary',label); button.type='button';
      button.dataset.uiCalendarAction=action; button.setAttribute('aria-label',name);
      button.disabled = action === 'prev' ? calendarMonth(month,-1) < calendarMonth(config.min) : action === 'next' ? calendarMonth(month,1) > calendarMonth(config.max) : config.today < config.min || config.today > config.max;
      actions.append(button);
    }
    toolbar.append(title,actions); state.view.append(toolbar);
    const hint = calendarNode('p','ui-calendar-hint','矢印キーで日付移動、Enterで選択。PageUp / PageDownで月を切り替えます。');
    state.view.append(hint);
    const table = calendarNode('table','ui-calendar-table');
    table.setAttribute('aria-labelledby',id(title)); table.setAttribute('aria-describedby',id(hint));
    const head=doc.createElement('thead'), headings=doc.createElement('tr');
    const weekdays=['日','月','火','水','木','金','土'];
    for(let i=0;i<7;i++) {
      const day=(i+config.start)%7;
      const cell=calendarNode('th',day===0?'is-sunday':day===6?'is-saturday':'',weekdays[day]); cell.scope='col'; headings.append(cell);
    }
    head.append(headings); table.append(head);
    const body=doc.createElement('tbody');
    const first=calendarShift(month,-((month.getDay()-config.start+7)%7));
    let focused=calendarDate(state.focus);
    if (!focused || focused.getMonth()!==month.getMonth() || focused.getFullYear()!==month.getFullYear() || focused<config.min || focused>config.max) {
      focused = value && value.slice(0,7)===monthKey ? calendarDate(value) : calendarISO(config.today).slice(0,7)===monthKey ? calendarClamp(config.today,config) : calendarClamp(month,config);
    }
    state.focus=calendarISO(focused);
    for(let week=0;week<6;week++) {
      const row=doc.createElement('tr');
      for(let day=0;day<7;day++) {
        const date=calendarShift(first,week*7+day), key=calendarISO(date), entries=events.get(key)||[];
        const cell=doc.createElement('td');
        const button=calendarNode('button','ui-calendar-day'); button.type='button'; button.dataset.uiCalendarDate=key;
        button.disabled=date<config.min || date>config.max;
        button.tabIndex=key===state.focus && !button.disabled ? 0 : -1;
        button.classList.toggle('is-outside',date.getMonth()!==month.getMonth());
        button.classList.toggle('is-sunday',date.getDay()===0);button.classList.toggle('is-saturday',date.getDay()===6);
        button.setAttribute('aria-pressed',String(key===value));
        if(modalEnabled)button.setAttribute('aria-haspopup','dialog');
        const today=key===calendarISO(config.today);
        if(today)button.setAttribute('aria-current','date');
        button.setAttribute('aria-label',calendarLabel(date)+(today?'・今日':'')+(entries.length?'・'+entries.length+'件の予定':'')+(button.disabled?'・選択範囲外':''));
        button.append(calendarNode('span','ui-calendar-number',String(date.getDate())));
        if(entries.length) {
          const preview=calendarNode('span','ui-calendar-preview'); preview.setAttribute('aria-hidden','true');
          for(const entry of entries.slice(0,2))preview.append(calendarNode('span','ui-calendar-event is-'+entry.variant,entry.text));
          preview.append(calendarNode('span','ui-calendar-event-count',entries.length+'件'));
          button.append(preview);
        }
        cell.append(button);row.append(cell);
      }
      body.append(row);
    }
    table.append(body); state.view.append(table);
    const agenda=calendarNode('section','ui-calendar-agenda');agenda.hidden=modalEnabled;
    const agendaTitle=calendarNode('h4','ui-calendar-agenda-title',value?calendarLabel(calendarDate(value))+'の予定':'日付を選択してください');
    agenda.setAttribute('aria-labelledby',id(agendaTitle));agenda.append(agendaTitle);
    if(value) {
      const selectedEvents=events.get(value)||[];
      if(selectedEvents.length) {
        const list=calendarNode('ul','ui-calendar-agenda-list');
        selectedEvents.forEach(entry=>list.append(calendarNode('li','ui-calendar-agenda-event is-'+entry.variant,entry.text)));agenda.append(list);
      } else agenda.append(calendarNode('p','ui-calendar-empty','予定はありません。'));
    }
    state.view.append(agenda);
    if(restore) {
      const action=activeAction && state.view.querySelector('[data-ui-calendar-action="'+activeAction+'"]');
      const day=state.view.querySelector('[data-ui-calendar-date="'+state.focus+'"]');
      (action && !action.disabled ? action : activeAction ? title : day)?.focus();
    }
  }
  function changeCalendarMonth(root, date, restore = true) {
    const state=calendarStates.get(root), config=calendarConfig(root);
    const old=root.dataset.uiMonth;
    const clamped=calendarClamp(date,config);
    root.dataset.uiMonth=calendarISO(clamped).slice(0,7);
    if(state)state.focus=calendarISO(clamped);
    renderCalendar(root,restore);
    if(old!==root.dataset.uiMonth) {
      state.status.textContent=root.dataset.uiMonth.replace('-','年')+'月を表示';
      emit(root,'monthchange',{month:root.dataset.uiMonth});
    }
  }
  function openCalendarDay(root,value) {
    const option=root.getAttribute('data-ui-calendar-modal'),state=calendarStates.get(root);
    if(option===null || option==='false' || !state || !root.isConnected)return;
    let dialog;
    if(option==='' || option==='true') {
      dialog=state.dialog;
      if(!dialog) {
        dialog=calendarNode('dialog','ui-dialog ui-calendar-modal');dialog.dataset.uiDialog='';
        const title=calendarNode('h2');title.dataset.uiCalendarModalTitle='';title.tabIndex=-1;title.setAttribute('autofocus','');
        dialog.setAttribute('aria-labelledby',id(title));
        const content=calendarNode('div');content.dataset.uiCalendarModalEvents='';
        const actions=calendarNode('div','buttons');
        const close=calendarNode('button','btn btn-sm btn-outline-secondary','閉じる');close.type='button';close.dataset.uiDismiss='dialog';
        actions.append(close);dialog.append(title,content,actions);root.append(dialog);state.dialog=dialog;
      }
    } else dialog=query(option);
    if(dialog?.tagName!=='DIALOG') {
      state.status.textContent='日付詳細のモーダルが見つかりません。';state.view.querySelector('.ui-calendar-agenda').hidden=false;return;
    }
    dialog.classList.add('ui-calendar-modal');dialog.dataset.uiDialog='';dialog.dataset.uiCalendarModalValue=value;
    const entries=state.events.get(value)||[];
    all(dialog,'[data-ui-calendar-modal-title]').forEach(title=>{title.textContent=calendarLabel(calendarDate(value))+'の予定';});
    all(dialog,'[data-ui-calendar-modal-events]').forEach(content=>{
      content.replaceChildren();
      if(entries.length) {
        const list=calendarNode('ul','ui-calendar-agenda-list');
        entries.forEach(entry=>list.append(calendarNode('li','ui-calendar-agenda-event is-'+entry.variant,entry.text)));content.append(list);
      } else content.append(calendarNode('p','ui-calendar-empty','予定はありません。'));
    });
    const opener=state.view.querySelector('[data-ui-calendar-date="'+value+'"]');
    if(dialog.open)openers.set(dialog,opener);else show(dialog,opener);
    emit(root,'dayopen',{value,dialog,events:entries.map(entry=>({...entry}))});
  }
  function selectCalendarDate(root,date) {
    const config=calendarConfig(root);
    if(date<config.min || date>config.max)return;
    const previousValue=root.dataset.uiValue||'',value=calendarISO(date);
    root.dataset.uiValue=value;
    changeCalendarMonth(root,date,true);
    const state=calendarStates.get(root);
    state.status.textContent=calendarLabel(date)+'を選択しました';
    emit(root,'dateselect',{value,previousValue});
    if(previousValue!==value) {
      const input=owned(root,'[data-ui-calendar-input]','[data-ui-calendar]')[0];
      if(input){input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
      emit(root,'datechange',{value,previousValue});
    }
    openCalendarDay(root,value);
  }
  doc.addEventListener('click',event=>{
    const button=closest(event.target,'[data-ui-calendar-action], [data-ui-calendar-date]');
    const root=button?.closest('[data-ui-calendar]');
    if(!root || disabled(button))return;
    event.preventDefault();
    if(!calendarStates.has(root))renderCalendar(root);
    const action=button.dataset.uiCalendarAction;
    if(action==='today')selectCalendarDate(root,calendarConfig(root).today);
    else if(action)changeCalendarMonth(root,calendarMonth(calendarDate(root.dataset.uiMonth+'-01'),action==='prev'?-1:1));
    else {const date=calendarDate(button.dataset.uiCalendarDate);if(date)selectCalendarDate(root,date);}
  });
  doc.addEventListener('keydown',event=>{
    const button=closest(event.target,'[data-ui-calendar-date]');
    const root=button?.closest('[data-ui-calendar]');
    if(!root || disabled(button))return;
    const current=calendarDate(button.dataset.uiCalendarDate),config=calendarConfig(root);
    let next;
    const offsets={ArrowLeft:-1,ArrowRight:1,ArrowUp:-7,ArrowDown:7};
    if(event.key in offsets)next=calendarShift(current,offsets[event.key]);
    if(event.key==='Home')next=calendarShift(current,-((current.getDay()-config.start+7)%7));
    if(event.key==='End')next=calendarShift(current,6-((current.getDay()-config.start+7)%7));
    if(event.key==='PageUp' || event.key==='PageDown') {
      next=calendarMonth(current,(event.key==='PageUp'?-1:1)*(event.shiftKey?12:1));
      const last=calendarShift(calendarMonth(next,1),-1).getDate();next.setDate(Math.min(current.getDate(),last));
    }
    if(!next)return;
    event.preventDefault();changeCalendarMonth(root,next,true);
  });

  // A real date input owns form values/constraints; the calendar is an optional picker.
  const datepickerStates = new WeakMap();
  let activeDatepicker = null;
  const datepickerLocked = input => input.readOnly || input.matches(':disabled');
  function syncDatepicker(state, resetMonth = false) {
    const {input,calendar,toggle,clear} = state;
    calendar.dataset.uiWeekStart=state.root.dataset.uiWeekStart || 'sunday';
    toggle.disabled = datepickerLocked(input);
    clear.disabled = datepickerLocked(input) || !input.value;
    for (const [attribute,value] of [['data-ui-value',input.value],['data-ui-min',input.min],['data-ui-max',input.max]]) {
      if(value)calendar.setAttribute(attribute,value);else calendar.removeAttribute(attribute);
    }
    if(resetMonth) {
      const selected=calendarDate(input.value);
      calendar.dataset.uiMonth=calendarISO(selected || calendarConfig(calendar).today).slice(0,7);
      const calendarState=calendarStates.get(calendar);if(calendarState)calendarState.focus=input.value;
    }
    renderCalendar(calendar);
  }
  function positionDatepicker(state) {
    const {root,popup} = state;
    const box=root.getBoundingClientRect();
    const below=Math.max(0,window.innerHeight-box.bottom-8);
    const above=Math.max(0,Math.min(box.top,window.innerHeight)-8);
    const natural=popup.getBoundingClientRect().height;
    const placeBelow=below>=natural || below>=above;
    const available=Math.min(window.innerHeight-16,Math.max(80,placeBelow?below:above));
    popup.style.maxHeight=Math.max(0,available)+'px';
    const bounds=popup.getBoundingClientRect();
    popup.style.left=Math.max(8,Math.min(box.left,window.innerWidth-bounds.width-8))+'px';
    const desired=placeBelow?box.bottom+8:box.top-bounds.height-8;
    popup.style.top=Math.max(8,Math.min(desired,window.innerHeight-bounds.height-8))+'px';
  }
  function closeDatepicker(state, restore = false) {
    if(!state)return;
    if(state.open)exitMotion(state.popup);
    state.open=false;
    if(state.popup.hidePopover && state.popup.matches(':popover-open'))state.popup.hidePopover();
    else state.popup.hidden=true;
    state.toggle.setAttribute('aria-expanded','false');
    if(activeDatepicker===state)activeDatepicker=null;
    if(restore && state.input.isConnected)state.input.focus();
  }
  function openDatepicker(root) {
    const state=initDatepicker(root);
    if(!state || datepickerLocked(state.input))return;
    if(state.open){closeDatepicker(state,true);return;}
    if(activeDatepicker)closeDatepicker(activeDatepicker);
    cancelExit(state.popup);
    syncDatepicker(state,true);
    state.popup.style.maxHeight='calc(100dvh - 16px)';
    state.popup.hidden=false;
    if(state.popup.showPopover)state.popup.showPopover();
    state.open=true;activeDatepicker=state;
    state.toggle.setAttribute('aria-expanded','true');
    positionDatepicker(state);
    (state.calendar.querySelector('[data-ui-calendar-date][tabindex="0"]') || state.popup.querySelector('button:not(:disabled)'))?.focus();
  }
  function updateDatepickerButton(state) {
    const icon=state.root.dataset.uiDatepickerButton === 'icon';
    if(state.iconMode===icon)return;
    state.iconMode=icon;
    state.toggle.classList.toggle('ui-datepicker-toggle-icon',icon);
    state.toggle.replaceChildren();
    if(icon) {
      const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');
      svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');svg.setAttribute('focusable','false');
      const path=doc.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2m0 16H5V10h14v10m0-12H5V6h14v2M7 12h5v5H7z');
      svg.append(path);state.toggle.append(svg);
      state.toggle.title=state.toggle.getAttribute('aria-label');
    } else {
      state.toggle.textContent='カレンダー';state.toggle.removeAttribute('title');
    }
  }
  function initDatepicker(root) {
    let state=datepickerStates.get(root);
    if(state){
      state.toggle.disabled=datepickerLocked(state.input);
      updateDatepickerButton(state);
      if(state.open){if(state.toggle.disabled)closeDatepicker(state);else syncDatepicker(state,state.calendar.dataset.uiValue!==state.input.value);}
      return state;
    }
    const input=all(root,'input[type="date"]').find(field=>field.closest('[data-ui-datepicker]')===root);
    if(!input)return null;
    const listen=scopedEvents(root),originalClass=root.classList.contains('ui-datepicker');
    root.classList.add('ui-datepicker');
    const name=input.getAttribute('aria-label') || input.labels?.[0]?.textContent.trim() || '日付';
    const toggle=calendarNode('button','btn btn-outline-secondary ui-datepicker-toggle','カレンダー');
    toggle.type='button';toggle.setAttribute('data-ui-datepicker-action','toggle');
    toggle.setAttribute('aria-label',name+'のカレンダーを開く');toggle.setAttribute('aria-haspopup','dialog');toggle.setAttribute('aria-expanded','false');
    const popup=calendarNode('div','ui-datepicker-popup');popup.hidden=true;popup.setAttribute('popover','auto');popup.setAttribute('role','dialog');popup.setAttribute('aria-label',name+'を選択');
    const calendar=calendarNode('div','ui-calendar ui-calendar-compact');calendar.setAttribute('data-ui-calendar','');
    if(root.dataset.uiWeekStart)calendar.dataset.uiWeekStart=root.dataset.uiWeekStart;
    const footer=calendarNode('div','ui-datepicker-footer');
    const clear=calendarNode('button','btn btn-sm btn-outline-secondary','クリア');clear.type='button';clear.setAttribute('data-ui-datepicker-action','clear');
    const close=calendarNode('button','btn btn-sm btn-outline-secondary','閉じる');close.type='button';close.setAttribute('data-ui-datepicker-action','close');
    footer.append(clear,close);popup.append(calendar,footer);root.append(toggle,popup);
    toggle.setAttribute('aria-controls',id(popup));
    state={root,input,toggle,popup,calendar,clear,open:false,syncing:false};datepickerStates.set(root,state);
    updateDatepickerButton(state);
    toggle.disabled=datepickerLocked(input);
    listen(popup,'toggle',event=>{
      if(event.newState==='closed' && state.open){state.open=false;toggle.setAttribute('aria-expanded','false');if(activeDatepicker===state)activeDatepicker=null;}
    });
    onDispose(root,()=>{closeDatepicker(state);toggle.remove();popup.remove();calendarStates.delete(calendar);datepickerStates.delete(root);if(!originalClass)root.classList.remove('ui-datepicker');});
    return state;
  }
  function setDatepickerValue(state,value) {
    if(datepickerLocked(state.input)){closeDatepicker(state);return;}
    const previousValue=state.input.value;
    state.input.value=value;
    state.syncing=true;
    try {
      if(previousValue!==state.input.value){state.input.dispatchEvent(new Event('input',{bubbles:true}));state.input.dispatchEvent(new Event('change',{bubbles:true}));}
    } finally {state.syncing=false;}
    closeDatepicker(state,true);
  }
  doc.addEventListener('click',event=>{
    const button=closest(event.target,'[data-ui-datepicker-action]');
    const root=button?.closest('[data-ui-datepicker]');
    if(!root || disabled(button))return;
    event.preventDefault();
    const state=initDatepicker(root);if(!state)return;
    if(button.dataset.uiDatepickerAction==='toggle')openDatepicker(root);
    else if(button.dataset.uiDatepickerAction==='clear')setDatepickerValue(state,'');
    else closeDatepicker(state,true);
  });
  doc.addEventListener('ui:dateselect',event=>{
    const root=closest(event.target,'[data-ui-datepicker]');
    const state=root && datepickerStates.get(root);
    if(state?.calendar===event.target){
      setDatepickerValue(state,event.detail.value);
    }
  });
  doc.addEventListener('input',event=>{
    const root=closest(event.target,'[data-ui-datepicker]'),state=root && datepickerStates.get(root);
    if(state && event.target===state.input && !state.syncing && state.open)syncDatepicker(state,true);
  });
  doc.addEventListener('change',event=>{
    const root=closest(event.target,'[data-ui-datepicker]'),state=root && datepickerStates.get(root);
    if(state && event.target===state.input && !state.syncing && state.open)syncDatepicker(state,true);
  });
  doc.addEventListener('keydown',event=>{
    const root=closest(event.target,'[data-ui-datepicker]'),state=root && datepickerStates.get(root);
    if(!state)return;
    if(event.key==='Escape' && state.open){event.preventDefault();event.stopPropagation();closeDatepicker(state,true);}
    if(event.key==='ArrowDown' && event.altKey && event.target===state.input){event.preventDefault();openDatepicker(root);}
  });
  doc.addEventListener('pointerdown',event=>{if(activeDatepicker && !activeDatepicker.root.contains(event.target))closeDatepicker(activeDatepicker);});
  doc.addEventListener('focusout',event=>{
    const state=activeDatepicker;
    if(state && state.root.contains(event.target) && event.relatedTarget && !state.root.contains(event.relatedTarget))closeDatepicker(state);
  });
  doc.addEventListener('reset',event=>{
    queueMicrotask(()=>{
      if(event.defaultPrevented)return;
      all(event.target,'[data-ui-datepicker]').forEach(root=>{
        const state=datepickerStates.get(root);if(!state)return;
        closeDatepicker(state);state.input.removeAttribute('aria-invalid');
        const error=state.input.closest('[data-ui-field]')?.querySelector('[data-ui-error]');
        if(error){error.hidden=true;error.textContent='';}
      });
    });
  });
  window.addEventListener('resize',()=>{if(activeDatepicker)positionDatepicker(activeDatepicker);});
  doc.addEventListener('scroll',event=>{
    if(activeDatepicker && !activeDatepicker.popup.contains(event.target))positionDatepicker(activeDatepicker);
  },true);

  // Saves the pre-request state once; repeated starts do not overwrite it.
  const loadingStates = new WeakMap();
  function loading(target, active = true) {
    const element = typeof target === 'string' ? query(target) : target;
    if (!(element instanceof Element)) return false;
    if (active) {
      if (!loadingStates.has(element)) loadingStates.set(element, {
        busy:element.getAttribute('aria-busy'),
        disabled:element instanceof HTMLButtonElement ? element.disabled : null
      });
      element.setAttribute('aria-busy', 'true');
      if (element instanceof HTMLButtonElement) element.disabled = true;
    } else {
      const previous = loadingStates.get(element);
      if (!previous) return false;
      if (previous.busy === null) element.removeAttribute('aria-busy');
      else element.setAttribute('aria-busy', previous.busy);
      if (previous.disabled !== null) element.disabled = previous.disabled;
      loadingStates.delete(element);
    }
    return true;
  }

  // Keep native form values and constraints; render the single-select popup ourselves.
  const selectControls = new WeakMap();
  let openSelect = null;
  function syncSelect(select) { selectControls.get(select)?.sync(); }
  function initSelect(select) {
    const listen=scopedEvents(select);
    if (selectControls.has(select)) { syncSelect(select); return; }
    if (select.multiple || select.size > 1 || !HTMLElement.prototype.showPopover) return;
    const original={tabindex:select.getAttribute('tabindex'),hidden:select.getAttribute('aria-hidden')};
    const wrapper = doc.createElement('span'); wrapper.className = 'ui-select';
    const button = doc.createElement('button'); button.type = 'button';
    button.className = select.className;
    button.classList.add('form-select','ui-select-trigger');
    if(select.hasAttribute('tabindex'))button.tabIndex=select.tabIndex;
    // Width belongs to the wrapper; reuse the utilities for all device ranges.
    for(const name of select.classList)if(name==='w-auto' || /^(?:(?:tablet|mobile):)?ui-w-/.test(name)) {
      wrapper.classList.add(name);button.classList.remove(name);
    }
    button.style.cssText = select.style.cssText;
    if (select.style.width) wrapper.style.width = select.style.width;
    button.setAttribute('role','combobox'); button.setAttribute('aria-haspopup','listbox');
    button.setAttribute('aria-expanded','false');
    const popup = doc.createElement('div'); popup.className = 'ui-select-menu';
    popup.setAttribute('popover','auto'); popup.setAttribute('role','listbox');
    button.setAttribute('aria-controls',id(popup));
    select.before(wrapper); wrapper.append(select, button, popup);
    select.classList.add('ui-select-native'); select.tabIndex = -1;
    select.setAttribute('aria-hidden','true');
    let active = -1, search = '', searchedAt = 0, nativeError = null;
    const enabled = option => !!option && !option.disabled && !option.hidden && !option.closest('optgroup')?.disabled && !option.closest('optgroup')?.hidden;
    const isOpen = () => popup.matches(':popover-open');
    function syncControl() {
      button.disabled = select.matches(':disabled');
      wrapper.hidden=select.hidden;
      button.textContent = select.selectedOptions[0]?.label || '選択してください';
      const labels = [...(select.labels || [])];
      const labelText=labels.map(label=>{const clone=label.cloneNode(true);all(clone,'select, input, textarea, button, .ui-select, .ui-invalid-feedback, [data-ui-error]').forEach(node=>node.remove());return clone.textContent.trim();}).join(' ');
      const labelledby = select.getAttribute('aria-labelledby');
      if (labelledby) button.setAttribute('aria-labelledby',labelledby);
      else {button.removeAttribute('aria-labelledby');button.setAttribute('aria-label',select.getAttribute('aria-label') || labelText || '選択してください');}
      for (const attribute of ['aria-describedby','aria-invalid']) {
        if(select.hasAttribute(attribute)) button.setAttribute(attribute,select.getAttribute(attribute));
        else button.removeAttribute(attribute);
      }
      button.setAttribute('aria-required',String(select.required));
      popup.setAttribute('aria-label',select.getAttribute('aria-label') || labelText || '選択肢');
      if(nativeError) {
        nativeError.hidden=select.validity.valid;
        if(!select.validity.valid) {describedBy(button,id(nativeError),true);button.setAttribute('aria-invalid','true');}
      }
      if (button.disabled && isOpen()) close();
    }
    function highlight(index) {
      active = index;
      all(popup,'[role="option"]').forEach(item=>item.classList.toggle('is-active',Number(item.dataset.index)===active));
      const item = popup.querySelector('[data-index="'+active+'"]');
      if(item) { button.setAttribute('aria-activedescendant',item.id); item.scrollIntoView({block:'nearest'}); }
      else button.removeAttribute('aria-activedescendant');
    }
    function render() {
      popup.replaceChildren();
      for (const child of select.children) {
        if(child.hidden)continue;
        if(child.tagName==='OPTGROUP') {
          const heading=doc.createElement('div');heading.className='ui-select-group';heading.textContent=child.label;popup.append(heading);
        }
        const options=child.tagName==='OPTGROUP'?[...child.children]:[child];
        for(const option of options) {
          if(option.tagName!=='OPTION' || option.hidden) continue;
          const item=doc.createElement('div');item.className='ui-select-option';
          item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));
          item.setAttribute('aria-disabled',String(!enabled(option)));id(item);
          item.dataset.index=String([...select.options].indexOf(option));item.textContent=option.label;
          popup.append(item);
        }
      }
    }
    function close() {
      if(isOpen()) { exitMotion(popup); popup.hidePopover(); }
      button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');
      if(openSelect?.select===select) openSelect=null;
    }
    function open() {
      syncControl();if(button.disabled || isOpen())return;
      openSelect?.close();render();popup.showPopover();
      const r=button.getBoundingClientRect(), gap=6, margin=8;
      const width=Math.min(Math.max(r.width,180),innerWidth-margin*2);
      const below=innerHeight-r.bottom-gap-margin, above=r.top-gap-margin;
      const upwards=below<Math.min(popup.scrollHeight,220) && above>below;
      const height=Math.min(320,Math.max(40,upwards?above:below));
      Object.assign(popup.style,{width:width+'px',maxHeight:height+'px',left:Math.max(margin,Math.min(r.left,innerWidth-width-margin))+'px',top:'0px'});
      popup.style.top=(upwards?Math.max(margin,r.top-gap-popup.getBoundingClientRect().height):r.bottom+gap)+'px';
      button.setAttribute('aria-expanded','true');openSelect={select,popup,close};
      const index=enabled(select.options[select.selectedIndex])?select.selectedIndex:[...select.options].findIndex(enabled);
      highlight(index);enterMotion(popup);
    }
    function commit(index) {
      const option=select.options[index];if(!option || !enabled(option))return;
      const previous=select.selectedIndex;select.selectedIndex=index;close();syncControl();
      if(previous!==index) {
        select.dispatchEvent(new Event('input',{bubbles:true}));select.dispatchEvent(new Event('change',{bubbles:true}));
      }
      button.focus();
    }
    // Light dismiss closes the menu after pointerup, before this click, so remember it was open.
    let pointerWasOpen=false;
    listen(button,'pointerdown',()=>{pointerWasOpen=isOpen();});
    listen(button,'pointercancel',()=>{pointerWasOpen=false;});
    listen(button,'click',()=>{const wasOpen=pointerWasOpen||isOpen();pointerWasOpen=false;if(wasOpen)close();else open();});
    listen(button,'keydown',event=>{
      const options=[...select.options];
      if(event.key==='Escape' && isOpen()) { event.preventDefault();event.stopPropagation();close();return; }
      if(event.key==='Tab') { close();return; }
      if(['Enter',' '].includes(event.key)) {
        event.preventDefault();if(isOpen())commit(active);else open();return;
      }
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault();const wasOpen=isOpen();if(!wasOpen)open();
        const indices=options.map((option,index)=>enabled(option)?index:-1).filter(index=>index>=0);
        let position=indices.indexOf(active);
        if(event.key==='Home')position=0;
        else if(event.key==='End')position=indices.length-1;
        else position=Math.max(0,Math.min(indices.length-1,position+(event.key==='ArrowDown'?1:-1)));
        highlight(indices[position]??-1);return;
      }
      if(event.key.length===1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();if(!isOpen())open();
        const now=Date.now();search=(now-searchedAt>700?'':search)+event.key.toLocaleLowerCase();searchedAt=now;
        const index=options.findIndex(option=>enabled(option) && option.label.toLocaleLowerCase().startsWith(search));
        if(index>=0)highlight(index);
      }
    });
    listen(popup,'pointerdown',event=>event.preventDefault());
    listen(popup,'click',event=>{
      const item=closest(event.target,'[role="option"]');if(item)commit(Number(item.dataset.index));
    });
    listen(popup,'toggle',()=>{if(!isOpen()){button.setAttribute('aria-expanded','false');button.removeAttribute('aria-activedescendant');if(openSelect?.select===select)openSelect=null;}});
    listen(button,'blur',close);
    listen(select,'focus',()=>button.focus());
    listen(select,'change',syncControl);
    listen(select,'input',syncControl);
    listen(select,'invalid',event=>{
      event.preventDefault();button.setAttribute('aria-invalid','true');
      if(!select.closest('form[data-ui-validate]')) {
        if(!nativeError) {nativeError=doc.createElement('small');nativeError.className='ui-invalid-feedback';nativeError.setAttribute('role','alert');wrapper.after(nativeError);}
        nativeError.hidden=false;nativeError.textContent=select.dataset.uiMessage || select.validationMessage;describedBy(button,id(nativeError),true);
      }
      button.focus();
    });
    for(const label of select.labels || [])listen(label,'click',event=>{
      if(event.target===label || !closest(event.target,'button, select, a, input, textarea')){event.preventDefault();button.focus();}
    });
    listen(select.form,'reset',()=>setTimeout(()=>{close();syncControl();},0));
    const observer=new MutationObserver(()=>{syncControl();if(isOpen()){render();highlight(select.selectedIndex);}});
    observer.observe(select,{attributes:true,childList:true,subtree:true,characterData:true});
    for(let parent=select.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='FIELDSET')observer.observe(parent,{attributes:true,attributeFilter:['disabled']});
    onDispose(select,()=>{observer.disconnect();close();nativeError?.remove();select.classList.remove('ui-select-native');
      for(const [name,value] of [['tabindex',original.tabindex],['aria-hidden',original.hidden]]){if(value===null)select.removeAttribute(name);else select.setAttribute(name,value);}
      if(wrapper.parentNode)wrapper.replaceWith(select);selectControls.delete(select);
    });
    selectControls.set(select,{sync:()=>{syncControl();if(isOpen()){render();highlight(select.selectedIndex);}}});syncControl();
  }
  window.addEventListener('resize',()=>withoutExitMotion(()=>openSelect?.close()));
  doc.addEventListener('scroll',event=>{if(openSelect && !openSelect.popup.contains(event.target))withoutExitMotion(()=>openSelect.close());},true);

  const inputPickers = new WeakMap();
  let activeInputPicker = null;
  const pickerTypes = {time:'時刻', 'datetime-local':'日時', month:'月', week:'週', color:'色'};
  function initInputPicker(input) {
    const listen=scopedEvents(input);
    if(inputPickers.has(input)) { inputPickers.get(input).sync(); return; }
    const type=input.getAttribute('type');
    if(!pickerTypes[type] || !HTMLElement.prototype.showPopover)return;
    const original={tabindex:input.getAttribute('tabindex'),hidden:input.getAttribute('aria-hidden')};
    const root=calendarNode('span','ui-input-picker');
    const trigger=calendarNode('button',input.className+' ui-input-picker-trigger');trigger.type='button';
    trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-expanded','false');
    if(input.hasAttribute('tabindex'))trigger.tabIndex=input.tabIndex;
    const popup=calendarNode('div','ui-input-popup');popup.setAttribute('popover','auto');popup.setAttribute('role','dialog');
    trigger.setAttribute('aria-controls',id(popup));
    input.before(root);root.append(input,trigger,popup);
    input.classList.add('ui-picker-native');input.tabIndex=-1;input.setAttribute('aria-hidden','true');
    const state={root,input,trigger,popup,sync};inputPickers.set(input,state);
    let controls={},error=null,pointerWasOpen=false,nativeFeedback=null;
    const locked=()=>input.matches(':disabled') || input.readOnly;
    const opened=()=>popup.matches(':popover-open');
    const pad=value=>String(value).padStart(2,'0');
    function labelText() {
      return input.getAttribute('aria-label') || [...(input.labels || [])].map(label=>{
        const clone=label.cloneNode(true);all(clone,'input, button, select, .ui-input-picker, [data-ui-error], small').forEach(node=>node.remove());return clone.textContent.trim();
      }).join(' ') || pickerTypes[type];
    }
    function sync() {
      root.hidden=input.hidden;trigger.disabled=locked();
      const value=input.value;
      trigger.textContent=value || pickerTypes[type]+'を選択';
      if(type==='color') {const swatch=calendarNode('span','ui-color-preview');swatch.style.backgroundColor=value;swatch.setAttribute('aria-hidden','true');trigger.prepend(swatch);}
      trigger.setAttribute('aria-label',labelText()+'：'+(value || '未選択'));
      popup.setAttribute('aria-label',labelText()+'を選択');
      for(const attribute of ['aria-describedby','aria-invalid']) {
        if(input.hasAttribute(attribute))trigger.setAttribute(attribute,input.getAttribute(attribute));else trigger.removeAttribute(attribute);
      }
      const feedback=root.nextElementSibling;
      if(feedback?.hasAttribute('data-ui-picker-error') && input.validity.valid)feedback.hidden=true;
      if(locked() && opened())close();
    }
    function position() {
      const r=trigger.getBoundingClientRect();
      popup.style.maxHeight=(innerHeight-16)+'px';
      const below=innerHeight-r.bottom-8,above=r.top-8;
      const down=popup.getBoundingClientRect().height<=below || below>=above;
      popup.style.maxHeight=Math.max(0,Math.min(innerHeight-16,down?below:above))+'px';
      const box=popup.getBoundingClientRect();
      popup.style.left=Math.max(8,Math.min(r.left,innerWidth-box.width-8))+'px';
      popup.style.top=Math.max(8,Math.min(down?r.bottom+8:r.top-box.height-8,innerHeight-box.height-8))+'px';
    }
    function close(restore=false) {
      if(opened()){openSelect?.close();exitMotion(popup);popup.hidePopover();}
      trigger.setAttribute('aria-expanded','false');if(activeInputPicker===state)activeInputPicker=null;
      if(restore && trigger.isConnected)trigger.focus();
    }
    state.close=close;state.position=position;
    function field(title,part,tag='select') {
      const label=calendarNode('label','ui-picker-field',title);
      const field=calendarNode(tag,tag==='select'?'form-select form-select-sm':'form-control form-control-sm');
      field.dataset.uiPickerPart=part;
      // Draft controls must not participate in the owning form's native validation.
      field.setAttribute('form',popup.id+'-draft');
      if(tag==='input')field.type='number';
      label.append(field);controls[part]=field;return label;
    }
    function options(select,count,start=0,format=String) {
      for(let n=start;n<start+count;n++)select.add(new Option(format(n),String(n)));
    }
    function weeksIn(year) {
      const first=new Date(0);first.setUTCFullYear(year,0,1);const day=first.getUTCDay();
      return day===4 || (day===3 && year%4===0 && (year%100!==0 || year%400===0))?53:52;
    }
    function refreshWeeks() {
      if(!controls.week)return;
      const previous=Number(controls.week.value)||1;controls.week.replaceChildren();
      options(controls.week,weeksIn(Number(controls.year.value)||new Date().getFullYear()),1,n=>'第'+n+'週');
      controls.week.value=String(Math.min(previous,controls.week.options.length));syncSelect(controls.week);
    }
    function render() {
      destroy(popup);popup.replaceChildren();controls={};
      const now=new Date(),value=input.value;
      if(type==='datetime-local') {
        const calendar=calendarNode('div','ui-calendar ui-calendar-compact');calendar.dataset.uiCalendar='';
        calendar.dataset.uiValue=value.slice(0,10)||calendarISO(now);calendar.dataset.uiMonth=calendar.dataset.uiValue.slice(0,7);
        if(input.min)calendar.dataset.uiMin=input.min.slice(0,10);if(input.max)calendar.dataset.uiMax=input.max.slice(0,10);
        controls.calendar=calendar;popup.append(calendar);renderCalendar(calendar);
      }
      const row=calendarNode('div','ui-picker-fields');
      if(type==='month' || type==='week') {
        row.append(field('年','year','input'),field(type==='month'?'月':'週',type));
        Object.assign(controls.year,{min:'1',max:'9999',step:'1',value:value.slice(0,4)||String(now.getFullYear())});
        if(type==='month') {options(controls.month,12,1,n=>n+'月');controls.month.value=String(Number(value.slice(5,7))||now.getMonth()+1);}
        else {refreshWeeks();controls.week.value=String(Number(value.slice(6,8))||1);listen(controls.year,'input',refreshWeeks);}
      }
      if(type==='time' || type==='datetime-local') {
        row.append(field('時','hour'),field('分','minute'));
        options(controls.hour,24,0,pad);options(controls.minute,60,0,pad);
        const time=(type==='time'?value:value.split('T')[1]) || '09:00';
        controls.hour.value=String(Number(time.slice(0,2)));controls.minute.value=String(Number(time.slice(3,5)));
        if(input.step==='any' || (input.step && Number(input.step)<60) || time.length>5) {
          row.append(field('秒','second','input'));Object.assign(controls.second,{min:'0',max:'59.999',step:'0.001',value:String(Number(time.slice(6))||0)});
        }
      }
      if(type==='color') {
        const palette=calendarNode('div','ui-color-palette');palette.setAttribute('role','group');palette.setAttribute('aria-label','色の候補');
        for(const color of ['#2f6fc4','#6b9de0','#2b95a9','#3d9a63','#d4a537','#cf4f4f','#a86cc1','#e789ab','#ffffff','#faf9f7','#c8c9cc','#8a8d94','#555961','#2b2b2e','#1b1c1e','#000000']) {
          const choice=calendarNode('button','ui-color-choice');choice.type='button';choice.style.backgroundColor=color;choice.setAttribute('aria-label',color);choice.setAttribute('aria-pressed',String(value.toLowerCase()===color));
          listen(choice,'click',()=>{controls.hex.value=color;all(palette,'button').forEach(button=>button.setAttribute('aria-pressed',String(button===choice)));});palette.append(choice);
        }
        popup.append(palette);row.append(field('カラーコード（#RRGGBB）','hex','input'));
        Object.assign(controls.hex,{type:'text',value:value||'#000000',maxLength:7,placeholder:'#2f6fc4'});controls.hex.spellcheck=false;
      }
      popup.append(row);
      error=calendarNode('p','ui-picker-error');error.hidden=true;error.setAttribute('role','alert');popup.append(error);
      const footer=calendarNode('div','ui-picker-footer');
      const clear=calendarNode('button','btn btn-sm btn-outline-secondary','クリア');clear.type='button';clear.disabled=type==='color';listen(clear,'click',()=>save(''));
      const cancel=calendarNode('button','btn btn-sm btn-outline-secondary','キャンセル');cancel.type='button';listen(cancel,'click',()=>close(true));
      const apply=calendarNode('button','btn btn-sm btn-primary','適用');apply.type='button';apply.dataset.uiPickerApply='';listen(apply,'click',applyDraft);
      footer.append(clear,cancel,apply);popup.append(footer);
      all(popup,'select').forEach(initSelect);
    }
    function save(value) {
      if(locked()) {close();return;}
      const previous=input.value;input.value=value;sync();close(true);
      if(previous!==input.value) {input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));}
    }
    function showError(message,field) {error.hidden=false;error.textContent=message;position();field?.focus();}
    function applyDraft() {
      if(locked()) {close();return;}
      let value='';
      if(type==='month' || type==='week') {
        if(!controls.year.validity.valid || !controls.year.value) {showError('年を1〜9999で入力してください。',controls.year);return;}
        value=String(controls.year.value).padStart(4,'0')+'-'+(type==='week'?'W':'')+pad(controls[type].value);
      } else if(type==='color') {
        value=controls.hex.value.trim();
        if(!/^#[0-9a-f]{6}$/i.test(value)) {showError('#に続けて6桁の16進数で入力してください。',controls.hex);return;}
      } else {
        if(controls.second && (!controls.second.value || !controls.second.validity.valid)) {showError('秒を0〜59.999で入力してください。',controls.second);return;}
        value=pad(controls.hour.value)+':'+pad(controls.minute.value);
        if(controls.second){const [seconds,fraction]=controls.second.value.split('.');value+=':'+pad(seconds)+(fraction?'.'+fraction:'');}
        if(type==='datetime-local')value=(controls.calendar.dataset.uiValue||'')+'T'+value;
      }
      const previous=input.value;input.value=value;
      const valid=!!input.value && input.validity.valid;
      const message=input.validationMessage;input.value=previous;
      if(!valid) {showError(message||'指定された範囲・間隔で値を選択してください。');return;}
      save(value);
    }
    function open() {
      if(locked())return;if(opened()){close(true);return;}
      activeInputPicker?.close();render();cancelExit(popup);popup.showPopover();position();
      trigger.setAttribute('aria-expanded','true');activeInputPicker=state;enterMotion(popup);
      (popup.querySelector('.ui-calendar-day[tabindex="0"]') || popup.querySelector('.ui-select-trigger, input:not(.ui-select-native), button') || popup).focus({preventScroll:true});
    }
    listen(trigger,'pointerdown',()=>{pointerWasOpen=opened();});
    listen(trigger,'pointercancel',()=>{pointerWasOpen=false;});
    listen(trigger,'click',()=>{if(pointerWasOpen){pointerWasOpen=false;close(true);}else open();});listen(input,'focus',()=>trigger.focus());
    listen(input,'input',sync);listen(input,'change',sync);
    listen(input,'invalid',event=>{
      event.preventDefault();trigger.setAttribute('aria-invalid','true');
      if(!input.closest('form[data-ui-validate]')) {
        let feedback=root.nextElementSibling;
        if(!feedback?.hasAttribute('data-ui-picker-error')){feedback=calendarNode('small','ui-invalid-feedback');feedback.dataset.uiPickerError='';root.after(feedback);nativeFeedback=feedback;}
        feedback.textContent=input.validationMessage;feedback.hidden=false;feedback.setAttribute('role','alert');describedBy(trigger,id(feedback),true);
      }
      trigger.focus();
    });
    listen(popup,'keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}
      else if(event.key==='Enter' && event.target.tagName==='INPUT'){event.preventDefault();applyDraft();}
    });
    listen(popup,'toggle',()=>{if(!opened()){trigger.setAttribute('aria-expanded','false');if(activeInputPicker===state)activeInputPicker=null;}});
    listen(root,'focusout',()=>setTimeout(()=>{if(opened() && !root.contains(doc.activeElement))close();},0));
    for(const label of input.labels || [])listen(label,'click',event=>{if(popup.contains(event.target))return;if(event.target===label || !closest(event.target,'input, button, select, a')){event.preventDefault();trigger.focus();}});
    listen(input.form,'reset',()=>setTimeout(()=>{close();sync();},0));
    const observer=new MutationObserver(sync);observer.observe(input,{attributes:true});
    for(let parent=input.parentElement;parent;parent=parent.parentElement)if(parent.tagName==='FIELDSET')observer.observe(parent,{attributes:true,attributeFilter:['disabled']});
    onDispose(input,()=>{observer.disconnect();destroy(popup);close();nativeFeedback?.remove();input.classList.remove('ui-picker-native');
      for(const [name,value] of [['tabindex',original.tabindex],['aria-hidden',original.hidden]]){if(value===null)input.removeAttribute(name);else input.setAttribute(name,value);}
      if(root.parentNode)root.replaceWith(input);inputPickers.delete(input);
    });
    sync();
  }
  window.addEventListener('resize',()=>activeInputPicker?.position());
  doc.addEventListener('scroll',event=>{
    if(!activeInputPicker || activeInputPicker.popup.contains(event.target))return;
    const bounds=activeInputPicker.trigger.getBoundingClientRect();
    if(bounds.bottom<0 || bounds.top>innerHeight)withoutExitMotion(()=>activeInputPicker.close());else activeInputPicker.position();
  },true);

  const mixedCheckboxes = new WeakSet();
  function initMixedCheckbox(input) {
    if(mixedCheckboxes.has(input))return;
    mixedCheckboxes.add(input);
    const listen=scopedEvents(input),original=input.indeterminate;let resetTimer;
    const initial=input.dataset.uiIndeterminate!=='false';input.indeterminate=initial;
    listen(input.form,'reset',event=>{clearTimeout(resetTimer);resetTimer=setTimeout(()=>{if(!event.defaultPrevented)input.indeterminate=initial;},0);});
    onDispose(input,()=>{clearTimeout(resetTimer);input.indeterminate=original;mixedCheckboxes.delete(input);});
  }
  // MDI 7.4.47: paths from assets/icons/mdi/*.svg; see its LICENSE and README.
  // Embedded deliberately: file:// does not need fetch, imports or a server.
  const mdiPaths = Object.freeze({
    "mdi-account-circle-outline": "M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M7.07,18.28C7.5,17.38 10.12,16.5 12,16.5C13.88,16.5 16.5,17.38 16.93,18.28C15.57,19.36 13.86,20 12,20C10.14,20 8.43,19.36 7.07,18.28M18.36,16.83C16.93,15.09 13.46,14.5 12,14.5C10.54,14.5 7.07,15.09 5.64,16.83C4.62,15.5 4,13.82 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,13.82 19.38,15.5 18.36,16.83M12,6C10.06,6 8.5,7.56 8.5,9.5C8.5,11.44 10.06,13 12,13C13.94,13 15.5,11.44 15.5,9.5C15.5,7.56 13.94,6 12,6M12,11A1.5,1.5 0 0,1 10.5,9.5A1.5,1.5 0 0,1 12,8A1.5,1.5 0 0,1 13.5,9.5A1.5,1.5 0 0,1 12,11Z",
    "mdi-account-circle": "M12,19.2C9.5,19.2 7.29,17.92 6,16C6.03,14 10,12.9 12,12.9C14,12.9 17.97,14 18,16C16.71,17.92 14.5,19.2 12,19.2M12,5A3,3 0 0,1 15,8A3,3 0 0,1 12,11A3,3 0 0,1 9,8A3,3 0 0,1 12,5M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12C22,6.47 17.5,2 12,2Z",
    "mdi-account-group-outline": "M12,5A3.5,3.5 0 0,0 8.5,8.5A3.5,3.5 0 0,0 12,12A3.5,3.5 0 0,0 15.5,8.5A3.5,3.5 0 0,0 12,5M12,7A1.5,1.5 0 0,1 13.5,8.5A1.5,1.5 0 0,1 12,10A1.5,1.5 0 0,1 10.5,8.5A1.5,1.5 0 0,1 12,7M5.5,8A2.5,2.5 0 0,0 3,10.5C3,11.44 3.53,12.25 4.29,12.68C4.65,12.88 5.06,13 5.5,13C5.94,13 6.35,12.88 6.71,12.68C7.08,12.47 7.39,12.17 7.62,11.81C6.89,10.86 6.5,9.7 6.5,8.5C6.5,8.41 6.5,8.31 6.5,8.22C6.2,8.08 5.86,8 5.5,8M18.5,8C18.14,8 17.8,8.08 17.5,8.22C17.5,8.31 17.5,8.41 17.5,8.5C17.5,9.7 17.11,10.86 16.38,11.81C16.5,12 16.63,12.15 16.78,12.3C16.94,12.45 17.1,12.58 17.29,12.68C17.65,12.88 18.06,13 18.5,13C18.94,13 19.35,12.88 19.71,12.68C20.47,12.25 21,11.44 21,10.5A2.5,2.5 0 0,0 18.5,8M12,14C9.66,14 5,15.17 5,17.5V19H19V17.5C19,15.17 14.34,14 12,14M4.71,14.55C2.78,14.78 0,15.76 0,17.5V19H3V17.07C3,16.06 3.69,15.22 4.71,14.55M19.29,14.55C20.31,15.22 21,16.06 21,17.07V19H24V17.5C24,15.76 21.22,14.78 19.29,14.55M12,16C13.53,16 15.24,16.5 16.23,17H7.77C8.76,16.5 10.47,16 12,16Z",
    "mdi-account-group": "M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25M0,20V18.5C0,17.11 1.89,15.94 4.45,15.6C3.86,16.28 3.5,17.22 3.5,18.25V20H0M24,20H20.5V18.25C20.5,17.22 20.14,16.28 19.55,15.6C22.11,15.94 24,17.11 24,18.5V20Z",
    "mdi-account-outline": "M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,6A2,2 0 0,0 10,8A2,2 0 0,0 12,10A2,2 0 0,0 14,8A2,2 0 0,0 12,6M12,13C14.67,13 20,14.33 20,17V20H4V17C4,14.33 9.33,13 12,13M12,14.9C9.03,14.9 5.9,16.36 5.9,17V18.1H18.1V17C18.1,16.36 14.97,14.9 12,14.9Z",
    "mdi-account-plus": "M15,14C12.33,14 7,15.33 7,18V20H23V18C23,15.33 17.67,14 15,14M6,10V7H4V10H1V12H4V15H6V12H9V10M15,12A4,4 0 0,0 19,8A4,4 0 0,0 15,4A4,4 0 0,0 11,8A4,4 0 0,0 15,12Z",
    "mdi-account": "M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z",
    "mdi-alert-outline": "M12,2L1,21H23M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16",
    "mdi-alert": "M13 14H11V9H13M13 18H11V16H13M1 21H23L12 2L1 21Z",
    "mdi-arrow-collapse-all": "M19.5,3.09L20.91,4.5L16.41,9H20V11H13V4H15V7.59L19.5,3.09M20.91,19.5L19.5,20.91L15,16.41V20H13V13H20V15H16.41L20.91,19.5M4.5,3.09L9,7.59V4H11V11H4V9H7.59L3.09,4.5L4.5,3.09M3.09,19.5L7.59,15H4V13H11V20H9V16.41L4.5,20.91L3.09,19.5Z",
    "mdi-arrow-down": "M11,4H13V16L18.5,10.5L19.92,11.92L12,19.84L4.08,11.92L5.5,10.5L11,16V4Z",
    "mdi-arrow-expand-all": "M9.5,13.09L10.91,14.5L6.41,19H10V21H3V14H5V17.59L9.5,13.09M10.91,9.5L9.5,10.91L5,6.41V10H3V3H10V5H6.41L10.91,9.5M14.5,13.09L19,17.59V14H21V21H14V19H17.59L13.09,14.5L14.5,13.09M13.09,9.5L17.59,5H14V3H21V10H19V6.41L14.5,10.91L13.09,9.5Z",
    "mdi-arrow-left": "M20,11V13H8L13.5,18.5L12.08,19.92L4.16,12L12.08,4.08L13.5,5.5L8,11H20Z",
    "mdi-arrow-right": "M4,11V13H16L10.5,18.5L11.92,19.92L19.84,12L11.92,4.08L10.5,5.5L16,11H4Z",
    "mdi-arrow-up": "M13,20H11V8L5.5,13.5L4.08,12.08L12,4.16L19.92,12.08L18.5,13.5L13,8V20Z",
    "mdi-attachment": "M7.5,18A5.5,5.5 0 0,1 2,12.5A5.5,5.5 0 0,1 7.5,7H18A4,4 0 0,1 22,11A4,4 0 0,1 18,15H9.5A2.5,2.5 0 0,1 7,12.5A2.5,2.5 0 0,1 9.5,10H17V11.5H9.5A1,1 0 0,0 8.5,12.5A1,1 0 0,0 9.5,13.5H18A2.5,2.5 0 0,0 20.5,11A2.5,2.5 0 0,0 18,8.5H7.5A4,4 0 0,0 3.5,12.5A4,4 0 0,0 7.5,16.5H17V18H7.5Z",
    "mdi-bell-outline": "M10 21H14C14 22.1 13.1 23 12 23S10 22.1 10 21M21 19V20H3V19L5 17V11C5 7.9 7 5.2 10 4.3V4C10 2.9 10.9 2 12 2S14 2.9 14 4V4.3C17 5.2 19 7.9 19 11V17L21 19M17 11C17 8.2 14.8 6 12 6S7 8.2 7 11V18H17V11Z",
    "mdi-bell": "M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21",
    "mdi-bookmark": "M17,3H7A2,2 0 0,0 5,5V21L12,18L19,21V5C19,3.89 18.1,3 17,3Z",
    "mdi-calendar-month": "M9,10V12H7V10H9M13,10V12H11V10H13M17,10V12H15V10H17M19,3A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5C3.89,21 3,20.1 3,19V5A2,2 0 0,1 5,3H6V1H8V3H16V1H18V3H19M19,19V8H5V19H19M9,14V16H7V14H9M13,14V16H11V14H13M17,14V16H15V14H17Z",
    "mdi-calendar": "M19,19H5V8H19M16,1V3H8V1H6V3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3H18V1M17,12H12V17H17V12Z",
    "mdi-camera": "M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z",
    "mdi-cellphone": "M17,19H7V5H17M17,1H7C5.89,1 5,1.89 5,3V21A2,2 0 0,0 7,23H17A2,2 0 0,0 19,21V3C19,1.89 18.1,1 17,1Z",
    "mdi-chart-bar": "M22,21H2V3H4V19H6V10H10V19H12V6H16V19H18V14H22V21Z",
    "mdi-chart-line": "M16,11.78L20.24,4.45L21.97,5.45L16.74,14.5L10.23,10.75L5.46,19H22V21H2V3H4V17.54L9.5,8L16,11.78Z",
    "mdi-check-circle-outline": "M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M12 20C7.59 20 4 16.41 4 12S7.59 4 12 4 20 7.59 20 12 16.41 20 12 20M16.59 7.58L10 14.17L7.41 11.59L6 13L10 17L18 9L16.59 7.58Z",
    "mdi-check-circle": "M12 2C6.5 2 2 6.5 2 12S6.5 22 12 22 22 17.5 22 12 17.5 2 12 2M10 17L5 12L6.41 10.59L10 14.17L17.59 6.58L19 8L10 17Z",
    "mdi-check": "M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z",
    "mdi-checkbox-blank-outline": "M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3M19,5V19H5V5H19Z",
    "mdi-checkbox-marked-circle-outline": "M20,12A8,8 0 0,1 12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4C12.76,4 13.5,4.11 14.2,4.31L15.77,2.74C14.61,2.26 13.34,2 12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12M7.91,10.08L6.5,11.5L11,16L21,6L19.59,4.58L11,13.17L7.91,10.08Z",
    "mdi-checkbox-marked": "M10,17L5,12L6.41,10.58L10,14.17L17.59,6.58L19,8M19,3H5C3.89,3 3,3.89 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3Z",
    "mdi-chevron-double-down": "M16.59,5.59L18,7L12,13L6,7L7.41,5.59L12,10.17L16.59,5.59M16.59,11.59L18,13L12,19L6,13L7.41,11.59L12,16.17L16.59,11.59Z",
    "mdi-chevron-double-left": "M18.41,7.41L17,6L11,12L17,18L18.41,16.59L13.83,12L18.41,7.41M12.41,7.41L11,6L5,12L11,18L12.41,16.59L7.83,12L12.41,7.41Z",
    "mdi-chevron-double-right": "M5.59,7.41L7,6L13,12L7,18L5.59,16.59L10.17,12L5.59,7.41M11.59,7.41L13,6L19,12L13,18L11.59,16.59L16.17,12L11.59,7.41Z",
    "mdi-chevron-double-up": "M7.41,18.41L6,17L12,11L18,17L16.59,18.41L12,13.83L7.41,18.41M7.41,12.41L6,11L12,5L18,11L16.59,12.41L12,7.83L7.41,12.41Z",
    "mdi-chevron-down": "M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z",
    "mdi-chevron-left": "M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z",
    "mdi-chevron-right": "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
    "mdi-chevron-up": "M7.41,15.41L12,10.83L16.59,15.41L18,14L12,8L6,14L7.41,15.41Z",
    "mdi-clock-outline": "M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z",
    "mdi-close-circle": "M12,2C17.53,2 22,6.47 22,12C22,17.53 17.53,22 12,22C6.47,22 2,17.53 2,12C2,6.47 6.47,2 12,2M15.59,7L12,10.59L8.41,7L7,8.41L10.59,12L7,15.59L8.41,17L12,13.41L15.59,17L17,15.59L13.41,12L17,8.41L15.59,7Z",
    "mdi-close": "M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z",
    "mdi-cog-outline": "M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10M10,22C9.75,22 9.54,21.82 9.5,21.58L9.13,18.93C8.5,18.68 7.96,18.34 7.44,17.94L4.95,18.95C4.73,19.03 4.46,18.95 4.34,18.73L2.34,15.27C2.21,15.05 2.27,14.78 2.46,14.63L4.57,12.97L4.5,12L4.57,11L2.46,9.37C2.27,9.22 2.21,8.95 2.34,8.73L4.34,5.27C4.46,5.05 4.73,4.96 4.95,5.05L7.44,6.05C7.96,5.66 8.5,5.32 9.13,5.07L9.5,2.42C9.54,2.18 9.75,2 10,2H14C14.25,2 14.46,2.18 14.5,2.42L14.87,5.07C15.5,5.32 16.04,5.66 16.56,6.05L19.05,5.05C19.27,4.96 19.54,5.05 19.66,5.27L21.66,8.73C21.79,8.95 21.73,9.22 21.54,9.37L19.43,11L19.5,12L19.43,13L21.54,14.63C21.73,14.78 21.79,15.05 21.66,15.27L19.66,18.73C19.54,18.95 19.27,19.04 19.05,18.95L16.56,17.95C16.04,18.34 15.5,18.68 14.87,18.93L14.5,21.58C14.46,21.82 14.25,22 14,22H10M11.25,4L10.88,6.61C9.68,6.86 8.62,7.5 7.85,8.39L5.44,7.35L4.69,8.65L6.8,10.2C6.4,11.37 6.4,12.64 6.8,13.8L4.68,15.36L5.43,16.66L7.86,15.62C8.63,16.5 9.68,17.14 10.87,17.38L11.24,20H12.76L13.13,17.39C14.32,17.14 15.37,16.5 16.14,15.62L18.57,16.66L19.32,15.36L17.2,13.81C17.6,12.64 17.6,11.37 17.2,10.2L19.31,8.65L18.56,7.35L16.15,8.39C15.38,7.5 14.32,6.86 13.12,6.62L12.75,4H11.25Z",
    "mdi-cog": "M12,15.5A3.5,3.5 0 0,1 8.5,12A3.5,3.5 0 0,1 12,8.5A3.5,3.5 0 0,1 15.5,12A3.5,3.5 0 0,1 12,15.5M19.43,12.97C19.47,12.65 19.5,12.33 19.5,12C19.5,11.67 19.47,11.34 19.43,11L21.54,9.37C21.73,9.22 21.78,8.95 21.66,8.73L19.66,5.27C19.54,5.05 19.27,4.96 19.05,5.05L16.56,6.05C16.04,5.66 15.5,5.32 14.87,5.07L14.5,2.42C14.46,2.18 14.25,2 14,2H10C9.75,2 9.54,2.18 9.5,2.42L9.13,5.07C8.5,5.32 7.96,5.66 7.44,6.05L4.95,5.05C4.73,4.96 4.46,5.05 4.34,5.27L2.34,8.73C2.21,8.95 2.27,9.22 2.46,9.37L4.57,11C4.53,11.34 4.5,11.67 4.5,12C4.5,12.33 4.53,12.65 4.57,12.97L2.46,14.63C2.27,14.78 2.21,15.05 2.34,15.27L4.34,18.73C4.46,18.95 4.73,19.03 4.95,18.95L7.44,17.94C7.96,18.34 8.5,18.68 9.13,18.93L9.5,21.58C9.54,21.82 9.75,22 10,22H14C14.25,22 14.46,21.82 14.5,21.58L14.87,18.93C15.5,18.67 16.04,18.34 16.56,17.94L19.05,18.95C19.27,19.03 19.54,18.95 19.66,18.73L21.66,15.27C21.78,15.05 21.73,14.78 21.54,14.63L19.43,12.97Z",
    "mdi-content-copy": "M19,21H8V7H19M19,5H8A2,2 0 0,0 6,7V21A2,2 0 0,0 8,23H19A2,2 0 0,0 21,21V7A2,2 0 0,0 19,5M16,1H4A2,2 0 0,0 2,3V17H4V3H16V1Z",
    "mdi-content-paste": "M19,20H5V4H7V7H17V4H19M12,2A1,1 0 0,1 13,3A1,1 0 0,1 12,4A1,1 0 0,1 11,3A1,1 0 0,1 12,2M19,2H14.82C14.4,0.84 13.3,0 12,0C10.7,0 9.6,0.84 9.18,2H5A2,2 0 0,0 3,4V20A2,2 0 0,0 5,22H19A2,2 0 0,0 21,20V4A2,2 0 0,0 19,2Z",
    "mdi-content-save-outline": "M17 3H5C3.89 3 3 3.9 3 5V19C3 20.1 3.89 21 5 21H19C20.1 21 21 20.1 21 19V7L17 3M19 19H5V5H16.17L19 7.83V19M12 12C10.34 12 9 13.34 9 15S10.34 18 12 18 15 16.66 15 15 13.66 12 12 12M6 6H15V10H6V6Z",
    "mdi-content-save": "M15,9H5V5H15M12,19A3,3 0 0,1 9,16A3,3 0 0,1 12,13A3,3 0 0,1 15,16A3,3 0 0,1 12,19M17,3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V7L17,3Z",
    "mdi-delete-outline": "M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19M8,9H16V19H8V9M15.5,4L14.5,3H9.5L8.5,4H5V6H19V4H15.5Z",
    "mdi-delete": "M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z",
    "mdi-dots-horizontal": "M16,12A2,2 0 0,1 18,10A2,2 0 0,1 20,12A2,2 0 0,1 18,14A2,2 0 0,1 16,12M10,12A2,2 0 0,1 12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12M4,12A2,2 0 0,1 6,10A2,2 0 0,1 8,12A2,2 0 0,1 6,14A2,2 0 0,1 4,12Z",
    "mdi-dots-vertical": "M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16M12,10A2,2 0 0,1 14,12A2,2 0 0,1 12,14A2,2 0 0,1 10,12A2,2 0 0,1 12,10M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8A2,2 0 0,1 10,6A2,2 0 0,1 12,4Z",
    "mdi-download": "M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z",
    "mdi-drag-vertical": "M9,3H11V5H9V3M13,3H15V5H13V3M9,7H11V9H9V7M13,7H15V9H13V7M9,11H11V13H9V11M13,11H15V13H13V11M9,15H11V17H9V15M13,15H15V17H13V15M9,19H11V21H9V19M13,19H15V21H13V19Z",
    "mdi-drag": "M7,19V17H9V19H7M11,19V17H13V19H11M15,19V17H17V19H15M7,15V13H9V15H7M11,15V13H13V15H11M15,15V13H17V15H15M7,11V9H9V11H7M11,11V9H13V11H11M15,11V9H17V11H15M7,7V5H9V7H7M11,7V5H13V7H11M15,7V5H17V7H15Z",
    "mdi-email-outline": "M22 6C22 4.9 21.1 4 20 4H4C2.9 4 2 4.9 2 6V18C2 19.1 2.9 20 4 20H20C21.1 20 22 19.1 22 18V6M20 6L12 11L4 6H20M20 18H4V8L12 13L20 8V18Z",
    "mdi-email": "M20,8L12,13L4,8V6L12,11L20,6M20,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6C22,4.89 21.1,4 20,4Z",
    "mdi-eye-off": "M11.83,9L15,12.16C15,12.11 15,12.05 15,12A3,3 0 0,0 12,9C11.94,9 11.89,9 11.83,9M7.53,9.8L9.08,11.35C9.03,11.56 9,11.77 9,12A3,3 0 0,0 12,15C12.22,15 12.44,14.97 12.65,14.92L14.2,16.47C13.53,16.8 12.79,17 12,17A5,5 0 0,1 7,12C7,11.21 7.2,10.47 7.53,9.8M2,4.27L4.28,6.55L4.73,7C3.08,8.3 1.78,10 1,12C2.73,16.39 7,19.5 12,19.5C13.55,19.5 15.03,19.2 16.38,18.66L16.81,19.08L19.73,22L21,20.73L3.27,3M12,7A5,5 0 0,1 17,12C17,12.64 16.87,13.26 16.64,13.82L19.57,16.75C21.07,15.5 22.27,13.86 23,12C21.27,7.61 17,4.5 12,4.5C10.6,4.5 9.26,4.75 8,5.2L10.17,7.35C10.74,7.13 11.35,7 12,7Z",
    "mdi-eye": "M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17M12,4.5C7,4.5 2.73,7.61 1,12C2.73,16.39 7,19.5 12,19.5C17,19.5 21.27,16.39 23,12C21.27,7.61 17,4.5 12,4.5Z",
    "mdi-file-document-outline": "M6,2A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V8L14,2H6M6,4H13V9H18V20H6V4M8,12V14H16V12H8M8,16V18H13V16H8Z",
    "mdi-file-document": "M13,9H18.5L13,3.5V9M6,2H14L20,8V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V4C4,2.89 4.89,2 6,2M15,18V16H6V18H15M18,14V12H6V14H18Z",
    "mdi-file-image": "M13,9H18.5L13,3.5V9M6,2H14L20,8V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V4C4,2.89 4.89,2 6,2M6,20H15L18,20V12L14,16L12,14L6,20M8,9A2,2 0 0,0 6,11A2,2 0 0,0 8,13A2,2 0 0,0 10,11A2,2 0 0,0 8,9Z",
    "mdi-filter-outline": "M15,19.88C15.04,20.18 14.94,20.5 14.71,20.71C14.32,21.1 13.69,21.1 13.3,20.71L9.29,16.7C9.06,16.47 8.96,16.16 9,15.87V10.75L4.21,4.62C3.87,4.19 3.95,3.56 4.38,3.22C4.57,3.08 4.78,3 5,3V3H19V3C19.22,3 19.43,3.08 19.62,3.22C20.05,3.56 20.13,4.19 19.79,4.62L15,10.75V19.88M7.04,5L11,10.06V15.58L13,17.58V10.05L16.96,5H7.04Z",
    "mdi-filter": "M14,12V19.88C14.04,20.18 13.94,20.5 13.71,20.71C13.32,21.1 12.69,21.1 12.3,20.71L10.29,18.7C10.06,18.47 9.96,18.16 10,17.87V12H9.97L4.21,4.62C3.87,4.19 3.95,3.56 4.38,3.22C4.57,3.08 4.78,3 5,3V3H19V3C19.22,3 19.43,3.08 19.62,3.22C20.05,3.56 20.13,4.19 19.79,4.62L14.03,12H14Z",
    "mdi-folder-open-outline": "M6.1,10L4,18V8H21A2,2 0 0,0 19,6H12L10,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H19C19.9,20 20.7,19.4 20.9,18.5L23.2,10H6.1M19,18H6L7.6,12H20.6L19,18Z",
    "mdi-folder-open": "M19,20H4C2.89,20 2,19.1 2,18V6C2,4.89 2.89,4 4,4H10L12,6H19A2,2 0 0,1 21,8H21L4,8V18L6.14,10H23.21L20.93,18.5C20.7,19.37 19.92,20 19,20Z",
    "mdi-folder-outline": "M20,18H4V8H20M20,6H12L10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6Z",
    "mdi-folder": "M10,4H4C2.89,4 2,4.89 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V8C22,6.89 21.1,6 20,6H12L10,4Z",
    "mdi-format-list-bulleted": "M7,5H21V7H7V5M7,13V11H21V13H7M4,4.5A1.5,1.5 0 0,1 5.5,6A1.5,1.5 0 0,1 4,7.5A1.5,1.5 0 0,1 2.5,6A1.5,1.5 0 0,1 4,4.5M4,10.5A1.5,1.5 0 0,1 5.5,12A1.5,1.5 0 0,1 4,13.5A1.5,1.5 0 0,1 2.5,12A1.5,1.5 0 0,1 4,10.5M7,19V17H21V19H7M4,16.5A1.5,1.5 0 0,1 5.5,18A1.5,1.5 0 0,1 4,19.5A1.5,1.5 0 0,1 2.5,18A1.5,1.5 0 0,1 4,16.5Z",
    "mdi-format-list-checks": "M3,5H9V11H3V5M5,7V9H7V7H5M11,7H21V9H11V7M11,15H21V17H11V15M5,20L1.5,16.5L2.91,15.09L5,17.17L9.59,12.59L11,14L5,20Z",
    "mdi-fullscreen-exit": "M14,14H19V16H16V19H14V14M5,14H10V19H8V16H5V14M8,5H10V10H5V8H8V5M19,8V10H14V5H16V8H19Z",
    "mdi-fullscreen": "M5,5H10V7H7V10H5V5M14,5H19V10H17V7H14V5M17,14H19V19H14V17H17V14M10,17V19H5V14H7V17H10Z",
    "mdi-heart-outline": "M12.1,18.55L12,18.65L11.89,18.55C7.14,14.24 4,11.39 4,8.5C4,6.5 5.5,5 7.5,5C9.04,5 10.54,6 11.07,7.36H12.93C13.46,6 14.96,5 16.5,5C18.5,5 20,6.5 20,8.5C20,11.39 16.86,14.24 12.1,18.55M16.5,3C14.76,3 13.09,3.81 12,5.08C10.91,3.81 9.24,3 7.5,3C4.42,3 2,5.41 2,8.5C2,12.27 5.4,15.36 10.55,20.03L12,21.35L13.45,20.03C18.6,15.36 22,12.27 22,8.5C22,5.41 19.58,3 16.5,3Z",
    "mdi-heart": "M12,21.35L10.55,20.03C5.4,15.36 2,12.27 2,8.5C2,5.41 4.42,3 7.5,3C9.24,3 10.91,3.81 12,5.08C13.09,3.81 14.76,3 16.5,3C19.58,3 22,5.41 22,8.5C22,12.27 18.6,15.36 13.45,20.03L12,21.35Z",
    "mdi-help-circle": "M15.07,11.25L14.17,12.17C13.45,12.89 13,13.5 13,15H11V14.5C11,13.39 11.45,12.39 12.17,11.67L13.41,10.41C13.78,10.05 14,9.55 14,9C14,7.89 13.1,7 12,7A2,2 0 0,0 10,9H8A4,4 0 0,1 12,5A4,4 0 0,1 16,9C16,9.88 15.64,10.67 15.07,11.25M13,19H11V17H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12C22,6.47 17.5,2 12,2Z",
    "mdi-home-outline": "M12 5.69L17 10.19V18H15V12H9V18H7V10.19L12 5.69M12 3L2 12H5V20H11V14H13V20H19V12H22",
    "mdi-home": "M10,20V14H14V20H19V12H22L12,3L2,12H5V20H10Z",
    "mdi-image": "M8.5,13.5L11,16.5L14.5,12L19,18H5M21,19V5C21,3.89 20.1,3 19,3H5A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19Z",
    "mdi-information-outline": "M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z",
    "mdi-information": "M13,9H11V7H13M13,17H11V11H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z",
    "mdi-link": "M3.9,12C3.9,10.29 5.29,8.9 7,8.9H11V7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H11V15.1H7C5.29,15.1 3.9,13.71 3.9,12M8,13H16V11H8V13M17,7H13V8.9H17C18.71,8.9 20.1,10.29 20.1,12C20.1,13.71 18.71,15.1 17,15.1H13V17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7Z",
    "mdi-lock-open": "M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V10A2,2 0 0,1 6,8H15V6A3,3 0 0,0 12,3A3,3 0 0,0 9,6H7A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,17A2,2 0 0,0 14,15A2,2 0 0,0 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17Z",
    "mdi-lock": "M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z",
    "mdi-login": "M11 7L9.6 8.4L12.2 11H2V13H12.2L9.6 15.6L11 17L16 12L11 7M20 19H12V21H20C21.1 21 22 20.1 22 19V5C22 3.9 21.1 3 20 3H12V5H20V19Z",
    "mdi-logout": "M17 7L15.59 8.41L18.17 11H8V13H18.17L15.59 15.58L17 17L22 12M4 5H12V3H4C2.9 3 2 3.9 2 5V19C2 20.1 2.9 21 4 21H12V19H4V5Z",
    "mdi-magnify": "M9.5,3A6.5,6.5 0 0,1 16,9.5C16,11.11 15.41,12.59 14.44,13.73L14.71,14H15.5L20.5,19L19,20.5L14,15.5V14.71L13.73,14.44C12.59,15.41 11.11,16 9.5,16A6.5,6.5 0 0,1 3,9.5A6.5,6.5 0 0,1 9.5,3M9.5,5C7,5 5,7 5,9.5C5,12 7,14 9.5,14C12,14 14,12 14,9.5C14,7 12,5 9.5,5Z",
    "mdi-menu-down": "M7,10L12,15L17,10H7Z",
    "mdi-menu": "M3,6H21V8H3V6M3,11H21V13H3V11M3,16H21V18H3V16Z",
    "mdi-message-text-outline": "M20,2A2,2 0 0,1 22,4V16A2,2 0 0,1 20,18H6L2,22V4C2,2.89 2.9,2 4,2H20M4,4V17.17L5.17,16H20V4H4M6,7H18V9H6V7M6,11H15V13H6V11Z",
    "mdi-message-text": "M20,2H4A2,2 0 0,0 2,4V22L6,18H20A2,2 0 0,0 22,16V4A2,2 0 0,0 20,2M6,9H18V11H6M14,14H6V12H14M18,8H6V6H18",
    "mdi-microphone-off": "M19,11C19,12.19 18.66,13.3 18.1,14.28L16.87,13.05C17.14,12.43 17.3,11.74 17.3,11H19M15,11.16L9,5.18V5A3,3 0 0,1 12,2A3,3 0 0,1 15,5V11L15,11.16M4.27,3L21,19.73L19.73,21L15.54,16.81C14.77,17.27 13.91,17.58 13,17.72V21H11V17.72C7.72,17.23 5,14.41 5,11H6.7C6.7,14 9.24,16.1 12,16.1C12.81,16.1 13.6,15.91 14.31,15.58L12.65,13.92L12,14A3,3 0 0,1 9,11V10.28L3,4.27L4.27,3Z",
    "mdi-microphone": "M12,2A3,3 0 0,1 15,5V11A3,3 0 0,1 12,14A3,3 0 0,1 9,11V5A3,3 0 0,1 12,2M19,11C19,14.53 16.39,17.44 13,17.93V21H11V17.93C7.61,17.44 5,14.53 5,11H7A5,5 0 0,0 12,16A5,5 0 0,0 17,11H19Z",
    "mdi-minus": "M19,13H5V11H19V13Z",
    "mdi-monitor": "M21,16H3V4H21M21,2H3C1.89,2 1,2.89 1,4V16A2,2 0 0,0 3,18H10V20H8V22H16V20H14V18H21A2,2 0 0,0 23,16V4C23,2.89 22.1,2 21,2Z",
    "mdi-open-in-new": "M14,3V5H17.59L7.76,14.83L9.17,16.24L19,6.41V10H21V3M19,19H5V5H12V3H5C3.89,3 3,3.9 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V12H19V19Z",
    "mdi-pause": "M14,19H18V5H14M6,19H10V5H6V19Z",
    "mdi-pencil-outline": "M14.06,9L15,9.94L5.92,19H5V18.08L14.06,9M17.66,3C17.41,3 17.15,3.1 16.96,3.29L15.13,5.12L18.88,8.87L20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18.17,3.09 17.92,3 17.66,3M14.06,6.19L3,17.25V21H6.75L17.81,9.94L14.06,6.19Z",
    "mdi-pencil": "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z",
    "mdi-play": "M8,5.14V19.14L19,12.14L8,5.14Z",
    "mdi-plus": "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z",
    "mdi-printer": "M18,3H6V7H18M19,12A1,1 0 0,1 18,11A1,1 0 0,1 19,10A1,1 0 0,1 20,11A1,1 0 0,1 19,12M16,19H8V14H16M19,8H5A3,3 0 0,0 2,11V17H6V21H18V17H22V11A3,3 0 0,0 19,8Z",
    "mdi-progress-clock": "M13,2.03V2.05L13,4.05C17.39,4.59 20.5,8.58 19.96,12.97C19.5,16.61 16.64,19.5 13,19.93V21.93C18.5,21.38 22.5,16.5 21.95,11C21.5,6.25 17.73,2.5 13,2.03M11,2.06C9.05,2.25 7.19,3 5.67,4.26L7.1,5.74C8.22,4.84 9.57,4.26 11,4.06V2.06M4.26,5.67C3,7.19 2.25,9.04 2.05,11H4.05C4.24,9.58 4.8,8.23 5.69,7.1L4.26,5.67M2.06,13C2.26,14.96 3.03,16.81 4.27,18.33L5.69,16.9C4.81,15.77 4.24,14.42 4.06,13H2.06M7.1,18.37L5.67,19.74C7.18,21 9.04,21.79 11,22V20C9.58,19.82 8.23,19.25 7.1,18.37M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z",
    "mdi-qrcode": "M3,11H5V13H3V11M11,5H13V9H11V5M9,11H13V15H11V13H9V11M15,11H17V13H19V11H21V13H19V15H21V19H19V21H17V19H13V21H11V17H15V15H17V13H15V11M19,19V15H17V19H19M15,3H21V9H15V3M17,5V7H19V5H17M3,3H9V9H3V3M5,5V7H7V5H5M3,15H9V21H3V15M5,17V19H7V17H5Z",
    "mdi-radiobox-blank": "M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z",
    "mdi-radiobox-marked": "M12,20A8,8 0 0,1 4,12A8,8 0 0,1 12,4A8,8 0 0,1 20,12A8,8 0 0,1 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7Z",
    "mdi-refresh": "M17.65,6.35C16.2,4.9 14.21,4 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20C15.73,20 18.84,17.45 19.73,14H17.65C16.83,16.33 14.61,18 12,18A6,6 0 0,1 6,12A6,6 0 0,1 12,6C13.66,6 15.14,6.69 16.22,7.78L13,11H20V4L17.65,6.35Z",
    "mdi-send": "M2,21L23,12L2,3V10L17,12L2,14V21Z",
    "mdi-share-variant": "M18,16.08C17.24,16.08 16.56,16.38 16.04,16.85L8.91,12.7C8.96,12.47 9,12.24 9,12C9,11.76 8.96,11.53 8.91,11.3L15.96,7.19C16.5,7.69 17.21,8 18,8A3,3 0 0,0 21,5A3,3 0 0,0 18,2A3,3 0 0,0 15,5C15,5.24 15.04,5.47 15.09,5.7L8.04,9.81C7.5,9.31 6.79,9 6,9A3,3 0 0,0 3,12A3,3 0 0,0 6,15C6.79,15 7.5,14.69 8.04,14.19L15.16,18.34C15.11,18.55 15.08,18.77 15.08,19C15.08,20.61 16.39,21.91 18,21.91C19.61,21.91 20.92,20.61 20.92,19A2.92,2.92 0 0,0 18,16.08Z",
    "mdi-skip-next": "M16,18H18V6H16M6,18L14.5,12L6,6V18Z",
    "mdi-skip-previous": "M6,18V6H8V18H6M9.5,12L18,6V18L9.5,12Z",
    "mdi-sort-ascending": "M19 17H22L18 21L14 17H17V3H19M2 17H12V19H2M6 5V7H2V5M2 11H9V13H2V11Z",
    "mdi-sort-descending": "M19 7H22L18 3L14 7H17V21H19M2 17H12V19H2M6 5V7H2V5M2 11H9V13H2V11Z",
    "mdi-sort": "M18 21L14 17H17V7H14L18 3L22 7H19V17H22M2 19V17H12V19M2 13V11H9V13M2 7V5H6V7H2Z",
    "mdi-star-outline": "M12,15.39L8.24,17.66L9.23,13.38L5.91,10.5L10.29,10.13L12,6.09L13.71,10.13L18.09,10.5L14.77,13.38L15.76,17.66M22,9.24L14.81,8.63L12,2L9.19,8.63L2,9.24L7.45,13.97L5.82,21L12,17.27L18.18,21L16.54,13.97L22,9.24Z",
    "mdi-star": "M12,17.27L18.18,21L16.54,13.97L22,9.24L14.81,8.62L12,2L9.19,8.62L2,9.24L7.45,13.97L5.82,21L12,17.27Z",
    "mdi-stop": "M18,18H6V6H18V18Z",
    "mdi-table": "M5,4H19A2,2 0 0,1 21,6V18A2,2 0 0,1 19,20H5A2,2 0 0,1 3,18V6A2,2 0 0,1 5,4M5,8V12H11V8H5M13,8V12H19V8H13M5,14V18H11V14H5M13,14V18H19V14H13Z",
    "mdi-theme-light-dark": "M7.5,2C5.71,3.15 4.5,5.18 4.5,7.5C4.5,9.82 5.71,11.85 7.53,13C4.46,13 2,10.54 2,7.5A5.5,5.5 0 0,1 7.5,2M19.07,3.5L20.5,4.93L4.93,20.5L3.5,19.07L19.07,3.5M12.89,5.93L11.41,5L9.97,6L10.39,4.3L9,3.24L10.75,3.12L11.33,1.47L12,3.1L13.73,3.13L12.38,4.26L12.89,5.93M9.59,9.54L8.43,8.81L7.31,9.59L7.65,8.27L6.56,7.44L7.92,7.35L8.37,6.06L8.88,7.33L10.24,7.36L9.19,8.23L9.59,9.54M19,13.5A5.5,5.5 0 0,1 13.5,19C12.28,19 11.15,18.6 10.24,17.93L17.93,10.24C18.6,11.15 19,12.28 19,13.5M14.6,20.08L17.37,18.93L17.13,22.28L14.6,20.08M18.93,17.38L20.08,14.61L22.28,17.15L18.93,17.38M20.08,12.42L18.94,9.64L22.28,9.88L20.08,12.42M9.63,18.93L12.4,20.08L9.87,22.27L9.63,18.93Z",
    "mdi-toggle-switch-off": "M17,7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7M7,15A3,3 0 0,1 4,12A3,3 0 0,1 7,9A3,3 0 0,1 10,12A3,3 0 0,1 7,15Z",
    "mdi-toggle-switch": "M17,7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7M17,15A3,3 0 0,1 14,12A3,3 0 0,1 17,9A3,3 0 0,1 20,12A3,3 0 0,1 17,15Z",
    "mdi-upload": "M9,16V10H5L12,3L19,10H15V16H9M5,20V18H19V20H5Z",
    "mdi-video": "M17,10.5V7A1,1 0 0,0 16,6H4A1,1 0 0,0 3,7V17A1,1 0 0,0 4,18H16A1,1 0 0,0 17,17V13.5L21,17.5V6.5L17,10.5Z",
    "mdi-view-dashboard": "M13,3V9H21V3M13,21H21V11H13M3,21H11V15H3M3,13H11V3H3V13Z",
    "mdi-view-grid": "M3,11H11V3H3M3,21H11V13H3M13,21H21V13H13M13,3V11H21V3",
    "mdi-volume-high": "M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z",
    "mdi-volume-mute": "M3,9H7L12,4V20L7,15H3V9M16.59,12L14,9.41L15.41,8L18,10.59L20.59,8L22,9.41L19.41,12L22,14.59L20.59,16L18,13.41L15.41,16L14,14.59L16.59,12Z",
    "mdi-weather-night": "M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z",
    "mdi-weather-sunny": "M12,7A5,5 0 0,1 17,12A5,5 0 0,1 12,17A5,5 0 0,1 7,12A5,5 0 0,1 12,7M12,9A3,3 0 0,0 9,12A3,3 0 0,0 12,15A3,3 0 0,0 15,12A3,3 0 0,0 12,9M12,2L14.39,5.42C13.65,5.15 12.84,5 12,5C11.16,5 10.35,5.15 9.61,5.42L12,2M3.34,7L7.5,6.65C6.9,7.16 6.36,7.78 5.94,8.5C5.5,9.24 5.25,10 5.11,10.79L3.34,7M3.36,17L5.12,13.23C5.26,14 5.53,14.78 5.95,15.5C6.37,16.24 6.91,16.86 7.5,17.37L3.36,17M20.65,7L18.88,10.79C18.74,10 18.47,9.23 18.05,8.5C17.63,7.78 17.1,7.15 16.5,6.64L20.65,7M20.64,17L16.5,17.36C17.09,16.85 17.62,16.22 18.04,15.5C18.46,14.77 18.73,14 18.87,13.21L20.64,17M12,22L9.59,18.56C10.33,18.83 11.14,19 12,19C12.82,19 13.63,18.83 14.37,18.56L12,22Z"
});
  const iconStates = new WeakMap();
  function renderIcon(host) {
    const name = host.getAttribute('icon');
    const path = Object.hasOwn(mdiPaths, name) ? mdiPaths[name] : null;
    const previous = iconStates.get(host);
    if (path && previous?.name === name && previous.svg.parentNode === host) return;
    previous?.svg.remove();
    iconStates.delete(host);
    if (!path) { // Unknown names preserve the author's text/fallback.
      if (name) warnOnce('icon:' + name, 'icon "' + name + '" is not bundled; the element keeps its own content.');
      return;
    }
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const shape = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    for (const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'24',height:'24',fill:'currentColor','aria-hidden':'true',focusable:'false',class:'ui-icon'})) svg.setAttribute(key,value);
    shape.setAttribute('d',path);
    svg.append(shape);
    host.prepend(svg);
    iconStates.set(host,{name,svg});
  }
  function automaticIconOwner(element){const owner=element.closest('[data-kav-ui-vue]');return !owner||owner.hasAttribute('data-kav-ui-html');}
  function scanIcons(scope, automatic = false) {
    const icons=[...(scope.matches?.('[icon]')?[scope]:[]),...all(scope,'[icon]')];
    icons.filter(element=>automatic?automaticIconOwner(element):scopeOwns(scope,element)).forEach(renderIcon);
  }
  // Only icons auto-initialize dynamically. Other components keep the init API.
  const iconObserver = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {if(automaticIconOwner(record.target))renderIcon(record.target);}
      else for (const node of record.addedNodes) {
        if (node.nodeType === 1) scanIcons(node,true);
      }
    }
  });
  const fileDropStates = new WeakMap();
  function initFileDrop(root) {
    const listen=scopedEvents(root);
    if (fileDropStates.has(root)) return;
    const input = root.querySelector('input[type="file"]');
    const zone = root.querySelector('[data-ui-file-zone]');
    // Preserve the standard input when assigning FileLists is unsupported.
    if (!input || !zone || typeof DataTransfer === 'undefined') return;
    try { const probe=doc.createElement('input');probe.type='file';probe.files=new DataTransfer().files; } catch { return; }
    root.classList.add('ui-file-drop');
    root.dataset.uiFileReady = 'true';
    const list = doc.createElement('ul');list.className='ui-file-list';list.setAttribute('role','list');list.setAttribute('aria-label','選択したファイル');
    const status = doc.createElement('p');status.className='ui-file-status';status.setAttribute('role','status');
    const error = doc.createElement('p');error.className='ui-file-error';error.setAttribute('role','alert');error.id=id(error);error.hidden=true;
    root.append(list,status,error);
    const described=(input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    input.setAttribute('aria-describedby',[...described,error.id].join(' '));
    const state={files:[...input.files],depth:0};fileDropStates.set(root,state);
    const inactive=()=>input.matches(':disabled');
    const clearError=()=>{error.textContent='';error.hidden=true;delete root.dataset.uiFileInvalid;};
    const reject=message=>{error.textContent=message;error.hidden=false;root.dataset.uiFileInvalid='true';emit(root,'filereject',{message});};
    const render=()=>{
      list.replaceChildren();list.hidden=!input.files.length;
      for (const [index,file] of [...input.files].entries()) {
        const item=doc.createElement('li');
        const name=doc.createElement('span');name.className='ui-file-name';name.textContent=file.name;
        const size=doc.createElement('span');size.className='ui-file-size';size.textContent=file.size<1024?file.size+' B':file.size<1048576?(file.size/1024).toFixed(1)+' KB':(file.size/1048576).toFixed(1)+' MB';
        const remove=doc.createElement('button');remove.type='button';remove.className='btn btn-sm btn-outline-secondary';remove.textContent='削除';remove.disabled=inactive();remove.setAttribute('aria-label',file.name+'を削除');
        listen(remove,'click',()=>{if(inactive())return;commit([...input.files].filter((_,i)=>i!==index));input.focus();});
        item.append(name,size,remove);list.append(item);
      }
      status.textContent=input.files.length?input.files.length+'件のファイルを選択しました。':'ファイルは選択されていません。';
    };
    const assign=files=>{const transfer=new DataTransfer();files.forEach(file=>transfer.items.add(file));input.files=transfer.files;};
    const validate=files=>{
      if (!input.multiple && files.length>1) return '選択できるファイルは1件です。';
      const maxCount=Number(root.dataset.uiMaxFiles),maxSize=Number(root.dataset.uiMaxSize);
      if (maxCount>0 && files.length>maxCount) return '選択できるファイルは'+maxCount+'件までです。';
      const accepts=input.accept.toLowerCase().split(',').map(value=>value.trim()).filter(Boolean);
      for (const file of files) {
        if (maxSize>0 && file.size>maxSize) return file.name+'：ファイルサイズの上限を超えています。';
        if (accepts.length && !accepts.some(value=>value.startsWith('.')?file.name.toLowerCase().endsWith(value):value.endsWith('/*')?file.type.toLowerCase().startsWith(value.slice(0,-1)):file.type.toLowerCase()===value)) return file.name+'：選択できないファイル形式です。';
      }
      return '';
    };
    const commit=files=>{
      const problem=validate(files);if(problem){reject(problem);return;}
      assign(files);state.files=[...input.files];clearError();render();
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('change',{bubbles:true}));
    };
    listen(input,'change',()=>{
      if(inactive()){assign(state.files);return;}
      const problem=validate([...input.files]);
      if(problem){assign(state.files);reject(problem);render();return;}
      state.files=[...input.files];clearError();render();emit(root,'filechange',{files:[...input.files]});
    });
    const fileDrag=event=>[...(event.dataTransfer?.types || [])].includes('Files');
    const stopDrag=()=>{state.depth=0;delete root.dataset.uiFileDragging;};
    listen(zone,'dragenter',event=>{if(!fileDrag(event))return;event.preventDefault();if(!inactive()){state.depth++;root.dataset.uiFileDragging='true';}});
    listen(zone,'dragover',event=>{if(!fileDrag(event))return;event.preventDefault();event.dataTransfer.dropEffect=inactive()?'none':'copy';});
    listen(zone,'dragleave',event=>{if(!fileDrag(event))return;event.preventDefault();if(--state.depth<=0)stopDrag();});
    listen(zone,'drop',event=>{
      if(!fileDrag(event))return;event.preventDefault();stopDrag();if(inactive())return;
      const items=[...(event.dataTransfer.items || [])];
      if(items.some(item=>item.webkitGetAsEntry?.()?.isDirectory)){reject('フォルダーではなくファイルを選択してください。');return;}
      const files=[...event.dataTransfer.files];if(files.length)commit(files);
    });
    listen(zone,'dragend',stopDrag);
    listen(input.form,'reset',event=>setTimeout(()=>{if(event.defaultPrevented)return;state.files=[...input.files];clearError();stopDrag();render();},0));
    const observer=new MutationObserver(()=>{stopDrag();render();});observer.observe(input,{attributes:true,attributeFilter:['disabled']});
    onDispose(root,()=>{observer.disconnect();stopDrag();list.remove();status.remove();error.remove();describedBy(input,error.id,false);fileDropStates.delete(root);delete root.dataset.uiFileReady;});
    render();
  }
  // Shared positioning and native light dismissal for menus and rich popovers.
  const popupStates = new WeakMap();
  const openPopups = new Set();
  const isPopup = panel => panel?.matches('[data-ui-dropdown], [data-ui-popover]');
  const popupOpen = panel => typeof panel.showPopover==='function' && panel.matches(':popover-open');
  const menuItems = panel => all(panel,'.ui-dropdown-item').filter(item=>!disabled(item) && !item.matches(':disabled') && !item.closest('[hidden], [inert]') && item.getClientRects().length);
  function syncPopup(panel, open) {
    for (const trigger of all(doc,'[data-ui-toggle="dropdown"], [data-ui-toggle="popover"]')) {
      if (target(trigger)!==panel) continue;
      trigger.setAttribute('aria-controls',id(panel));
      trigger.setAttribute('aria-expanded',String(open));
      trigger.setAttribute('aria-haspopup',panel.hasAttribute('data-ui-dropdown')?'menu':'dialog');
    }
  }
  function placePopup(panel, trigger) {
    if (!trigger?.isConnected) return;
    const r=trigger.getBoundingClientRect(), box=panel.getBoundingClientRect(), margin=8, gap=6;
    const placement=trigger.dataset.uiPlacement || 'bottom-start';
    let above=placement.startsWith('top');
    if (!above && innerHeight-r.bottom-gap<box.height && r.top>innerHeight-r.bottom) above=true;
    if (above && r.top-gap<box.height && innerHeight-r.bottom>r.top) above=false;
    const end=placement.endsWith('end') !== (getComputedStyle(trigger).direction==='rtl');
    const left=end?r.right-box.width:r.left, top=above?r.top-gap-box.height:r.bottom+gap;
    Object.assign(panel.style,{left:Math.max(margin,Math.min(left,innerWidth-box.width-margin))+'px',top:Math.max(margin,Math.min(top,innerHeight-box.height-margin))+'px'});
  }
  function initPopup(panel) {
    if (!isPopup(panel) || typeof panel.showPopover!=='function') return null;
    const menu=panel.hasAttribute('data-ui-dropdown');
    if (menu) all(panel,'.ui-dropdown-item').forEach(item=>{item.setAttribute('role','menuitem');if(!item.hasAttribute('tabindex'))item.tabIndex=-1;});
    if (popupStates.has(panel)) return popupStates.get(panel);
    const state={trigger:null,menu};
    popupStates.set(panel,state);
    panel.classList.add('ui-popup',menu?'ui-dropdown-menu':'ui-popover');
    panel.setAttribute('popover','auto');panel.tabIndex=-1;
    if (!panel.hasAttribute('role')) panel.setAttribute('role',menu?'menu':'dialog');
    if (menu) all(panel,'.ui-dropdown-item').forEach(item=>{item.setAttribute('role','menuitem');item.tabIndex=-1;});
    panel.addEventListener('beforetoggle',event=>{
      const open=event.newState==='open';
      if (open) openPopups.add(panel);else openPopups.delete(panel);
      syncPopup(panel,open);
    });
    panel.addEventListener('toggle',()=>emit(panel,popupOpen(panel)?'shown':'hidden'));
    panel.addEventListener('click',event=>{
      if (!menu) return;
      const item=closest(event.target,'.ui-dropdown-item');
      if (!item || item.closest('[data-ui-dropdown]')!==panel) return;
      if (disabled(item) || item.matches(':disabled')) {event.preventDefault();event.stopImmediatePropagation();return;}
      closePopup(panel,true);
      emit(panel,'menuselect',{item,value:item.dataset.uiValue ?? item.textContent.trim()});
    },true);
    panel.addEventListener('keydown',event=>{
      if (event.defaultPrevented) return;
      if (event.key==='Escape') {event.preventDefault();event.stopPropagation();closePopup(panel,true);return;}
      if (!menu) return;
      if (event.key==='Tab') {closePopup(panel,true);return;}
      if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
      event.preventDefault();
      const items=menuItems(panel);if(!items.length)return;
      const index=items.indexOf(closest(event.target,'.ui-dropdown-item'));
      const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;
      items.forEach((item,i)=>item.tabIndex=i===next?0:-1);items[next].focus();
    });
    return state;
  }
  function openPopup(panel, trigger, last=false) {
    const state=initPopup(panel);
    if (!state || !panel.isConnected || popupOpen(panel) || disabled(trigger) || trigger.matches(':disabled')) return;
    cancelExit(panel);state.trigger=trigger;
    if (!panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby')) panel.setAttribute('aria-labelledby',id(trigger));
    panel.showPopover();
    if (!popupOpen(panel)) {openPopups.delete(panel);syncPopup(panel,false);return;}
    placePopup(panel,trigger);
    if (state.menu) {
      const items=menuItems(panel),next=last?items.at(-1):items[0];
      items.forEach(item=>item.tabIndex=item===next?0:-1);(next || panel).focus();
    } else (panel.querySelector('[autofocus]') || panel.querySelector('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || panel).focus();
  }
  // Light dismiss closes an auto popover after pointerup, before the trigger's click.
  // Remember that it was open so the click closes it instead of reopening it.
  let pointerOpenPopup=null;
  doc.addEventListener('pointerdown',event=>{
    const trigger=closest(event.target,'[data-ui-toggle="dropdown"], [data-ui-toggle="popover"]');
    const panel=trigger && target(trigger);
    pointerOpenPopup=isPopup(panel) && popupOpen(panel) ? panel : null;
  },true);
  doc.addEventListener('pointercancel',()=>{pointerOpenPopup=null;},true);
  doc.addEventListener('keydown',()=>{pointerOpenPopup=null;},true);
  function closePopup(panel, restore=false) {
    if (!isPopup(panel)) return;
    if (!popupOpen(panel)) {openPopups.delete(panel);syncPopup(panel,false);return;}
    const trigger=popupStates.get(panel)?.trigger;
    exitMotion(panel);panel.hidePopover();
    if (restore && trigger?.isConnected && !disabled(trigger)) trigger.focus();
  }
  doc.addEventListener('keydown',event=>{
    const trigger=closest(event.target,'[data-ui-toggle="dropdown"]');
    if (!trigger || disabled(trigger) || !['ArrowDown','ArrowUp'].includes(event.key)) return;
    const panel=target(trigger);if(!isPopup(panel))return;
    event.preventDefault();openPopup(panel,trigger,event.key==='ArrowUp');
  });
  window.addEventListener('resize',()=>{for(const panel of openPopups)placePopup(panel,popupStates.get(panel)?.trigger);});
  doc.addEventListener('scroll',event=>{
    for (const panel of openPopups) if (!panel.contains(event.target)) withoutExitMotion(()=>closePopup(panel));
  },true);
  // SVG charts keep their source data and a readable table alongside the graphic.
  const chartStates = new WeakMap();
  const chartTypes = ['line','area','bar','donut'];
  function chartNode(tag, attributes = {}, text) {
    const node = doc.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key,value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function chart(root, config) {
    if (typeof root === 'string') { try { root = doc.querySelector(root); } catch { return false; } }
    if (!(root instanceof Element)) return false;
    let state = chartStates.get(root);
    if (!state) {
      state = {config:null, width:0, output:doc.createElement('div')};
      state.output.className = 'ui-chart-output';
      root.classList.add('ui-chart'); root.append(state.output); chartStates.set(root,state);
      if (window.ResizeObserver) {
        state.observer = new ResizeObserver(() => {
          const width = Math.max(240,Math.floor(root.getBoundingClientRect().width || 640));
          if (width !== state.width && state.config) drawChart(root,state);
        });
        state.observer.observe(root);
        onDispose(root,()=>{state.observer.disconnect();state.output.remove();chartStates.delete(root);});
      }
    }
    let candidate = config;
    try {
      if (candidate === undefined) candidate = JSON.parse([...root.children].find(node=>node.matches('script[type="application/json"][data-ui-chart-data]'))?.textContent || '{}');
      const type = candidate.type ?? root.dataset.uiChart ?? 'line';
      if (!chartTypes.includes(type)) throw new Error('typeはline / area / bar / donutを指定してください。');
      if (!Array.isArray(candidate.labels) || !Array.isArray(candidate.series) || candidate.labels.length > 500 || candidate.series.length > 12) throw new Error('labelsとseriesを配列で指定してください（最大500項目・12系列）。');
      const labels = candidate.labels.map(value=>String(value));
      const series = candidate.series.map((item,index)=>{
        if (!Array.isArray(item.values) || item.values.length !== labels.length || item.values.some(value=>typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value)>1e12)) throw new Error('各系列にlabelsと同数の有限な数値を指定してください（絶対値は1兆以下）。');
        if (type === 'donut' && item.values.some(value=>value<0)) throw new Error('ドーナツには0以上の値を指定してください。');
        return {name:String(item.name ?? `系列${index+1}`),values:[...item.values]};
      });
      if (type === 'donut' && series.length > 1) throw new Error('ドーナツは1系列で指定してください。');
      state.config = {type,labels,series,label:String(candidate.label ?? root.querySelector('figcaption')?.textContent ?? 'チャート'),unit:String(candidate.unit ?? '')};
      root.dataset.uiChart = type;
      drawChart(root,state);
      emit(root,'chartupdate',{type,labels:[...labels],series:series.map(item=>({...item,values:[...item.values]}))});
      return true;
    } catch (error) {
      state.config = null; state.output.replaceChildren();
      const message = doc.createElement('p'); message.className='ui-chart-message'; message.setAttribute('role','status'); message.textContent='チャートを表示できません。'+error.message;
      state.output.append(message); emit(root,'charterror',{message:error.message}); return false;
    }
  }
  function drawChart(root,state) {
    const {type,labels,series,label,unit} = state.config;
    state.width = Math.max(240,Math.floor(root.getBoundingClientRect().width || 640));
    const wasOpen = state.output.querySelector('details')?.open || false;
    // Preserve the table and its focus while a resize only redraws the graphic.
    const previousTable = state.output.querySelector('.ui-chart-data');
    state.output.querySelectorAll(':scope > :not(.ui-chart-data)').forEach(node=>node.remove());
    const empty = !labels.length || !series.length || (type==='donut' && !series[0].values.some(value=>value>0));
    const number = value=>new Intl.NumberFormat('ja-JP',{maximumFractionDigits:2}).format(value);
    const exact = value=>new Intl.NumberFormat('ja-JP',{maximumSignificantDigits:21}).format(value)+unit;
    const color = index=>`var(--ui-chart-color-${index%6+1})`;
    if (empty) {
      const message=doc.createElement('p');message.className='ui-chart-message';message.setAttribute('role','status');message.textContent='表示するデータがありません。';state.output.prepend(message);
    } else {
      const width=state.width,height=260,svg=chartNode('svg',{viewBox:`0 0 ${width} ${height}`,role:'img','aria-labelledby':`ui-chart-title-${++sequence}`});
      svg.classList.add('ui-chart-svg');
      svg.append(chartNode('title',{id:`ui-chart-title-${sequence}`},label+'。正確な値は下のデータ表で確認できます。'));
      if(type==='donut') {
        const total=series[0].values.reduce((a,b)=>a+b,0),cx=width/2,cy=126,radius=84;
        svg.append(chartNode('circle',{cx,cy,r:radius,fill:'none',stroke:'var(--bs-border-color)','stroke-width':30}));
        let angle=-Math.PI/2;
        series[0].values.forEach((value,index)=>{
          if(!value)return;
          const fraction=value/total,end=angle+fraction*Math.PI*2;
          let segment;
          if(fraction===1) segment=chartNode('circle',{cx,cy,r:radius,fill:'none',stroke:color(index),'stroke-width':30});
          else {
            const point=(r,a)=>`${cx+r*Math.cos(a)},${cy+r*Math.sin(a)}`;
            const outer=radius+15,inner=radius-15,large=fraction>.5?1:0;
            // Filled annular paths avoid closed-circle dash seams in Chromium.
            const path=`M${point(outer,angle)} A${outer},${outer} 0 ${large} 1 ${point(outer,end)} L${point(inner,end)} A${inner},${inner} 0 ${large} 0 ${point(inner,angle)} Z`;
            segment=chartNode('path',{d:path,fill:color(index)});
          }
          segment.append(chartNode('title',{},`${labels[index]}: ${exact(value)} (${number(fraction*100)}%)`));svg.append(segment);angle=end;
        });
        svg.append(chartNode('text',{x:cx,y:cy-4,'text-anchor':'middle',class:'ui-chart-total'},number(total)));
        svg.append(chartNode('text',{x:cx,y:cy+20,'text-anchor':'middle'},unit || '合計'));
      } else {
        const left=58,right=16,top=18,bottom=42,plotWidth=width-left-right,plotHeight=height-top-bottom;
        const values=series.flatMap(item=>item.values),low=Math.min(0,...values),high=Math.max(0,...values) || (low===0?1:0),range=high-low || 1;
        const y=value=>top+(high-value)/range*plotHeight;
        for(let tick=0;tick<=4;tick++) {
          const value=high-range*tick/4,py=top+plotHeight*tick/4;
          svg.append(chartNode('line',{x1:left,x2:width-right,y1:py,y2:py,class:'ui-chart-grid'}));
          svg.append(chartNode('text',{x:left-8,y:py+4,'text-anchor':'end'},Math.abs(value)>0 && Math.abs(value)<.01 ? value.toExponential(1) : new Intl.NumberFormat('ja-JP',{notation:'compact',maximumFractionDigits:1}).format(value)));
        }
        svg.append(chartNode('line',{x1:left,x2:width-right,y1:y(0),y2:y(0),class:'ui-chart-axis'}));
        const x=index=>type==='bar'?left+(index+.5)*plotWidth/labels.length:left+(labels.length===1?.5:index/(labels.length-1))*plotWidth;
        const labelCount=Math.max(2,Math.floor(plotWidth/68)),step=Math.max(1,Math.ceil(labels.length/labelCount));
        labels.forEach((text,index)=>{
          if(index%step && index!==labels.length-1)return;
          const displayed=text.length>9?text.slice(0,8)+'…':text;
          svg.append(chartNode('text',{x:x(index),y:height-15,'text-anchor':index===0?'start':index===labels.length-1?'end':'middle'},displayed));
        });
        series.forEach((item,index)=>{
          if(type==='bar') {
            const groupWidth=plotWidth/labels.length*.76,barWidth=groupWidth/series.length;
            item.values.forEach((value,i)=>{
              const rect=chartNode('rect',{x:x(i)-groupWidth/2+index*barWidth,y:Math.min(y(0),y(value)),width:Math.max(.1,barWidth-1),height:Math.abs(y(value)-y(0)),fill:color(index),rx:2});
              rect.append(chartNode('title',{},`${labels[i]} / ${item.name}: ${exact(value)}`));svg.append(rect);
            });
          } else {
            const points=item.values.map((value,i)=>`${x(i)},${y(value)}`).join(' ');
            if(type==='area') svg.append(chartNode('polygon',{points:`${x(0)},${y(0)} ${points} ${x(labels.length-1)},${y(0)}`,fill:color(index),opacity:.13}));
            svg.append(chartNode('polyline',{points,fill:'none',stroke:color(index),'stroke-width':2.5,'stroke-dasharray':index%3===1?'7 4':index%3===2?'2 3':'none','stroke-linejoin':'round'}));
            if(labels.length<=40) item.values.forEach((value,i)=>{
              const point=chartNode('circle',{cx:x(i),cy:y(value),r:3.5,fill:color(index)});point.append(chartNode('title',{},`${labels[i]} / ${item.name}: ${exact(value)}`));svg.append(point);
            });
          }
        });
      }
      state.output.prepend(svg);
      const legend=doc.createElement('ul');legend.className='ui-chart-legend';legend.setAttribute('aria-label','凡例');
      (type==='donut'?labels:series.map(item=>item.name)).forEach((name,index)=>{
        const item=doc.createElement('li'),swatch=doc.createElement('span');swatch.className='ui-chart-swatch';swatch.style.background=color(index);swatch.setAttribute('aria-hidden','true');
        item.append(swatch,doc.createTextNode(name+(type==='donut'?' · '+exact(series[0].values[index]):'')));legend.append(item);
      });
      if(previousTable)state.output.insertBefore(legend,previousTable);else state.output.append(legend);
    }
    // New data replaces the table; width changes leave the existing table intact.
    if(previousTable && previousTable._chartConfig === state.config)return;
    previousTable?.remove();
    if(!labels.length || !series.length)return;
    const details=doc.createElement('details');details.className='ui-chart-data';details.open=wasOpen;details._chartConfig=state.config;
    const summary=doc.createElement('summary');summary.textContent='データを表で確認';
    const scroll=doc.createElement('div');scroll.className='ui-table-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',label+'のデータ表');
    const table=doc.createElement('table');table.className='table';
    const caption=table.createCaption();caption.textContent=label+(unit?'（'+unit+'）':'');
    const head=table.createTHead().insertRow();
    ['項目',...series.map(item=>item.name)].forEach(name=>{const cell=doc.createElement('th');cell.scope='col';cell.textContent=name;head.append(cell);});
    const body=table.createTBody();
    labels.forEach((name,index)=>{const row=body.insertRow(),heading=doc.createElement('th');heading.scope='row';heading.textContent=name;row.append(heading);series.forEach(item=>{const cell=row.insertCell();cell.textContent=exact(item.values[index]);});});
    scroll.append(table);details.append(summary,scroll);state.output.append(details);
  }
  function initChart(root) { if(!chartStates.has(root))chart(root); }

  // Snapshot only attributes owned by these controllers, so teardown is reversible.
  function rememberAttributes(element,names) {
    const values=names.map(name=>[name,element.getAttribute(name)]);
    return ()=>values.forEach(([name,value])=>value===null?element.removeAttribute(name):element.setAttribute(name,value));
  }
  const commandStates=new WeakMap();
  function initCommand(root) {
    const input=owned(root,'[data-ui-command-input]','[data-ui-command]')[0];
    const list=owned(root,'[data-ui-command-list]','[data-ui-command]')[0];
    if(!input||!list)return;
    if(commandStates.has(root)){commandStates.get(root).refresh();return;}
    const listen=scopedEvents(root),originals=new Map();
    const remember=element=>{if(!originals.has(element))originals.set(element,{hidden:element.hidden,restore:rememberAttributes(element,['id','role','tabindex','hidden','aria-selected','aria-label'])});return originals.get(element);};
    const restoreInput=rememberAttributes(input,['role','aria-controls','aria-expanded','aria-activedescendant','aria-autocomplete']);
    const restoreList=rememberAttributes(list,['id','role']);
    const empty=owned(root,'[data-ui-command-empty]','[data-ui-command]')[0],status=owned(root,'[data-ui-command-status]','[data-ui-command]')[0];
    const restoreEmpty=empty?rememberAttributes(empty,['hidden']):()=>{},statusText=status?.textContent;
    let items=[],choices=[],active=null;
    const normalize=text=>text.normalize('NFKC').toLocaleLowerCase().trim();
    const unavailable=item=>item.matches(':disabled')||disabled(item);
    input.setAttribute('role','combobox');input.setAttribute('aria-controls',id(list));input.setAttribute('aria-autocomplete','list');list.setAttribute('role','listbox');
    function select(item,scroll=false) {
      active=item||null;
      for(const option of items)option.setAttribute('aria-selected',String(option===active));
      if(active){input.setAttribute('aria-activedescendant',id(active));if(scroll)active.scrollIntoView({block:'nearest'});}else input.removeAttribute('aria-activedescendant');
    }
    function refresh() {
      items=owned(root,'[data-ui-command-item]','[data-ui-command]').filter(item=>list.contains(item));
      const groups=owned(root,'[data-ui-command-group]','[data-ui-command]');
      for(const group of groups){remember(group);group.setAttribute('role','group');if(!group.hasAttribute('aria-label'))group.setAttribute('aria-label',group.dataset.uiCommandGroup||'操作');}
      const words=normalize(input.value).split(/\s+/).filter(Boolean);
      for(const item of items){
        const original=remember(item),group=item.closest('[data-ui-command-group]');
        const text=normalize(item.textContent+' '+(item.dataset.uiKeywords||''));
        item.hidden=original.hidden||!!(group&&originals.get(group)?.hidden)||!words.every(word=>text.includes(word));
        item.setAttribute('role','option');item.tabIndex=-1;id(item);
      }
      for(const group of groups)group.hidden=originals.get(group).hidden||!items.some(item=>group.contains(item)&&!item.hidden);
      choices=items.filter(item=>!item.hidden&&!unavailable(item));
      select(choices.includes(active)?active:choices[0]);
      const count=items.filter(item=>!item.hidden).length;
      if(empty)empty.hidden=count>0;if(status)status.textContent=count+'件の操作';
      input.setAttribute('aria-expanded',String(!root.hidden&&(root.tagName!=='DIALOG'||root.open)));
    }
    listen(input,'input',refresh);
    listen(input,'keydown',event=>{
      if(event.isComposing||event.altKey||event.ctrlKey||event.metaKey)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();refresh();const index=choices.indexOf(active),step=event.key==='ArrowDown'?1:-1;
        if(choices.length)select(choices[(index+step+choices.length)%choices.length],true);
      }else if(event.key==='Enter'){event.preventDefault();if(active&&!unavailable(active))active.click();}
      else if(event.key==='Escape'&&root.tagName!=='DIALOG'){event.preventDefault();input.value='';refresh();}
    });
    listen(root,'click',event=>{
      const item=closest(event.target,'[data-ui-command-item]');if(!item||item.closest('[data-ui-command]')!==root)return;
      if(item.hidden||unavailable(item)){event.preventDefault();return;}
      select(item);const value=item.hasAttribute('data-ui-value')?item.dataset.uiValue:(item.getAttribute('value')??item.textContent.trim());
      emit(root,'commandselect',{value,item});
      if(root.tagName==='DIALOG')hide(root);else input.focus({preventScroll:true});
    });
    listen(root,'ui:shown',event=>{if(event.target!==root)return;input.value=input.defaultValue;refresh();input.focus();});
    listen(root,'close',()=>input.setAttribute('aria-expanded','false'));
    listen(doc,'keydown',event=>{
      const shortcut=root.dataset.uiCommandShortcut;
      if(!shortcut||!root.isConnected||root.closest('[hidden],[inert]')||event.defaultPrevented||event.altKey||event.shiftKey||!(event.ctrlKey||event.metaKey)||event.key.toLowerCase()!==shortcut.toLowerCase())return;
      const editor=closest(event.target,'input,textarea,[contenteditable]:not([contenteditable="false"])');if(editor&&!root.contains(editor))return;
      if(root.tagName!=='DIALOG'&&!root.getClientRects().length)return;
      event.preventDefault();if(root.tagName==='DIALOG'){if(root.open)hide(root);else show(root,doc.activeElement);}else input.focus();
    });
    commandStates.set(root,{refresh});
    onDispose(root,()=>{restoreInput();restoreList();restoreEmpty();for(const original of originals.values())original.restore();if(status)status.textContent=statusText;commandStates.delete(root);});
    refresh();
  }

  const carouselStates=new WeakMap();
  function initCarousel(root) {
    const viewport=owned(root,'[data-ui-carousel-viewport]','[data-ui-carousel]')[0];if(!viewport)return;
    if(carouselStates.has(root)){carouselStates.get(root).refresh();return;}
    const listen=scopedEvents(root),originals=new Map(),originalDisabled=new WeakMap(),originalSlideLabels=new WeakMap(),status=owned(root,'[data-ui-carousel-status]','[data-ui-carousel]')[0];
    const remember=(element,names)=>{if(!originals.has(element))originals.set(element,rememberAttributes(element,names));};
    remember(root,['role','aria-roledescription','data-ui-carousel-ready','data-ui-carousel-index']);remember(viewport,['tabindex']);
    const statusText=status?.textContent;if(status)remember(status,['role','aria-live']);
    let slides=[],controls=[],index=0,pendingIndex=null,frame=0,settle=0,disposed=false;
    if(!root.hasAttribute('role'))root.setAttribute('role','region');if(!root.hasAttribute('aria-roledescription'))root.setAttribute('aria-roledescription','カルーセル');
    viewport.tabIndex=0;root.setAttribute('data-ui-carousel-ready','');
    if(status){status.setAttribute('role','status');status.setAttribute('aria-live','polite');}
    const initial=Number(root.dataset.uiCarouselIndex);if(Number.isFinite(initial))index=Math.max(0,Math.floor(initial));
    function render(notify=false) {
      for(const [i,slide] of slides.entries()){
        if(i!==index&&slide.contains(doc.activeElement))viewport.focus({preventScroll:true});
        slide.inert=i!==index;slide.setAttribute('aria-hidden',String(i!==index));
      }
      const loop=root.hasAttribute('data-ui-carousel-loop');
      for(const button of controls){
        if(button.hasAttribute('data-ui-carousel-to'))button.setAttribute('aria-pressed',String(Number(button.dataset.uiCarouselTo)===index));
        else if(button.hasAttribute('data-ui-carousel-prev'))button.disabled=originalDisabled.get(button)||slides.length<2||(!loop&&index===0);
        else button.disabled=originalDisabled.get(button)||slides.length<2||(!loop&&index===slides.length-1);
      }
      root.dataset.uiCarouselIndex=String(index);if(status)status.textContent=(slides.length?index+1:0)+' / '+slides.length;
      if(notify)emit(root,'carouselchange',{index,total:slides.length});
    }
    function goTo(value,behavior='smooth',notify=true) {
      if(!slides.length)return;
      const next=Math.max(0,Math.min(slides.length-1,Math.floor(value)));if(!Number.isFinite(next))return;
      const changed=next!==index;index=next;pendingIndex=index;render(notify&&changed);
      const delta=slides[index].getBoundingClientRect().left-viewport.getBoundingClientRect().left;
      viewport.scrollTo({left:viewport.scrollLeft+delta,behavior:reducedMotion.matches?'auto':behavior});
    }
    function measure(){
      if(disposed||!slides.length||!viewport.clientWidth)return;
      const edge=viewport.getBoundingClientRect().left;
      const distances=slides.map(slide=>Math.abs(slide.getBoundingClientRect().left-edge));
      if(pendingIndex!==null){if(distances[pendingIndex]>2)return;pendingIndex=null;}
      const next=distances.indexOf(Math.min(...distances));if(next!==index){index=next;render(true);}
    }
    function refresh(){
      slides=[...viewport.children].filter(slide=>slide.matches('.ui-carousel-slide')&&!slide.hidden);
      slides.forEach((slide,i)=>{if(!originalSlideLabels.has(slide))originalSlideLabels.set(slide,slide.getAttribute('aria-label'));remember(slide,['role','aria-roledescription','aria-label','aria-hidden','inert']);if(!slide.hasAttribute('role'))slide.setAttribute('role','group');if(!slide.hasAttribute('aria-roledescription'))slide.setAttribute('aria-roledescription','スライド');if(originalSlideLabels.get(slide)===null)slide.setAttribute('aria-label',(i+1)+' / '+slides.length);});
      controls=owned(root,'[data-ui-carousel-prev],[data-ui-carousel-next],[data-ui-carousel-to]','[data-ui-carousel]');
      for(const button of controls){if(!originals.has(button)){remember(button,['disabled','aria-pressed']);originalDisabled.set(button,button.disabled);}}
      pendingIndex=null;index=Math.min(index,Math.max(0,slides.length-1));render();goTo(index,'auto',false);
    }
    listen(root,'click',event=>{
      const button=closest(event.target,'[data-ui-carousel-prev],[data-ui-carousel-next],[data-ui-carousel-to]');
      if(!button||button.closest('[data-ui-carousel]')!==root||disabled(button))return;
      event.preventDefault();let next=button.hasAttribute('data-ui-carousel-to')?Number(button.dataset.uiCarouselTo):index+(button.hasAttribute('data-ui-carousel-prev')?-1:1);
      if(!Number.isFinite(next))return;if(root.hasAttribute('data-ui-carousel-loop')&&slides.length)next=(next+slides.length)%slides.length;goTo(next);
    });
    listen(viewport,'keydown',event=>{
      if(event.target!==viewport||event.altKey||event.ctrlKey||event.metaKey)return;
      const rtl=getComputedStyle(root).direction==='rtl';let next;
      if(event.key==='ArrowRight')next=index+(rtl?-1:1);else if(event.key==='ArrowLeft')next=index+(rtl?1:-1);else if(event.key==='Home')next=0;else if(event.key==='End')next=slides.length-1;else return;
      event.preventDefault();if(root.hasAttribute('data-ui-carousel-loop')&&slides.length)next=(next+slides.length)%slides.length;goTo(next);
    });
    listen(viewport,'scroll',()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);clearTimeout(settle);settle=setTimeout(()=>{pendingIndex=null;measure();},120);},{passive:true});
    listen(viewport,'pointerdown',()=>{pendingIndex=null;},{passive:true});listen(viewport,'wheel',()=>{pendingIndex=null;},{passive:true});
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(!disposed)goTo(index,'auto',false);}):null;observer?.observe(viewport);listen(window,'resize',()=>goTo(index,'auto',false));
    carouselStates.set(root,{refresh});
    onDispose(root,()=>{disposed=true;cancelAnimationFrame(frame);clearTimeout(settle);observer?.disconnect();for(const [element,restore] of originals){restore();}if(status)status.textContent=statusText;carouselStates.delete(root);});
    refresh();
  }

  const scrollActiveStates=new WeakMap();
  function initScrollActive(root) {
    if(scrollActiveStates.has(root)){scrollActiveStates.get(root)();return;}
    const listen=scopedEvents(root),once=root.dataset.uiScrollActive==='once';let frame=0,attempted=false,interacted=false;
    function reveal() {
      frame=0;if(once&&attempted)return;attempted=true;
      if(!root.isConnected||!root.clientHeight||!root.clientWidth)return;
      const current=all(root,'[aria-current]:not([aria-current="false"]):not([aria-current=""])').find(item=>item.closest('[data-ui-scroll-active]')===root&&item.getClientRects().length);
      if(!current)return;
      const box=root.getBoundingClientRect(),item=current.getBoundingClientRect();
      const top=box.top+root.clientTop,left=box.left+root.clientLeft;
      const bottom=top+root.clientHeight,right=left+root.clientWidth;
      // Align oversized items at their start; never scroll an ancestor or steal focus.
      const dy=root.scrollHeight>root.clientHeight?(item.top<top?item.top-top:item.bottom>bottom?Math.min(item.top-top,item.bottom-bottom):0):0;
      const dx=root.scrollWidth>root.clientWidth?(item.left<left?item.left-left:item.right>right?Math.min(item.left-left,item.right-right):0):0;
      if(Math.abs(dx)>.5||Math.abs(dy)>.5)root.scrollTo({top:root.scrollTop+dy,left:root.scrollLeft+dx,behavior:reducedMotion.matches?'instant':'auto'});
    }
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(reveal);};
    const observer=once?null:new MutationObserver(schedule);observer?.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['aria-current','hidden','open']});
    const resize=!once&&typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;resize?.observe(root);
    const stopInitial=()=>{if(interacted)return;interacted=true;attempted=true;cancelAnimationFrame(frame);frame=0;root.scrollTo({top:root.scrollTop,left:root.scrollLeft,behavior:'instant'});};
    if(once){listen(root,'pointerdown',stopInitial,{passive:true});listen(root,'keydown',stopInitial);listen(root,'wheel',stopInitial,{passive:true});}
    else {listen(root,'toggle',schedule,true);listen(window,'resize',schedule);}
    scrollActiveStates.set(root,schedule);
    onDispose(root,()=>{observer?.disconnect();resize?.disconnect();cancelAnimationFrame(frame);if(once)stopInitial();scrollActiveStates.delete(root);});
    schedule();
  }

  const dataTableStates=new WeakMap();
  function initDataTable(root) {
    if(dataTableStates.has(root)){dataTableStates.get(root)();return;}
    const table=root.matches('table')?root:owned(root,'table','[data-ui-data-table]')[0],body=table?.tBodies[0];if(!body)return;
    const own=selector=>owned(root,selector,'[data-ui-data-table]');
    const listen=scopedEvents(root),restores=new Map(),rows=new Map(),sortLabels=new Map(),originalDisabled=new WeakMap(),forms=new Set();
    const remember=(element,attributes)=>{if(element&&!restores.has(element))restores.set(element,rememberAttributes(element,attributes));};
    const texts=new Map();
    const rememberText=element=>{if(!texts.has(element))texts.set(element,element.textContent);remember(element,['role']);element.setAttribute('role','status');};
    remember(root,table===root?['data-ui-table-ready','id']:['data-ui-table-ready']);remember(table,['id']);id(table);root.setAttribute('data-ui-table-ready','');
    const empty=doc.createElement('tr'),emptyCell=doc.createElement('td');empty.className='ui-data-table-empty';empty.setAttribute('data-ui-table-empty','');empty.append(emptyCell);body.append(empty);
    const collator=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
    const normalize=value=>String(value).normalize('NFKC').toLocaleLowerCase().trim();
    const inactive=element=>!element||element.matches(':disabled')||disabled(element);
    const rowCheck=row=>[...row.querySelectorAll('input[type="checkbox"][data-ui-row-select]')].find(input=>input.closest('tr')===row);
    let records=[],buttons=[],page=1,sort=null,visible=[],filtered=[],search=null,sizeControl=null,resetTimer=0,nextIndex=0;
    const pageSize=()=>{const value=sizeControl?.value??root.dataset.uiPageSize??'10',number=Number(value);return String(value).trim()!==''&&Number.isInteger(number)&&number>=0?number:10;};
    const selectedRows=()=>records.filter(record=>!record.hidden&&rowCheck(record.row)?.checked&&!inactive(rowCheck(record.row)));
    function selection(notify=false) {
      const selected=selectedRows(),chosen=new Set(selected.map(record=>record.row));
      for(const record of records)record.row.toggleAttribute('data-ui-row-selected',chosen.has(record.row));
      const eligible=visible.map(record=>rowCheck(record.row)).filter(input=>!inactive(input)),count=eligible.filter(input=>input.checked).length;
      for(const input of own('input[type="checkbox"][data-ui-table-select-all]')){
        input.checked=eligible.length>0&&count===eligible.length;input.indeterminate=count>0&&count<eligible.length;input.disabled=originalDisabled.get(input)||eligible.length===0;
      }
      for(const output of own('[data-ui-table-selection]')){rememberText(output);output.textContent=selected.length+'件を選択';}
      if(notify)emit(root,'tableselect',{selected:selected.map(record=>record.row.dataset.uiRowId||record.row.id||String(record.index)),rows:selected.map(record=>record.row)});
    }
    function value(record,index,type) {
      const cell=record.row.cells[index];if(!cell)return null;
      const text=normalize(cell.getAttribute('data-ui-sort-value')??cell.textContent);if(!text)return null;
      if(type==='number'){const value=Number(text.replaceAll(',',''));return Number.isFinite(value)?value:null;}
      if(type==='date'){const value=Date.parse(text);return Number.isFinite(value)?value:null;}
      return text;
    }
    function render(notify=false) {
      const words=normalize(search?.value||'').split(/\s+/).filter(Boolean),data=records.filter(record=>!record.hidden);
      filtered=data.filter(record=>{const text=normalize([...record.row.cells].filter(cell=>!cell.hasAttribute('data-ui-table-ignore')).map(cell=>cell.textContent).join(' ')+' '+(record.row.dataset.uiTableKeywords||''));return words.every(word=>text.includes(word));});
      let ordered=[...records];
      if(sort)ordered.sort((a,b)=>{
        const av=value(a,sort.index,sort.type),bv=value(b,sort.index,sort.type);if(av===null||bv===null)return av===bv?a.index-b.index:av===null?1:-1;
        const result=typeof av==='number'?av-bv:collator.compare(av,bv);return result*(sort.direction==='ascending'?1:-1)||a.index-b.index;
      });
      else ordered.sort((a,b)=>a.index-b.index);
      const matching=new Set(filtered);filtered=ordered.filter(record=>matching.has(record));
      const size=pageSize(),pages=Math.max(1,size?Math.ceil(filtered.length/size):1);page=Math.min(pages,Math.max(1,Number.isFinite(page)?Math.floor(page):1));
      const start=size?(page-1)*size:0;visible=size?filtered.slice(start,start+size):filtered;
      const showing=new Set(visible);
      for(const record of records)record.row.hidden=record.hidden||!showing.has(record);
      const focused=doc.activeElement;
      ordered.forEach((record,index)=>{if(body.rows[index]!==record.row)body.insertBefore(record.row,body.rows[index]||null);});
      body.append(empty);empty.hidden=filtered.length>0;emptyCell.colSpan=[...(table.tHead?.rows||[]),...records.map(record=>record.row)].reduce((columns,row)=>Math.max(columns,[...row.cells].reduce((sum,cell)=>sum+cell.colSpan,0)),1);
      emptyCell.textContent=root.dataset.uiTableEmpty||'一致するデータがありません。';
      if(focused&&root.contains(focused)&&doc.activeElement!==focused&&!focused.closest('[hidden]'))focused.focus({preventScroll:true});
      for(const button of buttons){
        const active=sort?.button===button,header=button.closest('th');if(active)header.setAttribute('aria-sort',sort.direction);else header.removeAttribute('aria-sort');
        const next=active?(sort.direction==='ascending'?'降順に並べ替え':'元の順序に戻す'):'昇順に並べ替え';button.setAttribute('aria-label',sortLabels.get(button)+'：'+next);
      }
      for(const button of own('[data-ui-table-prev], [data-ui-table-next], [data-ui-table-first], [data-ui-table-last], [data-ui-table-page]')){
        const target=button.hasAttribute('data-ui-table-page')?Number(button.dataset.uiTablePage):button.hasAttribute('data-ui-table-prev')?page-1:button.hasAttribute('data-ui-table-next')?page+1:button.hasAttribute('data-ui-table-first')?1:pages;
        button.disabled=originalDisabled.get(button)||!Number.isInteger(target)||target<1||target>pages||((button.hasAttribute('data-ui-table-first')||button.hasAttribute('data-ui-table-last'))&&target===page);
        if(button.hasAttribute('data-ui-table-page')){if(target===page)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');}
      }
      for(const output of own('[data-ui-table-status]')){rememberText(output);output.textContent='全'+data.length+'件中 '+(visible.length?(start+1)+'–'+(start+visible.length):'0')+'件を表示'+(filtered.length!==data.length?'（検索結果'+filtered.length+'件）':'');}
      for(const output of own('[data-ui-table-page-status]')){rememberText(output);output.textContent=page+' / '+pages+'ページ';}
      selection();
      if(notify)emit(root,'tablechange',{search:search?.value||'',page,pageSize:size,total:data.length,filtered:filtered.length,pageCount:pages,sort:sort?{column:sort.index,type:sort.type,direction:sort.direction}:null});
    }
    function refresh() {
      records=[...body.rows].filter(row=>row!==empty).map(row=>{if(!rows.has(row)){remember(row,['hidden','data-ui-row-selected']);rows.set(row,{row,hidden:row.hidden,index:nextIndex++});}return rows.get(row);});
      search=own('[data-ui-table-search]')[0];sizeControl=own('[data-ui-table-page-size]')[0];
      for(const control of [search,sizeControl].filter(Boolean)){remember(control,['aria-controls']);control.setAttribute('aria-controls',table.id);}
      buttons=own('button[data-ui-table-sort]').filter(button=>button.closest('table')===table&&button.closest('th'));
      for(const button of buttons){if(!sortLabels.has(button))sortLabels.set(button,button.getAttribute('aria-label')||button.textContent.trim());remember(button,['aria-label']);remember(button.closest('th'),['aria-sort','scope']);if(!button.closest('th').hasAttribute('scope'))button.closest('th').scope='col';}
      if(sort&&!buttons.includes(sort.button))sort=null;
      for(const input of own('input[type="checkbox"][data-ui-table-select-all]'))if(!originalDisabled.has(input)){
        originalDisabled.set(input,input.disabled);const checked=input.checked,indeterminate=input.indeterminate;remember(input,['disabled']);onDispose(root,()=>{input.checked=checked;input.indeterminate=indeterminate;});
      }
      for(const button of own('button[data-ui-table-prev], button[data-ui-table-next], button[data-ui-table-first], button[data-ui-table-last], button[data-ui-table-page]'))if(!originalDisabled.has(button)){originalDisabled.set(button,button.disabled);remember(button,['disabled','aria-current']);}
      for(const control of own('input,select'))if(control.form&&!forms.has(control.form)){
        forms.add(control.form);listen(control.form,'reset',event=>{clearTimeout(resetTimer);resetTimer=setTimeout(()=>{if(event.defaultPrevented)return;page=1;sort=null;render(true);selection(true);},0);});
      }
      render();
    }
    listen(root,'input',event=>{if(event.target===search){page=1;render(true);}});
    listen(root,'keydown',event=>{if(event.target===search&&event.key==='Enter'&&!event.isComposing)event.preventDefault();});
    listen(root,'change',event=>{
      if(event.target===sizeControl){page=1;render(true);return;}
      const input=event.target;if(input.closest('[data-ui-data-table]')!==root)return;
      if(input.matches('input[type="checkbox"][data-ui-table-select-all]')&&!inactive(input)){
        for(const record of visible){const check=rowCheck(record.row);if(!inactive(check))check.checked=input.checked;}selection(true);
      }else if(input.matches('input[type="checkbox"][data-ui-row-select]')&&records.some(record=>rowCheck(record.row)===input))selection(true);
    });
    listen(root,'click',event=>{
      // A tap on the check cell's padding toggles its checkbox, so the cell is the touch target.
      const cell=event.target instanceof Element&&event.target.matches('.ui-data-table-check')?event.target:null;
      const check=cell?.querySelector(':scope > input[type="checkbox"]:is([data-ui-row-select],[data-ui-table-select-all])');
      if(check&&cell.closest('[data-ui-data-table]')===root&&!inactive(check)){check.click();return;}
      const button=closest(event.target,'button[data-ui-table-sort], button[data-ui-table-prev], button[data-ui-table-next], button[data-ui-table-first], button[data-ui-table-last], button[data-ui-table-page]');if(!button||button.closest('[data-ui-data-table]')!==root||inactive(button))return;
      event.preventDefault();
      if(button.hasAttribute('data-ui-table-sort')){
        if(!buttons.includes(button))return;
        if(sort?.button===button)sort=sort.direction==='ascending'?{...sort,direction:'descending'}:null;
        else {const header=button.closest('th');sort={button,index:[...header.parentElement.cells].slice(0,header.cellIndex).reduce((sum,cell)=>sum+cell.colSpan,0),type:['number','date'].includes(button.dataset.uiTableSort)?button.dataset.uiTableSort:'text',direction:'ascending'};}
        page=1;
      }else {const size=pageSize(),pages=Math.max(1,size?Math.ceil(filtered.length/size):1);page=button.hasAttribute('data-ui-table-page')?Number(button.dataset.uiTablePage):button.hasAttribute('data-ui-table-prev')?page-1:button.hasAttribute('data-ui-table-next')?page+1:button.hasAttribute('data-ui-table-first')?1:pages;}
      render(true);
    });
    dataTableStates.set(root,refresh);
    onDispose(root,()=>{clearTimeout(resetTimer);empty.remove();for(const [element,restore]of restores)restore();for(const [element,text]of texts)element.textContent=text;[...rows.values()].sort((a,b)=>a.index-b.index).filter(record=>record.row.parentElement===body).forEach(record=>body.append(record.row));dataTableStates.delete(root);});
    refresh();
  }

  const agentFlowStates=new WeakSet();
  function initAgentFlow(root) {
    if(agentFlowStates.has(root))return;
    const restore=rememberAttributes(root,['data-ui-agent-visible']),listen=scopedEvents(root);
    let visible=false,disposed=false;
    const sync=()=>{if(!disposed)root.toggleAttribute('data-ui-agent-visible',visible&&!doc.hidden);};
    // CSS-only and browsers without visibility observation keep a static gradient.
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
      visible=entries.some(entry=>entry.isIntersecting&&entry.intersectionRatio>0);sync();
    }):null;
    root.removeAttribute('data-ui-agent-visible');observer?.observe(root);
    listen(doc,'visibilitychange',sync);
    agentFlowStates.add(root);
    onDispose(root,()=>{disposed=true;observer?.disconnect();restore();agentFlowStates.delete(root);});
  }

  function init(scope = doc) {
    scanIcons(scope);
    const scan = selector => [...(scope.matches?.(selector) ? [scope] : []), ...all(scope, selector)].filter(element=>scopeOwns(scope,element));
    scan('[data-ui-agent-flow]').forEach(initAgentFlow);
    scan('[data-ui-data-table]').forEach(initDataTable);
    scan('[data-ui-scroll-active]').forEach(initScrollActive);
    scan('[data-ui-command]').forEach(initCommand);
    scan('[data-ui-carousel]').forEach(initCarousel);
    scan('[data-ui-splitter]').forEach(initSplitter);
    scan('[data-ui-navbar]').forEach(initNavbar);
    scan('[data-ui-sidebar]').forEach(initResponsiveSidebar);
    scan('[data-ui-tabs]').forEach(group => {
      const {tabs} = tabData(group);
      const tab = tabs.find(item => item.getAttribute('aria-selected') === 'true' && !disabled(item)) || tabs.find(item => !disabled(item));
      if (tab) activateTab(tab, false);
    });
    scan('[data-ui-pagination]').forEach(group => {
      renderPage(group, pageStates.get(group) || 1, false);
    });
    scan('[data-ui-file-drop]').forEach(initFileDrop);
    scan('[data-ui-chart]').forEach(initChart);
    scan('[data-ui-dropdown], [data-ui-popover]').forEach(initPopup);
    scan('[data-ui-toggle="dropdown"], [data-ui-toggle="popover"]').forEach(trigger=>{const panel=target(trigger);if(initPopup(panel))syncPopup(panel,popupOpen(panel));});
    scan('[data-ui-toggle="theme"]').forEach(syncThemeToggle);
    scan('input[type="checkbox"][data-ui-indeterminate]').forEach(initMixedCheckbox);
    scan('form[data-ui-validate]').forEach(form => { form.noValidate = true; });
    scan('[data-ui-board]').forEach(updateBoard);
    scan('[data-ui-calendar]').forEach(root => renderCalendar(root));
    scan('[data-ui-datepicker]').forEach(initDatepicker);
    scan('input.form-control[type="time"], input.form-control[type="datetime-local"], input.form-control[type="month"], input.form-control[type="week"], input.form-control[type="color"]').forEach(initInputPicker);
    scan('button[data-ui-copy], button[data-ui-copy-target]').forEach(initCopyIcon);
    syncDesignThemeControls(scope);
    syncColorThemeControls(scope);
    scan('form[data-ui-palette-editor]').forEach(initPaletteEditor);
    syncPaletteControls(scope);
    scan('select.form-select, select[data-ui-theme-select], select[data-ui-color-select], select[data-ui-palette-select]').forEach(initSelect);
    scan('[data-ui-toggle="collapse"], [data-ui-toggle="sidebar"]').forEach(button => {
      const panel = target(button);
      if (panel) sync(panel);
    });
  }
  const designThemes = ['default', 'glass', 'glassmorphism', 'flat', 'soft'];
  function syncDesignThemeControls(scope = doc) {
    const value = doc.body.dataset.uiTheme || 'default';
    if (scope.matches?.('select[data-ui-theme-select]')) scope.value = value;
    all(scope, 'select[data-ui-theme-select]').forEach(select => { select.value = value; syncSelect(select); });
    if (scope.matches?.('select[data-ui-theme-select]')) syncSelect(scope);
    [...(scope.matches?.('[data-ui-design]')?[scope]:[]),...all(scope, '[data-ui-design]')].forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.uiDesign===value)));
  }
  function applyDesignTheme(theme, notify = true) {
    const before = doc.body.dataset.uiTheme || 'default';
    doc.body.dataset.uiTheme = theme;
    syncDesignThemeControls();
    if (notify && before !== theme) { emit(doc.body, 'designchange', {theme}); }
  }
  function setDesignTheme(theme, {persist = false} = {}) {
    if (!designThemes.includes(theme)) return false;
    applyDesignTheme(theme);
    if (persist) {
      try { localStorage.setItem('kav-ui-design-theme', theme); } catch { /* Theme selection still works without storage. */ }
    }
    return true;
  }
  // Percent units, matching the public CSS variable. Each glass theme clamps its lower bound.
  function setSurfaceOpacity(value, {persist = false} = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const opacity = Math.min(100, Math.max(52, value));
    doc.body.style.setProperty('--ui-theme-surface-opacity', opacity + '%');
    if (persist) {
      try { localStorage.setItem('kav-ui-surface-opacity', String(opacity)); } catch { /* Storage is optional. */ }
    }
    return true;
  }
  doc.addEventListener('change', event => {
    const select = closest(event.target, 'select[data-ui-theme-select]');
    if (!select || disabled(select)) return;
    setDesignTheme(select.value, {persist:doc.body.hasAttribute('data-ui-theme-persist')});
    syncDesignThemeControls();
  });
  // BEGIN BUNDLED MATERIAL COLOR UTILITIES
  // Apache-2.0, Google LLC; notices: assets/vendor/material-color-utilities.
  const materialColors = (() => {
    const modules = {
"hct/cam16": (require) => {
const utils = require("utils/color_utils");
const math = require("utils/math_utils");
const { ViewingConditions } = require("hct/viewing_conditions");
class Cam16 {
    hue;
    chroma;
    j;
    q;
    m;
    s;
    jstar;
    astar;
    bstar;
    constructor(hue, chroma, j, q, m, s, jstar, astar, bstar){
        this.hue = hue;
        this.chroma = chroma;
        this.j = j;
        this.q = q;
        this.m = m;
        this.s = s;
        this.jstar = jstar;
        this.astar = astar;
        this.bstar = bstar;
    }
    distance(other) {
        const dJ = this.jstar - other.jstar;
        const dA = this.astar - other.astar;
        const dB = this.bstar - other.bstar;
        const dEPrime = Math.sqrt(dJ * dJ + dA * dA + dB * dB);
        const dE = 1.41 * Math.pow(dEPrime, 0.63);
        return dE;
    }
    static fromInt(argb) {
        return Cam16.fromIntInViewingConditions(argb, ViewingConditions.DEFAULT);
    }
    static fromIntInViewingConditions(argb, viewingConditions) {
        const red = (argb & 0x00ff0000) >> 16;
        const green = (argb & 0x0000ff00) >> 8;
        const blue = argb & 0x000000ff;
        const redL = utils.linearized(red);
        const greenL = utils.linearized(green);
        const blueL = utils.linearized(blue);
        const x = 0.41233895 * redL + 0.35762064 * greenL + 0.18051042 * blueL;
        const y = 0.2126 * redL + 0.7152 * greenL + 0.0722 * blueL;
        const z = 0.01932141 * redL + 0.11916382 * greenL + 0.95034478 * blueL;
        const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
        const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
        const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
        const rD = viewingConditions.rgbD[0] * rC;
        const gD = viewingConditions.rgbD[1] * gC;
        const bD = viewingConditions.rgbD[2] * bC;
        const rAF = Math.pow(viewingConditions.fl * Math.abs(rD) / 100.0, 0.42);
        const gAF = Math.pow(viewingConditions.fl * Math.abs(gD) / 100.0, 0.42);
        const bAF = Math.pow(viewingConditions.fl * Math.abs(bD) / 100.0, 0.42);
        const rA = math.signum(rD) * 400.0 * rAF / (rAF + 27.13);
        const gA = math.signum(gD) * 400.0 * gAF / (gAF + 27.13);
        const bA = math.signum(bD) * 400.0 * bAF / (bAF + 27.13);
        const a = (11.0 * rA + -12.0 * gA + bA) / 11.0;
        const b = (rA + gA - 2.0 * bA) / 9.0;
        const u = (20.0 * rA + 20.0 * gA + 21.0 * bA) / 20.0;
        const p2 = (40.0 * rA + 20.0 * gA + bA) / 20.0;
        const atan2 = Math.atan2(b, a);
        const atanDegrees = atan2 * 180.0 / Math.PI;
        const hue = math.sanitizeDegreesDouble(atanDegrees);
        const hueRadians = hue * Math.PI / 180.0;
        const ac = p2 * viewingConditions.nbb;
        const j = 100.0 * Math.pow(ac / viewingConditions.aw, viewingConditions.c * viewingConditions.z);
        const q = 4.0 / viewingConditions.c * Math.sqrt(j / 100.0) * (viewingConditions.aw + 4.0) * viewingConditions.fLRoot;
        const huePrime = hue < 20.14 ? hue + 360 : hue;
        const eHue = 0.25 * (Math.cos(huePrime * Math.PI / 180.0 + 2.0) + 3.8);
        const p1 = 50000.0 / 13.0 * eHue * viewingConditions.nc * viewingConditions.ncb;
        const t = p1 * Math.sqrt(a * a + b * b) / (u + 0.305);
        const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
        const c = alpha * Math.sqrt(j / 100.0);
        const m = c * viewingConditions.fLRoot;
        const s = 50.0 * Math.sqrt(alpha * viewingConditions.c / (viewingConditions.aw + 4.0));
        const jstar = (1.0 + 100.0 * 0.007) * j / (1.0 + 0.007 * j);
        const mstar = 1.0 / 0.0228 * Math.log(1.0 + 0.0228 * m);
        const astar = mstar * Math.cos(hueRadians);
        const bstar = mstar * Math.sin(hueRadians);
        return new Cam16(hue, c, j, q, m, s, jstar, astar, bstar);
    }
    static fromJch(j, c, h) {
        return Cam16.fromJchInViewingConditions(j, c, h, ViewingConditions.DEFAULT);
    }
    static fromJchInViewingConditions(j, c, h, viewingConditions) {
        const q = 4.0 / viewingConditions.c * Math.sqrt(j / 100.0) * (viewingConditions.aw + 4.0) * viewingConditions.fLRoot;
        const m = c * viewingConditions.fLRoot;
        const alpha = c / Math.sqrt(j / 100.0);
        const s = 50.0 * Math.sqrt(alpha * viewingConditions.c / (viewingConditions.aw + 4.0));
        const hueRadians = h * Math.PI / 180.0;
        const jstar = (1.0 + 100.0 * 0.007) * j / (1.0 + 0.007 * j);
        const mstar = 1.0 / 0.0228 * Math.log(1.0 + 0.0228 * m);
        const astar = mstar * Math.cos(hueRadians);
        const bstar = mstar * Math.sin(hueRadians);
        return new Cam16(h, c, j, q, m, s, jstar, astar, bstar);
    }
    static fromUcs(jstar, astar, bstar) {
        return Cam16.fromUcsInViewingConditions(jstar, astar, bstar, ViewingConditions.DEFAULT);
    }
    static fromUcsInViewingConditions(jstar, astar, bstar, viewingConditions) {
        const a = astar;
        const b = bstar;
        const m = Math.sqrt(a * a + b * b);
        const M = (Math.exp(m * 0.0228) - 1.0) / 0.0228;
        const c = M / viewingConditions.fLRoot;
        let h = Math.atan2(b, a) * (180.0 / Math.PI);
        if (h < 0.0) {
            h += 360.0;
        }
        const j = jstar / (1 - (jstar - 100) * 0.007);
        return Cam16.fromJchInViewingConditions(j, c, h, viewingConditions);
    }
    toInt() {
        return this.viewed(ViewingConditions.DEFAULT);
    }
    viewed(viewingConditions) {
        const alpha = this.chroma === 0.0 || this.j === 0.0 ? 0.0 : this.chroma / Math.sqrt(this.j / 100.0);
        const t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73), 1.0 / 0.9);
        const hRad = this.hue * Math.PI / 180.0;
        const eHue = 0.25 * (Math.cos(hRad + 2.0) + 3.8);
        const ac = viewingConditions.aw * Math.pow(this.j / 100.0, 1.0 / viewingConditions.c / viewingConditions.z);
        const p1 = eHue * (50000.0 / 13.0) * viewingConditions.nc * viewingConditions.ncb;
        const p2 = ac / viewingConditions.nbb;
        const hSin = Math.sin(hRad);
        const hCos = Math.cos(hRad);
        const gamma = 23.0 * (p2 + 0.305) * t / (23.0 * p1 + 11.0 * t * hCos + 108.0 * t * hSin);
        const a = gamma * hCos;
        const b = gamma * hSin;
        const rA = (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0;
        const gA = (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0;
        const bA = (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0;
        const rCBase = Math.max(0, 27.13 * Math.abs(rA) / (400.0 - Math.abs(rA)));
        const rC = math.signum(rA) * (100.0 / viewingConditions.fl) * Math.pow(rCBase, 1.0 / 0.42);
        const gCBase = Math.max(0, 27.13 * Math.abs(gA) / (400.0 - Math.abs(gA)));
        const gC = math.signum(gA) * (100.0 / viewingConditions.fl) * Math.pow(gCBase, 1.0 / 0.42);
        const bCBase = Math.max(0, 27.13 * Math.abs(bA) / (400.0 - Math.abs(bA)));
        const bC = math.signum(bA) * (100.0 / viewingConditions.fl) * Math.pow(bCBase, 1.0 / 0.42);
        const rF = rC / viewingConditions.rgbD[0];
        const gF = gC / viewingConditions.rgbD[1];
        const bF = bC / viewingConditions.rgbD[2];
        const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
        const y = 0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF;
        const z = -0.01584150 * rF - 0.03412294 * gF + 1.04996444 * bF;
        const argb = utils.argbFromXyz(x, y, z);
        return argb;
    }
    static fromXyzInViewingConditions(x, y, z, viewingConditions) {
        const rC = 0.401288 * x + 0.650173 * y - 0.051461 * z;
        const gC = -0.250268 * x + 1.204414 * y + 0.045854 * z;
        const bC = -0.002079 * x + 0.048952 * y + 0.953127 * z;
        const rD = viewingConditions.rgbD[0] * rC;
        const gD = viewingConditions.rgbD[1] * gC;
        const bD = viewingConditions.rgbD[2] * bC;
        const rAF = Math.pow(viewingConditions.fl * Math.abs(rD) / 100.0, 0.42);
        const gAF = Math.pow(viewingConditions.fl * Math.abs(gD) / 100.0, 0.42);
        const bAF = Math.pow(viewingConditions.fl * Math.abs(bD) / 100.0, 0.42);
        const rA = math.signum(rD) * 400.0 * rAF / (rAF + 27.13);
        const gA = math.signum(gD) * 400.0 * gAF / (gAF + 27.13);
        const bA = math.signum(bD) * 400.0 * bAF / (bAF + 27.13);
        const a = (11.0 * rA + -12.0 * gA + bA) / 11.0;
        const b = (rA + gA - 2.0 * bA) / 9.0;
        const u = (20.0 * rA + 20.0 * gA + 21.0 * bA) / 20.0;
        const p2 = (40.0 * rA + 20.0 * gA + bA) / 20.0;
        const atan2 = Math.atan2(b, a);
        const atanDegrees = atan2 * 180.0 / Math.PI;
        const hue = atanDegrees < 0 ? atanDegrees + 360.0 : atanDegrees >= 360 ? atanDegrees - 360 : atanDegrees;
        const hueRadians = hue * Math.PI / 180.0;
        const ac = p2 * viewingConditions.nbb;
        const J = 100.0 * Math.pow(ac / viewingConditions.aw, viewingConditions.c * viewingConditions.z);
        const Q = 4.0 / viewingConditions.c * Math.sqrt(J / 100.0) * (viewingConditions.aw + 4.0) * viewingConditions.fLRoot;
        const huePrime = hue < 20.14 ? hue + 360 : hue;
        const eHue = 1.0 / 4.0 * (Math.cos(huePrime * Math.PI / 180.0 + 2.0) + 3.8);
        const p1 = 50000.0 / 13.0 * eHue * viewingConditions.nc * viewingConditions.ncb;
        const t = p1 * Math.sqrt(a * a + b * b) / (u + 0.305);
        const alpha = Math.pow(t, 0.9) * Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
        const C = alpha * Math.sqrt(J / 100.0);
        const M = C * viewingConditions.fLRoot;
        const s = 50.0 * Math.sqrt(alpha * viewingConditions.c / (viewingConditions.aw + 4.0));
        const jstar = (1.0 + 100.0 * 0.007) * J / (1.0 + 0.007 * J);
        const mstar = Math.log(1.0 + 0.0228 * M) / 0.0228;
        const astar = mstar * Math.cos(hueRadians);
        const bstar = mstar * Math.sin(hueRadians);
        return new Cam16(hue, C, J, Q, M, s, jstar, astar, bstar);
    }
    xyzInViewingConditions(viewingConditions) {
        const alpha = this.chroma === 0.0 || this.j === 0.0 ? 0.0 : this.chroma / Math.sqrt(this.j / 100.0);
        const t = Math.pow(alpha / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73), 1.0 / 0.9);
        const hRad = this.hue * Math.PI / 180.0;
        const eHue = 0.25 * (Math.cos(hRad + 2.0) + 3.8);
        const ac = viewingConditions.aw * Math.pow(this.j / 100.0, 1.0 / viewingConditions.c / viewingConditions.z);
        const p1 = eHue * (50000.0 / 13.0) * viewingConditions.nc * viewingConditions.ncb;
        const p2 = ac / viewingConditions.nbb;
        const hSin = Math.sin(hRad);
        const hCos = Math.cos(hRad);
        const gamma = 23.0 * (p2 + 0.305) * t / (23.0 * p1 + 11 * t * hCos + 108.0 * t * hSin);
        const a = gamma * hCos;
        const b = gamma * hSin;
        const rA = (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0;
        const gA = (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0;
        const bA = (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0;
        const rCBase = Math.max(0, 27.13 * Math.abs(rA) / (400.0 - Math.abs(rA)));
        const rC = math.signum(rA) * (100.0 / viewingConditions.fl) * Math.pow(rCBase, 1.0 / 0.42);
        const gCBase = Math.max(0, 27.13 * Math.abs(gA) / (400.0 - Math.abs(gA)));
        const gC = math.signum(gA) * (100.0 / viewingConditions.fl) * Math.pow(gCBase, 1.0 / 0.42);
        const bCBase = Math.max(0, 27.13 * Math.abs(bA) / (400.0 - Math.abs(bA)));
        const bC = math.signum(bA) * (100.0 / viewingConditions.fl) * Math.pow(bCBase, 1.0 / 0.42);
        const rF = rC / viewingConditions.rgbD[0];
        const gF = gC / viewingConditions.rgbD[1];
        const bF = bC / viewingConditions.rgbD[2];
        const x = 1.86206786 * rF - 1.01125463 * gF + 0.14918677 * bF;
        const y = 0.38752654 * rF + 0.62144744 * gF - 0.00897398 * bF;
        const z = -0.01584150 * rF - 0.03412294 * gF + 1.04996444 * bF;
        return [
            x,
            y,
            z
        ];
    }
}

return {Cam16};
},
"hct/hct": (require) => {
const utils = require("utils/color_utils");
const { Cam16 } = require("hct/cam16");
const { HctSolver } = require("hct/hct_solver");
const { ViewingConditions } = require("hct/viewing_conditions");
class Hct {
    argb;
    internalHue;
    internalChroma;
    internalTone;
    static from(hue, chroma, tone) {
        return new Hct(HctSolver.solveToInt(hue, chroma, tone));
    }
    static fromInt(argb) {
        return new Hct(argb);
    }
    toInt() {
        return this.argb;
    }
    get hue() {
        return this.internalHue;
    }
    set hue(newHue) {
        this.setInternalState(HctSolver.solveToInt(newHue, this.internalChroma, this.internalTone));
    }
    get chroma() {
        return this.internalChroma;
    }
    set chroma(newChroma) {
        this.setInternalState(HctSolver.solveToInt(this.internalHue, newChroma, this.internalTone));
    }
    get tone() {
        return this.internalTone;
    }
    set tone(newTone) {
        this.setInternalState(HctSolver.solveToInt(this.internalHue, this.internalChroma, newTone));
    }
    setValue(propertyName, value) {
        this[propertyName] = value;
    }
    toString() {
        return `HCT(${this.hue.toFixed(0)}, ${this.chroma.toFixed(0)}, ${this.tone.toFixed(0)})`;
    }
    static isBlue(hue) {
        return hue >= 250 && hue < 270;
    }
    static isYellow(hue) {
        return hue >= 105 && hue < 125;
    }
    static isCyan(hue) {
        return hue >= 170 && hue < 207;
    }
    constructor(argb){
        this.argb = argb;
        const cam = Cam16.fromInt(argb);
        this.internalHue = cam.hue;
        this.internalChroma = cam.chroma;
        this.internalTone = utils.lstarFromArgb(argb);
        this.argb = argb;
    }
    setInternalState(argb) {
        const cam = Cam16.fromInt(argb);
        this.internalHue = cam.hue;
        this.internalChroma = cam.chroma;
        this.internalTone = utils.lstarFromArgb(argb);
        this.argb = argb;
    }
    inViewingConditions(vc) {
        const cam = Cam16.fromInt(this.toInt());
        const viewedInVc = cam.xyzInViewingConditions(vc);
        const recastInVc = Cam16.fromXyzInViewingConditions(viewedInVc[0], viewedInVc[1], viewedInVc[2], ViewingConditions.make());
        const recastHct = Hct.from(recastInVc.hue, recastInVc.chroma, utils.lstarFromY(viewedInVc[1]));
        return recastHct;
    }
}

return {Hct};
},
"hct/hct_solver": (require) => {
const colorUtils = require("utils/color_utils");
const mathUtils = require("utils/math_utils");
const { Cam16 } = require("hct/cam16");
const { ViewingConditions } = require("hct/viewing_conditions");
class HctSolver {
    static SCALED_DISCOUNT_FROM_LINRGB = [
        [
            0.001200833568784504,
            0.002389694492170889,
            0.0002795742885861124
        ],
        [
            0.0005891086651375999,
            0.0029785502573438758,
            0.0003270666104008398
        ],
        [
            0.00010146692491640572,
            0.0005364214359186694,
            0.0032979401770712076
        ]
    ];
    static LINRGB_FROM_SCALED_DISCOUNT = [
        [
            1373.2198709594231,
            -1100.4251190754821,
            -7.278681089101213
        ],
        [
            -271.815969077903,
            559.6580465940733,
            -32.46047482791194
        ],
        [
            1.9622899599665666,
            -57.173814538844006,
            308.7233197812385
        ]
    ];
    static Y_FROM_LINRGB = [
        0.2126,
        0.7152,
        0.0722
    ];
    static CRITICAL_PLANES = [
        0.015176349177441876,
        0.045529047532325624,
        0.07588174588720938,
        0.10623444424209313,
        0.13658714259697685,
        0.16693984095186062,
        0.19729253930674434,
        0.2276452376616281,
        0.2579979360165119,
        0.28835063437139563,
        0.3188300904430532,
        0.350925934958123,
        0.3848314933096426,
        0.42057480301049466,
        0.458183274052838,
        0.4976837250274023,
        0.5391024159806381,
        0.5824650784040898,
        0.6277969426914107,
        0.6751227633498623,
        0.7244668422128921,
        0.775853049866786,
        0.829304845476233,
        0.8848452951698498,
        0.942497089126609,
        1.0022825574869039,
        1.0642236851973577,
        1.1283421258858297,
        1.1946592148522128,
        1.2631959812511864,
        1.3339731595349034,
        1.407011200216447,
        1.4823302800086415,
        1.5599503113873272,
        1.6398909516233677,
        1.7221716113234105,
        1.8068114625156377,
        1.8938294463134073,
        1.9832442801866852,
        2.075074464868551,
        2.1693382909216234,
        2.2660538449872063,
        2.36523901573795,
        2.4669114995532007,
        2.5710888059345764,
        2.6777882626779785,
        2.7870270208169257,
        2.898822059350997,
        3.0131901897720907,
        3.1301480604002863,
        3.2497121605402226,
        3.3718988244681087,
        3.4967242352587946,
        3.624204428461639,
        3.754355295633311,
        3.887192587735158,
        4.022731918402185,
        4.160988767090289,
        4.301978482107941,
        4.445716283538092,
        4.592217266055746,
        4.741496401646282,
        4.893568542229298,
        5.048448422192488,
        5.20615066083972,
        5.3666897647573375,
        5.5300801301023865,
        5.696336044816294,
        5.865471690767354,
        6.037501145825082,
        6.212438385869475,
        6.390297286737924,
        6.571091626112461,
        6.7548350853498045,
        6.941541251256611,
        7.131223617812143,
        7.323895587840543,
        7.5195704746346665,
        7.7182615035334345,
        7.919981813454504,
        8.124744458384042,
        8.332562408825165,
        8.543448553206703,
        8.757415699253682,
        8.974476575321063,
        9.194643831691977,
        9.417930041841839,
        9.644347703669503,
        9.873909240696694,
        10.106627003236781,
        10.342513269534024,
        10.58158024687427,
        10.8238400726681,
        11.069304815507364,
        11.317986476196008,
        11.569896988756009,
        11.825048221409341,
        12.083451977536606,
        12.345119996613247,
        12.610063955123938,
        12.878295467455942,
        13.149826086772048,
        13.42466730586372,
        13.702830557985108,
        13.984327217668513,
        14.269168601521828,
        14.55736596900856,
        14.848930523210871,
        15.143873411576273,
        15.44220572664832,
        15.743938506781891,
        16.04908273684337,
        16.35764934889634,
        16.66964922287304,
        16.985093187232053,
        17.30399201960269,
        17.62635644741625,
        17.95219714852476,
        18.281524751807332,
        18.614349837764564,
        18.95068293910138,
        19.290534541298456,
        19.633915083172692,
        19.98083495742689,
        20.331304511189067,
        20.685334046541502,
        21.042933821039977,
        21.404114048223256,
        21.76888489811322,
        22.137256497705877,
        22.50923893145328,
        22.884842241736916,
        23.264076429332462,
        23.6469514538663,
        24.033477234264016,
        24.42366364919083,
        24.817520537484558,
        25.21505769858089,
        25.61628489293138,
        26.021211842414342,
        26.429848230738664,
        26.842203703840827,
        27.258287870275353,
        27.678110301598522,
        28.10168053274597,
        28.529008062403893,
        28.96010235337422,
        29.39497283293396,
        29.83362889318845,
        30.276079891419332,
        30.722335150426627,
        31.172403958865512,
        31.62629557157785,
        32.08401920991837,
        32.54558406207592,
        33.010999283389665,
        33.4802739966603,
        33.953417292456834,
        34.430438229418264,
        34.911345834551085,
        35.39614910352207,
        35.88485700094671,
        36.37747846067349,
        36.87402238606382,
        37.37449765026789,
        37.87891309649659,
        38.38727753828926,
        38.89959975977785,
        39.41588851594697,
        39.93615253289054,
        40.460400508064545,
        40.98864111053629,
        41.520882981230194,
        42.05713473317016,
        42.597404951718396,
        43.141702194811224,
        43.6900349931913,
        44.24241185063697,
        44.798841244188324,
        45.35933162437017,
        45.92389141541209,
        46.49252901546552,
        47.065252796817916,
        47.64207110610409,
        48.22299226451468,
        48.808024568002054,
        49.3971762874833,
        49.9904556690408,
        50.587870934119984,
        51.189430279724725,
        51.79514187861014,
        52.40501387947288,
        53.0190544071392,
        53.637271562750364,
        54.259673423945976,
        54.88626804504493,
        55.517063457223934,
        56.15206766869424,
        56.79128866487574,
        57.43473440856916,
        58.08241284012621,
        58.734331877617365,
        59.39049941699807,
        60.05092333227251,
        60.715611475655585,
        61.38457167773311,
        62.057811747619894,
        62.7353394731159,
        63.417162620860914,
        64.10328893648692,
        64.79372614476921,
        65.48848194977529,
        66.18756403501224,
        66.89098006357258,
        67.59873767827808,
        68.31084450182222,
        69.02730813691093,
        69.74813616640164,
        70.47333615344107,
        71.20291564160104,
        71.93688215501312,
        72.67524319850172,
        73.41800625771542,
        74.16517879925733,
        74.9167682708136,
        75.67278210128072,
        76.43322770089146,
        77.1981124613393,
        77.96744375590167,
        78.74122893956174,
        79.51947534912904,
        80.30219030335869,
        81.08938110306934,
        81.88105503125999,
        82.67721935322541,
        83.4778813166706,
        84.28304815182372,
        85.09272707154808,
        85.90692527145302,
        86.72564993000343,
        87.54890820862819,
        88.3767072518277,
        89.2090541872801,
        90.04595612594655,
        90.88742016217518,
        91.73345337380438,
        92.58406282226491,
        93.43925555268066,
        94.29903859396902,
        95.16341895893969,
        96.03240364439274,
        96.9059996312159,
        97.78421388448044,
        98.6670533535366,
        99.55452497210776
    ];
    static sanitizeRadians(angle) {
        return (angle + Math.PI * 8) % (Math.PI * 2);
    }
    static trueDelinearized(rgbComponent) {
        const normalized = rgbComponent / 100.0;
        let delinearized = 0.0;
        if (normalized <= 0.0031308) {
            delinearized = normalized * 12.92;
        } else {
            delinearized = 1.055 * Math.pow(normalized, 1.0 / 2.4) - 0.055;
        }
        return delinearized * 255.0;
    }
    static chromaticAdaptation(component) {
        const af = Math.pow(Math.abs(component), 0.42);
        return mathUtils.signum(component) * 400.0 * af / (af + 27.13);
    }
    static hueOf(linrgb) {
        const scaledDiscount = mathUtils.matrixMultiply(linrgb, HctSolver.SCALED_DISCOUNT_FROM_LINRGB);
        const rA = HctSolver.chromaticAdaptation(scaledDiscount[0]);
        const gA = HctSolver.chromaticAdaptation(scaledDiscount[1]);
        const bA = HctSolver.chromaticAdaptation(scaledDiscount[2]);
        const a = (11.0 * rA + -12.0 * gA + bA) / 11.0;
        const b = (rA + gA - 2.0 * bA) / 9.0;
        return Math.atan2(b, a);
    }
    static areInCyclicOrder(a, b, c) {
        const deltaAB = HctSolver.sanitizeRadians(b - a);
        const deltaAC = HctSolver.sanitizeRadians(c - a);
        return deltaAB < deltaAC;
    }
    static intercept(source, mid, target) {
        return (mid - source) / (target - source);
    }
    static lerpPoint(source, t, target) {
        return [
            source[0] + (target[0] - source[0]) * t,
            source[1] + (target[1] - source[1]) * t,
            source[2] + (target[2] - source[2]) * t
        ];
    }
    static setCoordinate(source, coordinate, target, axis) {
        const t = HctSolver.intercept(source[axis], coordinate, target[axis]);
        return HctSolver.lerpPoint(source, t, target);
    }
    static isBounded(x) {
        return 0.0 <= x && x <= 100.0;
    }
    static nthVertex(y, n) {
        const kR = HctSolver.Y_FROM_LINRGB[0];
        const kG = HctSolver.Y_FROM_LINRGB[1];
        const kB = HctSolver.Y_FROM_LINRGB[2];
        const coordA = n % 4 <= 1 ? 0.0 : 100.0;
        const coordB = n % 2 === 0 ? 0.0 : 100.0;
        if (n < 4) {
            const g = coordA;
            const b = coordB;
            const r = (y - g * kG - b * kB) / kR;
            if (HctSolver.isBounded(r)) {
                return [
                    r,
                    g,
                    b
                ];
            } else {
                return [
                    -1.0,
                    -1.0,
                    -1.0
                ];
            }
        } else if (n < 8) {
            const b = coordA;
            const r = coordB;
            const g = (y - r * kR - b * kB) / kG;
            if (HctSolver.isBounded(g)) {
                return [
                    r,
                    g,
                    b
                ];
            } else {
                return [
                    -1.0,
                    -1.0,
                    -1.0
                ];
            }
        } else {
            const r = coordA;
            const g = coordB;
            const b = (y - r * kR - g * kG) / kB;
            if (HctSolver.isBounded(b)) {
                return [
                    r,
                    g,
                    b
                ];
            } else {
                return [
                    -1.0,
                    -1.0,
                    -1.0
                ];
            }
        }
    }
    static bisectToSegment(y, targetHue) {
        let left = [
            -1.0,
            -1.0,
            -1.0
        ];
        let right = left;
        let leftHue = 0.0;
        let rightHue = 0.0;
        let initialized = false;
        let uncut = true;
        for(let n = 0; n < 12; n++){
            const mid = HctSolver.nthVertex(y, n);
            if (mid[0] < 0) {
                continue;
            }
            const midHue = HctSolver.hueOf(mid);
            if (!initialized) {
                left = mid;
                right = mid;
                leftHue = midHue;
                rightHue = midHue;
                initialized = true;
                continue;
            }
            if (uncut || HctSolver.areInCyclicOrder(leftHue, midHue, rightHue)) {
                uncut = false;
                if (HctSolver.areInCyclicOrder(leftHue, targetHue, midHue)) {
                    right = mid;
                    rightHue = midHue;
                } else {
                    left = mid;
                    leftHue = midHue;
                }
            }
        }
        return [
            left,
            right
        ];
    }
    static midpoint(a, b) {
        return [
            (a[0] + b[0]) / 2,
            (a[1] + b[1]) / 2,
            (a[2] + b[2]) / 2
        ];
    }
    static criticalPlaneBelow(x) {
        return Math.floor(x - 0.5);
    }
    static criticalPlaneAbove(x) {
        return Math.ceil(x - 0.5);
    }
    static bisectToLimit(y, targetHue) {
        const segment = HctSolver.bisectToSegment(y, targetHue);
        let left = segment[0];
        let leftHue = HctSolver.hueOf(left);
        let right = segment[1];
        for(let axis = 0; axis < 3; axis++){
            if (left[axis] !== right[axis]) {
                let lPlane = -1;
                let rPlane = 255;
                if (left[axis] < right[axis]) {
                    lPlane = HctSolver.criticalPlaneBelow(HctSolver.trueDelinearized(left[axis]));
                    rPlane = HctSolver.criticalPlaneAbove(HctSolver.trueDelinearized(right[axis]));
                } else {
                    lPlane = HctSolver.criticalPlaneAbove(HctSolver.trueDelinearized(left[axis]));
                    rPlane = HctSolver.criticalPlaneBelow(HctSolver.trueDelinearized(right[axis]));
                }
                for(let i = 0; i < 8; i++){
                    if (Math.abs(rPlane - lPlane) <= 1) {
                        break;
                    } else {
                        const mPlane = Math.floor((lPlane + rPlane) / 2.0);
                        const midPlaneCoordinate = HctSolver.CRITICAL_PLANES[mPlane];
                        const mid = HctSolver.setCoordinate(left, midPlaneCoordinate, right, axis);
                        const midHue = HctSolver.hueOf(mid);
                        if (HctSolver.areInCyclicOrder(leftHue, targetHue, midHue)) {
                            right = mid;
                            rPlane = mPlane;
                        } else {
                            left = mid;
                            leftHue = midHue;
                            lPlane = mPlane;
                        }
                    }
                }
            }
        }
        return HctSolver.midpoint(left, right);
    }
    static inverseChromaticAdaptation(adapted) {
        const adaptedAbs = Math.abs(adapted);
        const base = Math.max(0, 27.13 * adaptedAbs / (400.0 - adaptedAbs));
        return mathUtils.signum(adapted) * Math.pow(base, 1.0 / 0.42);
    }
    static findResultByJ(hueRadians, chroma, y) {
        let j = Math.sqrt(y) * 11.0;
        const viewingConditions = ViewingConditions.DEFAULT;
        const tInnerCoeff = 1 / Math.pow(1.64 - Math.pow(0.29, viewingConditions.n), 0.73);
        const eHue = 0.25 * (Math.cos(hueRadians + 2.0) + 3.8);
        const p1 = eHue * (50000.0 / 13.0) * viewingConditions.nc * viewingConditions.ncb;
        const hSin = Math.sin(hueRadians);
        const hCos = Math.cos(hueRadians);
        for(let iterationRound = 0; iterationRound < 5; iterationRound++){
            const jNormalized = j / 100.0;
            const alpha = chroma === 0.0 || j === 0.0 ? 0.0 : chroma / Math.sqrt(jNormalized);
            const t = Math.pow(alpha * tInnerCoeff, 1.0 / 0.9);
            const ac = viewingConditions.aw * Math.pow(jNormalized, 1.0 / viewingConditions.c / viewingConditions.z);
            const p2 = ac / viewingConditions.nbb;
            const gamma = 23.0 * (p2 + 0.305) * t / (23.0 * p1 + 11 * t * hCos + 108.0 * t * hSin);
            const a = gamma * hCos;
            const b = gamma * hSin;
            const rA = (460.0 * p2 + 451.0 * a + 288.0 * b) / 1403.0;
            const gA = (460.0 * p2 - 891.0 * a - 261.0 * b) / 1403.0;
            const bA = (460.0 * p2 - 220.0 * a - 6300.0 * b) / 1403.0;
            const rCScaled = HctSolver.inverseChromaticAdaptation(rA);
            const gCScaled = HctSolver.inverseChromaticAdaptation(gA);
            const bCScaled = HctSolver.inverseChromaticAdaptation(bA);
            const linrgb = mathUtils.matrixMultiply([
                rCScaled,
                gCScaled,
                bCScaled
            ], HctSolver.LINRGB_FROM_SCALED_DISCOUNT);
            if (linrgb[0] < 0 || linrgb[1] < 0 || linrgb[2] < 0) {
                return 0;
            }
            const kR = HctSolver.Y_FROM_LINRGB[0];
            const kG = HctSolver.Y_FROM_LINRGB[1];
            const kB = HctSolver.Y_FROM_LINRGB[2];
            const fnj = kR * linrgb[0] + kG * linrgb[1] + kB * linrgb[2];
            if (fnj <= 0) {
                return 0;
            }
            if (iterationRound === 4 || Math.abs(fnj - y) < 0.002) {
                if (linrgb[0] > 100.01 || linrgb[1] > 100.01 || linrgb[2] > 100.01) {
                    return 0;
                }
                return colorUtils.argbFromLinrgb(linrgb);
            }
            j = j - (fnj - y) * j / (2 * fnj);
        }
        return 0;
    }
    static solveToInt(hueDegrees, chroma, lstar) {
        if (chroma < 0.0001 || lstar < 0.0001 || lstar > 99.9999) {
            return colorUtils.argbFromLstar(lstar);
        }
        hueDegrees = mathUtils.sanitizeDegreesDouble(hueDegrees);
        const hueRadians = hueDegrees / 180 * Math.PI;
        const y = colorUtils.yFromLstar(lstar);
        const exactAnswer = HctSolver.findResultByJ(hueRadians, chroma, y);
        if (exactAnswer !== 0) {
            return exactAnswer;
        }
        const linrgb = HctSolver.bisectToLimit(y, hueRadians);
        return colorUtils.argbFromLinrgb(linrgb);
    }
    static solveToCam(hueDegrees, chroma, lstar) {
        return Cam16.fromInt(HctSolver.solveToInt(hueDegrees, chroma, lstar));
    }
}

return {HctSolver};
},
"hct/viewing_conditions": (require) => {
const utils = require("utils/color_utils");
const math = require("utils/math_utils");
class ViewingConditions {
    n;
    aw;
    nbb;
    ncb;
    c;
    nc;
    rgbD;
    fl;
    fLRoot;
    z;
    static DEFAULT = ViewingConditions.make();
    static make(whitePoint = utils.whitePointD65(), adaptingLuminance = 200.0 / Math.PI * utils.yFromLstar(50.0) / 100.0, backgroundLstar = 50.0, surround = 2.0, discountingIlluminant = false) {
        const xyz = whitePoint;
        const rW = xyz[0] * 0.401288 + xyz[1] * 0.650173 + xyz[2] * -0.051461;
        const gW = xyz[0] * -0.250268 + xyz[1] * 1.204414 + xyz[2] * 0.045854;
        const bW = xyz[0] * -0.002079 + xyz[1] * 0.048952 + xyz[2] * 0.953127;
        const f = 0.8 + surround / 10.0;
        const c = f >= 0.9 ? math.lerp(0.59, 0.69, (f - 0.9) * 10.0) : math.lerp(0.525, 0.59, (f - 0.8) * 10.0);
        let d = discountingIlluminant ? 1.0 : f * (1.0 - 1.0 / 3.6 * Math.exp((-adaptingLuminance - 42.0) / 92.0));
        d = d > 1.0 ? 1.0 : d < 0.0 ? 0.0 : d;
        const nc = f;
        const rgbD = [
            d * (100.0 / rW) + 1.0 - d,
            d * (100.0 / gW) + 1.0 - d,
            d * (100.0 / bW) + 1.0 - d
        ];
        const k = 1.0 / (5.0 * adaptingLuminance + 1.0);
        const k4 = k * k * k * k;
        const k4F = 1.0 - k4;
        const fl = k4 * adaptingLuminance + 0.1 * k4F * k4F * Math.cbrt(5.0 * adaptingLuminance);
        const n = utils.yFromLstar(backgroundLstar) / whitePoint[1];
        const z = 1.48 + Math.sqrt(n);
        const nbb = 0.725 / Math.pow(n, 0.2);
        const ncb = nbb;
        const rgbAFactors = [
            Math.pow(fl * rgbD[0] * rW / 100.0, 0.42),
            Math.pow(fl * rgbD[1] * gW / 100.0, 0.42),
            Math.pow(fl * rgbD[2] * bW / 100.0, 0.42)
        ];
        const rgbA = [
            400.0 * rgbAFactors[0] / (rgbAFactors[0] + 27.13),
            400.0 * rgbAFactors[1] / (rgbAFactors[1] + 27.13),
            400.0 * rgbAFactors[2] / (rgbAFactors[2] + 27.13)
        ];
        const aw = (2.0 * rgbA[0] + rgbA[1] + 0.05 * rgbA[2]) * nbb;
        return new ViewingConditions(n, aw, nbb, ncb, c, nc, rgbD, fl, Math.pow(fl, 0.25), z);
    }
    constructor(n, aw, nbb, ncb, c, nc, rgbD, fl, fLRoot, z){
        this.n = n;
        this.aw = aw;
        this.nbb = nbb;
        this.ncb = ncb;
        this.c = c;
        this.nc = nc;
        this.rgbD = rgbD;
        this.fl = fl;
        this.fLRoot = fLRoot;
        this.z = z;
    }
}

return {ViewingConditions};
},
"utils/color_utils": (require) => {
const mathUtils = require("utils/math_utils");
const SRGB_TO_XYZ = [
    [
        0.41233895,
        0.35762064,
        0.18051042
    ],
    [
        0.2126,
        0.7152,
        0.0722
    ],
    [
        0.01932141,
        0.11916382,
        0.95034478
    ]
];
const XYZ_TO_SRGB = [
    [
        3.2413774792388685,
        -1.5376652402851851,
        -0.49885366846268053
    ],
    [
        -0.9691452513005321,
        1.8758853451067872,
        0.04156585616912061
    ],
    [
        0.05562093689691305,
        -0.20395524564742123,
        1.0571799111220335
    ]
];
const WHITE_POINT_D65 = [
    95.047,
    100.0,
    108.883
];
function argbFromRgb(red, green, blue) {
    return (255 << 24 | (red & 255) << 16 | (green & 255) << 8 | blue & 255) >>> 0;
}
function argbFromLinrgb(linrgb) {
    const r = delinearized(linrgb[0]);
    const g = delinearized(linrgb[1]);
    const b = delinearized(linrgb[2]);
    return argbFromRgb(r, g, b);
}
function alphaFromArgb(argb) {
    return argb >> 24 & 255;
}
function redFromArgb(argb) {
    return argb >> 16 & 255;
}
function greenFromArgb(argb) {
    return argb >> 8 & 255;
}
function blueFromArgb(argb) {
    return argb & 255;
}
function isOpaque(argb) {
    return alphaFromArgb(argb) >= 255;
}
function argbFromXyz(x, y, z) {
    const matrix = XYZ_TO_SRGB;
    const linearR = matrix[0][0] * x + matrix[0][1] * y + matrix[0][2] * z;
    const linearG = matrix[1][0] * x + matrix[1][1] * y + matrix[1][2] * z;
    const linearB = matrix[2][0] * x + matrix[2][1] * y + matrix[2][2] * z;
    const r = delinearized(linearR);
    const g = delinearized(linearG);
    const b = delinearized(linearB);
    return argbFromRgb(r, g, b);
}
function xyzFromArgb(argb) {
    const r = linearized(redFromArgb(argb));
    const g = linearized(greenFromArgb(argb));
    const b = linearized(blueFromArgb(argb));
    return mathUtils.matrixMultiply([
        r,
        g,
        b
    ], SRGB_TO_XYZ);
}
function argbFromLab(l, a, b) {
    const whitePoint = WHITE_POINT_D65;
    const fy = (l + 16.0) / 116.0;
    const fx = a / 500.0 + fy;
    const fz = fy - b / 200.0;
    const xNormalized = labInvf(fx);
    const yNormalized = labInvf(fy);
    const zNormalized = labInvf(fz);
    const x = xNormalized * whitePoint[0];
    const y = yNormalized * whitePoint[1];
    const z = zNormalized * whitePoint[2];
    return argbFromXyz(x, y, z);
}
function labFromArgb(argb) {
    const linearR = linearized(redFromArgb(argb));
    const linearG = linearized(greenFromArgb(argb));
    const linearB = linearized(blueFromArgb(argb));
    const matrix = SRGB_TO_XYZ;
    const x = matrix[0][0] * linearR + matrix[0][1] * linearG + matrix[0][2] * linearB;
    const y = matrix[1][0] * linearR + matrix[1][1] * linearG + matrix[1][2] * linearB;
    const z = matrix[2][0] * linearR + matrix[2][1] * linearG + matrix[2][2] * linearB;
    const whitePoint = WHITE_POINT_D65;
    const xNormalized = x / whitePoint[0];
    const yNormalized = y / whitePoint[1];
    const zNormalized = z / whitePoint[2];
    const fx = labF(xNormalized);
    const fy = labF(yNormalized);
    const fz = labF(zNormalized);
    const l = 116.0 * fy - 16;
    const a = 500.0 * (fx - fy);
    const b = 200.0 * (fy - fz);
    return [
        l,
        a,
        b
    ];
}
function argbFromLstar(lstar) {
    const y = yFromLstar(lstar);
    const component = delinearized(y);
    return argbFromRgb(component, component, component);
}
function lstarFromArgb(argb) {
    const y = xyzFromArgb(argb)[1];
    return 116.0 * labF(y / 100.0) - 16.0;
}
function yFromLstar(lstar) {
    return 100.0 * labInvf((lstar + 16.0) / 116.0);
}
function lstarFromY(y) {
    return labF(y / 100.0) * 116.0 - 16.0;
}
function linearized(rgbComponent) {
    const normalized = rgbComponent / 255.0;
    if (normalized <= 0.040449936) {
        return normalized / 12.92 * 100.0;
    } else {
        return Math.pow((normalized + 0.055) / 1.055, 2.4) * 100.0;
    }
}
function delinearized(rgbComponent) {
    const normalized = rgbComponent / 100.0;
    let delinearized = 0.0;
    if (normalized <= 0.0031308) {
        delinearized = normalized * 12.92;
    } else {
        delinearized = 1.055 * Math.pow(normalized, 1.0 / 2.4) - 0.055;
    }
    return mathUtils.clampInt(0, 255, Math.round(delinearized * 255.0));
}
function whitePointD65() {
    return WHITE_POINT_D65;
}
function labF(t) {
    const e = 216.0 / 24389.0;
    const kappa = 24389.0 / 27.0;
    if (t > e) {
        return Math.pow(t, 1.0 / 3.0);
    } else {
        return (kappa * t + 16) / 116;
    }
}
function labInvf(ft) {
    const e = 216.0 / 24389.0;
    const kappa = 24389.0 / 27.0;
    const ft3 = ft * ft * ft;
    if (ft3 > e) {
        return ft3;
    } else {
        return (116 * ft - 16) / kappa;
    }
}

return {argbFromRgb,argbFromLinrgb,alphaFromArgb,redFromArgb,greenFromArgb,blueFromArgb,isOpaque,argbFromXyz,xyzFromArgb,argbFromLab,labFromArgb,argbFromLstar,lstarFromArgb,yFromLstar,lstarFromY,linearized,delinearized,whitePointD65};
},
"utils/math_utils": (require) => {
function signum(num) {
    if (num < 0) {
        return -1;
    } else if (num === 0) {
        return 0;
    } else {
        return 1;
    }
}
function lerp(start, stop, amount) {
    return (1.0 - amount) * start + amount * stop;
}
function clampInt(min, max, input) {
    if (input < min) {
        return min;
    } else if (input > max) {
        return max;
    }
    return input;
}
function clampDouble(min, max, input) {
    if (input < min) {
        return min;
    } else if (input > max) {
        return max;
    }
    return input;
}
function sanitizeDegreesInt(degrees) {
    degrees = degrees % 360;
    if (degrees < 0) {
        degrees = degrees + 360;
    }
    return degrees;
}
function sanitizeDegreesDouble(degrees) {
    degrees = degrees % 360.0;
    if (degrees < 0) {
        degrees = degrees + 360.0;
    }
    return degrees;
}
function rotationDirection(from, to) {
    const increasingDifference = sanitizeDegreesDouble(to - from);
    return increasingDifference <= 180.0 ? 1.0 : -1.0;
}
function differenceDegrees(a, b) {
    return 180.0 - Math.abs(Math.abs(a - b) - 180.0);
}
function matrixMultiply(row, matrix) {
    const a = row[0] * matrix[0][0] + row[1] * matrix[0][1] + row[2] * matrix[0][2];
    const b = row[0] * matrix[1][0] + row[1] * matrix[1][1] + row[2] * matrix[1][2];
    const c = row[0] * matrix[2][0] + row[1] * matrix[2][1] + row[2] * matrix[2][2];
    return [
        a,
        b,
        c
    ];
}

return {signum,lerp,clampInt,clampDouble,sanitizeDegreesInt,sanitizeDegreesDouble,rotationDirection,differenceDegrees,matrixMultiply};
}
    };
    const cache = new Map();
    function require(id) {
      if (!cache.has(id)) cache.set(id,modules[id](require));
      return cache.get(id);
    }
    return require('hct/hct');
  })();
  // END BUNDLED MATERIAL COLOR UTILITIES
  let customPalette = null;
  const paletteHex = value => typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
  function customPaletteStyle(record) {
    let style=doc.querySelector('style[data-ui-custom-palette-style]');
    if(!style){style=doc.createElement('style');style.setAttribute('data-ui-custom-palette-style','');doc.head.append(style);}
    style.textContent=['light','dark'].map(mode=>{
      const properties=record[mode],primary=properties['--bs-primary'];
      const rgb=[1,3,5].map(index=>parseInt(primary.slice(index,index+2),16)).join(', ');
      const ink=properties['--ui-on-primary'].replace('#','%23');
      const tick=`url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3e%3cpath fill='none' stroke='${ink}' stroke-linecap='round' stroke-linejoin='round' stroke-width='2.6' d='m4 10 4 4 8-8'/%3e%3c/svg%3e")`;
      const dash=`url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3e%3cpath stroke='${ink}' stroke-width='2.6' stroke-linecap='round' d='M5 10h10'/%3e%3c/svg%3e")`;
      const selector=mode==='dark'?':root[data-bs-theme="dark"][data-ui-palette="custom"]':':root[data-ui-palette="custom"]';
      return selector+'{'+Object.entries(properties).map(([key,value])=>key+':'+value+';').join('')+`--bs-primary-rgb:${rgb};--ui-palette-check-tick:${tick};--ui-palette-check-dash:${dash};}`;
    }).join('\n');
  }
  function createCustomPalette(seed, chroma) {
    seed=paletteHex(seed);
    if(!seed || typeof chroma!=='number' || !Number.isInteger(chroma) || chroma<0 || chroma>32)return null;
    const source=materialColors.Hct.fromInt(parseInt('ff'+seed.slice(1),16));
    const gray=source.chroma<3 || chroma===0;
    const hue=gray?0:source.hue;
    const specifications={primary:[hue,gray?0:chroma],secondary:[hue,gray?0:Math.min(chroma/2,12)],tertiary:[(hue+60)%360,gray?0:Math.min(chroma*2/3,16)],neutral:[hue,gray?0:4],variant:[hue,gray?0:8],error:[25,32],success:[145,32],warning:[85,24],info:[235,24]};
    const record={version:2,seed,chroma};
    const token=role=>(['success','warning','info'].includes(role.replace(/^on-/, '').split('-')[0])?'--ui-color-':'--md-sys-color-')+role;
    for(const dark of [false,true]) {
      const roles={},properties={};
      const put=(name,palette,tone)=>{
        const [hue,chroma]=specifications[palette];
        roles[name]='#'+(materialColors.Hct.from(hue,chroma,tone).toInt()>>>0).toString(16).slice(-6).padStart(6,'0');
      };
      for(const key of ['primary','secondary','tertiary','error','success','warning','info']) {
        put(key,key,dark?80:40);put('on-'+key,key,dark?20:100);put(key+'-container',key,dark?30:90);put('on-'+key+'-container',key,dark?90:30);
      }
      for(const [key,palette,tone] of [['surface','neutral',dark?6:96],['on-surface','neutral',dark?90:10],['surface-container-lowest','neutral',dark?4:98],['surface-container-low','neutral',dark?10:96],['surface-container','neutral',dark?12:94],['surface-container-high','neutral',dark?17:92],['surface-container-highest','neutral',dark?22:90],['surface-variant','variant',dark?30:90],['on-surface-variant','variant',dark?80:30],['outline','variant',dark?60:50],['outline-variant','variant',dark?30:80],['inverse-surface','neutral',dark?90:20],['inverse-on-surface','neutral',dark?20:95],['inverse-primary','primary',dark?40:80]])put(key,palette,tone);
      for(const [role,value] of Object.entries(roles))properties[token(role)]=value;
      const aliases={'--bs-body-bg':'surface','--bs-body-color':'on-surface','--bs-secondary-color':'on-surface-variant','--bs-secondary-bg':'surface-container-high','--bs-tertiary-bg':'surface-container-low','--bs-border-color':'outline-variant','--ui-control-outline':'outline'};
      for(const [property,role] of Object.entries(aliases))properties[property]=roles[role];
      for(const [ui,material] of [['primary','primary'],['danger','error'],['success','success'],['warning','warning'],['info','info']]) {
        for(const [suffix,role] of [['',material],['-bg-subtle',material+'-container'],['-border-subtle',material+'-container'],['-text-emphasis','on-'+material+'-container']])properties['--bs-'+ui+suffix]=roles[role];
        properties['--ui-on-'+ui]=roles['on-'+material];
      }
      record[dark?'dark':'light']=properties;
    }
    return record;
  }
  function getCustomPalette() { return customPalette?{seed:customPalette.seed,chroma:customPalette.chroma}:null; }
  function syncPaletteEditors(scope=doc) {
    const editors=[...(scope.matches?.('form[data-ui-palette-editor]')?[scope]:[]),...all(scope,'form[data-ui-palette-editor]')];
    for(const form of editors) {
      const seed=form.querySelector('[data-ui-palette-seed]'),chroma=form.querySelector('[data-ui-palette-chroma]');
      if(customPalette && seed && chroma) {
        seed.value=seed.defaultValue=customPalette.seed;chroma.value=chroma.defaultValue=String(customPalette.chroma);inputPickers.get(seed)?.sync();
      }
      const status=form.querySelector('[data-ui-palette-status]');if(status){status.textContent='';status.removeAttribute('data-ui-error');}
      updatePaletteDraft(form);
    }
  }
  function updatePaletteDraft(form) {
    const output=form.querySelector('[data-ui-palette-chroma-output]'),chroma=form.querySelector('[data-ui-palette-chroma]');
    if(output && chroma)output.textContent=chroma.value;
  }
  const paletteEditors = new WeakSet();
  function initPaletteEditor(form) {
    if(paletteEditors.has(form))return;
    paletteEditors.add(form);form.noValidate=true;syncPaletteEditors(form);
    form.addEventListener('reset',()=>setTimeout(()=>{updatePaletteDraft(form);const status=form.querySelector('[data-ui-palette-status]');if(status){status.textContent='';status.removeAttribute('data-ui-error');}},0));
  }
  function setCustomPalette(seed, {chroma=24,persist=false}={}) {
    const record=createCustomPalette(seed,chroma);if(!record)return false;
    const changed=!customPalette || customPalette.seed!==record.seed || customPalette.chroma!==record.chroma;
    const before=doc.documentElement.dataset.uiPalette;
    customPalette=record;customPaletteStyle(record);applyPalette('custom',false);syncPaletteEditors();
    if(persist)try {localStorage.setItem('kav-ui-custom-palette',JSON.stringify(record));localStorage.setItem('kav-ui-palette','custom');}catch { /* In-page colors still work without storage. */ }
    if(changed || before!=='custom')emit(doc.body,'palettechange',{palette:'custom',...getCustomPalette()});
    return true;
  }
  doc.addEventListener('input',event=>{
    const form=closest(event.target,'form[data-ui-palette-editor]');if(form)updatePaletteDraft(form);
  });
  doc.addEventListener('submit',event=>{
    const form=event.target;if(!form.matches('form[data-ui-palette-editor]') || event.defaultPrevented)return;
    event.preventDefault();
    const seed=form.querySelector('[data-ui-palette-seed]'),chroma=form.querySelector('[data-ui-palette-chroma]'),status=form.querySelector('[data-ui-palette-status]');
    if(event.submitter && disabled(event.submitter))return;
    const valid=seed && chroma && form.checkValidity() && setCustomPalette(seed.value,{chroma:Number(chroma.value),persist:doc.body.hasAttribute('data-ui-theme-persist')});
    if(status){status.textContent=valid?'カスタム配色を適用しました。':'基準色を#RRGGBB、彩度を0〜32で指定してください。';status.toggleAttribute('data-ui-error',!valid);}
    if(!valid){if(seed && !paletteHex(seed.value))seed.focus();else chroma?.focus();}
  });

  // Palette hue is independent from light/dark preference and surface design.
  const colorPalettes = ['default','slate','sage','teal','mauve','sand','clay','custom'];
  function syncPaletteControls(scope = doc) {
    const palette=doc.documentElement.dataset.uiPalette || 'default';
    [...(scope.matches?.('select[data-ui-palette-select]')?[scope]:[]),...all(scope,'select[data-ui-palette-select]')].forEach(select=>{
      let option=[...select.options].find(option=>option.value==='custom');
      if(customPalette && !option){option=doc.createElement('option');option.value='custom';option.textContent='カスタム';select.append(option);}
      if(option)option.disabled=!customPalette;select.value=palette;syncSelect(select);
    });
    [...(scope.matches?.('button[data-ui-palette-value]')?[scope]:[]),...all(scope,'button[data-ui-palette-value]')].forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.uiPaletteValue===palette)));
  }
  function applyPalette(palette, notify = true) {
    const before=doc.documentElement.dataset.uiPalette || 'default';
    doc.documentElement.dataset.uiPalette=palette;syncPaletteControls();
    if(notify && before!==palette)emit(doc.body,'palettechange',palette==='custom'?{palette,...getCustomPalette()}:{palette});
  }
  function setPalette(palette, {persist = false} = {}) {
    if(!colorPalettes.includes(palette) || (palette==='custom' && !customPalette))return false;
    applyPalette(palette);
    if(persist)try {if(palette==='custom')localStorage.setItem('kav-ui-custom-palette',JSON.stringify(customPalette));localStorage.setItem('kav-ui-palette',palette);} catch { /* Storage is optional. */ }
    return true;
  }
  doc.addEventListener('change',event=>{
    const select=closest(event.target,'select[data-ui-palette-select]');
    if(select && !disabled(select))setPalette(select.value,{persist:doc.body.hasAttribute('data-ui-theme-persist')});
  });
  doc.addEventListener('click',event=>{
    const button=closest(event.target,'button[data-ui-palette-value]');
    if(button && !disabled(button))setPalette(button.dataset.uiPaletteValue,{persist:doc.body.hasAttribute('data-ui-theme-persist')});
  });
  // Store the selected preference separately from the resolved light/dark palette.
  const preference = window.matchMedia('(prefers-color-scheme: dark)');
  const colorModes = ['light','dark','system'];
  let chosen = null;
  try { chosen = localStorage.getItem('kav-ui-theme'); } catch { /* Storage is optional. */ }
  if (!colorModes.includes(chosen)) chosen = 'system';
  const resolvedColorTheme = () => chosen === 'system' ? (preference.matches ? 'dark' : 'light') : chosen;
  function syncColorThemeControls(scope = doc) {
    [...(scope.matches?.('button[data-ui-color-mode]')?[scope]:[]),...all(scope,'button[data-ui-color-mode]')].forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.uiColorMode===chosen)));
    [...(scope.matches?.('select[data-ui-color-select]')?[scope]:[]),...all(scope,'select[data-ui-color-select]')].forEach(select=>{select.value=chosen;syncSelect(select);});
  }
  function setColorTheme(mode, {persist = false} = {}) {
    if(!colorModes.includes(mode))return false;
    chosen=mode;const theme=resolvedColorTheme();applyTheme(theme);
    if(persist)try {localStorage.setItem('kav-ui-theme',mode);} catch { /* Storage is optional. */ }
    return true;
  }
  doc.addEventListener('change',event=>{
    const select=closest(event.target,'select[data-ui-color-select]');
    if(select && !disabled(select))setColorTheme(select.value,{persist:doc.body.hasAttribute('data-ui-theme-persist')});
  });
  doc.addEventListener('click',event=>{
    const button=closest(event.target,'button[data-ui-design], button[data-ui-color-mode]');
    if(!button || disabled(button))return;
    const persist=doc.body.hasAttribute('data-ui-theme-persist');
    if(button.hasAttribute('data-ui-design'))setDesignTheme(button.dataset.uiDesign,{persist});
    else setColorTheme(button.dataset.uiColorMode,{persist});
  });
  function syncThemeToggle(button) {
    const dark = doc.documentElement.dataset.bsTheme === 'dark';
    const label = dark ? 'ライトに切替' : 'ダークに切替';
    if (button.hasAttribute('data-ui-theme-icon')) {
      button.setAttribute('icon', dark ? 'mdi-weather-sunny' : 'mdi-weather-night');
      renderIcon(button);
      button.setAttribute('title', label);
    } else button.textContent = label;
    button.setAttribute('aria-label', label);
  }
  function applyTheme(theme, notify = true) {
    const before=doc.documentElement.dataset.bsTheme,previousMode=doc.documentElement.dataset.uiColorPreference;
    doc.documentElement.dataset.bsTheme = theme;
    doc.documentElement.dataset.uiColorPreference = chosen;
    syncColorThemeControls();
    all(doc, '[data-ui-toggle="theme"]').forEach(syncThemeToggle);
    if(notify && (before!==theme || previousMode!==chosen))emit(doc.body,'colorchange',{mode:chosen,theme});
  }
  preference.addEventListener('change', () => { if (chosen==='system') applyTheme(resolvedColorTheme()); });
  doc.addEventListener('click', event => {
    const button = closest(event.target, '[data-ui-toggle], [data-ui-dismiss], [data-ui-toast], [data-ui-tooltip], [data-ui-page], [data-ui-page-step]');
    if (!button || disabled(button)) return;
    const action = button.dataset.uiToggle;
    if (button.hasAttribute('data-ui-tooltip')) showTooltip(button);
    if (button.hasAttribute('data-ui-toast')) {
      event.preventDefault();
      toast(button.dataset.uiToast, {title:button.dataset.uiTitle, body:button.dataset.uiBody, meta:button.dataset.uiMeta, variant:button.dataset.uiVariant, duration:button.dataset.uiDuration, copy:button.hasAttribute('data-ui-toast-copy') && button.dataset.uiToastCopy !== 'false', copyText:button.dataset.uiCopyText, copyLabel:button.dataset.uiCopyLabel});
    }
    if (button.hasAttribute('data-ui-dismiss')) {
      const kind = button.dataset.uiDismiss;
      const panel = target(button) || (kind === 'dialog' ? button.closest('dialog') : kind === 'popover' ? button.closest('[data-ui-popover]') : kind === 'dropdown' ? button.closest('[data-ui-dropdown]') : button.closest(kind === 'banner' ? '.ui-banner' : kind === 'toast' ? '.ui-toast' : '.alert'));
      if (panel) {
        event.preventDefault();
        hide(panel, button);
        if (kind === 'toast') panel.remove();
      }
    }
    if (action === 'theme') {
      event.preventDefault();
      setColorTheme(doc.documentElement.dataset.bsTheme === 'dark' ? 'light' : 'dark', {persist:true});
    } else if (['dropdown','popover'].includes(action)) {
      const panel=activatedTarget(button);if(!isPopup(panel))return;
      event.preventDefault();const wasOpen=pointerOpenPopup===panel || popupOpen(panel);pointerOpenPopup=null;
      if(wasOpen)closePopup(panel,true);else openPopup(panel,button);
    } else if (action === 'sidebar-responsive') {
      event.preventDefault();responsiveSidebar(activatedTarget(button),{trigger:button});
    } else if (action === 'tab') {
      event.preventDefault(); activateTab(button);
    } else if (['collapse','sidebar','dialog','show','hide'].includes(action)) {
      const panel = activatedTarget(button);
      if (panel) {
        event.preventDefault();
        if (action === 'hide' || (['collapse','sidebar'].includes(action) && !panel.hidden)) hide(panel, button);
        else show(panel, button);
      }
    }
    if (button.hasAttribute('data-ui-page') || button.hasAttribute('data-ui-page-step')) {
      const group = button.closest('[data-ui-pagination]');
      if (!group) return;
      event.preventDefault();
      const next = button.hasAttribute('data-ui-page') ? Number(button.dataset.uiPage) : (pageStates.get(group) || 1) + Number(button.dataset.uiPageStep);
      renderPage(group, next);
      if (button.disabled) group.querySelector('[data-ui-page][aria-current]')?.focus();
    }
  });
  doc.addEventListener('keydown', event => {
    if (event.key === 'Escape' && tooltip) { hideTooltip(); event.preventDefault(); return; }
    const tab = closest(event.target, '[data-ui-toggle="tab"]');
    const group = tab?.closest('[data-ui-tabs]');
    if (!group) return;
    const tabs = tabData(group).tabs.filter(item => !disabled(item));
    const vertical = tab.closest('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical';
    const index = tabs.indexOf(tab);
    const rtl = getComputedStyle(tab.closest('[role="tablist"]') || group).direction === 'rtl';
    const previous = vertical ? 'ArrowUp' : rtl ? 'ArrowRight' : 'ArrowLeft';
    const next = vertical ? 'ArrowDown' : rtl ? 'ArrowLeft' : 'ArrowRight';
    let position;
    if (event.key === next) position = (index + 1) % tabs.length;
    if (event.key === previous) position = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') position = 0;
    if (event.key === 'End') position = tabs.length - 1;
    if (position === undefined) return;
    event.preventDefault();
    if(group.dataset.uiTabActivation==='manual')tabs.forEach((item,index)=>item.tabIndex=index===position?0:-1);
    else activateTab(tabs[position]);
    tabs[position].focus();
  });
  doc.addEventListener('focusin', event => {
    const trigger = closest(event.target, '[data-ui-tooltip]');
    if (trigger) showTooltip(trigger);
  });
  doc.addEventListener('focusout', event => {
    if (tooltip && tooltip.trigger.contains(event.target) && !tooltip.bubble.contains(event.relatedTarget)) hideTooltip();
  });
  doc.addEventListener('pointerover', event => {
    const trigger = closest(event.target, '[data-ui-tooltip]');
    if (trigger) showTooltip(trigger);
  });
  doc.addEventListener('pointerout', event => {
    if (!tooltip) return;
    const {trigger, bubble} = tooltip;
    if ((trigger.contains(event.target) || bubble.contains(event.target)) && !trigger.contains(event.relatedTarget) && !bubble.contains(event.relatedTarget) && doc.activeElement !== trigger) hideTooltip();
  });
  doc.addEventListener('pointerdown', event => {
    if (tooltip && !tooltip.trigger.contains(event.target) && !tooltip.bubble.contains(event.target)) hideTooltip();
  });
  window.addEventListener('resize', ()=>withoutExitMotion(hideTooltip));
  doc.addEventListener('scroll', ()=>withoutExitMotion(hideTooltip), true);
  doc.addEventListener('reset', event => {
    const form=event.target,state=validationStates.get(form);
    if(!state)return;
    setTimeout(()=>{
      if(event.defaultPrevented)return;
      for(const restore of state.fields.values())restore();
      for(const restore of state.errors.values())restore();
      for(const error of state.generated)error.remove();
      validationStates.delete(form);
    },0);
  });
  doc.addEventListener('change', event => {
    const input = event.target;
    if (input.matches('input[type="checkbox"], input[type="radio"]') && !disabled(input)) motion(input,[{scale:.9},{scale:1}], 'fast');
  });
  doc.addEventListener('close', event => {
    if (!event.target.matches('dialog[data-ui-dialog]')) return;
    const opener = openers.get(event.target);
    if (opener?.isConnected && !opener.closest('[hidden], [inert]')) opener.focus();
    emit(event.target, 'hidden');
  }, true);
  doc.addEventListener('click', event => {
    const dialog = event.target;
    if (!dialog.matches?.('dialog[data-ui-dialog][open]') || dialog.dataset.uiBackdrop === 'static') return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) hide(dialog);
  });
  doc.addEventListener('submit', event => {
    const form = event.target;
    if (!form.matches('form[data-ui-validate]')) return;
    const results = fields(form).map(field => ({field, valid:validateField(field)}));
    const invalid = results.find(item => !item.valid);
    if (invalid) { event.preventDefault(); invalid.field.focus(); }
    else if (!emit(form, 'valid', {form}, true)) event.preventDefault();
  }, true);
  doc.addEventListener('input', event => {
    const field = event.target;
    if (field.matches('input, select, textarea') && field.closest('form[data-ui-validate]') && field.hasAttribute('aria-invalid')) validateField(field);
  });
  doc.addEventListener('change', event => {
    const select = closest(event.target, '[data-ui-move]');
    const card = select?.closest('[data-ui-card]');
    const board = card?.closest('[data-ui-board]');
    if (!board) return;
    const column = owned(board, '[data-ui-column]', '[data-ui-board]').find(item => item.dataset.uiColumn === select.value);
    if (column) { moveCard(card, column); select.focus(); }
  });
  doc.addEventListener('dragstart', event => {
    const card = closest(event.target, '[data-ui-card]');
    const board = card?.closest('[data-ui-board]');
    if (!board || !event.dataTransfer) return;
    dragging = {card, board};
    card.classList.add('dragged');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.dataset.uiCard || 'card');
  });
  doc.addEventListener('dragover', event => {
    const column = closest(event.target, '[data-ui-column]');
    if (!dragging || column?.closest('[data-ui-board]') !== dragging.board) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    column.classList.add('drop');
  });
  doc.addEventListener('dragleave', event => {
    const column = closest(event.target, '[data-ui-column]');
    if (column && !column.contains(event.relatedTarget)) column.classList.remove('drop');
  });
  doc.addEventListener('drop', event => {
    const column = closest(event.target, '[data-ui-column]');
    if (!dragging || column?.closest('[data-ui-board]') !== dragging.board) return;
    event.preventDefault(); moveCard(dragging.card, column); endDrag();
  });
  doc.addEventListener('dragend', endDrag);
  window.KavUI = Object.freeze({init, destroy, sync:syncSelect, show, hide, toast, loading, copy, chart, splitter, sidebar:responsiveSidebar, setSurfaceOpacity, setDesignTheme, setColorTheme, setPalette, setCustomPalette, getCustomPalette});
  function boot() {
    initToastAnnouncers();
    applyTheme(resolvedColorTheme(), false);
    let savedDesign = null, savedPalette = null, savedCustom = null;
    if (doc.body.hasAttribute('data-ui-theme-persist')) {
      try { savedDesign = localStorage.getItem('kav-ui-design-theme'); savedPalette = localStorage.getItem('kav-ui-palette'); savedCustom=JSON.parse(localStorage.getItem('kav-ui-custom-palette') || 'null'); } catch { /* Storage is optional. */ }
    }
    if (doc.body.hasAttribute('data-ui-theme-persist') && !doc.body.style.getPropertyValue('--ui-theme-surface-opacity')) {
      try {
        const saved = localStorage.getItem('kav-ui-surface-opacity');
        if (saved !== null && saved.trim() !== '') setSurfaceOpacity(Number(saved));
      } catch { /* Storage is optional. */ }
    }
    const explicitSeed=doc.documentElement.getAttribute('data-ui-palette-seed');
    const explicitChroma=doc.documentElement.getAttribute('data-ui-palette-chroma');
    const record=explicitSeed?createCustomPalette(explicitSeed,explicitChroma===null?24:Number(explicitChroma)):[1,2].includes(savedCustom?.version)?createCustomPalette(savedCustom.seed,savedCustom.chroma):null;
    if(record){customPalette=record;customPaletteStyle(record);}
    const validPalette=palette=>colorPalettes.includes(palette) && (palette!=='custom' || customPalette);
    const explicitPalette = doc.documentElement.getAttribute('data-ui-palette');
    applyPalette(validPalette(explicitPalette) ? explicitPalette : validPalette(savedPalette) ? savedPalette : 'default', false);
    const explicitDesign = doc.body.getAttribute('data-ui-theme');
    applyDesignTheme(designThemes.includes(explicitDesign) ? explicitDesign : designThemes.includes(savedDesign) ? savedDesign : 'default', false);
    init();
    iconObserver.observe(doc.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['icon']});
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded',boot,{once:true}); else boot();
})();
