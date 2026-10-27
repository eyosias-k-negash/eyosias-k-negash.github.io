/* eyosias.me: terminal behaviours. No dependencies. */
(function () {
  'use strict';

  var root = document.documentElement;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /* Typed commands
     Each [data-term] block types its command once it scrolls into view, then
     reveals its output. Blocks run one at a time, in the order they appear. */

  var queue = [];
  var running = false;

  function finish(block) {
    block.classList.remove('is-typing');
    block.classList.add('is-done');
    block.dispatchEvent(new CustomEvent('term:done'));
  }

  function inView(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < window.innerHeight;
  }

  async function typeBlock(block) {
    var el = block.querySelector('.cmd-text');
    // Don't make the reader wait on blocks they have already scrolled past.
    if (!el || !inView(block)) return finish(block);

    var text = el.getAttribute('data-cmd');
    var hurry = function () { return queue.length > 2; };
    // ~48ms a key, but long commands never take much more than a second
    var perChar = Math.min(48, 1100 / text.length);
    el.textContent = '';
    block.classList.add('is-typing');

    // Every wait re-checks visibility: when the reader jumps past this block
    // (e.g. pressing a window number), stop holding up the queue.
    for (var t = 0; t < 240 && !hurry() && inView(block); t += 40) await sleep(40);

    for (var i = 0; i < text.length && inView(block); i++) {
      el.textContent = text.slice(0, i + 1);
      await sleep(hurry() ? 6 : perChar * (0.6 + Math.random() * 0.8));
    }

    el.textContent = text;
    if (inView(block)) await sleep(hurry() ? 30 : 150);
    finish(block);
  }

  async function drain() {
    if (running) return;
    running = true;
    while (queue.length) {
      queue.sort(function (a, b) {
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      await typeBlock(queue.shift());
    }
    running = false;
  }

  function initTyping() {
    var blocks = document.querySelectorAll('[data-term]');

    if (reduceMotion || !('IntersectionObserver' in window)) {
      blocks.forEach(finish);
      return;
    }

    blocks.forEach(function (block) {
      var el = block.querySelector('.cmd-text');
      if (el) el.setAttribute('data-cmd', el.textContent);
    });

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);
        queue.push(entry.target);
      });
      drain();
    }, { rootMargin: '0px 0px -12% 0px' });

    blocks.forEach(function (block) { io.observe(block); });
  }

  /* "new" badges are decided at build time, but GitHub Pages only rebuilds on
     push: drop the ones that have aged out since (see _includes/new-badge.html). */

  function initNewBadges() {
    document.querySelectorAll('[data-new-since]').forEach(function (badge) {
      var until = new Date(badge.getAttribute('data-new-since') + 'T00:00:00');
      until.setMonth(until.getMonth() + parseInt(badge.getAttribute('data-new-months'), 10));
      if (!(Date.now() < until)) badge.remove();
    });
  }

  /* Role line: types and deletes each entry in turn */

  function TxtRotate(el, lines, period) {
    this.el = el;
    this.lines = lines;
    this.period = period;
    this.loop = 0;
    this.txt = '';
    this.deleting = false;
    this.text = document.createElement('span');
    this.cursor = document.createElement('span');
    this.cursor.className = 'rotate-cursor';
    el.textContent = '';
    el.appendChild(this.text);
    el.appendChild(this.cursor);
    this.tick();
  }

  TxtRotate.prototype.tick = function () {
    var full = this.lines[this.loop % this.lines.length];
    this.txt = this.deleting ? full.slice(0, this.txt.length - 1) : full.slice(0, this.txt.length + 1);
    this.text.textContent = this.txt;

    var delta = this.deleting ? 18 : 45 + Math.random() * 45;
    if (!this.deleting && this.txt === full) {
      delta = this.period;
      this.deleting = true;
    } else if (this.deleting && this.txt === '') {
      this.deleting = false;
      this.loop++;
      delta = 450;
    }
    setTimeout(this.tick.bind(this), delta);
  };

  function initRotate() {
    var el = document.getElementById('txt-rotate');
    if (!el || reduceMotion) return;

    var lines = JSON.parse(el.getAttribute('data-rotate'));
    var period = parseInt(el.getAttribute('data-period'), 10) || 2000;
    var block = el.closest('[data-term]');
    var start = function () { new TxtRotate(el, lines, period); };

    if (block && !block.classList.contains('is-done')) {
      block.addEventListener('term:done', start, { once: true });
    } else {
      start();
    }
  }

  /* `su`: clicking the name cycles through the pseudonyms and recolours every prompt */

  function initAlias() {
    var alias = document.querySelector('.alias');
    if (!alias) return;

    var aliases = JSON.parse(alias.getAttribute('data-aliases') || '[]');
    if (aliases.length < 2) return;

    alias.addEventListener('click', function () {
      var current = alias.getAttribute('data-text');
      var idx = aliases.findIndex(function (a) { return a.name === current; });
      var next = aliases[(idx + 1) % aliases.length];

      alias.textContent = next.name;
      alias.setAttribute('data-text', next.name);
      root.style.setProperty('--pseudonym-color', next.color);
      document.querySelectorAll('.ps1-user').forEach(function (el) { el.textContent = next.name; });

      if (!reduceMotion) {
        alias.classList.remove('is-switching');
        void alias.offsetWidth; // restart the animation
        alias.classList.add('is-switching');
      }
    });
  }

  /* Skills: shuffle on load, filter by type */

  function initSkills() {
    var cloud = document.querySelector('.skill-cloud');
    if (!cloud) return;

    var items = Array.prototype.slice.call(cloud.children);
    for (var i = items.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = items[i]; items[i] = items[j]; items[j] = tmp;
    }
    items.forEach(function (item) { cloud.appendChild(item); });

    var buttons = document.querySelectorAll('.skill-filter [data-filter]');
    var cmd = cloud.closest('[data-term]').querySelector('.cmd-text');

    buttons.forEach(function (button) {
      button.addEventListener('click', function () {
        var filter = button.getAttribute('data-filter');
        cloud.setAttribute('data-filter', filter);
        buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b === button)); });
        if (cmd) {
          cmd.textContent = 'skills --cloud' + (filter === 'all' ? '' : ' --type=' + button.textContent) + ' | shuf';
        }
      });
    });
  }

  /* tmux status line: live clock, active window, number keys switch windows */

  function initStatusbar() {
    var clock = document.querySelector('[data-clock]');
    if (clock) {
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      var tick = function () {
        var d = new Date();
        clock.textContent = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' +
          pad(d.getDate()) + '-' + months[d.getMonth()] + '-' + String(d.getFullYear()).slice(-2);
      };
      tick();
      setInterval(tick, 15000);
    }

    var links = Array.prototype.slice.call(document.querySelectorAll('.tmux-windows a'));
    var windowLinks = links.filter(function (a) { return a.hasAttribute('data-window'); });

    if (windowLinks.length && 'IntersectionObserver' in window) {
      var list = document.querySelector('.tmux-windows');
      var setActive = function (id) {
        windowLinks.forEach(function (a) {
          if (a.getAttribute('data-window') !== id) return a.removeAttribute('aria-current');
          a.setAttribute('aria-current', 'true');
          // keep the active window visible when the list overflows on narrow screens
          list.scrollLeft = a.offsetLeft - (list.clientWidth - a.offsetWidth) / 2;
        });
      };
      var spy = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      }, { rootMargin: '-35% 0px -60% 0px' });
      document.querySelectorAll('section[data-window]').forEach(function (s) { spy.observe(s); });
    }

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[0-9]$/.test(e.key)) return;
      var target = e.composedPath ? e.composedPath()[0] : e.target;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      var link = links[parseInt(e.key, 10)];
      if (link) link.click();
    });
  }

  /* Glass panes: the specular highlight follows the pointer across the hovered pane */

  function initGlass() {
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;

    var last = null;
    var frame = 0;

    document.addEventListener('pointermove', function (e) {
      last = e;
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        var pane = last.target.closest && last.target.closest('.pane');
        var glass = pane && pane.querySelector(':scope > .glass');
        if (!glass) return;
        var r = glass.getBoundingClientRect();
        glass.style.setProperty('--mx', Math.round(last.clientX - r.left) + 'px');
        glass.style.setProperty('--my', Math.round(last.clientY - r.top) + 'px');
      });
    }, { passive: true });
  }

  /* Declassify: link labels ([data-redact]) are covered by a bar that then retracts
     while the text unscrambles. Each plays once when first scrolled into view, then
     an occasional random on-screen link repeats it. */

  var GLYPHS = '!<>-_\\/[]{}=+*^?#$%&@01'; // ASCII only: every glyph is one monospace cell wide
  var REDACT_MS = 1000;

  // Screen readers keep the real label; only an aria-hidden copy gets scrambled.
  function prepareLabel(el) {
    var text = el.textContent;
    var spoken = document.createElement('span');
    var shown = document.createElement('span');
    spoken.className = 'sr-only';
    spoken.textContent = text;
    shown.setAttribute('aria-hidden', 'true');
    shown.textContent = text;
    el.setAttribute('data-text', text);
    el.textContent = '';
    el.appendChild(spoken);
    el.appendChild(shown);
  }

  function cancelRedact(el) {
    if (!el.classList.contains('is-redacting')) return;
    el.classList.remove('is-redacting');
    el.lastChild.textContent = el.getAttribute('data-text');
  }

  function declassify(el) {
    if (el.classList.contains('is-redacting')) return;
    var text = el.getAttribute('data-text');
    var shown = el.lastChild;
    var start = performance.now();
    var lastRoll = -1;
    el.classList.add('is-redacting');

    // Timeline (matches @keyframes redact): bar covers 0-200ms, holds to 500ms,
    // retracts left to right 500-850ms; text resolves left to right 600-980ms.
    var frame = function (now) {
      if (!el.classList.contains('is-redacting')) return; // cancelled
      var t = now - start;
      if (t >= REDACT_MS) {
        shown.textContent = text;
        el.classList.remove('is-redacting');
        return;
      }
      var roll = Math.floor(t / 55);
      if (t >= 200 && roll !== lastRoll) {
        lastRoll = roll;
        var keep = Math.floor(Math.max(0, Math.min(1, (t - 600) / 380)) * text.length);
        var out = text.slice(0, keep);
        for (var i = keep; i < text.length; i++) {
          out += text[i] === ' ' ? ' ' : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        }
        shown.textContent = out;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function initRedact() {
    var labels = Array.prototype.slice.call(document.querySelectorAll('[data-redact]'));
    if (!labels.length || reduceMotion || !('IntersectionObserver' in window)) return;
    labels.forEach(prepareLabel);

    var barHeight = function () {
      var bar = document.querySelector('.statusbar');
      return bar ? bar.getBoundingClientRect().bottom : 0;
    };
    var fullyVisible = function (el) {
      var r = el.getBoundingClientRect();
      return r.top >= barHeight() && r.bottom <= window.innerHeight && r.width > 0;
    };
    var outputShown = function (el) {
      var block = el.closest('[data-term]');
      return !block || block.classList.contains('is-done');
    };
    var engaged = function (el) {
      var link = el.closest('a') || el;
      return link.matches(':hover') || link.matches(':focus-within');
    };

    // First sighting: stagger labels that arrive together so they ripple rather than fire at once.
    var nextAt = 0;
    var stagger = function (el) {
      var now = performance.now();
      nextAt = Math.max(now, nextAt) + 70;
      setTimeout(function () { if (!engaged(el)) declassify(el); }, nextAt - now);
    };

    var firstLook = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var el = entry.target;
        firstLook.unobserve(el);
        var block = el.closest('[data-term]');
        if (block && !block.classList.contains('is-done')) {
          block.addEventListener('term:done', function () { stagger(el); }, { once: true });
        } else {
          stagger(el);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });
    labels.forEach(function (el) { firstLook.observe(el); });

    // Afterwards, sparsely: one random fully visible, idle link every 8-15s,
    // never the same one twice in a row when there is a choice.
    var last = null;
    var ambient = function () {
      setTimeout(function () {
        if (!document.hidden) {
          var pool = labels.filter(function (el) {
            return !el.classList.contains('is-redacting') && outputShown(el) && fullyVisible(el) && !engaged(el);
          });
          if (pool.length > 1) pool = pool.filter(function (el) { return el !== last; });
          if (pool.length) {
            last = pool[Math.floor(Math.random() * pool.length)];
            declassify(last);
          }
        }
        ambient();
      }, 8000 + Math.random() * 7000);
    };
    ambient();

    // Never stand between the reader and a link they are reaching for.
    var release = function (e) {
      var link = e.target.closest && e.target.closest('a');
      if (!link) return;
      if (link.hasAttribute('data-redact')) cancelRedact(link);
      link.querySelectorAll('[data-redact]').forEach(cancelRedact);
    };
    document.addEventListener('pointerover', release);
    document.addEventListener('focusin', release);
  }

  function init() {
    root.classList.add('term-ready');
    initNewBadges();
    initTyping();
    initRotate();
    initAlias();
    initSkills();
    initStatusbar();
    initGlass();
    initRedact();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
