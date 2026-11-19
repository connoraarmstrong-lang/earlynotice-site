
(function () {
  "use strict";
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
  function hex(buffer) {
    return Array.prototype.map.call(new Uint8Array(buffer), function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
  }
  // The dashboard's data is locked. The key is the part of the link after the # sign, which never leaves the browser.
  async function load() {
    var raw;
    try { raw = bytesFromLink(location.hash.slice(1)); } catch (e) { raw = new Uint8Array(0); }
    if (raw.length !== 32) throw new Error("This page opens only from the admin link.");
    var id = hex(await crypto.subtle.digest("SHA-256", raw)).slice(0, 20);
    var response = await fetch("/admin/" + id + ".bin", { cache: "no-store" });
    if (!response.ok) throw new Error("This admin link is no longer the current one.");
    var blob = new Uint8Array(await response.arrayBuffer());
    var key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12))));
  }
  function section(root, title, note) {
    root.appendChild(el("h2", "", title));
    if (note) root.appendChild(el("p", "muted", note));
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
  var LEVELS = { held: "held", look: "your call", note: "to know" };
  function notes(root, items) {
    var list = el("ul", "admin-notes");
    items.forEach(function (item) {
      var li = el("li");
      li.appendChild(el("span", "tag" + (item.level === "held" ? " ok" : ""), LEVELS[item.level] || item.level));
      li.appendChild(document.createTextNode(item.text));
      list.appendChild(li);
    });
    root.appendChild(list);
  }
  function table(root, headers, rows, numeric, narrow) {
    var wrap = el("div", "scroll"), t = el("table", narrow ? "narrow" : ""), head = el("tr");
    headers.forEach(function (h, i) { head.appendChild(el("th", numeric.indexOf(i) !== -1 ? "num" : "", h)); });
    t.appendChild(head);
    rows.forEach(function (row) {
      var tr = el("tr");
      row.forEach(function (cell, i) {
        var td = el("td", numeric.indexOf(i) !== -1 ? "num" : "");
        if (cell && cell.tag) td.appendChild(el("span", "tag" + (cell.ok ? " ok" : ""), cell.tag)); else td.textContent = String(cell);
        tr.appendChild(td);
      });
      t.appendChild(tr);
    });
    wrap.appendChild(t);
    root.appendChild(wrap);
  }
  function render(d) {
    var root = $("admin-root"), t = d.totals, o = d.offer;
    root.replaceChildren();
    var hours = d.built_at ? Math.floor((Date.now() - new Date(d.built_at).getTime()) / 3600000) : 0;
    $("admin-sub").textContent = "A picture taken " + (d.built_at ? d.built_at.replace("T", " at ") : d.built) +
      " from the files on your computer. It is not live: it refreshes each time the site is built and published." +
      (hours >= 36 ? " This one is " + Math.floor(hours / 24) + " days old." : "");

    if (d.gate) {
      var held = d.gate.filter(function (g) { return g.stops && !g.passed; });
      root.appendChild(el("p", "admin-status", held.length ?
        "First emails are HELD by " + held.length + (held.length === 1 ? " rule" : " rules") + ". None can go until each one passes. The reasons are just below." :
        "First emails are clear to go on the next weekday run."));
    }

    var m = d.money, r = d.replies;
    tiles(root, [
      [t.emailed, "businesses emailed so far"], [t.emailed_week, "emailed in the last 7 days"],
      [r ? r.wrote_back : "-", "wrote back"], [t.said_no, "said no or unsubscribed"],
      [t.bounced, "could not be delivered"], [t.trials, "on a free trial"],
      [t.paying, "paying"], [t.monthly_revenue, "a month from subscriptions"],
      [m ? cash(m.left_now) : "-", "a month left after today's costs"],
      [t.set_aside, "to keep aside: yearly money not yet earned"], [t.lists_sent, "Monday lists sent to subscribers"],
      [t.may_email, "businesses we may email"], [t.waiting, "still waiting their turn"],
      [t.lists, "lists (trade and city)"], [t.cities, "cities with records"], [t.records, "fit-outs in the last 30 days"]
    ]);

    if (d.attention) {
      section(root, "Needs your attention", "Checked when this page was built. \"Held\" stops first emails. \"Your call\" is a decision or a check that is yours. \"To know\" needs nothing from you.");
      if (d.attention.length) notes(root, d.attention);
      else root.appendChild(el("p", "", "Nothing needs you."));
    }

    if (d.inbox) {
      section(root, "Waiting for you", "Messages a person has to answer. A business that says no is marked by itself and is not listed here.");
      if (d.inbox.waiting.length) table(root, ["When", "From", "Business", "What", "They wrote"], d.inbox.waiting.map(function (w) {
        return [w.when, w.from, w.business, w.kind, w.said];
      }), []);
      else root.appendChild(el("p", "", "Nothing is waiting."));
      section(root, "Handled without you, last 14 days", d.inbox.last_read ?
        "The mailbox was last read on " + d.inbox.last_read.replace("T", " at ") + "." : "The mailbox has not been read yet.");
      if (d.inbox.handled.length) table(root, ["When", "Business", "What was done"], d.inbox.handled.map(function (h) {
        return [h.when, h.business, h.what];
      }), []);
      else root.appendChild(el("p", "", "Nothing yet."));
    }

    if (r) {
      section(root, "Who wrote back", "Counted from your main mailbox, since it was first read by the program. Mail from services and from yourself is left out.");
      table(root, ["", "So far"], [
        ["Messages from businesses, in all", r.wrote_back], ["Said no (marked, never emailed again)", r.said_no],
        ["Want to start", r.want_to_start], ["Want to cancel", r.want_to_cancel], ["Wrote something else", r.other],
        ["Of those, answered by you", r.answered], ["Automatic replies (away notes, ticket numbers)", r.auto]
      ], [1], true);
    }

    if (m) {
      section(root, "Money, each month", "The services bill in US dollars. They are shown in Canadian dollars at " + m.rate.rate +
        " (" + m.rate.source + ", " + m.rate.day + "), which assumes your own prices are charged in Canadian dollars. " +
        "Income is what is recorded here when a customer pays, not a reading of your Stripe account.");
      table(root, ["", "A month"], [
        ["Coming in from subscriptions (a yearly payment counts as a twelfth each month)", cash(m.income)],
        ["Stripe keeps", cash(-m.stripe)],
        ["Running costs charged today (US" + cash(m.costs_now_usd) + ")", cash(-m.costs_now_cad)],
        ["Left over today", cash(m.left_now)],
        ["Running costs if every free trial is kept on (US" + cash(m.costs_usd) + ")", cash(-m.costs_cad)],
        ["Left over then", cash(m.left)]
      ], [1], true);
      if (m.customers_to_cover) root.appendChild(el("p", "", m.customers_to_cover + " paying " +
        (m.customers_to_cover === 1 ? "customer covers" : "customers cover") + " the full running costs. You keep " +
        cash(m.kept_of_one) + " of each " + o.price + " monthly payment after Stripe's share."));
      table(root, ["What it is", "US$ a month", "State", "Where the figure comes from"], m.lines.map(function (line) {
        return [line.what, line.usd.toFixed(2), line.state + (line.decide_by ? ", decide by " + line.decide_by : ""), line.seen];
      }), [1]);
    }

    section(root, "The offer", null);
    root.appendChild(el("p", "", o.price + " a month per city" + (o.yearly ? ", or " + o.yearly + " a year" : "") + ". " + o.weeks +
      " free weeks, no card. " + (o.seats ? "At most " + o.seats + " businesses per trade in each city. " : "No limit on how many businesses of one trade may subscribe. ") +
      "Sending limit: " + o.daily_cap +
      " first emails a day per city, " + o.overall_cap + " a day in all, weekdays only, one email per business ever."));
    if (o.links && o.links.length) {
      var pay = el("p", "", "Where customers pay: ");
      o.links.forEach(function (pair, i) {
        if (i) pay.appendChild(document.createTextNode("  ·  "));
        var a = el("a", "", pair[0]);
        a.href = pair[1];
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        pay.appendChild(a);
      });
      root.appendChild(pay);
    }

    section(root, "Lists", "One row per trade and city. A list is only emailed once its wording is approved.");
    table(root, ["City", "Trade", "Wording", "Found", "May email", "With a pin", "Emailed", "Waiting", "Said no", "Trial", "Paying", "Places left"],
      d.lists.map(function (l) {
        return [l.city, l.trade, { tag: l.approved ? "approved" : "not approved", ok: l.approved }, l.found, l.may_email, l.pinned,
                l.emailed, l.waiting, l.said_no, l.trial, l.paid, l.places_left === null ? "no limit" : l.places_left];
      }), [3, 4, 5, 6, 7, 8, 9, 10, 11]);

    section(root, "Next to be emailed", "Who the next weekday run would write to, the trades taking turns in each city.");
    if (d.next_up.length) table(root, ["City", "Trade", "Business", "Ready"], d.next_up.map(function (n) {
      return [n.city, n.trade, n.company, { tag: n.approved ? "ready" : "waits for wording approval", ok: n.approved }];
    }), []);
    else root.appendChild(el("p", "", "Nobody is waiting."));

    section(root, "First emails sent, last " + d.sent_by_day.length + " days", null);
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
    root.appendChild(bars);

    section(root, "Subscribers", null);
    if (d.subscribers.length) table(root, ["Business", "Trade", "City", "Status", "Plan", "Started", "Trial ends", "Lists sent"],
      d.subscribers.map(function (s) { return [s.name, s.trade, s.city, s.status, s.plan || "", s.started, s.ends || "", s.lists_sent]; }), [7]);
    else root.appendChild(el("p", "", "None yet. The first one appears here the day a business says yes."));

    section(root, "City data", "How fresh each city's records are. Maps exist where the city publishes each permit's position.");
    table(root, ["City", "Fit-outs, last 30 days", "Newest record", "Map"], d.cities.map(function (c) {
      return [c.city + (c.province ? ", " + c.province : ""), c.records, c.newest, c.map ? "yes" : "no"];
    }), [1]);

    section(root, "See it as they do", null);
    var links = el("p");
    [["The public site", "/"], ["The map preview", "/map/"], ["Pricing", "/#pricing"]].concat(
      d.samples.preview ? [["One business's own map preview" + (d.samples.preview_name ? " (" + d.samples.preview_name + ")" : ""), d.samples.preview]] : []
    ).forEach(function (pair, i) {
      if (i) links.appendChild(document.createTextNode("  ·  "));
      var a = el("a", "", pair[0]);
      a.href = pair[1];
      links.appendChild(a);
    });
    root.appendChild(links);
    [["The first email a business gets", d.samples.first_email], ["The Monday list a subscriber gets", d.samples.monday_email]].forEach(function (pair) {
      if (!pair[1]) return;
      var box = el("details");
      box.appendChild(el("summary", "", pair[0]));
      box.appendChild(el("pre", "", pair[1]));
      root.appendChild(box);
    });

    if (d.gate) {
      section(root, "The rules a first email must pass", "Every rule, checked when this page was built. One that reads STOP holds every first email until it passes.");
      table(root, ["Rule", "Result", "What was found"], d.gate.map(function (g) {
        return [g.rule, { tag: g.passed ? "passes" : (g.stops ? "STOP" : "care"), ok: !g.passed && g.stops }, g.detail];
      }), []);
    }

    if (d.open_items) {
      section(root, "Open items", "Everything in the review log that is not closed. \"Must act\" holds first emails. \"Watch\" needs nothing unless it changes.");
      if (d.open_items.length) table(root, ["#", "Kind", "What", "Where it stands"], d.open_items.map(function (i) {
        return [i.n, i.kind, i.what, i.state];
      }), []);
      else root.appendChild(el("p", "", "Nothing is open."));
    }

    section(root, "What is not measured", null);
    root.appendChild(el("p", "", "Opens and clicks. The website keeps no record of visitors, so there is no way to see who opened an email or a map link. " +
      "Replies are the signal: a business that says yes or no is marked by hand and shows in the table above."));
    root.appendChild(el("p", "", "How warm each sending mailbox is. That is on the warm-up service's own dashboard, which the program cannot read. " +
      "Your Stripe balance is not read either: a payment shows here once it is recorded on this computer."));
  }
  async function start() {
    try { render(await load()); }
    catch (problem) { $("admin-sub").textContent = problem && problem.message ? problem.message : "This page could not be opened."; }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
