
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
  function table(root, headers, rows, numeric) {
    var wrap = el("div", "scroll"), t = el("table"), head = el("tr");
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
    $("admin-sub").textContent = "Built " + d.built + " from the files on your computer. It refreshes each time the site is built.";

    tiles(root, [
      [t.may_email, "businesses we may email"], [t.emailed, "emailed so far"], [t.emailed_week, "emailed in the last 7 days"],
      [t.waiting, "still waiting their turn"], [t.said_no, "said no thanks"], [t.trials, "on a free trial"],
      [t.paying, "paying"], [t.monthly_revenue, "a month from subscriptions"],
      [t.set_aside, "to keep aside: yearly money not yet earned"], [t.lists, "lists (trade and city)"],
      [t.cities, "cities with fresh data"], [t.records, "fit-outs in the last 30 days"]
    ]);

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

    section(root, "What is not measured", null);
    root.appendChild(el("p", "", "Opens and clicks. The website keeps no record of visitors, so there is no way to see who opened an email or a map link. " +
      "Replies are the signal: a business that says yes or no is marked by hand and shows in the table above."));
  }
  async function start() {
    try { render(await load()); }
    catch (problem) { $("admin-sub").textContent = problem && problem.message ? problem.message : "This page could not be opened."; }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
