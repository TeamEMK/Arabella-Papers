/*
 * Arabella Papers pricing calculator: SCREEN
 * Puts the calculator inside any element of your MIS page:
 *
 *   ArabellaPricing.mount(document.getElementById("pricing"), {
 *     rates: window.ArabellaPricingRates,   // or rates loaded from your MIS
 *     brand: "ARA",                         // optional starting brand
 *     title: "Arabella Papers price calculator", // optional heading
 *     mode: "customer",                     // optional: customer copy (no store, discount, rush fee or other items)
 *     wordmark: "ARABELLA PAPERS",          // optional, customer mode: name shown at the top
 *     store: "Bella Stationery",            // optional, fills Store name
 *     customer: "Priya",                    // optional, fills Customer name
 *     onQuote: function (quote) { ... },    // optional, called after each Calculate quote
 *     saveLabel: "Save quote to order",     // optional, shows a Save button that calls onSave
 *     onSave: function (quote) { ... }      // optional
 *   });
 *
 * `quote` = { brand, store, customer, result (see pricing-engine.js), summary (text), order (input) }
 * Needs pricing-engine.js and pricing-calculator.css on the page.
 */
(function (global) {
  "use strict";

  var Q = 1, LAY = 2, PLY = 4, INK = 8, GNA = 16;
  function flaps(p) { return [[p + "-VF", "V flap"], [p + "-SF", "Square flap"]]; }

  // Every line on the calculator. `i` is the field id; the order here is the order of lines in the summary.
  var SLOTS = [
    { i: 0,  label: "Invitation", type: "INVITE", f: Q | LAY | PLY | INK },
    { i: 1,  label: "Envelope", f: Q | INK | GNA, opts: flaps("ENV"), typeLabel: "Flap", gnaLabel: "GNA" },
    { i: 2,  label: "Envelope liner", liner: true, opts: [["PL", "Printed liner"], ["PFL", "Paper full liner"], ["PHL", "Paper half liner"]] },
    { i: 4,  label: "RSVP card", type: "RSVPC", f: Q | LAY | PLY | INK },
    { i: 5,  label: "RSVP envelope", f: Q | INK, opts: flaps("RSVP-ENV"), typeLabel: "Flap" },
    { i: 6,  label: "Thank you card", f: Q | LAY | PLY | INK, opts: [["TY-FLATC", "Flat card"], ["TY-FOLDC", "Folded card"]] },
    { i: 7,  label: "Thank you envelope", f: Q | INK | GNA, opts: flaps("TY-ENV"), typeLabel: "Flap", gnaLabel: "GNA (Thank you envelope)" },
    { i: 22, label: "Escort envelope", f: Q | INK | GNA, opts: flaps("ESC-ENV"), typeLabel: "Flap", gnaLabel: "GNA (Escort envelope)" },
    { i: 10, label: "Save the date card", type: "STDC", f: Q | LAY | PLY | INK },
    { i: 9,  label: "Direction card", type: "DIRC", f: Q | LAY | PLY | INK },
    { i: 20, label: "Details card", type: "DETC", f: Q | LAY | PLY | INK },
    { i: 21, label: "Reception card", type: "RECC", f: Q | LAY | PLY | INK },
    { i: 11, label: "Accommodation card", type: "ACMC", f: Q | LAY | PLY | INK },
    { i: 8,  label: "Folder", f: Q | INK, opts: [["FOL-SFF", "Single fold folder"], ["FOL-POC", "Pocket folder"], ["FOL-RIBPOC", "Ribbon pocket folder"]] },
    { i: 13, label: "Tags", type: "TAGS", f: Q | LAY | PLY | INK },
    { i: 12, label: "Belly band", type: "BELLYB", f: Q | LAY | INK | GNA, gnaLabel: "GNA (Belly band)" },
    { i: 16, label: "Place card", f: Q | LAY | PLY | INK | GNA, gnaLabel: "GNA (Place card)", opts: [["PL-FLATC", "Flat card"], ["PL-ENV-FLATC", "Flat card with envelope"], ["PL-TENT", "Tented card"]] },
    { i: 17, label: "Table number card", type: "TNC", f: Q | LAY | PLY | INK | GNA, gnaLabel: "GNA (Table number card)" },
    { i: 18, label: "Program card", f: Q | LAY | PLY | INK, opts: [["PR-FLATC", "Flat card"], ["PR-FOLDC", "Folded card"]] },
    { i: 19, label: "Menu card", type: "MENUC", f: Q | LAY | PLY | INK | GNA, gnaLabel: "GNA (Menu card)" }
  ];
  var SLOT_BY_I = {};
  SLOTS.forEach(function (s) { SLOT_BY_I[s.i] = s; });

  // Screen layout: [title, slot ids]. "ADDONS" is the add-ons and edges list.
  var LEFT = [
    ["Invitation and cards", [0, 4, 6, 10]],
    ["Enclosure cards", [9, 20, 21, 11]],
    ["Folder, tags and belly band", [8, 13, 12]]
  ];
  var RIGHT = [
    ["Envelopes", [1, 2, 5, 7]],
    ["Escort envelope", [22]],
    ["Reception stationery", [16, 17, 18, 19]],
    ["Add-ons and edges", "ADDONS"]
  ];

  var INKS = ["ink1", "ink2", "ink3"];          // front ink colours
  var BACK = ["back1", "back2"];                 // back ink colours
  var ALL_INKS = INKS.concat(BACK);
  function inkLabel(k) { var i = INKS.indexOf(k); return i >= 0 ? "Ink " + (i + 1) : "Back ink " + (BACK.indexOf(k) + 1); }

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function moneyGrouped(v) { return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function n(v) { return String(+v.toFixed(10)); }

  function mount(root, opts) {
    opts = opts || {};
    var rates = opts.rates || global.ArabellaPricingRates;
    var engine = global.ArabellaPricing.engine;
    if (!rates || !engine) throw new Error("Load pricing-rates.js and pricing-engine.js before pricing-ui.js");
    // Ink colour choices: every printing technique on the price list.
    var printOpts = Object.keys(rates.printing).map(function (c) { return [c, rates.printing[c][0]]; });
    var lastQuote = null;

    function optionsHtml(list, first) {
      return '<option value="">' + first + "</option>" + list.map(function (o) { return '<option value="' + esc(o[0]) + '">' + esc(o[1]) + "</option>"; }).join("");
    }
    function num(name, label, cls, attr) {
      return '<label class="apc-f ' + (cls || "") + '"><span>' + label + '</span><input type="number" ' + (attr || 'data-n="' + name + '"') + ' min="0" step="1" inputmode="numeric"></label>';
    }
    function sel(name, label, list, first, cls, attr) {
      return '<label class="apc-f apc-f-select ' + (cls || "") + '"><span>' + label + '</span><select ' + (attr || 'data-n="' + name + '"') + ">" + optionsHtml(list, first) + "</select></label>";
    }
    // Ink boxes sit in the same row as Qty (they wrap onto the next line only when space runs out).
    function inkFields(prefix) {
      return ALL_INKS.map(function (k) {
        return sel(prefix + "-" + k, inkLabel(k), printOpts, "None", "apc-f-ink" + (BACK.indexOf(k) >= 0 ? " apc-f-back" : ""));
      }).join("");
    }
    function rowInkFields() {
      return ALL_INKS.map(function (k) {
        return sel(null, inkLabel(k), printOpts, "None", "apc-f-ink" + (BACK.indexOf(k) >= 0 ? " apc-f-back" : ""), 'data-k="' + k + '"');
      }).join("");
    }

    function slotHtml(s) {
      var p = "c" + s.i, f = "";
      if (s.liner) {
        f = '<div class="apc-fields">' + sel(p + "-t1", "Liner", s.opts, "None") + inkFields(p) + '</div><p class="apc-note">Priced at the envelope quantity.</p>';
      } else {
        f = '<div class="apc-fields">';
        if (s.f & Q) f += num(p + "-q", "Qty", "apc-f-qty");
        if (s.opts) f += sel(p + "-t", s.typeLabel || "Type", s.opts, "Choose…");
        if (s.f & LAY) f += num(p + "-l", "Layers", "apc-f-small");
        if (s.f & PLY) f += num(p + "-p", "Ply", "apc-f-small");
        if (s.f & GNA) f += num(p + "-gna", "GNA qty", "apc-f-qty");
        if (s.f & INK) f += inkFields(p);
        f += "</div>";
      }
      return '<div class="apc-item' + (s.liner ? " apc-sub" : "") + '"><div class="apc-name">' + s.label + "</div>" + f + "</div>";
    }
    function panelHtml(sec) {
      if (sec[1] === "ADDONS") {
        return '<section class="apc-panel"><h3>' + sec[0] + '</h3><p class="apc-hint apc-hint-top">Every add-on item and edge from the price list.</p>' +
          '<div class="apc-custom-list" data-r="addons"></div>' +
          '<button type="button" class="apc-btn2" data-a="add-addon">Add another add-on or edge</button></section>';
      }
      return '<section class="apc-panel"><h3>' + sec[0] + '</h3><div class="apc-items">' +
        sec[1].map(function (k) { return slotHtml(SLOT_BY_I[k]); }).join("") + "</div></section>";
    }

    var brandOpts = rates.brands.map(function (b) {
      return '<option value="' + b[0] + '"' + (b[0] === (opts.brand || rates.brands[0][0]) ? " selected" : "") + ">" + esc(b[1]) + "</option>";
    }).join("");

    var isCustomer = opts.mode === "customer";
    var isPremium = isCustomer || opts.premium === true;   // premium look (masthead, serif headings, itemised summary)
    root.classList.add("apc");
    root.innerHTML =
      '<form class="apc-form" novalidate>' +
        (isPremium
          ? '<header class="apc-mast"><p class="apc-wordmark">' + esc(opts.wordmark || "") + '</p>' +
              '<h2 class="apc-h1">' + esc(opts.title || (isCustomer ? "Price estimate" : "Pricing calculator")) + "</h2>" +
              '<p class="apc-lede">' + esc(opts.lede || (isCustomer ? "Choose the pieces for your stationery suite and see an estimate straight away."
                                                                      : "Price a quote from the ARB or KPC price list.")) + "</p></header>"
          : "") +
        '<section class="apc-panel apc-head">' +
          '<div class="apc-head-row">' + (isPremium ? '<h3 class="apc-head-title">' + (isCustomer ? "Your details" : "Quote details") + "</h3>" : '<h2 class="apc-h1">' + esc(opts.title || "Price a quote") + "</h2>") +
            '<button type="button" class="apc-btn2" data-a="new">' + (isCustomer ? "Start a new estimate" : "Start a new quote") + "</button></div>" +
          '<div class="apc-alert apc-alert-error" data-r="errors" role="alert" hidden></div>' +
          '<div class="apc-details">' +
            // With only one brand in the rates (a customer copy), the Brand box is hidden.
            '<label class="apc-field"' + (rates.brands.length < 2 ? " hidden" : "") + '><span>Brand</span><select data-n="brand">' + brandOpts + "</select></label>" +
            (isCustomer ? "" : '<label class="apc-field apc-wide"><span>Store name</span><input type="text" data-n="store" autocomplete="off"></label>') +
            '<label class="apc-field apc-wide"><span>' + (isCustomer ? "Your name" : "Customer name") + '</span><input type="text" data-n="customer" autocomplete="off"></label>' +
            (isCustomer ? "" :
            '<label class="apc-field"><span>Additional discount (%)</span><input type="number" data-n="addDisc" min="0" max="100" step="any" inputmode="decimal"></label>' +
            '<label class="apc-field"><span>Additional rush fee (%)</span><input type="number" data-n="rush" min="0" max="100" step="any" inputmode="decimal"></label>') +
          "</div>" +
          (rates.baseDiscount > 0 && !isCustomer ? '<p class="apc-hint">A base discount of ' + n(rates.baseDiscount) + "% is taken off every quote after the total, then any additional discount. A rush fee is added on the discounted amount.</p>" : "") +
        "</section>" +
        '<div class="apc-cols">' +
          '<div class="apc-col">' + LEFT.map(panelHtml).join("") + "</div>" +
          '<div class="apc-col">' + RIGHT.map(panelHtml).join("") + "</div>" +
        "</div>" +
        (isCustomer ? '<div data-r="custom" hidden></div>' :
        '<section class="apc-panel"><h3>Other items</h3><p class="apc-hint apc-hint-top">For anything not listed above.</p>' +
          '<div class="apc-custom-list" data-r="custom"></div>' +
          '<button type="button" class="apc-btn2" data-a="add-custom">Add another item</button></section>') +
        '<section class="apc-panel apc-quote" aria-live="polite">' +
          '<button type="submit" class="apc-btn1">' + (isCustomer ? "Calculate estimate" : "Calculate quote") + "</button>" +
          '<div data-r="result" hidden>' +
            (isPremium ? '<div class="apc-estimate"><h3 class="apc-estimate-title">Cost summary</h3><p class="apc-estimate-for" data-r="for"></p>' +
              '<ol class="apc-sumlines" data-r="lines"></ol></div>' : "") +
            '<div class="apc-quote-grid">' +
              '<dl class="apc-totals" data-r="totals"></dl>' +
              '<div><label class="apc-summary-label"' + (isPremium ? " hidden" : "") + '>Summary to send<textarea class="apc-summary" data-r="summary" readonly rows="12"></textarea></label>' +
                '<div class="apc-row"><button type="button" class="apc-btn2" data-a="copy">Copy summary</button>' +
                  (isPremium ? '<button type="button" class="apc-btn2" data-a="print">Print or save as PDF</button>' : "") +
                  (opts.onSave ? '<button type="button" class="apc-btn2" data-a="save">' + esc(opts.saveLabel || "Save quote") + "</button>" : "") +
                '</div><p class="apc-hint" data-r="saved" hidden></p></div>' +
            "</div>" +
            '<div class="apc-alert apc-alert-warn" data-r="warnings" hidden></div>' +
          "</div>" +
        "</section>" +
      "</form>";

    var form = root.querySelector("form");
    if (isPremium) root.classList.add("apc-premium");
    // Customer copies are shown entirely in capital letters (CSS for page text; option lists and the summary text here).
    function caps(scope) {
      if (!isCustomer) return;
      Array.prototype.forEach.call(scope.querySelectorAll("option"), function (o) { o.textContent = o.textContent.toUpperCase(); });
      Array.prototype.forEach.call(scope.querySelectorAll("optgroup"), function (g) { g.label = g.label.toUpperCase(); });
    }
    if (isCustomer) { root.classList.add("apc-caps"); caps(root); }
    function el(name) { return root.querySelector('[data-n="' + name + '"]'); }
    function part(name) { return root.querySelector('[data-r="' + name + '"]'); }
    function val(name) { var e = el(name); return e && e.value !== "" && !e.disabled ? Number(e.value) : 0; }
    function sv(name) { var e = el(name); return e && !e.disabled ? e.value : ""; }
    function inks(prefix, list) { return list.map(function (k) { return sv(prefix + "-" + k); }).filter(Boolean); }

    if (opts.store && el("store")) el("store").value = opts.store;
    if (opts.customer) el("customer").value = opts.customer;

    // Liner inks: available for all three liner types, once a liner is chosen.
    function syncLiner() {
      var chosen = el("c2-t1").value !== "";
      ALL_INKS.forEach(function (k) { var e = el("c2-" + k); e.disabled = !chosen; if (!chosen) e.value = ""; });
    }
    el("c2-t1").addEventListener("change", syncLiner); syncLiner();

    // Add-ons and edges rows
    var addonList = part("addons");
    var addonGroups = [["Add-on items", rates.addons || {}], ["Edges", rates.edges || {}]];
    function addAddon() {
      var row = document.createElement("div");
      row.className = "apc-custom-row";
      row.innerHTML =
        '<div class="apc-fields">' +
          '<label class="apc-f apc-f-select apc-f-addon"><span>Add-on or edge</span><select data-k="code"><option value="">Choose…</option>' +
            addonGroups.map(function (g) {
              return '<optgroup label="' + esc(g[0]) + '">' + Object.keys(g[1]).map(function (c) {
                return '<option value="' + esc(c) + '">' + esc(g[1][c][0]) + "</option>"; }).join("") + "</optgroup>";
            }).join("") + "</select></label>" +
          num(null, "Qty", "apc-f-qty", 'data-k="qty"') +
          num(null, "Layers", "apc-f-small", 'data-k="layers"') +
          num(null, "Ply", "apc-f-small", 'data-k="ply"') +
          rowInkFields() +
          '<button type="button" class="apc-link" data-a="remove">Remove</button>' +
        "</div>";
      addonList.appendChild(row);
      caps(row);
      return row;
    }
    addAddon();

    // Other items rows: Item, Qty, Ink colour, Price each
    var customList = part("custom");
    function addCustom() {
      var row = document.createElement("div");
      row.className = "apc-custom-row";
      row.innerHTML =
        '<div class="apc-fields">' +
          '<label class="apc-f apc-f-name"><span>Item</span><input type="text" data-k="name" autocomplete="off"></label>' +
          num(null, "Qty", "apc-f-qty", 'data-k="qty"') +
          sel(null, "Ink colour", printOpts, "None", "", 'data-k="ink"') +
          '<label class="apc-f"><span>Price each</span><input type="number" data-k="price" min="0" step="any" inputmode="decimal"></label>' +
          '<button type="button" class="apc-link" data-a="remove">Remove</button>' +
        "</div>";
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
          items.push({ code: "LIN-" + envType + "-" + t1, qty: envQty, printing: inks(p, INKS), printingBack: inks(p, BACK) });
          return;
        }
        var qty = val(p + "-q");
        var code = s.type || (el(p + "-t") ? el(p + "-t").value : "");
        if (qty > 0 && !code) { errors.push(s.label + ": choose a " + (s.typeLabel || "type").toLowerCase() + "."); }
        else if (qty > 0) {
          items.push({ code: code, qty: qty, layers: val(p + "-l"), ply: val(p + "-p"),
            printing: (s.f & INK) ? inks(p, INKS) : [],
            printingBack: (s.f & INK) ? inks(p, BACK) : [] });
        }
        if (s.f & GNA) {
          var g = val(p + "-gna");
          if (g > 0) items.push({ code: "GNA", label: s.gnaLabel, qty: g });
        }
      });
      Array.prototype.forEach.call(addonList.children, function (row, k) {
        function g(key) { return row.querySelector('[data-k="' + key + '"]').value.trim(); }
        var code = g("code"), qty = Number(g("qty")) || 0;
        if (!code && !qty) return;
        if (!code) { errors.push("Add-on " + (k + 1) + ": choose an add-on or edge."); return; }
        if (qty <= 0) { errors.push("Add-on " + (k + 1) + ": enter a quantity."); return; }
        items.push({ code: code, qty: qty, layers: Number(g("layers")) || 0, ply: Number(g("ply")) || 0,
          printing: INKS.map(function (x) { return g(x); }).filter(Boolean),
          printingBack: BACK.map(function (x) { return g(x); }).filter(Boolean) });
      });
      Array.prototype.forEach.call(customList.children, function (row, k) {
        function g(key) { return row.querySelector('[data-k="' + key + '"]').value.trim(); }
        var name = g("name"), qty = Number(g("qty")) || 0;
        if (!name && !qty && !g("price")) return;
        if (qty > 0 && !name) { errors.push("Other item " + (k + 1) + ": enter a name."); return; }
        if (qty <= 0) return;
        items.push({ custom: true, name: name, qty: qty, price: Number(g("price")) || 0, printing: g("ink") ? [g("ink")] : [] });
      });
      var add = val("addDisc");
      if (add < 0 || add > 100) errors.push("Additional discount must be between 0 and 100%.");
      var rush = val("rush");
      if (rush < 0 || rush > 100) errors.push("Rush fee must be between 0 and 100%.");
      if (Array.prototype.some.call(root.querySelectorAll('input[type="number"]'), function (e) { return Number(e.value) < 0; })) errors.push("Numbers can’t be negative.");
      if (!errors.length && !items.length) errors.push("Enter at least one quantity.");
      return { errors: errors.filter(function (m, i, a) { return a.indexOf(m) === i; }), order: { brand: el("brand").value, additionalDiscount: add, rushFee: rush, items: items } };
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
      part("totals").innerHTML =
        "<div><dt>Total</dt><dd>" + cur + " " + moneyGrouped(r.total) + "</dd></div>" +
        (r.baseDiscountPercent > 0 ? "<div><dt>Less " + n(r.baseDiscountPercent) + "%</dt><dd>− " + cur + " " + moneyGrouped(r.baseDiscountAmount) + "</dd></div>" : "") +
        (r.additionalDiscountPercent > 0 ? "<div><dt>Less " + n(r.additionalDiscountPercent) + "%</dt><dd>− " + cur + " " + moneyGrouped(r.additionalDiscountAmount) + "</dd></div>" : "") +
        (r.rushFeePercent > 0 ? "<div><dt>Rush fee " + n(r.rushFeePercent) + "%</dt><dd>+ " + cur + " " + moneyGrouped(r.rushFeeAmount) + "</dd></div>" : "") +
        '<div class="apc-balance"><dt>Balance</dt><dd>' + cur + " " + moneyGrouped(r.balance) + "</dd></div>";
      var noAdjustments = !r.baseDiscountPercent && !r.additionalDiscountPercent && !r.rushFeePercent;
      if (isCustomer && noAdjustments) {
        // Retail-only customer copy: just the total.
        part("totals").innerHTML = '<div class="apc-balance"><dt>Total</dt><dd>' + cur + " " + moneyGrouped(r.total) + "</dd></div>";
      }
      var w = part("warnings");
      w.hidden = !r.warnings.length;
      w.innerHTML = r.warnings.length ? "<p>Check these lines:</p><ul>" + r.warnings.map(function (m) { return "<li>" + esc(m) + "</li>"; }).join("") + "</ul>" : "";
      var who = { store: el("store") ? el("store").value.trim() : "", customer: el("customer").value.trim() };
      if (isPremium) {
        // Same cost summary lines as the staff calculator: item, layers/ply, printing, price each x qty = amount.
        var forWhom = [who.store, who.customer].filter(Boolean).join(" / ");
        part("for").textContent = forWhom ? "Prepared for " + forWhom : "";
        part("lines").innerHTML = r.lines.map(function (line) {
          if (isCustomer) line = line.toUpperCase();
          var cut = line.lastIndexOf(" = ");
          var left = cut > 0 ? line.slice(0, cut) : line, right = cut > 0 ? line.slice(cut + 3) : "";
          return "<li><span class=\"apc-sum-item\">" + esc(left) + "</span><span class=\"apc-sum-amt\">" + (right ? "= " + esc(right) : "") + "</span></li>";
        }).join("");
      }
      var summary = engine.summaryText(r, who);
      if (isCustomer && noAdjustments) summary = summary.replace(/\n\nBalance= .*$/, "");
      if (isCustomer) summary = summary.toUpperCase();
      part("summary").value = summary;
      part("result").hidden = false; part("saved").hidden = true;
      lastQuote = { brand: r.brand, store: who.store, customer: who.customer, result: r, summary: summary, order: c.order };
      if (typeof opts.onQuote === "function") opts.onQuote(lastQuote);
    });

    // Switching the brand re-prices the quote straight away.
    el("brand").addEventListener("change", function () {
      if (!part("result").hidden && form.requestSubmit) form.requestSubmit();
    });

    root.addEventListener("click", function (e) {
      var b = e.target.closest("[data-a]"); if (!b || !root.contains(b)) return;
      var a = b.getAttribute("data-a");
      if (a === "add-custom") { addCustom().querySelector("input").focus(); }
      else if (a === "add-addon") { addAddon().querySelector("select").focus(); }
      else if (a === "remove") {
        var row = b.closest(".apc-custom-row");
        if (row.parentNode.children.length === 1) Array.prototype.forEach.call(row.querySelectorAll("input, select"), function (i) { i.value = ""; });
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
          msg.textContent = "Couldn’t save the quote" + (err && err.message ? ": " + err.message : "."); msg.hidden = false;
        });
      } else if (a === "print") {
        window.print();
      } else if (a === "new") {
        var keepBrand = el("brand").value;
        form.reset(); el("brand").value = keepBrand;
        if (opts.store && el("store")) el("store").value = opts.store;
        if (opts.customer) el("customer").value = opts.customer;
        customList.innerHTML = ""; addCustom(); addonList.innerHTML = ""; addAddon(); syncLiner();
        part("result").hidden = true; part("errors").hidden = true;
        lastQuote = null;
        root.scrollIntoView({ block: "start" });
      }
    });

    return {
      getQuote: function () { return lastQuote; },
      setCustomer: function (store, customer) { if (store != null && el("store")) el("store").value = store; if (customer != null) el("customer").value = customer; }
    };
  }

  global.ArabellaPricing = global.ArabellaPricing || {};
  global.ArabellaPricing.mount = mount;
})(window);
