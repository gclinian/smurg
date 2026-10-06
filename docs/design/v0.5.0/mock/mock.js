// smurg v0.5.0 mock: the little behaviour that makes the static pages clickable. No framework, no network.
// Everything is driven by data attributes in the HTML:
//   data-toggle (+ aria-controls)   collapse / expand a section or a topic
//   data-left-toggle                collapse the left column to its rail
//   data-open="<column id>"         open a column in the focused column (data-flash: what to point at inside it)
//   data-open-side="<column id>"    open it in a new column beside the focused one (4 at most)
//   data-col-close                  close the column the button is in
//   data-menu                       open the .ui-menu next to the button
//   data-dialog-open / -close       a dialog
//   data-show="<id>"                switch a view inside a column (Read / Edit)
//   data-q / data-perm / data-sug   the live parts of a question, a permission request, a suggestion
//   data-region                     a stop of F6 / Shift+F6
(() => {
  'use strict';
  const zh = document.documentElement.lang.startsWith('zh');
  const say = (en, tw) => (zh ? tw : en);
  const MAX_COLUMNS = 4;
  const MIN_COLUMN = 320;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  // ---------------------------------------------------------------- toast
  function toast(text) {
    let region = $('.ui-toast-region');
    if (!region) {
      region = document.createElement('div');
      region.className = 'ui-toast-region';
      region.setAttribute('role', 'status');
      document.body.append(region);
    }
    const item = document.createElement('div');
    item.className = 'ui-toast';
    item.innerHTML = '<div class="ui-toast__body"><div class="ui-toast__title"></div></div>';
    $('.ui-toast__title', item).textContent = text;
    region.append(item);
    setTimeout(() => item.remove(), 3200);
  }

  // ---------------------------------------------------------------- columns
  const strip = () => $('.sv-cols');
  const columns = () => $$(':scope > .col', strip());

  function rebuildSeparators() {
    const s = strip();
    if (!s) return;
    $$(':scope > .col-sep', s).forEach((sep) => sep.remove());
    const cols = columns();
    cols.forEach((col, index) => {
      col.style.flex = '';
      if (index === 0) return;
      const sep = document.createElement('div');
      sep.className = 'col-sep';
      sep.tabIndex = 0;
      sep.setAttribute('role', 'separator');
      sep.setAttribute('aria-orientation', 'vertical');
      sep.setAttribute('aria-label', say('Drag or use the arrow keys to resize the columns', '拖曳或用方向鍵調整欄寬'));
      col.before(sep);
    });
    const empty = $('#tpl-empty');
    if (cols.length === 0 && empty && !$('.sv-empty', s)) s.append(empty.content.cloneNode(true));
    if (cols.length > 0) $('.sv-empty', s)?.remove();
    fitColumns();
    updateMore();
    markRows();
  }

  /**
   * A column is at least MIN_COLUMN wide. When the open columns do not fit, the strip shows as many WHOLE columns as
   * fit (never a cut one) and scrolls sideways for the rest.
   */
  function fitColumns() {
    const s = strip();
    if (!s) return;
    const cols = columns();
    const area = s.clientWidth;
    const fit = Math.max(1, Math.floor(area / MIN_COLUMN));
    if (cols.length > fit) {
      const width = (area - (fit - 1)) / fit;
      cols.forEach((col) => {
        col.style.flex = `0 0 ${width}px`;
        col.dataset.fit = '';
      });
    } else {
      cols.forEach((col) => {
        if ('fit' in col.dataset) {
          col.style.flex = '';
          delete col.dataset.fit;
        }
      });
    }
  }

  function focusColumn(col) {
    columns().forEach((other) => other.toggleAttribute('data-focused', other === col));
    markRows();
  }

  /** The rows of the left column say what is open (a bar) and what the focused column shows (the selection). */
  function markRows() {
    const s = strip();
    if (!s) return;
    const open = new Set(columns().map((col) => col.dataset.col));
    const focused = $('.col[data-focused]', s)?.dataset.col;
    $$('.srow[data-open]').forEach((row) => {
      row.toggleAttribute('data-open-in', open.has(row.dataset.open));
      if (row.dataset.open === focused) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    });
  }

  function openColumn(id, { side = false, flash } = {}) {
    const s = strip();
    if (!s) return;
    let col = $(`:scope > .col[data-col="${id}"]`, s);
    if (!col) {
      const template = document.getElementById(`tpl-${id}`);
      if (!template) {
        toast(say('This item is not part of the mock.', '這個項目不在這份示意稿裡。'));
        return;
      }
      const cols = columns();
      const focused = $(':scope > .col[data-focused]', s) ?? cols.at(-1);
      if (side && cols.length >= MAX_COLUMNS) {
        toast(say('Four columns are open. Close one first.', '已經開了四欄，請先關閉一欄。'));
        return;
      }
      col = template.content.firstElementChild.cloneNode(true);
      if (!focused) s.append(col);
      else if (side) focused.after(col);
      else focused.replaceWith(col);
      rebuildSeparators();
    }
    focusColumn(col);
    showColumn(col);
    if (flash) {
      const target = $(flash, col);
      if (target) {
        scrollInside(target);
        target.setAttribute('data-flash', '');
        setTimeout(() => target.removeAttribute('data-flash'), 2000);
      }
    }
    updateMore();
  }

  /** Brings a column into view by scrolling the strip only (scrollIntoView would also move the page). */
  function showColumn(col, align = 'nearest') {
    const s = strip();
    const left = col.offsetLeft - s.offsetLeft;
    const right = left + col.offsetWidth;
    if (align === 'start' || left < s.scrollLeft) s.scrollLeft = left;
    else if (right > s.scrollLeft + s.clientWidth) s.scrollLeft = right - s.clientWidth;
  }
  /** Centres an element inside its own scroll container (a conversation, a column body). */
  function scrollInside(target) {
    const box = target.closest('.conv, .col-body, .lsec__body');
    if (!box) return;
    const offset = target.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(0, offset - Math.max(12, (box.clientHeight - target.offsetHeight) / 2));
  }

  /** How many columns are out of view on each side of the strip. */
  function updateMore() {
    const s = strip();
    if (!s) return;
    const view = s.getBoundingClientRect();
    let left = 0;
    let right = 0;
    for (const col of columns()) {
      const box = col.getBoundingClientRect();
      if (box.right <= view.left + 8) left += 1;
      else if (box.left >= view.right - 8) right += 1;
    }
    const set = (name, count, text) => {
      const pill = $(`.sv-more--${name}`);
      if (!pill) return;
      pill.hidden = count === 0;
      $('span', pill).textContent = text;
    };
    set('left', left, say(`${left} more`, `還有 ${left} 欄`));
    set('right', right, say(`${right} more`, `還有 ${right} 欄`));
  }

  function resizeFrom(sep, delta) {
    const cols = columns();
    const widths = cols.map((col) => col.getBoundingClientRect().width);
    const before = cols.indexOf(sep.previousElementSibling);
    const after = cols.indexOf(sep.nextElementSibling);
    if (before < 0 || after < 0) return;
    if ('fit' in cols[before].dataset) {
      // The strip overflows: the divider changes the width of the column before it; the rest move along.
      cols[before].style.flex = `0 0 ${Math.max(MIN_COLUMN, widths[before] + delta)}px`;
      return;
    }
    const total = widths[before] + widths[after];
    const next = Math.min(total - MIN_COLUMN, Math.max(MIN_COLUMN, widths[before] + delta));
    widths[before] = next;
    widths[after] = total - next;
    cols.forEach((col, index) => {
      col.style.flex = `${widths[index]} 1 0`;
    });
  }

  let drag = null;
  document.addEventListener('pointerdown', (event) => {
    const sep = event.target.closest('.col-sep, .sv-sep');
    if (sep && event.button === 0) {
      drag = { sep, x: event.clientX };
      sep.setAttribute('data-dragging', '');
      sep.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const col = event.target.closest('.sv-cols > .col');
    if (col) focusColumn(col);
  });
  document.addEventListener('pointermove', (event) => {
    if (!drag || event.buttons !== 1) return;
    const delta = event.clientX - drag.x;
    drag.x = event.clientX;
    if (drag.sep.classList.contains('sv-sep')) resizeLeft(delta);
    else resizeFrom(drag.sep, delta);
    updateMore();
  });
  document.addEventListener('pointerup', () => {
    drag?.sep.removeAttribute('data-dragging');
    drag = null;
  });
  document.addEventListener('dblclick', (event) => {
    if (event.target.closest('.col-sep')) columns().forEach((col) => (col.style.flex = ''));
  });
  function resizeLeft(delta) {
    const left = $('.sv-left');
    if (!left || left.hasAttribute('data-collapsed')) return;
    const width = Math.min(420, Math.max(220, left.getBoundingClientRect().width + delta));
    left.style.setProperty('--sv-left-width', `${width}px`);
  }

  // ---------------------------------------------------------------- clicks
  document.addEventListener('click', (event) => {
    const target = event.target;
    const toggle = target.closest('[data-toggle]');
    if (toggle) {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      const controlled = document.getElementById(toggle.getAttribute('aria-controls'));
      if (controlled) controlled.hidden = !expanded;
      toggle.closest('.lsec')?.toggleAttribute('data-collapsed', !expanded && toggle.classList.contains('lsec__toggle'));
      return;
    }
    const leftToggle = target.closest('[data-left-toggle]');
    if (leftToggle) {
      $('.sv-left')?.toggleAttribute('data-collapsed');
      requestAnimationFrame(() => {
        fitColumns();
        updateMore();
      });
      return;
    }
    const themeToggle = target.closest('[data-theme-toggle]');
    if (themeToggle) {
      const root = document.documentElement;
      root.dataset.theme = root.dataset.theme === 'light' ? 'dark' : 'light';
      return;
    }
    const close = target.closest('[data-col-close]');
    if (close) {
      const col = close.closest('.col');
      const neighbour = col.nextElementSibling?.nextElementSibling ?? col.previousElementSibling?.previousElementSibling;
      col.remove();
      rebuildSeparators();
      if (neighbour?.classList.contains('col')) {
        focusColumn(neighbour);
        $('.col-head__title', neighbour)?.focus();
      }
      return;
    }
    const sideButton = target.closest('[data-open-side]');
    if (sideButton) {
      event.preventDefault();
      event.stopPropagation();
      openColumn(sideButton.dataset.openSide, { side: true, flash: sideButton.dataset.flash });
      return;
    }
    const opener = target.closest('[data-open]');
    if (opener && !target.closest('[data-menu], .ui-menu')) {
      event.preventDefault();
      if (opener.classList.contains('inbox-item')) {
        $$('.inbox-item').forEach((item) => item.removeAttribute('aria-current'));
        opener.setAttribute('aria-current', 'true');
        opener.removeAttribute('data-unread');
      }
      openColumn(opener.dataset.open, { side: event.altKey || event.shiftKey, flash: opener.dataset.flash });
      return;
    }
    const more = target.closest('.sv-more');
    if (more) {
      const width = columns()[0]?.getBoundingClientRect().width ?? MIN_COLUMN;
      strip().scrollBy({ left: more.classList.contains('sv-more--left') ? -width : width, behavior: 'smooth' });
      return;
    }
    const menuButton = target.closest('[data-menu]');
    $$('.ui-menu[data-popup]').forEach((menu) => {
      if (!menuButton || menu !== menuButton.parentElement.querySelector('.ui-menu')) menu.hidden = true;
    });
    if (menuButton) {
      const menu = menuButton.parentElement.querySelector('.ui-menu');
      if (menu) {
        menu.hidden = !menu.hidden;
        menuButton.setAttribute('aria-expanded', String(!menu.hidden));
        if (!menu.hidden) $('.ui-menu__item', menu)?.focus();
      }
      return;
    }
    const dialogOpen = target.closest('[data-dialog-open]');
    if (dialogOpen) {
      const dialog = document.getElementById(dialogOpen.dataset.dialogOpen);
      if (dialog) {
        dialog.hidden = false;
        $('input, textarea, select, button', $('.ui-dialog__body', dialog) ?? dialog)?.focus();
      }
      return;
    }
    if (target.closest('[data-dialog-close]') || target.classList.contains('ui-dialog-backdrop')) {
      target.closest('.ui-dialog-backdrop').hidden = true;
      return;
    }
    const show = target.closest('[data-show]');
    if (show) {
      const group = show.closest('.col');
      $$('[data-view]', group).forEach((view) => (view.hidden = view.dataset.view !== show.dataset.show));
      $$('[data-show]', group).forEach((button) => button.setAttribute('aria-checked', String(button === show)));
      return;
    }
    const perm = target.closest('[data-perm]');
    if (perm) {
      const card = perm.closest('.card');
      const text = {
        once: say('Allowed once by you', '你已允許這一次'),
        always: card.querySelector('.perm__scope input:last-of-type:checked, .perm__scope label:last-child input:checked') ? say('Allowed by you, and always for this kind in every session of this topic', '你已允許，這個主題的所有 session 之後一律允許這類指令') : say('Allowed by you, and always for this kind in this session', '你已允許，這個 session 之後一律允許這類指令'),
        deny: say('Denied by you', '你已拒絕'),
      }[perm.dataset.perm];
      settle(card, text);
      return;
    }
    const sug = target.closest('[data-sug]');
    if (sug) {
      const text = {
        accept: say('Accepted by you. It was sent to the agent.', '你已採用，內容已送給 agent。'),
        reject: say('Rejected by you', '你已拒絕'),
        withdraw: say('Withdrawn', '已撤回'),
      }[sug.dataset.sug];
      settle(sug.closest('.card'), text);
      return;
    }
    const submit = target.closest('[data-q-submit]');
    if (submit) {
      const card = submit.closest('.card');
      const select = $('select', card);
      const answer = select.options[select.selectedIndex].dataset.label;
      settle(card, say(`Answered: ${answer}. Submitted by you.`, `已回答：${answer}。由你送出。`));
      return;
    }
    const review = target.closest('[data-review]');
    if (review) {
      review.disabled = true;
      review.textContent = say('Reviewed by you', '你已看過');
      return;
    }
    if (target.closest('[data-todo]')) toast(say('Not part of the mock: see UX.md.', '不在這份示意稿裡：請看 UX.md。'));
  });

  function settle(card, text) {
    card.classList.add('card--settled');
    card.innerHTML = '<div class="card__settled"><span></span></div>';
    $('span', card).textContent = text;
  }

  // ---------------------------------------------------------------- a question: live votes
  document.addEventListener('change', (event) => {
    const card = event.target.closest('[data-q]');
    if (!card || !event.target.matches('.q-opt input')) return;
    const mine = $('template[data-me]', card).content.firstElementChild;
    $$('.ui-avatar[data-mine]', card).forEach((avatar) => avatar.remove());
    const chosen = event.target.closest('.q-opt');
    const avatar = mine.cloneNode(true);
    avatar.setAttribute('data-mine', '');
    $('.ui-avatar-stack', chosen).append(avatar);
    tally(card);
    // For the person who decides, a click on an option is the vote AND the answer to submit (they may still choose another one).
    const select = $('.q__submit select', card);
    if (select) {
      select.selectedIndex = $$('.q-opt', card).indexOf(chosen) + 1;
      $('[data-q-submit]', card).disabled = false;
    }
  });
  function tally(card) {
    const options = $$('.q-opt', card);
    const counts = options.map((option) => $$('.ui-avatar-stack > .ui-avatar', option).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const top = Math.max(...counts);
    const leaders = counts.filter((count) => count === top).length;
    options.forEach((option, index) => {
      $('.q-opt__count', option).textContent = String(counts[index]);
      $('.q-opt__bar', option).style.setProperty('--share', total ? `${(counts[index] / total) * 100}%` : '0%');
      const lead = $('.q-opt__lead', option);
      if (lead) lead.hidden = !(counts[index] === top && leaders === 1 && top > 0);
    });
    const state = $('.card__state', card);
    if (state) state.textContent = say(`${total} of ${card.dataset.people} voted`, `${total} / ${card.dataset.people} 人已投票`);
    const select = $('.q__submit select', card);
    if (!select) return;
    const tie = $('.q__tie', card);
    const none = $('.q__none', card);
    const button = $('[data-q-submit]', card);
    const leading = leaders === 1 && top > 0;
    // Prefilled with the leading option; a tie or no vote at all leaves the choice to the responsible person.
    select.selectedIndex = leading ? counts.indexOf(top) + 1 : 0;
    button.disabled = !leading;
    if (tie) tie.hidden = leading || top === 0;
    if (none) none.hidden = top > 0;
  }
  document.addEventListener('input', (event) => {
    if (!event.target.matches('.q__submit select')) return;
    const card = event.target.closest('.card');
    $('[data-q-submit]', card).disabled = event.target.selectedIndex === 0;
  });

  // ---------------------------------------------------------------- keyboard
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $$('.ui-menu[data-popup]').forEach((menu) => (menu.hidden = true));
      $$('.ui-dialog-backdrop').forEach((dialog) => (dialog.hidden = true));
      return;
    }
    // F6 / Shift+F6: the regions in order (inbox, sessions, each column).
    if (event.key === 'F6') {
      const regions = $$('[data-region]').filter((region) => region.offsetParent !== null);
      if (regions.length === 0) return;
      event.preventDefault();
      const current = regions.findIndex((region) => region.contains(document.activeElement));
      const next = regions[(current + (event.shiftKey ? -1 : 1) + regions.length) % regions.length];
      const stop = $('[data-region-focus]', next) ?? next;
      stop.focus();
      if (next.classList.contains('col')) focusColumn(next);
      return;
    }
    // The session list: arrows move, Enter opens, Shift+Enter opens to the side.
    const row = event.target.closest?.('.srow, .inbox-item, .topic__toggle');
    if (row) {
      const rows = $$('.inbox-item, .topic__toggle, .srow').filter((item) => item.offsetParent !== null);
      const index = rows.indexOf(row);
      const expanded = row.getAttribute('aria-expanded');
      if ((event.key === 'ArrowRight' && expanded === 'false') || (event.key === 'ArrowLeft' && expanded === 'true')) row.click();
      else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') return;
      else if (event.key === 'ArrowDown') rows[Math.min(rows.length - 1, index + 1)]?.focus();
      else if (event.key === 'ArrowUp') rows[Math.max(0, index - 1)]?.focus();
      else if (event.key === 'Enter' && row.dataset.open) openColumn(row.dataset.open, { side: event.shiftKey, flash: row.dataset.flash });
      else return;
      event.preventDefault();
      return;
    }
    const sep = event.target.closest?.('.col-sep');
    if (sep && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      resizeFrom(sep, (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 64 : 16));
      return;
    }
    // Delete on a column's title closes the column (the same key closes an ended session's tab today).
    if (event.key === 'Delete' && event.target.matches?.('.col-head__title')) {
      $('[data-col-close]', event.target.closest('.col'))?.click();
    }
  });

  // ---------------------------------------------------------------- start
  $$('.sv-cols').forEach((s) => s.addEventListener('scroll', updateMore, { passive: true }));
  window.addEventListener('resize', () => {
    fitColumns();
    updateMore();
  });
  if (strip()) {
    const hadSeparators = $$(':scope > .col-sep', strip()).length > 0;
    if (!hadSeparators) rebuildSeparators();
    if (!$('.col[data-focused]', strip()) && columns()[0]) focusColumn(columns()[0]);
    fitColumns();
    markRows();
    updateMore();
    const scrollTo = document.body.dataset.scrollColumn;
    if (scrollTo && $(`.col[data-col="${scrollTo}"]`)) showColumn($(`.col[data-col="${scrollTo}"]`), 'start');
    updateMore();
  }
  $$('[data-scroll-end]').forEach((el) => (el.scrollTop = el.scrollHeight));
  $$('[data-scroll-to]').forEach((el) => {
    const target = $(el.dataset.scrollTo, el);
    if (target) scrollInside(target);
  });
  window.smurgMock = { showColumn: (id, align) => showColumn($(`.col[data-col="${id}"]`), align), updateMore };
  $$('[data-q]').forEach(tally);
})();
