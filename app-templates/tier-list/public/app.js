// The tier list screen. Talks to api.js; every request carries the platform
// token the frame was opened with, which is how the server knows who you are.
//
// One board, two rankings. "The group's" puts every item in the tier its
// average lands in. "Yours" is the same board with your own tiers on it:
// drag an item into a tier (press and hold first on a touch screen, so a
// swipe still scrolls), or tap it and then tap a tier. Dragging it back to
// "Not ranked yet" takes it off your board.
//
// Rendering builds elements and sets textContent, never innerHTML with
// people's words in it, so an item called "<b>hi</b>" shows exactly that.
// Class names are whole literals so the Tailwind build can see them.

(function () {
  var token = new URLSearchParams(window.location.search).get('token') || '';

  var el = {
    form: document.getElementById('add-form'),
    status: document.getElementById('status'),
    loading: document.getElementById('loading'),
    error: document.getElementById('error'),
    empty: document.getElementById('empty'),
    ranking: document.getElementById('ranking'),
    toggle: document.getElementById('view-toggle'),
    note: document.getElementById('board-note'),
    hint: document.getElementById('hint'),
    board: document.getElementById('board'),
    tray: document.getElementById('tray'),
    trayLabel: document.getElementById('tray-label'),
    trayItems: document.getElementById('tray-items'),
    picked: document.getElementById('picked-actions'),
  };

  // Whole class names per tier, so the build and the <style> block see them.
  var TIER_CLASS = { S: 'tier-s', A: 'tier-a', B: 'tier-b', C: 'tier-c', D: 'tier-d', F: 'tier-f' };
  var TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  var CHIP = 'inline-flex max-w-full items-center rounded-lg bg-raised px-2.5 py-1.5 text-small font-medium';
  var CHIP_MOVABLE = 'inline-flex min-h-9 max-w-full cursor-grab touch-manipulation select-none items-center rounded-lg border border-line bg-surface px-2.5 py-1.5 text-small font-medium shadow-sm';
  var CHIP_PICKED = 'inline-flex min-h-9 max-w-full cursor-grab touch-manipulation select-none items-center rounded-lg border border-accent bg-surface px-2.5 py-1.5 text-small font-medium ring-2 ring-accent';

  var data = null;
  // Which ranking is on the board; remembered on this device. Yours first,
  // so somebody new can drag straight away; once they switch, that sticks.
  var view = 'yours';
  try { if (localStorage.getItem('tier-list:view') === 'group') view = 'group'; } catch (e) { /* yours */ }
  // The item tapped and waiting for a tier, if any.
  var picked = null;
  // A drag under way: { id, chip, ghost, x, y, pointerId, touch, active, timer }.
  var drag = null;
  var justDragged = false;

  function api(method, url, body) {
    var headers = { 'x-usernode-token': token };
    // A preview opened at a chosen moment tells the server what time it is
    // there (req.now; "Time-dependent features" in the platform conventions).
    if (window.usernode && window.usernode.previewNow) headers['x-usernode-now'] = window.usernode.now().toISOString();
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(url, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok) {
            throw new Error(d.error === 'account_required'
              ? 'Make an account to join in.'
              : d.error || 'Something went wrong (' + res.status + ').');
          }
          return d;
        });
      });
  }

  /** A tiny element builder: h('p', 'text-small', 'Hello'). */
  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /**
   * A tap that cannot be undone asks for a second one. window.confirm() is no
   * use here: Homeroom's app frame does not allow dialogs, so it returns false
   * without showing anything. The first tap says what the second will do, and
   * the button goes back to how it was after a few seconds.
   */
  function tapTwice(button, armedLabel, action) {
    var timer = null;
    var resting = null;
    var label = null;
    var className = null;
    function rest() {
      timer = null;
      button.textContent = '';
      resting.forEach(function (n) { button.appendChild(n); });
      if (label) button.setAttribute('aria-label', label);
      button.className = className;
    }
    button.addEventListener('click', function () {
      if (timer) {
        clearTimeout(timer);
        rest();
        action();
        return;
      }
      resting = Array.prototype.slice.call(button.childNodes);
      label = button.getAttribute('aria-label');
      className = button.className;
      button.textContent = armedLabel;
      button.setAttribute('aria-label', armedLabel);
      button.className = 'btn-secondary shrink-0 whitespace-nowrap border-0 bg-transparent px-2 text-small text-danger';
      timer = setTimeout(rest, 4000);
    });
  }

  function showStatus(err) {
    el.status.textContent = err ? err.message : '';
    el.status.hidden = !err;
  }

  function act(promise) {
    return promise.then(function () { showStatus(null); return load(); }).catch(function (err) { showStatus(err); return load(); });
  }

  function count(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function itemById(id) {
    return data.items.filter(function (i) { return i.id === id; })[0];
  }

  // Where an item sits on the board being shown.
  function placeOf(item) {
    return view === 'yours' ? item.yours : item.tier;
  }

  // ── Placing an item in your tiers ───────────────────────────────────────

  function place(id, tier) {
    var item = itemById(id);
    picked = null;
    if (!item || item.yours === tier) { render(); return; }
    item.yours = tier; // on the board straight away; the server agrees or the reload puts it back
    render();
    act(api('PUT', '/api/items/' + id + '/tier', { tier: tier }));
  }

  function pick(id) {
    picked = picked === id ? null : id;
    render();
  }

  // ── Dragging ────────────────────────────────────────────────────────────

  function dropTargetAt(x, y) {
    var under = document.elementFromPoint(x, y);
    return under ? under.closest('[data-drop]') : null;
  }

  function highlight(target) {
    Array.prototype.forEach.call(document.querySelectorAll('[data-drop]'), function (n) {
      n.classList.toggle('bg-raised', n === target);
    });
  }

  function onPointerDown(e) {
    if (view !== 'yours' || e.button > 0) return;
    var chip = e.currentTarget;
    drag = { id: Number(chip.getAttribute('data-item')), chip: chip, x: e.clientX, y: e.clientY, pointerId: e.pointerId, touch: e.pointerType !== 'mouse', active: false, timer: null };
    // On a touch screen a drag starts after a short hold, so a swipe still scrolls.
    if (drag.touch) drag.timer = setTimeout(begin, 220);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', endDrag);
  }

  function begin() {
    if (!drag || drag.active) return;
    drag.active = true;
    var rect = drag.chip.getBoundingClientRect();
    var ghost = drag.chip.cloneNode(true);
    ghost.className = 'pointer-events-none fixed z-50 inline-flex items-center rounded-lg border border-accent bg-surface px-2.5 py-1.5 text-small font-medium shadow-lg';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    drag.offsetX = drag.x - rect.left;
    drag.offsetY = drag.y - rect.top;
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    drag.chip.classList.add('opacity-40');
  }

  function onPointerMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 6) return;
      // Moving before the hold is a scroll on a touch screen; with a mouse it is a drag.
      if (drag.touch) { endDrag(); return; }
      begin();
    }
    drag.ghost.style.left = (e.clientX - drag.offsetX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
    highlight(dropTargetAt(e.clientX, e.clientY));
  }

  function onPointerUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    var wasActive = drag.active;
    var id = drag.id;
    var target = wasActive ? dropTargetAt(e.clientX, e.clientY) : null;
    endDrag();
    if (!wasActive) return; // a tap: the click handler picks it
    justDragged = true;
    setTimeout(function () { justDragged = false; }, 0);
    if (target) place(id, target.getAttribute('data-drop') || null);
  }

  function endDrag() {
    if (!drag) return;
    clearTimeout(drag.timer);
    if (drag.ghost) drag.ghost.remove();
    drag.chip.classList.remove('opacity-40');
    highlight(null);
    drag = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', endDrag);
  }

  // Once a drag is under way on a touch screen, the page must not scroll under it.
  document.addEventListener('touchmove', function (e) { if (drag && drag.active) e.preventDefault(); }, { passive: false });

  // ── The board ───────────────────────────────────────────────────────────

  function chipFor(item) {
    if (view === 'group') {
      var still = h('span', CHIP, item.name);
      still.setAttribute('data-item', String(item.id));
      still.title = item.name + ': ' + count(item.votes, 'person', 'people') + ' ranked it';
      return still;
    }
    var chip = h('button', picked === item.id ? CHIP_PICKED : CHIP_MOVABLE, item.name);
    chip.type = 'button';
    chip.setAttribute('data-item', String(item.id));
    chip.setAttribute('aria-pressed', picked === item.id ? 'true' : 'false');
    chip.setAttribute('aria-label', item.name + (item.yours ? ', in your ' + item.yours + ' tier' : ', not ranked yet') + '. Tap, then tap a tier to move it.');
    chip.style.webkitTouchCallout = 'none';
    chip.addEventListener('pointerdown', onPointerDown);
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!justDragged) pick(item.id);
    });
    chip.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    return chip;
  }

  function sorted(items) {
    if (view === 'yours') return items;
    return items.slice().sort(function (a, b) { return b.average - a.average || b.votes - a.votes; });
  }

  function row(tier) {
    var items = sorted(data.items.filter(function (i) { return placeOf(i) === tier; }));
    var r = h('div', 'flex min-h-14 items-stretch');
    r.setAttribute('data-tier', tier);
    var label;
    if (view === 'yours') {
      r.setAttribute('data-drop', tier);
      label = h('button', 'flex w-14 shrink-0 items-center justify-center text-heading ' + TIER_CLASS[tier], tier);
      label.type = 'button';
      label.setAttribute('aria-label', picked ? 'Put ' + itemById(picked).name + ' in ' + tier : 'Tier ' + tier);
      r.addEventListener('click', function () { if (picked) place(picked, tier); });
    } else {
      label = h('div', 'flex w-14 shrink-0 items-center justify-center text-heading ' + TIER_CLASS[tier], tier);
      label.setAttribute('aria-label', 'Tier ' + tier);
    }
    r.appendChild(label);
    var chips = h('div', picked ? 'flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-1.5 px-3 py-2' : 'flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-3 py-2');
    items.forEach(function (item) { chips.appendChild(chipFor(item)); });
    r.appendChild(chips);
    return r;
  }

  function renderPicked() {
    el.picked.textContent = '';
    var item = picked && itemById(picked);
    el.picked.hidden = !item;
    if (!item) return;
    if (item.yours) {
      var out = h('button', 'btn-secondary', 'Take it off my board');
      out.type = 'button';
      out.addEventListener('click', function () { place(item.id, null); });
      el.picked.appendChild(out);
    }
    if (item.mine) {
      var remove = h('button', 'btn-secondary border-0 bg-transparent px-2 text-small text-muted', 'Remove it for everyone');
      remove.type = 'button';
      // Everyone's tiers for it go with it.
      tapTwice(remove, 'Tap again to remove', function () { picked = null; act(api('DELETE', '/api/items/' + item.id)); });
      el.picked.appendChild(remove);
    }
    var cancel = h('button', 'btn-secondary border-0 bg-transparent px-2 text-small text-muted', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { picked = null; render(); });
    el.picked.appendChild(cancel);
  }

  function renderBoard() {
    el.board.setAttribute('data-view', view);
    el.board.textContent = '';
    TIERS.forEach(function (tier) { el.board.appendChild(row(tier)); });

    Array.prototype.forEach.call(el.toggle.querySelectorAll('[data-view]'), function (b) {
      var on = b.getAttribute('data-view') === view;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.className = on
        ? 'min-h-11 rounded-lg bg-accent px-4 text-body font-medium text-on-accent'
        : 'min-h-11 rounded-lg px-4 text-body font-medium text-muted hover:bg-raised';
    });

    var waiting = data.items.filter(function (i) { return !placeOf(i); });
    el.trayItems.textContent = '';
    waiting.forEach(function (item) { el.trayItems.appendChild(chipFor(item)); });
    if (view === 'yours') {
      var ranked = data.items.length - waiting.length;
      el.note.textContent = ranked === data.items.length ? 'All ranked' : ranked + ' of ' + data.items.length + ' ranked';
      el.trayLabel.textContent = waiting.length ? 'Not ranked yet' : 'Not ranked yet: drag one here to take it off your board';
      el.tray.hidden = false;
      el.tray.setAttribute('data-drop', '');
      el.tray.onclick = function () { if (picked && itemById(picked).yours) place(picked, null); };
      el.hint.textContent = picked
        ? 'Now tap a tier for ' + itemById(picked).name + '.'
        : 'Drag each one into a tier, or tap it and then tap a tier.';
      el.hint.hidden = false;
    } else {
      el.note.textContent = data.rankers ? 'From ' + count(data.rankers, 'person\'s', 'people\'s') + ' rankings' : 'Nobody has ranked yet';
      el.trayLabel.textContent = 'Nobody has ranked these yet';
      el.tray.hidden = !waiting.length;
      el.tray.removeAttribute('data-drop');
      el.tray.onclick = null;
      el.hint.hidden = true;
    }
    renderPicked();
  }

  // ── Loading, empty, error ──────────────────────────────────────────────

  function show(state) {
    el.loading.hidden = state !== 'loading';
    el.error.hidden = state !== 'error';
    el.empty.hidden = state !== 'empty';
    // With nothing added yet the empty tiers still show under the empty
    // state, so it is clear what the list will be.
    el.ranking.hidden = state !== 'ready' && state !== 'empty';
  }

  function render() {
    if (picked && !itemById(picked)) picked = null;
    renderBoard();
    var none = !data.items.length;
    // Nothing to switch between, drag or tray yet: just the tiers.
    el.toggle.parentNode.hidden = none;
    if (none) { el.hint.hidden = true; el.tray.hidden = true; }
    show(none ? 'empty' : 'ready');
  }

  var loaded = false;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = api('GET', '/api/items')
      .then(function (d) {
        loaded = true;
        // Not while somebody is mid-drag: the board would move under them.
        if (drag) return;
        data = d;
        render();
      })
      .catch(function (err) {
        // A refresh that fails keeps what is on screen; only a first load
        // with nothing to show turns into the error state.
        if (loaded) showStatus(err);
        else show('error');
      })
      .then(function () { loading = null; });
    return loading;
  }

  el.toggle.addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]');
    if (!b) return;
    view = b.getAttribute('data-view');
    picked = null;
    try { localStorage.setItem('tier-list:view', view); } catch (err) { /* not kept */ }
    render();
  });
  el.form.addEventListener('submit', function (e) {
    e.preventDefault();
    var input = el.form.elements.name;
    if (!input.value.trim()) return;
    act(api('POST', '/api/items', { name: input.value }).then(function () { el.form.reset(); }));
  });
  document.getElementById('retry').addEventListener('click', function () { show('loading'); load(); });

  // Other people rank too: look again every 15 seconds while the app is on
  // screen, and straight away when it comes back. Skipped while someone is
  // typing, dragging or has picked an item, so a refresh never interrupts them.
  setInterval(function () {
    var typing = document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.value;
    if (!document.hidden && !typing && !drag && !picked) load();
  }, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && !drag) load(); });

  load();
})();
