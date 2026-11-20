
(function () {
  "use strict";
  var SALT = "earlynotice-admin-v1", ROUNDS = 600000, KEPT = "en-admin", TAB = "en-admin-tab";
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function bytesFromLink(text) {
    var s = text.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function linkFromBytes(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }

  // What this browser keeps for its owner: the key while signed in, and the tab last looked at.
  // A browser may refuse to keep anything; the page then simply asks again.
  function box(name) { try { return window[name]; } catch (e) { return null; } }
  function read(name, key) { try { var b = box(name); return (b && b.getItem(key)) || ""; } catch (e) { return ""; } }
  function write(name, key, value) { try { var b = box(name); if (b) b.setItem(key, value); } catch (e) { /* not kept */ } }
  function drop(name, key) { try { var b = box(name); if (b) b.removeItem(key); } catch (e) { /* nothing to drop */ } }
  function kept() { return read("sessionStorage", KEPT) || read("localStorage", KEPT); }
  function keep(text, always) { write("sessionStorage", KEPT, text); if (always) write("localStorage", KEPT, text); }
  function forget() { drop("sessionStorage", KEPT); drop("localStorage", KEPT); }

  // The dashboard's data is locked. Its key is the part of the admin link after the # sign, or what the
  // password unlocks. Neither ever leaves the browser.
  async function openWith(raw) {
    if (raw.length !== 32) throw new Error("not a key");
    var id = hex(await crypto.subtle.digest("SHA-256", raw)).slice(0, 20);
    var response = await fetch("/admin/" + id + ".bin", { cache: "no-store" });
    if (!response.ok) throw new Error("no longer the current key");
    var blob = new Uint8Array(await response.arrayBuffer());
    var key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12))));
  }
  // A password is stretched into a key, slowly on purpose, and that key opens one small file holding the real key.
  async function keyFromPassword(password) {
    var enc = new TextEncoder();
    var base = await crypto.subtle.importKey("raw", enc.encode(password.normalize("NFKC").trim()), "PBKDF2", false, ["deriveBits"]);
    var bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(SALT), iterations: ROUNDS, hash: "SHA-256" }, base, 256));
    var id = hex(await crypto.subtle.digest("SHA-256", bits)).slice(0, 20);
    var response = await fetch("/admin/p" + id + ".bin", { cache: "no-store" });
    if (!response.ok) return null;
    var blob = new Uint8Array(await response.arrayBuffer());
    var key = await crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12)));
  }

  // ---- the pieces every tab is built from
  function para(root, text, cls) { var p = el("p", cls || "", text); root.appendChild(p); return p; }
  function heading(root, title, note) {
    root.appendChild(el("h2", "", title));
    if (note) para(root, note, "muted small");
  }
  function tiles(root, items) {
    var list = el("ul", "admin-tiles");
    items.forEach(function (item) {
      var li = el("li");
      li.appendChild(el("b", "", String(item[0])));
      li.appendChild(el("span", "", item[1]));
      list.appendChild(li);
    });
    root.appendChild(list);
  }
  function cash(n) {
    return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  // One card per thing: an optional tag, a bold title, a line of text, and a quieter line under it.
  function cards(root, items) {
    var list = el("ul", "admin-notes");
    items.forEach(function (item) {
      var li = el("li");
      if (item.tag) li.appendChild(el("span", "tag" + (item.strong ? " ok" : ""), item.tag));
      if (item.title) li.appendChild(el("b", "", item.title));
      if (item.text) li.appendChild(el("span", "txt", item.text));
      if (item.sub) li.appendChild(el("span", "sub", item.sub));
      list.appendChild(li);
    });
    root.appendChild(list);
  }
  // A part that stays shut until it is wanted, so a tab never becomes a long page.
  function fold(root, title, figures) {
    var box = el("details", "fold"), top = el("summary");
    top.appendChild(el("b", "", title));
    if (figures) top.appendChild(el("span", "fig", figures));
    box.appendChild(top);
    var inner = el("div", "fold-in");
    box.appendChild(inner);
    root.appendChild(box);
    return inner;
  }
  function table(root, headers, rows, numeric) {
    var wrap = el("div", "scroll"), t = el("table"), head = el("tr");
    headers.forEach(function (h, i) { head.appendChild(el("th", numeric.indexOf(i) !== -1 ? "num" : "", h)); });
    t.appendChild(head);
    rows.forEach(function (row) {
      var tr = el("tr");
      row.forEach(function (cell, i) { tr.appendChild(el("td", numeric.indexOf(i) !== -1 ? "num" : "", String(cell))); });
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    root.appendChild(wrap);
  }
  function links(root, lead, pairs, outside) {
    var p = el("p", "", lead);
    pairs.forEach(function (pair, i) {
      if (i) p.appendChild(document.createTextNode("  ·  "));
      var a = el("a", "", pair[0]);
      a.href = pair[1];
      if (outside) { a.target = "_blank"; a.rel = "noopener noreferrer"; }
      p.appendChild(a);
    });
    root.appendChild(p);
  }
  function plural(n, one, many) { return n + " " + (n === 1 ? one : many); }
  var LEVELS = { held: "held", look: "your call", note: "to know" };

  function render(d) {
    var root = $("admin-root"), t = d.totals, o = d.offer, m = d.money, r = d.replies, show;
    root.replaceChildren();
    var hours = d.built_at ? Math.floor((Date.now() - new Date(d.built_at).getTime()) / 3600000) : 0;
    $("admin-sub").textContent = "Picture taken " + (d.built_at ? d.built_at.replace("T", " at ") : d.built) +
      ". Not live." + (hours >= 36 ? " This one is " + Math.floor(hours / 24) + " days old." : "");
    $("admin-sub").title = "It refreshes each time the site is published.";

    var held = (d.gate || []).filter(function (g) { return g.stops && !g.passed; });
    var mine = (d.attention || []).filter(function (a) { return a.level !== "note"; }).length;
    var waiting = d.inbox ? d.inbox.waiting.length : 0;
    function jump(text, id) {
      var b = el("button", "linkish", text);
      b.type = "button";
      b.addEventListener("click", function () { show(id, true); });
      return b;
    }

    function today(p) {
      if (d.gate) {
        var s = para(p, held.length ? "First emails are HELD by " + plural(held.length, "rule", "rules") + ". " :
          "First emails are clear to go on the next weekday run. ", "admin-status");
        s.appendChild(jump(held.length ? "See why" : "See the rules", "rules"));
      }
      tiles(p, [
        [t.emailed, "businesses emailed so far"], [r ? r.wrote_back : "-", "wrote back"],
        [t.trials, "on a free trial"], [t.paying, "paying"],
        [t.monthly_revenue, "a month from subscriptions"], [m ? cash(m.left_now) : "-", "a month left after today's costs"],
        [t.waiting, "businesses lined up, not yet emailed"], [mine, "things waiting on you"]
      ]);
    }

    function todo(p) {
      heading(p, "Needs your attention", "\"Held\" stops first emails. \"Your call\" is a decision or a check that is yours. \"To know\" needs nothing from you.");
      if (d.attention && d.attention.length) cards(p, d.attention.map(function (a) {
        return { tag: LEVELS[a.level] || a.level, strong: a.level === "held", text: a.text };
      }));
      else para(p, "Nothing needs you.");
      if (d.open_items) {
        var inner = fold(p, "Open items in the review log", d.open_items.length + " open");
        if (d.open_items.length) cards(inner, d.open_items.map(function (i) {
          return { tag: i.kind, strong: i.kind.toLowerCase() === "must act", title: "#" + i.n + " " + i.what, sub: i.state };
        }));
        else para(inner, "Nothing is open.");
      }
    }

    function emails(p) {
      tiles(p, [
        [t.emailed, "businesses emailed so far"], [t.emailed_week, "emailed in the last 7 days"],
        [t.bounced, "could not be delivered"], [t.said_no, "said no or unsubscribed"],
        [t.may_email, "businesses we may email"], [t.waiting, "still waiting their turn"]
      ]);
      var boxes = d.mailboxes;
      para(p, "The daily number now: " + (d.pace === undefined ? o.overall_cap : d.pace) + " first emails a day from each sending mailbox that is ready" +
        (boxes ? " (" + boxes.ready + " of " + boxes.on_file + " ready today)" : "") + ". At most " + o.daily_cap +
        " to one city, never more than " + o.overall_cap + " a day from one mailbox, weekdays only, one email per business, ever.");
      if (boxes && boxes.notes.length) cards(p, boxes.notes.map(function (note) { return { tag: "not used today", text: note }; }));
      heading(p, "First emails sent, last " + d.sent_by_day.length + " days", null);
      var most = Math.max.apply(null, d.sent_by_day.map(function (x) { return x.n; }).concat([1]));
      var bars = el("div", "bars");
      bars.setAttribute("role", "img");
      bars.setAttribute("aria-label", "Emails sent per day: " + d.sent_by_day.map(function (x) { return x.day.slice(5) + " " + x.n; }).join(", "));
      d.sent_by_day.forEach(function (x) {
        var col = el("div"), bar = el("i");
        bar.style.height = Math.round(100 * x.n / most) + "%";
        col.appendChild(el("span", "", String(x.n)));
        col.appendChild(bar);
        col.appendChild(el("span", "", x.day.slice(8)));
        bars.appendChild(col);
      });
      p.appendChild(bars);
      var next = fold(p, "Who the next weekday run would write to", String(d.next_up.length));
      if (d.next_up.length) cards(next, d.next_up.map(function (n) {
        return { title: n.company, sub: n.trade + ", " + n.city + (n.approved ? "" : " · waits for wording approval") };
      }));
      else para(next, "Nobody is waiting.");
      if (d.samples.first_email) fold(p, "The first email a business gets", "").appendChild(el("pre", "", d.samples.first_email));
      para(p, "Opens and clicks are not measured. The website keeps no record of visitors, so replies are the signal.", "muted small");
    }

    function lists(p) {
      para(p, "One row per city. Open a city to see each trade. A list is emailed only once its wording is approved.", "muted small");
      var order = [], by = {};
      d.lists.forEach(function (l) {
        if (!by[l.city]) { by[l.city] = []; order.push(l.city); }
        by[l.city].push(l);
      });
      function sum(rows, key) { return rows.reduce(function (n, l) { return n + l[key]; }, 0); }
      order.sort(function (a, b) { return sum(by[b], "may_email") - sum(by[a], "may_email"); });
      order.forEach(function (city) {
        var rows = by[city];
        var inner = fold(p, city, sum(rows, "may_email") + " may email · " + sum(rows, "emailed") + " emailed · " +
          sum(rows, "trial") + " on trial · " + sum(rows, "paid") + " paying");
        cards(inner, rows.map(function (l) {
          return { tag: l.approved ? "" : "wording not approved", title: l.trade,
                   text: l.may_email + " may email · " + l.emailed + " emailed · " + l.waiting + " waiting · " + l.said_no + " said no",
                   sub: l.trial + " on trial · " + l.paid + " paying · " + l.found + " found, " + l.pinned + " with a pin on the map" +
                        (l.places_left === null ? "" : " · " + l.places_left + " places left") };
        }));
      });
      if (!order.length) para(p, "No lists yet.");
    }

    function replies(p) {
      if (!d.inbox) { para(p, "The mailbox has not been read yet."); return; }
      heading(p, "Waiting for you", "Messages a person has to answer. A business that says no is marked by itself and is not listed here.");
      if (waiting) cards(p, d.inbox.waiting.map(function (w) {
        return { tag: w.kind, strong: true, title: w.business || w.from, text: w.said, sub: w.when + " · " + w.from };
      }));
      else para(p, "Nothing is waiting.");
      if (r) {
        heading(p, "Who wrote back", null);
        table(p, ["", "So far"], [
          ["Messages from businesses, in all", r.wrote_back], ["Said no (marked, never emailed again)", r.said_no],
          ["Want to start", r.want_to_start], ["Want to cancel", r.want_to_cancel], ["Wrote something else", r.other],
          ["Of those, answered by you", r.answered], ["Automatic replies (away notes, ticket numbers)", r.auto]
        ], [1]);
      }
      var done = fold(p, "Handled without you, last 14 days", String(d.inbox.handled.length));
      if (d.inbox.handled.length) cards(done, d.inbox.handled.map(function (h) { return { title: h.business, text: h.what, sub: h.when }; }));
      else para(done, "Nothing yet.");
      para(p, (d.inbox.last_read ? "The main mailbox was last read on " + d.inbox.last_read.replace("T", " at ") + "." : "The mailbox has not been read yet.") +
        " Mail from services and from yourself is left out of the counts.", "muted small");
    }

    function customers(p) {
      tiles(p, [
        [t.trials, "on a free trial"], [t.paying, "paying"],
        [t.lists_sent, "Monday lists sent to subscribers"], [t.set_aside, "to keep aside: yearly money not yet earned"]
      ]);
      heading(p, "Subscribers", null);
      if (d.subscribers.length) cards(p, d.subscribers.map(function (s) {
        return { tag: s.status, strong: s.status.toLowerCase() === "paid", title: s.name,
                 text: s.trade + ", " + s.city + (s.plan ? " · " + s.plan : ""),
                 sub: "Started " + s.started + (s.ends ? " · trial ends " + s.ends : "") + " · " + plural(s.lists_sent, "list", "lists") + " sent" };
      }));
      else para(p, "None yet. The first one appears here the day a business says yes.");
      heading(p, "The offer", null);
      para(p, o.price + " a month per city" + (o.yearly ? ", or " + o.yearly + " a year" : "") + ". " + o.weeks + " free weeks, " +
        (o.card ? "started on the payment page with a card, cancel any time. " : "no card, started by email. ") +
        (o.seats ? "At most " + o.seats + " businesses per trade in each city." : "No limit on how many businesses of one trade may subscribe."));
      if (o.links && o.links.length) links(p, "Where customers pay: ", o.links, true);
      links(p, "See it as they do: ", [["The public site", "/"], ["The map preview", "/map/"], ["Pricing", "/#pricing"]].concat(
        d.samples.preview ? [["One business's own map preview" + (d.samples.preview_name ? " (" + d.samples.preview_name + ")" : ""), d.samples.preview]] : []), false);
      if (d.samples.monday_email) fold(p, "The Monday list a subscriber gets", "").appendChild(el("pre", "", d.samples.monday_email));
    }

    function money(p) {
      if (!m) { para(p, "This picture holds no money figures."); return; }
      table(p, ["Each month", "C$"], [
        ["Coming in from subscriptions", cash(m.income)], ["Stripe keeps", cash(-m.stripe)],
        ["Running costs charged today", cash(-m.costs_now_cad)], ["Left over today", cash(m.left_now)],
        ["Running costs if every free trial is kept", cash(-m.costs_cad)], ["Left over then", cash(m.left)]
      ], [1]);
      if (m.customers_to_cover) para(p, plural(m.customers_to_cover, "paying customer covers", "paying customers cover") +
        " the full running costs. You keep " + cash(m.kept_of_one) + " of each " + o.price + " monthly payment after Stripe's share.");
      var lines = fold(p, "What each service costs", "US" + cash(m.costs_usd) + " a month in all");
      cards(lines, m.lines.map(function (line) {
        return { tag: line.state, strong: line.state === "free trial", title: "US" + cash(line.usd) + " a month", text: line.what,
                 sub: "From " + line.seen + (line.decide_by ? " · decide by " + line.decide_by : "") };
      }));
      para(p, "A yearly payment counts as a twelfth each month. The services bill in US dollars, shown here in Canadian dollars at " + m.rate.rate +
        " (" + m.rate.source + ", " + m.rate.day + "). Your own price is charged in Canadian dollars, as your payment page shows. Income is what is recorded here " +
        "when a customer pays. Your Stripe balance is not read.", "muted small");
    }

    function rules(p) {
      if (!d.gate) { para(p, "The rules could not be checked when this picture was taken. Run: py run.py preflight."); return; }
      var failing = d.gate.filter(function (g) { return !g.passed; }), passing = d.gate.filter(function (g) { return g.passed; });
      heading(p, failing.length ? "Not passed" : "Every rule passes", "A first email goes only when no rule reads STOP.");
      if (failing.length) cards(p, failing.map(function (g) {
        return { tag: g.stops ? "STOP" : "care", strong: g.stops, title: g.rule, sub: g.detail };
      }));
      var ok = fold(p, "Rules that pass", String(passing.length));
      cards(ok, passing.map(function (g) { return { tag: "passes", title: g.rule, sub: g.detail }; }));
      para(p, "How warm each sending mailbox is cannot be read here. That is on the warm-up service's own dashboard.", "muted small");
    }

    function cities(p) {
      para(p, "How fresh each city's records are. \"Late\" means its newest record is over 7 days old, so that city is skipped until it catches up.", "muted small");
      var built = new Date(d.built).getTime();
      table(p, ["City", "30 days", "Newest record", "Map"], d.cities.map(function (c) {
        var late = (built - new Date(c.newest).getTime()) / 86400000 > 7;
        return [c.city + (c.province ? ", " + c.province : ""), c.records, c.newest + (late ? " · late" : ""), c.map ? "yes" : "no"];
      }), [1]);
    }

    var tabs = [
      { id: "today", name: "Today", fill: today }, { id: "todo", name: "To do", n: mine, fill: todo },
      { id: "emails", name: "Emails", fill: emails }, { id: "lists", name: "Lists", fill: lists },
      { id: "replies", name: "Replies", n: waiting, fill: replies }, { id: "customers", name: "Customers", fill: customers },
      { id: "money", name: "Money", fill: money }, { id: "rules", name: "Rules", n: held.length, fill: rules },
      { id: "cities", name: "Cities", fill: cities }
    ];
    var bar = el("div", "admin-tabs");
    bar.setAttribute("role", "tablist");
    bar.setAttribute("aria-label", "Parts of the dashboard");
    root.appendChild(bar);
    show = function (id, byHand) {
      tabs.forEach(function (tab) {
        var on = tab.id === id;
        tab.button.setAttribute("aria-selected", on ? "true" : "false");
        tab.button.tabIndex = on ? 0 : -1;
        tab.panel.hidden = !on;
      });
      if (!byHand) return;
      write("sessionStorage", TAB, id);
      // A tab opens at its top: if the page had been scrolled down, bring the tabs back to the top of the screen.
      var top = root.getBoundingClientRect().top;
      if (top < 0) window.scrollBy(0, top);
    };
    tabs.forEach(function (tab, i) {
      tab.button = el("button", "", tab.name);
      tab.button.type = "button";
      tab.button.id = "admin-tab-" + tab.id;
      tab.button.setAttribute("role", "tab");
      tab.button.setAttribute("aria-controls", "admin-panel-" + tab.id);
      if (tab.n) tab.button.appendChild(el("span", "n", String(tab.n)));
      tab.panel = el("div", "admin-panel");
      tab.panel.id = "admin-panel-" + tab.id;
      tab.panel.setAttribute("role", "tabpanel");
      tab.panel.setAttribute("aria-labelledby", tab.button.id);
      tab.fill(tab.panel);
      tab.button.addEventListener("click", function () { show(tab.id, true); });
      tab.button.addEventListener("keydown", function (event) {
        var step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        var other = tabs[(i + step + tabs.length) % tabs.length];
        show(other.id, true);
        other.button.focus();
      });
      bar.appendChild(tab.button);
    });
    tabs.forEach(function (tab) { root.appendChild(tab.panel); });
    var first = read("sessionStorage", TAB);
    show(tabs.some(function (tab) { return tab.id === first; }) ? first : "today", false);
  }

  function signedOut(message) {
    $("admin-root").replaceChildren();
    $("admin-out").hidden = true;
    $("admin-sub").textContent = message;
    $("admin-signin").hidden = false;
  }
  function signedIn(d) {
    $("admin-signin").hidden = true;
    $("admin-out").hidden = false;
    render(d);
  }
  async function start() {
    var form = $("admin-signin"), field = $("admin-pass"), button = form.querySelector("button");
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      if (!field.value) return;
      button.disabled = true;
      $("admin-sub").textContent = "Checking. This takes a moment.";
      try {
        var raw = await keyFromPassword(field.value);
        if (!raw) throw new Error("not the password");
        var d = await openWith(raw);
        keep(linkFromBytes(raw), $("admin-keep").checked);
        field.value = "";
        signedIn(d);
      } catch (problem) {
        $("admin-sub").textContent = "That password did not open the dashboard. Check it and try again.";
      }
      button.disabled = false;
    });
    $("admin-out").addEventListener("click", function () {
      forget();
      if (location.hash) { try { history.replaceState(null, "", location.pathname); } catch (e) { /* the address stays as it is */ } }
      signedOut("Signed out.");
    });
    var fromLink = location.hash.slice(1), saved = fromLink ? "" : kept(), text = fromLink || saved;
    if (!text) { signedOut("Sign in to open the dashboard."); return; }
    try {
      var raw;
      try { raw = bytesFromLink(text); } catch (e) { raw = new Uint8Array(0); }
      signedIn(await openWith(raw));
    } catch (problem) {
      if (saved) forget();
      signedOut(fromLink ? "This admin link is no longer the current one. Sign in with your password instead." : "Sign in to open the dashboard.");
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
