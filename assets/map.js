
(function () {
  "use strict";

  var COLORS = { office: "#2563eb", retail: "#c2410c", food: "#b91c1c", medical: "#0f766e",
                 personal: "#7c3aed", hotel: "#92400e", other: "#52525b" };
  var LABELS = { office: "Offices", retail: "Shops", food: "Restaurants and food", medical: "Medical and dental",
                 personal: "Fitness and personal care", hotel: "Hotels", other: "Type not published" };
  var ONE = { office: "An office", retail: "A shop", food: "A restaurant or food business", medical: "A medical or dental office",
              personal: "A fitness or personal care business", hotel: "A hotel", other: "A business" };
  var ORDER = ["retail", "food", "medical", "personal", "hotel", "office", "other"];

  var liveMap = null, touchMoves = false;
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

  // A link ends in a short code (k7qf-2mxd-9rta, after the business's name and a dot). The code is
  // stretched into the real key here, in the browser, by hashing it 600,000 times. Older links carry
  // the full key instead.
  async function keyFromLink(text) {
    var code = /(?:^|\.)([a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4})$/i.exec(text);
    if (!code) return bytesFromLink(text);
    var enc = new TextEncoder();
    var material = await crypto.subtle.importKey("raw", enc.encode(code[1].toUpperCase()), "PBKDF2", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: enc.encode("earlynotice-map-v1"), iterations: 600000, hash: "SHA-256" }, material, 256));
  }

  // A private map's data is locked. The key is the part of the link after the # sign,
  // which the browser never sends anywhere.
  async function loadPrivate() {
    var key = location.hash.slice(1);
    if (!key) throw new Error("This link is incomplete. Open the full link from your Early Notice email.");
    if (!window.crypto || !crypto.subtle) throw new Error("This browser cannot open a private map. Try a current version of Chrome, Edge, Safari or Firefox.");
    var raw;
    try { raw = await keyFromLink(key); } catch (e) { raw = new Uint8Array(0); }
    if (raw.length !== 32) throw new Error("This link is not valid. Open the full link from your Early Notice email.");
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

  // Outside the prairie cities a direction can come before the street ("West 12th Avenue") or after it
  // ("Queen Street West"), and every city abbreviates its own way. So both sides are put into one
  // standard spelling and compared word for word.
  var DIRS = { N: "N", NORTH: "N", S: "S", SOUTH: "S", E: "E", EAST: "E", W: "W", WEST: "W", NE: "NE", NW: "NW", SE: "SE", SW: "SW",
               NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW" };
  var WORDS = { STREET: "ST", ST: "ST", AVENUE: "AV", AVE: "AV", AV: "AV", ROAD: "RD", RD: "RD", DRIVE: "DR", DR: "DR",
                BOULEVARD: "BLVD", BLVD: "BLVD", BV: "BLVD", CRESCENT: "CRES", CRES: "CRES", CR: "CRES", PLACE: "PL", PL: "PL",
                COURT: "CRT", CRT: "CRT", CT: "CRT", LANE: "LANE", LN: "LANE", TERRACE: "TER", TERR: "TER", TER: "TER",
                HIGHWAY: "HWY", HWY: "HWY", PARKWAY: "PKWY", PKWY: "PKWY", PKY: "PKWY", SQUARE: "SQ", SQ: "SQ",
                CIRCLE: "CIR", CIR: "CIR", CRCL: "CIR", TRAIL: "TRL", TRL: "TRL", TR: "TRL", WAY: "WAY", WY: "WAY",
                GARDENS: "GDNS", GDNS: "GDNS", GATE: "GT", GT: "GT", DIVERSION: "DIVERS", DIVERS: "DIVERS",
                MOUNT: "MT", MT: "MT", SAINT: "ST" };
  var TYPES = Object.keys(WORDS).map(function (k) { return WORDS[k]; });
  function isDir(w) { return /^(N|S|E|W|NE|NW|SE|SW)$/.test(w); }
  // "Suite 400, 1 St. Clair Ave. East" -> { number: 1, words: ["ST", "CLAIR", "AV", "E"], plain: "1 ST CLAIR AVE EAST" }, or null.
  function streetWords(text) {
    var t = String(text || "").toUpperCase().replace(/,/g, " ").replace(/[.']/g, "").replace(/[^A-Z0-9 #-]/g, " ").replace(/\s+/g, " ").trim();
    t = t.replace(/^(?:#\s*\w+|(?:BAY|UNIT|SUITE|STE)\s*#?\s*\w+)\s+/, "").replace(/^-\s*/, "").replace(/^\w{1,5}\s*-\s*(?=\d)/, "");
    var words = t.split(" "), number = /^(\d+)[A-Z]?$/.exec(words[0] || "");
    if (!number || words.length < 2) return null;
    return { number: Number(number[1]), plain: number[1] + " " + words.slice(1).join(" "),
             words: words.slice(1).map(function (w) { return DIRS[w] || WORDS[w] || w; }) };
  }
  function bare(words) { return words.filter(function (w) { return !isDir(w); }).join(" "); }
  // The one street on file that is the typed one. A typed address with no direction ("1055 Georgia Street")
  // fits only when a single street does, so West Georgia is never mistaken for East Georgia.
  function sameStreet(wanted, onFile) {
    var key = wanted.join(" ");
    if (onFile[key]) return onFile[key];
    if (bare(wanted) !== key) return null;
    var loose = Object.keys(onFile).filter(function (k) { return bare(k.split(" ")) === key; });
    return loose.length === 1 ? onFile[loose[0]] : null;
  }
  // The word of a street's name that best narrows a search: the longest one that is not a direction or a type.
  function nameWord(words) {
    var names = words.filter(function (w) { return !isDir(w) && TYPES.indexOf(w) === -1; });
    return (names.length ? names : words).slice().sort(function (x, y) { return y.length - x.length; })[0];
  }

  // Each city writes its address records its own way. All of them answer straight to the visitor's browser.
  var LOOKUPS = {
    vancouver: async function (a, typed) {
      var s = streetWords(typed);
      if (!s) return null;
      var where = "civic_number='" + s.number + "' and std_street like '%" + nameWord(s.words) + "%'";
      var rows = (await (await fetch("https://opendata.vancouver.ca/api/explore/v2.1/catalog/datasets/property-addresses/records" +
        "?select=civic_number,std_street,geo_point_2d&limit=100&where=" + encodeURIComponent(where))).json()).results || [];
      var onFile = {};
      rows.forEach(function (r) {
        var got = streetWords(r.civic_number + " " + r.std_street), p = r.geo_point_2d, key = got && got.words.join(" ");
        if (got && got.number === s.number && p && p.lat && p.lon && !onFile[key]) onFile[key] = { lat: p.lat, lon: p.lon, label: r.civic_number + " " + r.std_street };
      });
      return sameStreet(s.words, onFile);
    },
    // Toronto's own address records cannot be asked from a browser, so Natural Resources Canada's public lookup is asked.
    toronto: async function (a, typed) {
      var s = streetWords(typed);
      if (!s) return null;
      var rows = await (await fetch("https://www.geolocator.api.geo.ca/geolocation/en/locate?q=" + encodeURIComponent(s.plain + ", Toronto, ON"))).json();
      var onFile = {};
      (Array.isArray(rows) ? rows : []).forEach(function (r) {
        var title = String(r.title || ""), c = r.geometry && r.geometry.coordinates;
        if (!/Street$/.test(String(r.type || "")) || r.qualifier !== "INTERPOLATED_POSITION" || !/Toronto/i.test(title) || !c) return;
        var got = streetWords(title.split(",")[0]), key = got && got.words.join(" ");
        if (got && got.number === s.number && !onFile[key]) onFile[key] = { lat: Number(c[1]), lon: Number(c[0]), label: title.split(",")[0] };
      });
      return sameStreet(s.words, onFile);
    },
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
      var source = data.lookup_source || ("the City of " + data.city + "'s address records");
      result.textContent = "Looking that up in " + source + ".";
      try {
        var found = await lookup(address, box.value);
        if (!found) { result.textContent = "That address was not found in " + source + ". Check the number and street, or click the map where your business is."; return; }
        typed = box.value.trim();
        placePin(found.lat, found.lon, "Your business");
      } catch (problem) {
        result.textContent = (problem && /end in NE/.test(problem.message)) ? problem.message :
          "The address records could not be reached just now. Click the map where your business is instead.";
      }
    };
    report();
  }

  function money(n) {
    if (n >= 1e6) return "$" + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
    return "$" + Math.round(n);
  }
  // A bigger job gets a bigger dot.
  function radiusOf(p) {
    var v = p.value || 0;
    return v >= 500000 ? 13.5 : v >= 100000 ? 10.5 : v >= 25000 ? 8 : 6;
  }
  function things(data, n) {
    var words = (data.audience && data.audience.things) || "business fit-outs";
    return n === 1 ? words.replace(/s$/, "") : words;
  }

  function headings(data, points) {
    var shop = data.shop, name = data.name || (shop && shop.name) || "";
    var rings = data.rings_km || [], far = rings[rings.length - 1];
    // The same two numbers their email states: fit-outs of the kinds they sell to, and how many are near.
    var mine = (data.audience && data.audience.focus) || ORDER;
    var own = points.filter(function (p) { return mine.indexOf(p.tag) !== -1; });
    var close = shop && far ? own.filter(function (p) { return p.km <= far; }).length : 0;
    var count = data.focus_total !== undefined ? data.focus_total : own.length;
    var nearest = shop && own.length ? Math.min.apply(null, own.map(function (p) { return p.km; })) : null;
    if (data.mode === "preview") return;    // the public page has its own heading
    var who = data.mode === "personal" ? name : "you";
    setText("map-kicker", data.mode === "personal" ? "Preview" + (name ? " for " + name : "") : (name || "Your map"));
    if (close) {
      setText("map-title", close + " " + things(data, close) + " within " + far + " km of " + (who || "you"));
      setText("map-sub", count + " were approved across " + data.city + " in the last 30 days. Updated " + data.built + ".");
    } else {
      setText("map-title", count + " " + things(data, count) + " in " + data.city + " in the last 30 days");
      setText("map-sub", (nearest !== null ? "The nearest is " + nearest.toFixed(1) + " km from " + (who || "you") + ". " : "") + "Updated " + data.built + ".");
    }
    document.title = (name ? name + ": " : "") + data.city + " fit-outs | Early Notice";
    var offer = $("map-offer");
    if (data.mode === "personal" && offer && data.offer && !offer.children.length) {
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
    var pinNote = $("map-pin-note");
    if (pinNote) pinNote.hidden = !shop;
  }

  function render(data) {
    data.mode = data.mode || "member";
    var shop = data.shop, focus = (data.audience && data.audience.focus) || ORDER;
    var isPreview = data.mode !== "member";
    var rings = data.rings_km || [], near = rings[0], far = rings[rings.length - 1];
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
    var state = { active: active, sort: shop ? "near" : "new" };
    headings(data, points);

    // ---- the map
    var map = null, markers = {};
    if (liveMap) { liveMap.remove(); liveMap = null; }   // drawing again, for a new pin or trade
    if (window.L) {
      // On a phone, one finger scrolls the page, even over the map. A tap on the map hands it the finger.
      var needsTap = L.Browser.mobile && !touchMoves;
      map = liveMap = L.map("map", { scrollWheelZoom: false, dragging: !needsTap });
      var hint = $("map-hint");
      if (hint) hint.hidden = !needsTap;
      map.on("click", function (event) {
        map.scrollWheelZoom.enable();
        if (!map.dragging.enabled()) {
          map.dragging.enable();
          touchMoves = true;
          if (hint) hint.hidden = true;
          return;
        }
        if (data.mode === "preview" && placePin) placePin(event.latlng.lat, event.latlng.lng, "");
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
      }).addTo(map);
      // The map needs a starting view before anything can be drawn on it.
      var first = shop || points[0];
      map.setView(first ? [first.lat, first.lon] : [56, -106], first ? 12 : 4);
      if (shop) {
        L.marker([shop.lat, shop.lon], { icon: L.divIcon({ className: "", html: '<div class="shop-pin"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
          title: shop.name, zIndexOffset: 1000 }).addTo(map)
          .bindTooltip(shop.name, { permanent: true, direction: "top", offset: [0, -12], className: "shop-label" });
        rings.forEach(function (ringKm) {
          var ring = L.circle([shop.lat, shop.lon], { radius: ringKm * 1000, color: "#16181d", weight: 1.5, dashArray: "6 6", fill: false, interactive: false }).addTo(map);
          L.marker([ring.getBounds().getNorth(), shop.lon], { interactive: false, icon: L.divIcon({ className: "ring-label", html: ringKm + " km", iconSize: [44, 14], iconAnchor: [22, 16] }) }).addTo(map);
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
          // One tap to go there, or to see the storefront before going.
          var links = el("p", "go");
          var drive = el("a", "", "Directions");
          drive.href = "https://www.google.com/maps/dir/?api=1&destination=" + p.lat + "," + p.lon + (shop ? "&origin=" + shop.lat + "," + shop.lon : "");
          var look = el("a", "", "Street view");
          look.href = "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=" + p.lat + "," + p.lon;
          [drive, look].forEach(function (a) { a.target = "_blank"; a.rel = "noopener noreferrer"; links.appendChild(a); });
          body.appendChild(links);
          markers[p.index] = L.circleMarker([p.lat, p.lon], { radius: radiusOf(p), color: p.new ? "#16181d" : "#ffffff", weight: p.new ? 3 : 2,
            fillColor: color, fillOpacity: 0.95, bubblingMouseEvents: false });
        } else {
          body.appendChild(el("p", "addr", (ONE[p.tag] || ONE.other) + " being fitted out near here"));
          var facts = [];
          if (p.value) facts.push("Estimated at about " + money(p.value) + ".");
          if (p.new) facts.push("Approved in the last 7 days.");
          if (p.km !== null) facts.push("About " + p.km.toFixed(1) + " km from you.");
          if (facts.length) body.appendChild(el("p", "", facts.join(" ")));
          body.appendChild(el("p", "meta", "Placed roughly, not on the exact spot. Subscribers see the address and who filed it."));
          markers[p.index] = L.circleMarker([p.lat, p.lon], { radius: radiusOf(p), color: color, weight: p.new ? 4 : 2.5,
            fillColor: "#ffffff", fillOpacity: 0.85, bubblingMouseEvents: false });
        }
        markers[p.index].bindPopup(body);
      });
      var legend = $("map-legend");
      if (legend) legend.textContent = "A bigger dot is a bigger job. A heavy outline was approved in the last 7 days." +
        (isPreview ? " A hollow dot is placed roughly: its address is for subscribers." : "");
    } else {
      $("map").hidden = true;
      say("The map itself could not load, so the records are shown as a list.");
    }

    // ---- the side panel
    function shown() {
      return points.filter(function (p) { return state.active.indexOf(p.tag) !== -1; });
    }
    // Frame what matters: the business and the fit-outs nearest to it, never an empty circle.
    function frame(rows) {
      if (!map) return;
      var spots = [];
      if (shop) {
        spots.push([shop.lat, shop.lon]);
        rows.slice().sort(function (a, b) { return a.km - b.km; }).slice(0, 10).forEach(function (p) { spots.push([p.lat, p.lon]); });
        var reach = rows.filter(function (p) { return p.km <= far; }).length >= 3 ? far : null;
        if (reach) { var edge = L.latLng(shop.lat, shop.lon).toBounds(reach * 2000); spots.push(edge.getSouthWest(), edge.getNorthEast()); }
      } else {
        rows.forEach(function (p) { spots.push([p.lat, p.lon]); });
      }
      if (spots.length > 1) map.fitBounds(spots, { padding: [28, 28], maxZoom: 15 });
    }
    function tile(root, big, small) {
      var li = el("li");
      li.appendChild(el("b", "", String(big)));
      li.appendChild(el("span", "", small));
      root.appendChild(li);
    }
    function draw(reframe) {
      var rows = shown();
      var order = {
        near: function (a, b) { return a.km - b.km; },
        "new": function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; },
        big: function (a, b) { return (b.value || 0) - (a.value || 0); }
      }[state.sort];
      var full = rows.filter(function (p) { return p.full; }).sort(order);
      if (map) points.forEach(function (p) {
        var on = state.active.indexOf(p.tag) !== -1;
        if (on && !map.hasLayer(markers[p.index])) markers[p.index].addTo(map);
        if (!on && map.hasLayer(markers[p.index])) map.removeLayer(markers[p.index]);
        if (on && p.full) markers[p.index].bringToFront();
      });
      if (reframe) frame(rows);

      // ---- the numbers that matter, for the types selected
      var stats = $("map-stats");
      if (stats) {
        stats.replaceChildren();
        var worth = function (list) { return list.reduce(function (sum, p) { return sum + (p.value || 0); }, 0); };
        var fresh = rows.filter(function (p) { return p["new"]; }).length;
        if (shop) {
          var inFar = rows.filter(function (p) { return p.km <= far; }), inNear = rows.filter(function (p) { return p.km <= near; });
          if (inFar.length) {
            tile(stats, inFar.length, "within " + far + " km");
            tile(stats, inNear.length, "within " + near + " km");
            if (worth(inFar)) tile(stats, money(worth(inFar)), "of work within " + far + " km"); else tile(stats, fresh, "new this week");
          } else {
            // Nothing close by: say how far the nearest is, and widen the circle.
            var wide = far * 2, inWide = rows.filter(function (p) { return p.km <= wide; });
            var closest = rows.length ? Math.min.apply(null, rows.map(function (p) { return p.km; })) : null;
            tile(stats, closest === null ? "none" : closest.toFixed(1) + " km", "to the nearest");
            tile(stats, inWide.length, "within " + wide + " km");
            if (worth(inWide)) tile(stats, money(worth(inWide)), "of work within " + wide + " km"); else tile(stats, fresh, "new this week");
          }
          tile(stats, rows.length, "across " + data.city);
        } else {
          tile(stats, rows.length, "in " + data.city + ", 30 days");
          tile(stats, fresh, "new this week");
          if (worth(rows)) tile(stats, money(worth(rows)), "of work in all");
          var top = Math.max.apply(null, rows.map(function (p) { return p.value || 0; }).concat([0]));
          if (top) tile(stats, money(top), "the biggest job");
        }
      }

      var summary = $("map-summary");
      summary.replaceChildren();
      summary.appendChild(el("span", "", isPreview ? full.length + " shown in full, of " + rows.length : rows.length + (rows.length === 1 ? " record" : " records")));
      var sorts = el("span", "sorts");
      (shop ? [["near", "Nearest"]] : []).concat([["new", "Newest"], ["big", "Biggest"]]).forEach(function (pair) {
        var pick = el("button", "sort", pair[1]);
        pick.type = "button";
        pick.setAttribute("aria-pressed", String(state.sort === pair[0]));
        pick.onclick = function () { state.sort = pair[0]; draw(false); };
        sorts.appendChild(pick);
      });
      summary.appendChild(sorts);

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
          draw(true);
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
            draw(true);
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
        var meta = el("span", "meta", "Approved " + niceDate(r.date) + (r.km !== null ? " · " + r.km.toFixed(1) + " km" : ""));
        if (r["new"]) meta.appendChild(el("b", "fresh", "new"));
        button.appendChild(meta);
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
          var hollow = points.length - data.records.length;
          notes.push("This preview shows " + data.records.length + " of " + points.length + " records in full." +
            (hollow > 0 ? " The " + hollow + " hollow dots are the rest, each placed within about 400 m of the real spot." : "") +
            " Subscribers see every address, the cost and who filed it.");
        }
        if (unplaced > 0) notes.push(unplaced + " more " + (unplaced === 1 ? "record has" : "records have") +
          " no map position from the city. " + (isPreview ? "Subscribers get those in the weekly list." : "Those are in your weekly list."));
        locked.hidden = !notes.length;
        locked.textContent = notes.join(" ");
      }
    }
    draw(true);
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
