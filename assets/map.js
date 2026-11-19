
(function () {
  "use strict";

  var COLORS = { office: "#2563eb", retail: "#c2410c", food: "#b91c1c", medical: "#0f766e",
                 personal: "#7c3aed", hotel: "#92400e", other: "#52525b" };
  var LABELS = { office: "Offices", retail: "Shops", food: "Restaurants and food", medical: "Medical and dental",
                 personal: "Fitness and personal care", hotel: "Hotels", other: "Type not published" };
  var ONE = { office: "An office", retail: "A shop", food: "A restaurant or food business", medical: "A medical or dental office",
              personal: "A fitness or personal care business", hotel: "A hotel", other: "A business" };
  var ORDER = ["retail", "food", "medical", "personal", "hotel", "office", "other"];

  var liveMap = null;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }
  function setText(id, text) { var node = $(id); if (node) node.textContent = text; }
  function say(message) {
    var box = $("map-status");
    box.hidden = false;
    box.textContent = message;
  }
  function distanceKm(lat1, lon1, lat2, lon2) {
    var rad = Math.PI / 180, p1 = lat1 * rad, p2 = lat2 * rad;
    var a = Math.pow(Math.sin((p2 - p1) / 2), 2) +
            Math.cos(p1) * Math.cos(p2) * Math.pow(Math.sin((lon2 - lon1) * rad / 2), 2);
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }
  function niceDate(day) {
    return new Date(day + "T00:00:00Z").toLocaleDateString("en-CA", { month: "short", day: "numeric", timeZone: "UTC" });
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

  // A private map's data is locked. The key is the part of the link after the # sign,
  // which the browser never sends anywhere.
  async function loadPrivate() {
    var key = location.hash.slice(1);
    if (!key) throw new Error("This link is incomplete. Open the full link from your Early Notice email.");
    var raw;
    try { raw = bytesFromLink(key); } catch (e) { raw = new Uint8Array(0); }
    if (raw.length !== 32) throw new Error("This link is not valid. Open the full link from your Early Notice email.");
    if (!window.crypto || !crypto.subtle) throw new Error("This browser cannot open a private map. Try a current version of Chrome, Edge, Safari or Firefox.");
    var id = hex(await crypto.subtle.digest("SHA-256", raw)).slice(0, 20);
    var response = await fetch("/m/" + id + ".bin", { cache: "no-store" });
    if (!response.ok) throw new Error("This map link is no longer active. Reply to any Early Notice email and we will set it up again.");
    var blob = new Uint8Array(await response.arrayBuffer());
    var cryptoKey = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    var plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, cryptoKey, blob.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  }

  // The public preview carries the sample records that are already public, and rough dots for the rest.
  // A visitor can say what they sell and where they are. That stays in the part of the address after
  // the # sign, which the browser never sends anywhere.
  function readChoice() {
    var hash = new URLSearchParams(location.hash.slice(1)), query = new URLSearchParams(location.search);
    var at = (hash.get("at") || query.get("at") || "").split(",").map(Number);
    var good = at.length === 2 && isFinite(at[0]) && isFinite(at[1]) && Math.abs(at[0]) <= 90 && Math.abs(at[1]) <= 180 && (at[0] || at[1]);
    return { trade: hash.get("for") || query.get("for") || "", at: good ? at : null };
  }
  function loadPreview() {
    var data = JSON.parse($("map-data").textContent);
    var choice = readChoice();
    data.everyone = data.audience;
    if (choice.at) data.shop = { name: "Your business", lat: choice.at[0], lon: choice.at[1] };
    if (data.audiences && data.audiences[choice.trade]) data.audience = data.audiences[choice.trade];
    return data;
  }

  // ---- finding a typed address in the city's own address records
  var QUADS = { NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW" };
  var TYPE_CODES = { ST: "ST", STREET: "ST", AV: "AV", AVE: "AV", AVENUE: "AV", RD: "RD", ROAD: "RD", DR: "DR", DRIVE: "DR",
                     WAY: "WY", WY: "WY", BLVD: "BV", BOULEVARD: "BV", BV: "BV", TRAIL: "TR", TR: "TR" };
  var TYPE_WORDS = Object.keys(TYPE_CODES).concat(["CRES", "CRESCENT", "CR", "PL", "PLACE", "CLOSE", "CL", "CIRCLE", "CI", "COURT", "CT",
    "GREEN", "MANOR", "RISE", "PARK", "TERRACE", "GARDENS", "VIEW", "HEIGHTS", "GROVE", "BAY", "COMMON", "MEWS", "POINT", "LANDING",
    "HILL", "LANE", "LN", "LINK", "SQUARE", "HEATH", "GATE", "COVE", "ROW"]);

  // "#1, 4500 - 5 Street NE" -> { number: 4500, name: "5", kind: "ST", quad: "NE" }, or null.
  function parseAddress(text) {
    var t = String(text || "").toUpperCase().replace(/,/g, " ").replace(/N\.E\./g, "NE").replace(/N\.W\./g, "NW")
      .replace(/S\.E\./g, "SE").replace(/S\.W\./g, "SW").replace(/\./g, "").replace(/[^A-Z0-9 '#-]/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:#\s*\w+|(?:BAY|UNIT|SUITE|STE)\s*#?\s*\w+)\s+/, "");
    var numbered = /^(\d+[A-Z]?)\s*-\s*(\d+[A-Z]{0,2}\s+(?:ST|STREET|AVE?|AVENUE)\b.*)$/.exec(t);
    t = numbered ? numbered[1] + " " + numbered[2] : t.replace(/^\w{1,5}\s*-\s*(?=\d)/, "");
    var words = t.split(" "), number = /^(\d+)[A-Z]?$/.exec(words[0] || "");
    if (!number || words.length < 2) return null;
    var rest = words.slice(1).map(function (w) { return QUADS[w] || w; }), quad = "", kind = "";
    if (/^(NE|NW|SE|SW)$/.test(rest[rest.length - 1])) quad = rest.pop();
    if (rest.length > 1 && TYPE_WORDS.indexOf(rest[rest.length - 1]) !== -1) { var word = rest.pop(); kind = TYPE_CODES[word] || word; }
    var name = rest.join(" ").replace(/^(\d+)(ST|ND|RD|TH)$/, "$1");
    if (!name || TYPE_WORDS.indexOf(name) !== -1) return null;
    return { number: Number(number[1]), name: name, kind: kind, quad: quad };
  }
  function quoted(text) { return "'" + text.replace(/'/g, "''") + "'"; }

  // Each city writes its address records its own way. Both answer straight to the visitor's browser.
  var LOOKUPS = {
    calgary: async function (a) {
      if (!a.quad) throw new Error("Calgary addresses end in NE, NW, SE or SW. Add that and try again.");
      var where = "street_name = " + quoted(a.name) + " AND street_quad = " + quoted(a.quad) +
        " AND house_number between " + (a.number - 150) + " and " + (a.number + 150);
      var rows = await (await fetch("https://data.calgary.ca/resource/9zvu-p8uz.json?$select=address,house_number,street_type,latitude,longitude&$limit=400&$where=" +
        encodeURIComponent(where))).json();
      rows = rows.filter(function (r) { return r.latitude && r.longitude && r.house_number; });
      if (TYPE_CODES[a.kind]) rows = rows.filter(function (r) { return r.street_type === a.kind; });
      else if (rows.some(function (r) { return r.street_type !== rows[0].street_type; })) return null;
      if (!rows.length) return null;
      rows.sort(function (x, y) {
        return Math.abs(x.house_number - a.number) - Math.abs(y.house_number - a.number) || (x.address.charAt(0) === "#") - (y.address.charAt(0) === "#");
      });
      return { lat: Number(rows[0].latitude), lon: Number(rows[0].longitude), label: rows[0].address };
    },
    edmonton: async function (a) {
      var where = "house_number = " + quoted(String(a.number)) + " AND street_name like " + quoted(a.name + " %");
      var rows = await (await fetch("https://data.edmonton.ca/resource/ut27-nrpn.json?$select=house_number,street_name,sub_address,latitude,longitude&$limit=300&$where=" +
        encodeURIComponent(where))).json();
      var fits = [], kinds = {};
      rows.forEach(function (r) {
        var got = r.latitude && r.longitude && parseAddress(r.house_number + " " + r.street_name);
        if (!got || got.number !== a.number || got.name !== a.name) return;
        if ((a.kind && got.kind && got.kind !== a.kind) || (a.quad && got.quad !== a.quad)) return;
        kinds[got.kind + " " + got.quad] = true;
        fits.push(r);
      });
      if (!fits.length || Object.keys(kinds).length > 1) return null;
      fits.sort(function (x, y) { return Boolean(x.sub_address) - Boolean(y.sub_address); });
      return { lat: Number(fits[0].latitude), lon: Number(fits[0].longitude), label: fits[0].house_number + " " + fits[0].street_name };
    }
  };

  // ---- the "what do you sell, where are you" form on the public preview
  var placePin = null;
  function setUpForm(data) {
    var form = $("map-form"), trade = $("map-trade"), box = $("map-address"), result = $("map-form-result");
    if (!form) return;
    var typed = "";
    function chosen() { return (data.audiences && data.audiences[trade.value]) || data.everyone; }
    function remember() {
      var parts = [];
      if (trade.value) parts.push("for=" + encodeURIComponent(trade.value));
      if (data.shop) parts.push("at=" + data.shop.lat.toFixed(4) + "," + data.shop.lon.toFixed(4));
      history.replaceState(null, "", location.pathname + (parts.length ? "#" + parts.join("&") : ""));
    }
    function report() {
      var far = (data.rings_km || [])[(data.rings_km || []).length - 1], audience = chosen(), mine = audience !== data.everyone;
      var cta = document.querySelector(".map-cta a");
      if (cta && data.offer) cta.href = "mailto:" + data.offer.email + "?subject=" +
        encodeURIComponent("Start my " + data.offer.weeks + " free weeks (" + data.city + ")") + "&body=" +
        encodeURIComponent("City I want: " + data.city + "\nMy business:\n" + (mine ? "What I sell: " + audience.label + "\n" : "") +
          (typed ? "My address: " + typed + "\n" : ""));
      if (!data.shop || !far) { result.hidden = true; return; }
      var near = data.records.concat(data.hidden || []).filter(function (p) {
        return audience.focus.indexOf(p.tag) !== -1 && distanceKm(data.shop.lat, data.shop.lon, p.lat, p.lon) <= far;
      }).length;
      result.hidden = false;
      result.textContent = "About " + near + (mine ? " fit-outs of the kinds " + audience.label + " sell to were" : " business fit-outs were") +
        " approved within " + far + " km of you in the last 30 days. Subscribers see every address, nearest first.";
    }
    placePin = function (lat, lon, label) {
      data.shop = { name: label || "Your business", lat: lat, lon: lon };
      data.audience = chosen();
      remember();
      render(data);
      report();
    };
    if (data.audiences && data.audiences[readChoice().trade]) trade.value = readChoice().trade;
    trade.onchange = function () {
      data.audience = chosen();
      remember();
      render(data);
      report();
    };
    form.onsubmit = async function (event) {
      event.preventDefault();
      var lookup = LOOKUPS[data.lookup], address = parseAddress(box.value);
      result.hidden = false;
      if (!lookup) { result.textContent = "Click the map where your business is."; return; }
      if (!address) { result.textContent = "That does not look like a street address. Try a house number and street, such as the example, or click the map where your business is."; return; }
      result.textContent = "Looking that up in the City of " + data.city + "'s address records.";
      try {
        var found = await lookup(address);
        if (!found) { result.textContent = "The City of " + data.city + " has no address like that. Check the number and street, or click the map where your business is."; return; }
        typed = box.value.trim();
        placePin(found.lat, found.lon, "Your business");
      } catch (problem) {
        result.textContent = (problem && /end in NE/.test(problem.message)) ? problem.message :
          "The address records could not be reached just now. Click the map where your business is instead.";
      }
    };
    report();
  }

  function headings(data, points) {
    var shop = data.shop, name = data.name || (shop && shop.name) || "";
    if (data.mode === "member") {
      setText("map-title", "Business fit-outs in " + data.city + (data.audience ? " for " + data.audience.label : ""));
      setText("map-sub", points.length + " records from the last 30 days, updated " + data.built + "." +
        (shop ? " Sorted by distance from " + shop.name + "." : ""));
      document.title = data.city + " fit-outs | Early Notice";
    } else if (data.mode === "personal") {
      setText("map-kicker", "Preview" + (name ? " for " + name : ""));
      setText("map-title", shop ? "Business fit-outs around " + name : "Business fit-outs in " + data.city);
      var rings = data.rings_km || [], far = rings[rings.length - 1];
      var close = shop && far ? points.filter(function (p) { return p.km <= far; }).length : 0;
      setText("map-sub", data.total + " business fit-outs were approved in " + data.city + " in the last 30 days" +
        (close ? ", " + close + " of them within " + far + " km of you" : "") + ". " +
        "This preview shows " + data.records.length + " in full. The rest are rings placed near the real spot.");
      document.title = (name ? name + ": " : "") + data.city + " fit-outs preview | Early Notice";
      var offer = $("map-offer");
      if (offer && data.offer) {
        offer.hidden = false;
        offer.appendChild(el("h2", "", "Want every address on this map?"));
        offer.appendChild(el("p", "", "Reply to the email we sent you, or use this button. You get the full map, updated every weekday, and the list every Monday, free for " +
          data.offer.weeks + " weeks, with nothing to sign up for. This same link becomes your full map." +
          (data.offer.price ? " After that it is " + data.offer.price + " a month, and that price stays for as long as you do." : "") +
          (data.offer.seats && data.audience ? " We take at most " + data.offer.seats + " " + data.audience.label + " in " + data.city + "." : "")));
        var go = el("a", "btn", "Start my " + data.offer.weeks + " free weeks");
        go.href = "mailto:" + data.offer.email + "?subject=" + encodeURIComponent("Start my " + data.offer.weeks + " free weeks" + (name ? ": " + name : "")) +
          "&body=" + encodeURIComponent("Please start my " + data.offer.weeks + " free weeks of the " + data.city + " list and map." + (name ? "\n\n" + name : ""));
        offer.appendChild(go);
      }
    }
    var pinNote = $("map-pin-note");
    if (pinNote) pinNote.hidden = !(shop && data.mode !== "preview");
  }

  function render(data) {
    data.mode = data.mode || "member";
    var shop = data.shop, focus = (data.audience && data.audience.focus) || ORDER;
    var isPreview = data.mode !== "member";
    var points = [];
    (data.hidden || []).forEach(function (h) { h.full = false; points.push(h); });
    data.records.forEach(function (r) { r.full = true; points.push(r); });
    points.forEach(function (p, index) {
      p.index = index;
      p.km = shop ? distanceKm(shop.lat, shop.lon, p.lat, p.lon) : null;
    });
    var present = ORDER.filter(function (tag) { return points.some(function (p) { return p.tag === tag; }); });
    var active = present.filter(function (tag) { return focus.indexOf(tag) !== -1; });
    if (!active.length) active = present.slice();
    var state = { active: active };
    headings(data, points);

    // ---- the map
    var map = null, markers = {};
    if (liveMap) { liveMap.remove(); liveMap = null; }   // drawing again, for a new pin or trade
    if (window.L) {
      map = liveMap = L.map("map", { scrollWheelZoom: false });
      map.on("click", function (event) {
        map.scrollWheelZoom.enable();
        if (data.mode === "preview" && placePin) placePin(event.latlng.lat, event.latlng.lng, "");
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      // The map needs a starting view before anything can be drawn on it.
      var first = shop || points[0];
      map.setView(first ? [first.lat, first.lon] : [56, -106], first ? 12 : 4);
      var bounds = [];
      if (shop) {
        L.marker([shop.lat, shop.lon], { icon: L.divIcon({ className: "", html: '<div class="shop-pin"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
          title: shop.name, zIndexOffset: 1000 }).addTo(map).bindPopup(el("p", "addr", shop.name));
        (data.rings_km || []).forEach(function (ringKm) {
          var ring = L.circle([shop.lat, shop.lon], { radius: ringKm * 1000, color: "#16181d", weight: 1.5, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
          var edge = ring.getBounds();
          L.marker([edge.getNorth(), shop.lon], { interactive: false, icon: L.divIcon({ className: "ring-label", html: ringKm + " km", iconSize: [44, 14], iconAnchor: [22, 16] }) }).addTo(map);
          bounds.push(edge.getSouthWest(), edge.getNorthEast());
        });
      }
      points.forEach(function (p) {
        var color = COLORS[p.tag] || COLORS.other, body = el("div");
        if (p.full) {
          body.appendChild(el("p", "addr", p.address));
          body.appendChild(el("p", "", p.what + (p.cost ? " · est. " + p.cost : "")));
          if (p.note) body.appendChild(el("p", "meta", p.note));
          body.appendChild(el("p", "meta", "Approved " + niceDate(p.date) + (p.area ? " · " + p.area : "") +
            (p.km !== null ? " · " + p.km.toFixed(1) + " km away" : "")));
          markers[p.index] = L.circleMarker([p.lat, p.lon], { radius: 8, color: "#ffffff", weight: 2, fillColor: color, fillOpacity: 0.95, bubblingMouseEvents: false });
        } else {
          body.appendChild(el("p", "addr", (ONE[p.tag] || ONE.other) + " being fitted out near here"));
          body.appendChild(el("p", "meta", "Placed roughly, not on the exact spot. Subscribers see the address, the cost and who filed it."));
          markers[p.index] = L.circleMarker([p.lat, p.lon], { radius: 6, color: color, weight: 2.5, fillColor: "#ffffff", fillOpacity: 0.85, bubblingMouseEvents: false });
        }
        markers[p.index].bindPopup(body);
        if (!shop) bounds.push([p.lat, p.lon]);
      });
      if (bounds.length) map.fitBounds(bounds, { padding: [24, 24] });
    } else {
      $("map").hidden = true;
      say("The map itself could not load, so the records are shown as a list.");
    }

    // ---- the side panel
    function shown() {
      return points.filter(function (p) { return state.active.indexOf(p.tag) !== -1; });
    }
    function draw() {
      var rows = shown();
      var full = rows.filter(function (p) { return p.full; })
        .sort(function (a, b) { return shop ? a.km - b.km : (a.date < b.date ? 1 : -1); });
      if (map) points.forEach(function (p) {
        var on = state.active.indexOf(p.tag) !== -1;
        if (on && !map.hasLayer(markers[p.index])) markers[p.index].addTo(map);
        if (!on && map.hasLayer(markers[p.index])) map.removeLayer(markers[p.index]);
        if (on && p.full) markers[p.index].bringToFront();
      });

      var summary = $("map-summary");
      summary.replaceChildren();
      var line = el("span");
      line.appendChild(el("b", "", String(rows.length)));
      line.appendChild(document.createTextNode(rows.length === 1 ? " fit-out" : " fit-outs"));
      summary.appendChild(line);
      if (shop) (data.rings_km || []).forEach(function (ringKm) {
        var n = rows.filter(function (p) { return p.km <= ringKm; }).length;
        summary.appendChild(el("span", "", " · " + n + " within " + ringKm + " km"));
      });

      var filters = $("map-filters");
      filters.replaceChildren();
      present.forEach(function (tag) {
        var n = points.filter(function (p) { return p.tag === tag; }).length;
        var chip = el("button", "chip");
        chip.type = "button";
        chip.setAttribute("aria-pressed", String(state.active.indexOf(tag) !== -1));
        var dot = el("span", "dot");
        dot.style.background = COLORS[tag];
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(LABELS[tag] + " " + n));
        chip.onclick = function () {
          var at = state.active.indexOf(tag);
          if (at === -1) state.active.push(tag); else state.active.splice(at, 1);
          draw();
        };
        filters.appendChild(chip);
      });
      var mine = present.filter(function (tag) { return focus.indexOf(tag) !== -1; });
      if (present.length > 1) {
        var showingAll = state.active.length === present.length;
        if (!showingAll || (mine.length && mine.length < present.length)) {
          var all = el("button", "chip", showingAll ? "Show my types only" : "Show all types");
          all.type = "button";
          all.onclick = function () {
            state.active = showingAll ? mine.slice() : present.slice();
            draw();
          };
          filters.appendChild(all);
        }
      }

      var list = $("map-list");
      list.replaceChildren();
      full.forEach(function (r) {
        var item = el("li"), button = el("button");
        button.type = "button";
        var dot = el("span", "dot");
        dot.style.background = COLORS[r.tag] || COLORS.other;
        button.appendChild(dot);
        button.appendChild(el("span", "addr", r.address));
        button.appendChild(el("span", "what", r.what + (r.cost ? " · est. " + r.cost : "")));
        button.appendChild(el("span", "meta", "Approved " + niceDate(r.date) + (r.km !== null ? " · " + r.km.toFixed(1) + " km" : "")));
        button.onclick = function () {
          if (!map) return;
          map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15));
          markers[r.index].openPopup();
          $("map").scrollIntoView({ block: "nearest" });
        };
        item.appendChild(button);
        list.appendChild(item);
      });
      if (!full.length) list.appendChild(el("li", "meta", isPreview && rows.length ?
        "None of the records shown in full are of these types." : "No records of the types selected."));

      var locked = $("map-locked");
      if (locked) {
        var unplaced = (data.total || 0) - points.length;
        var notes = [];
        if (isPreview) {
          var rings = points.length - data.records.length;
          notes.push("This preview shows " + data.records.length + " of " + points.length + " records in full." +
            (rings > 0 ? " The " + rings + " rings are the rest, each placed within about 400 m of the real spot." : "") +
            " Subscribers see every address, the cost and who filed it.");
        }
        if (unplaced > 0) notes.push(unplaced + " more " + (unplaced === 1 ? "record has" : "records have") +
          " no map position from the city. " + (isPreview ? "Subscribers get those in the weekly list." : "Those are in your weekly list."));
        locked.hidden = !notes.length;
        locked.textContent = notes.join(" ");
      }
    }
    draw();
  }

  async function start() {
    var holder = $("map");
    if (!holder) return;
    try {
      if (holder.getAttribute("data-mode") === "member") render(await loadPrivate());
      else { var preview = loadPreview(); render(preview); setUpForm(preview); }
    } catch (problem) {
      holder.hidden = true;
      var side = document.querySelector(".map-side");
      if (side) side.hidden = true;
      setText("map-sub", "");
      say(problem && problem.message ? problem.message : "This map could not be opened.");
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
