/*
 * Arabella Papers pricing calculator: SCREEN
 * Puts the calculator inside any element of your MIS page:
 *
 *   ArabellaPricing.mount(document.getElementById("pricing"), {
 *     rates: window.ArabellaPricingRates,   // or rates loaded from your MIS
 *     brand: "ARA",                         // optional starting brand
 *     store: "Bella Stationery",            // optional, fills Store name
 *     customer: "Priya",                    // optional, fills Customer name
 *     onQuote: function (quote) { ... }     // optional, called after each Calculate quote
 *     saveLabel: "Save quote to order"      // optional, shows a Save button that calls onSave
 *     onSave: function (quote) { ... }      // optional
 *   });
 *
 * `quote` = { brand, store, customer, result (see pricing-engine.js), summary (text), order (input) }
 * Needs pricing-engine.js and pricing-calculator.css on the page.
 */
(function (global) {
  "use strict";

  var Q = 1, LAY = 2, PLY = 4, INK = 8;
  function flaps(p) { return [[p + "-VF", "V flap"], [p + "-SF", "Square flap"]]; }
  var SLOTS = [
    { i: 0, label: "Invitation", type: "INVITE", f: Q | LAY | PLY | INK },
    { i: 1, label: "Envelope", f: Q | INK, opts: flaps("ENV"), typeLabel: "Flap" },
    { i: 2, label: "Envelope liner", liner: true, opts: [["PL", "Printed liner"], ["PFL", "Paper full liner"], ["PHL", "Paper half liner"]] },
    { i: 3, label: "GNA", type: "GNA", f: Q },
    { i: 4, label: "RSVP card", type: "RSVPC", f: Q | LAY | INK },
    { i: 5, label: "RSVP envelope", f: Q | INK, opts: flaps("RSVP-ENV"), typeLabel: "Flap" },
    { i: 6, label: "Thank you card", f: Q | INK, opts: [["TY-FLATC", "Flat card"], ["TY-FOLDC", "Folded card"]] },
    { i: 7, label: "Thank you envelope", f: Q | INK, opts: flaps("TY-ENV"), typeLabel: "Flap" },
    { i: 8, label: "Folder", f: Q | INK, opts: [["FOL-SFF", "Single fold folder"], ["FOL-POC", "Pocket folder"], ["FOL-RIBPOC", "Ribbon pocket folder"]] },
    { i: 9, label: "Direction card", type: "DIRC", f: Q | LAY | INK },
    { i: 10, label: "Save the date card", type: "STDC", f: Q | LAY | INK },
    { i: 11, label: "Accommodation card", type: "ACMC", f: Q | LAY | INK },
    { i: 12, label: "Belly band", type: "BELLYB", f: Q | INK },
    { i: 13, label: "Tags", type: "TAGS", f: Q | LAY | INK },
    { i: 14, label: "Ribbon", type: "RIBBON", f: Q },
    { i: 15, label: "Rhinestone", type: "RHINEST", f: Q },
    { i: 16, label: "Place card", f: Q | INK, opts: [["PL-FLATC", "Flat card"], ["PL-ENV-FLATC", "Flat card with envelope"], ["PL-TENT", "Tented card"]] },
    { i: 17, label: "Table number card", type: "TNC", f: Q | INK },
    { i: 18, label: "Program card", f: Q | INK, opts: [["PR-FLATC", "Flat card"], ["PR-FOLDC", "Folded card"]] },
    { i: 19, label: "Menu card", type: "MENUC", f: Q | INK }
  ];
  var SECTIONS = [
    ["Invitation and envelope", [0, 1, 2, 3]], ["Reply and thank you", [4, 5, 6, 7]],
    ["Enclosure cards", [10, 9, 11]], ["Folders and finishing", [8, 12, 13, 14, 15]],
    ["Reception stationery", [16, 17, 18, 19]]
  ];
  var INKS = ["ink1", "ink2", "ink3"];

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function moneyGrouped(v) { return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function n(v) { return String(+v.toFixed(10)); }

  function mount(root, opts) {
    opts = opts || {};
    var rates = opts.rates || global.ArabellaPricingRates;
    var engine = global.ArabellaPricing.engine;
    if (!rates || !engine) throw new Error("Load pricing-rates.js and pricing-engine.js before pricing-ui.js");
    var printOpts = Object.keys(rates.printing).map(function (c) { return [c, rates.printing[c][0]]; });
    var lastQuote = null;

    function num(name, label, cls) {
      return '<label class="apc-f ' + (cls || "") + '"><span>' + label + '</span><input type="number" data-n="' + name + '" min="0" step="1" inputmode="numeric"></label>';
    }
    function sel(name, label, list, first, cls) {
      return '<label class="apc-f apc-f-select ' + (cls || "") + '"><span>' + label + '</span><select data-n="' + name + '"><option value="">' + first + "</option>" +
        list.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + "</option>"; }).join("") + "</select></label>";
    }
    function inkFields(prefix, note) {
      return INKS.map(function (k, x) { return sel(prefix + "-" + k, "Ink " + (x + 1) + (note && x === 0 ? " (" + note + ")" : ""), printOpts, "None"); }).join("");
    }

    var brandOpts = rates.brands.map(function (b) {
      return '<option value="' + b[0] + '"' + (b[0] === (opts.brand || rates.brands[0][0]) ? " selected" : "") + ">" + esc(b[1]) + "</option>";
    }).join("");

    root.classList.add("apc");
    root.innerHTML =
      '<form class="apc-calc" novalidate>' +
        '<div class="apc-main">' +
          '<section class="apc-panel"><h2 class="apc-h1">Price a quote</h2>' +
            '<div class="apc-alert apc-alert-error" data-r="errors" role="alert" hidden></div>' +
            '<div class="apc-details">' +
              '<label class="apc-field"><span>Brand</span><select data-n="brand">' + brandOpts + "</select></label>" +
              '<label class="apc-field apc-wide"><span>Store name</span><input type="text" data-n="store" autocomplete="off"></label>' +
              '<label class="apc-field apc-wide"><span>Customer name</span><input type="text" data-n="customer" autocomplete="off"></label>' +
              '<label class="apc-field"><span>Additional discount (%)</span><input type="number" data-n="addDisc" min="0" max="100" step="any" inputmode="decimal"></label>' +
            "</div>" +
            (rates.baseDiscount > 0 ? '<p class="apc-hint">A base discount of ' + n(rates.baseDiscount) + "% is taken off every quote after the total, before any additional discount.</p>" : "") +
          "</section>" +
          SECTIONS.map(function (sec) {
            return '<section class="apc-panel"><h3>' + sec[0] + '</h3><div class="apc-items">' + sec[1].map(function (k) {
              var s = SLOTS[k], p = "c" + k, f = "";
              if (s.liner) {
                f = sel(p + "-t1", "Liner", s.opts, "None") + inkFields(p, "printed liner") + '<p class="apc-note">Priced at the envelope quantity.</p>';
              } else {
                if (s.f & Q) f += num(p + "-q", "Qty", "apc-f-qty");
                if (s.opts) f += sel(p + "-t", s.typeLabel || "Type", s.opts, "Choose…");
                if (s.f & LAY) f += num(p + "-l", "Layers");
                if (s.f & PLY) f += num(p + "-p", "Ply");
                if (s.f & INK) f += inkFields(p);
              }
              return '<div class="apc-item' + (s.liner ? " apc-sub" : "") + '"><div class="apc-name">' + s.label + '</div><div class="apc-fields">' + f + "</div></div>";
            }).join("") + "</div></section>";
          }).join("") +
          '<section class="apc-panel"><h3>Other items</h3><p class="apc-hint">For anything not listed above. Enter the price for each piece.</p>' +
            '<div class="apc-custom-list" data-r="custom"></div>' +
            '<button type="button" class="apc-btn2" data-a="add-custom">Add another item</button></section>' +
        "</div>" +
        '<aside class="apc-side"><div class="apc-quote" aria-live="polite"><h3>Quote</h3>' +
          '<div data-r="result" hidden>' +
            '<p class="apc-hint apc-brandline" data-r="brandline"></p><dl class="apc-totals" data-r="totals"></dl>' +
            '<div class="apc-alert apc-alert-warn" data-r="warnings" hidden></div>' +
            '<label class="apc-summary-label">Summary to send<textarea class="apc-summary" data-r="summary" readonly rows="10"></textarea></label>' +
            '<div class="apc-row"><button type="button" class="apc-btn2" data-a="copy">Copy summary</button>' +
              (opts.onSave ? '<button type="button" class="apc-btn2" data-a="save">' + esc(opts.saveLabel || "Save quote") + "</button>" : "") +
            '</div><p class="apc-hint" data-r="saved" hidden></p>' +
          "</div>" +
          '<p class="apc-muted" data-r="empty">Enter quantities and choose Calculate quote. Switch the brand at any time to see the other price list.</p>' +
          '<button type="submit" class="apc-btn1">Calculate quote</button>' +
          '<button type="button" class="apc-link" data-a="new">Start a new quote</button>' +
        "</div></aside>" +
      "</form>";

    var form = root.querySelector("form");
    function el(name) { return root.querySelector('[data-n="' + name + '"]'); }
    function part(name) { return root.querySelector('[data-r="' + name + '"]'); }
    function val(name) { var e = el(name); return e && e.value !== "" && !e.disabled ? Number(e.value) : 0; }
    function sv(name) { var e = el(name); return e && !e.disabled ? e.value : ""; }
    function inks(prefix) { return INKS.map(function (k) { return sv(prefix + "-" + k); }).filter(Boolean); }

    if (opts.store) el("store").value = opts.store;
    if (opts.customer) el("customer").value = opts.customer;

    // Liner inks only for printed liners
    function syncLiner() {
      var pl = el("c2-t1").value === "PL";
      INKS.forEach(function (k) { var e = el("c2-" + k); e.disabled = !pl; if (!pl) e.value = ""; });
    }
    el("c2-t1").addEventListener("change", syncLiner); syncLiner();

    // Other items
    var customList = part("custom");
    function addCustom() {
      var row = document.createElement("div");
      row.className = "apc-custom-row";
      row.innerHTML =
        '<label class="apc-f apc-f-name"><span>Item</span><input type="text" data-k="name" autocomplete="off"></label>' +
        '<label class="apc-f apc-f-qty"><span>Qty</span><input type="number" data-k="qty" min="0" step="1" inputmode="numeric"></label>' +
        '<label class="apc-f apc-f-comments"><span>Comments</span><input type="text" data-k="comments" autocomplete="off"></label>' +
        '<label class="apc-f"><span>Price each</span><input type="number" data-k="price" min="0" step="any" inputmode="decimal"></label>' +
        INKS.map(function (k, x) {
          return '<label class="apc-f apc-f-select"><span>Ink ' + (x + 1) + '</span><select data-k="' + k + '"><option value="">None</option>' +
            printOpts.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + "</option>"; }).join("") + "</select></label>";
        }).join("") +
        '<button type="button" class="apc-link" data-a="remove">Remove</button>';
      customList.appendChild(row);
      return row;
    }
    addCustom();

    function collect() {
      var errors = [], items = [];
      var envType = el("c1-t").value, envQty = val("c1-q");
      SLOTS.forEach(function (s) {
        var p = "c" + s.i;
        if (s.liner) {
          var t1 = el(p + "-t1").value;
          if (!t1) return;
          if (!envType || envQty <= 0) { errors.push("Liners are priced per envelope. Enter an envelope quantity and flap first."); return; }
          items.push({ code: "LIN-" + envType + "-" + t1, qty: envQty, printing: t1 === "PL" ? inks(p) : [] });
          return;
        }
        var qty = val(p + "-q");
        var code = s.type || (el(p + "-t") ? el(p + "-t").value : "");
        if (qty > 0 && !code) { errors.push(s.label + ": choose a " + (s.typeLabel || "type").toLowerCase() + "."); return; }
        if (qty <= 0) return;
        items.push({ code: code, qty: qty, layers: val(p + "-l"), ply: val(p + "-p"), printing: (s.f & INK) ? inks(p) : [] });
      });
      Array.prototype.forEach.call(customList.children, function (row, k) {
        function g(key) { return row.querySelector('[data-k="' + key + '"]').value.trim(); }
        var name = g("name"), qty = Number(g("qty")) || 0;
        if (!name && !qty && !g("price")) return;
        if (qty > 0 && !name) { errors.push("Other item " + (k + 1) + ": enter a name."); return; }
        if (qty <= 0) return;
        items.push({ custom: true, name: name, comments: g("comments"), qty: qty, price: Number(g("price")) || 0,
          printing: INKS.map(function (x) { return g(x); }).filter(Boolean) });
      });
      var add = val("addDisc");
      if (add < 0 || add > 100) errors.push("Additional discount must be between 0 and 100%.");
      if (Array.prototype.some.call(root.querySelectorAll('input[type="number"]'), function (e) { return Number(e.value) < 0; })) errors.push("Numbers can’t be negative.");
      if (!errors.length && !items.length) errors.push("Enter at least one quantity.");
      return { errors: errors.filter(function (m, i, a) { return a.indexOf(m) === i; }), order: { brand: el("brand").value, additionalDiscount: add, items: items } };
    }

    function showErrors(list) {
      var box = part("errors");
      box.innerHTML = "<ul>" + list.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>";
      box.hidden = false; box.scrollIntoView({ block: "center" });
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var c = collect();
      if (c.errors.length) { showErrors(c.errors); return; }
      var r;
      try { r = engine.calculate(rates, c.order); }
      catch (err) { showErrors([err && err.name === "PricingError" ? err.message : "Something went wrong while pricing this quote."]); return; }
      part("errors").hidden = true;
      var cur = r.currency;
      part("brandline").textContent = r.brandName + " price list";
      part("totals").innerHTML =
        "<div><dt>Total</dt><dd>" + cur + " " + moneyGrouped(r.total) + "</dd></div>" +
        (r.baseDiscountPercent > 0 ? "<div><dt>Less " + n(r.baseDiscountPercent) + "%</dt><dd>− " + cur + " " + moneyGrouped(r.baseDiscountAmount) + "</dd></div>" : "") +
        (r.additionalDiscountPercent > 0 ? "<div><dt>Less " + n(r.additionalDiscountPercent) + "%</dt><dd>− " + cur + " " + moneyGrouped(r.additionalDiscountAmount) + "</dd></div>" : "") +
        '<div class="apc-balance"><dt>Balance</dt><dd>' + cur + " " + moneyGrouped(r.balance) + "</dd></div>";
      var w = part("warnings");
      w.hidden = !r.warnings.length;
      w.innerHTML = r.warnings.length ? "<p>Check these lines:</p><ul>" + r.warnings.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>" : "";
      var who = { store: el("store").value.trim(), customer: el("customer").value.trim() };
      var summary = engine.summaryText(r, who);
      part("summary").value = summary;
      part("result").hidden = false; part("empty").hidden = true; part("saved").hidden = true;
      lastQuote = { brand: r.brand, store: who.store, customer: who.customer, result: r, summary: summary, order: c.order };
      if (typeof opts.onQuote === "function") opts.onQuote(lastQuote);
    });

    el("brand").addEventListener("change", function () {
      if (!part("result").hidden && form.requestSubmit) form.requestSubmit();
    });

    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-a]"); if (!b || !root.contains(b)) return;
      var a = b.getAttribute("data-a");
      if (a === "add-custom") { addCustom().querySelector("input").focus(); }
      else if (a === "remove") {
        var row = b.closest(".apc-custom-row");
        if (customList.children.length === 1) Array.prototype.forEach.call(row.querySelectorAll("input, select"), function (i) { i.value = ""; });
        else row.parentNode.removeChild(row);
      } else if (a === "copy") {
        var ta = part("summary"), label = b.textContent;
        var done = function () { b.textContent = "Copied"; setTimeout(function () { b.textContent = label; }, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).then(done, function () { ta.select(); document.execCommand("copy"); done(); });
        else { ta.select(); document.execCommand("copy"); done(); }
      } else if (a === "save" && lastQuote) {
        var msg = part("saved");
        Promise.resolve(opts.onSave(lastQuote)).then(function (text) {
          msg.textContent = typeof text === "string" ? text : "Quote saved."; msg.hidden = false;
        }, function (err) {
          msg.textContent = "Couldn’t save the quote" + (err && err.message ? ": " + err.message : ".") ; msg.hidden = false;
        });
      } else if (a === "new") {
        var keepBrand = el("brand").value;
        form.reset(); el("brand").value = keepBrand;
        if (opts.store) el("store").value = opts.store;
        if (opts.customer) el("customer").value = opts.customer;
        customList.innerHTML = ""; addCustom(); syncLiner();
        part("result").hidden = true; part("empty").hidden = false; part("errors").hidden = true;
        lastQuote = null;
        root.scrollIntoView({ block: "start" });
      }
    });

    return {
      getQuote: function () { return lastQuote; },
      setCustomer: function (store, customer) { if (store != null) el("store").value = store; if (customer != null) el("customer").value = customer; }
    };
  }

  global.ArabellaPricing = global.ArabellaPricing || {};
  global.ArabellaPricing.mount = mount;
})(window);
