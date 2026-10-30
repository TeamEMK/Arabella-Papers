/*
 * Arabella Papers pricing calculator: ENGINE
 * Pure calculation, no screen code. Can be used on its own by your MIS:
 *
 *   var result = ArabellaPricing.engine.calculate(rates, {
 *     brand: "ARA",                       // or "KPC"
 *     additionalDiscount: 0,              // %
 *     rushFee: 0,                         // %, added after the discounts
 *     items: [
 *       { code: "INVITE", qty: 100, layers: 2, ply: 0, printing: ["PR-FOIL", "PR-DIGITAL"], printingBack: ["PR-DIGITAL"] },
 *       { code: "ENV-VF", qty: 100, printing: [] },
 *       { custom: true, name: "Wax seal", comments: "gold", qty: 100, price: 2, printing: [] }
 *     ]
 *   });
 *   // result.lines, result.total, result.baseDiscountAmount, result.balance, ...
 *   var text = ArabellaPricing.engine.summaryText(result, { store: "Bella", customer: "Priya" });
 *
 * Pricing rules (from the July 2025 price lists):
 *   - Up to 100 pieces: the first column (25/50/75/100) that covers the quantity and has a price
 *     is the TOTAL for the item.
 *   - Above 100, or when no column applies: quantity x per-piece price.
 *   - Layers and ply: 2 layers or 2 ply = twice the price (layers x ply, each at least 1).
 *   - Each chosen printing technique (up to 3 front inks and 2 back inks) is priced the same way and added.
 *   - Total, then minus the base discount (50%), then minus the additional discount,
 *     then plus the rush fee (% of the discounted amount).
 */
(function (global) {
  "use strict";

  var LIMITS = [25, 50, 75, 100];

  function PricingError(message) { this.name = "PricingError"; this.message = message; }
  PricingError.prototype = Object.create(Error.prototype);

  function brandName(rates, brand) {
    for (var i = 0; i < rates.brands.length; i++) if (rates.brands[i][0] === brand) return rates.brands[i][1];
    throw new PricingError("Unknown brand: " + brand);
  }

  // Rate list for a component or printing code and brand: [25, 50, 75, 100, each above 100]
  function rateList(rates, code, brand) {
    var row = (rates.components && rates.components[code]) || (rates.printing && rates.printing[code]) ||
              (rates.addons && rates.addons[code]) || (rates.edges && rates.edges[code]);
    if (!row) return null;
    var list = brand === "KPC" && row[2] ? row[2] : row[1];
    return { name: row[0], list: list };
  }

  // Price of `qty` pieces from a rate list. Returns null when there is no applicable price.
  function priceFromList(list, qty) {
    if (qty <= 100) {
      for (var k = 0; k < 4; k++) {
        if (qty <= LIMITS[k] && list[k] !== null && list[k] !== undefined) return list[k];
      }
    }
    if (list[4] === null || list[4] === undefined) return null;
    return qty * list[4];
  }

  function n(v) { return String(+v.toFixed(10)); }
  function money(v) { return v.toFixed(2); }
  // Banker's rounding to 2 places, as .NET Math.Round did in the old system.
  function round2(x) {
    var s = x * 100, r = Math.round(s);
    if (Math.abs(s % 1) === 0.5 && r % 2) r -= 1;
    return r / 100;
  }

  function calculate(rates, order) {
    var brand = order.brand;
    var bname = brandName(rates, brand);
    var cur = rates.currency || "US$";
    var lines = [], details = [], warnings = [], total = 0;

    (order.items || []).forEach(function (it) {
      var qty = Number(it.qty) || 0;
      if (qty <= 0) return;
      var layers = Number(it.layers) || 0, ply = Number(it.ply) || 0;
      var desc, itemCost;

      if (it.custom) {
        desc = it.name + (it.comments ? " (" + it.comments + ")" : "");
        itemCost = qty * (Number(it.price) || 0);
      } else {
        var r = rateList(rates, it.code, brand);
        if (!r) throw new PricingError("Unknown item code: " + it.code);
        desc = it.label || r.name;
        var base = priceFromList(r.list, qty);
        if (base === null) {
          warnings.push(r.name + ": no " + bname + " rate for a quantity of " + n(qty) + ", so only printing was priced.");
          base = 0;
        }
        var units = (layers || ply) ? Math.max(layers, 1) * Math.max(ply, 1) : 1;
        itemCost = base * units;
      }

      // Front inks (it.printing) and back inks (it.printingBack): each priced from the price list and added.
      var printCost = 0, printNames = [], backNames = [];
      function addPrinting(code, names) {
        if (!code) return;
        var p = rateList(rates, code, brand);
        if (!p) throw new PricingError("Unknown printing code: " + code);
        var pc = priceFromList(p.list, qty);
        if (pc === null) throw new PricingError(p.name + " has no " + bname + " rate for a quantity of " + n(qty) + ".");
        printCost += pc; names.push(p.name);
      }
      (it.printing || []).forEach(function (c) { addPrinting(c, printNames); });
      (it.printingBack || []).forEach(function (c) { addPrinting(c, backNames); });

      var s = "";
      if (layers > 0) s = n(layers) + " Layer ";
      if (ply > 0) s += n(ply) + " Ply ";
      s += desc + " Cost";
      var withParts = [];
      if (printNames.length) withParts.push(printNames.join(" + "));
      if (backNames.length) withParts.push("Back: " + backNames.join(" + "));
      if (withParts.length) s += "(With " + withParts.join("; ") + ")";
      var lineCost = itemCost + printCost;
      lines.push(s.trim() + " = " + cur + " " + n(round2(lineCost / qty)) + " X " + n(qty) + " = " + cur + " " + money(lineCost));
      details.push({ code: it.custom ? "X" : it.code, description: desc, qty: qty, layers: layers, ply: ply,
        printing: printNames, printingBack: backNames, itemCost: itemCost, printingCost: printCost, lineTotal: lineCost, each: round2(lineCost / qty) });
      total += lineCost;
    });

    var basePct = typeof order.baseDiscount === "number" ? order.baseDiscount : (rates.baseDiscount || 0);
    var addPct = Number(order.additionalDiscount) || 0;
    var baseAmt = total * basePct / 100;
    var addAmt = (total - baseAmt) * addPct / 100;
    // Rush fee: a percentage added on the discounted amount.
    var rushPct = Number(order.rushFee) || 0;
    var rushAmt = (total - baseAmt - addAmt) * rushPct / 100;

    return {
      brand: brand, brandName: bname, currency: cur, ratesVersion: rates.version,
      lines: lines, items: details, warnings: warnings,
      total: total, baseDiscountPercent: basePct, baseDiscountAmount: baseAmt,
      additionalDiscountPercent: addPct, additionalDiscountAmount: addAmt,
      rushFeePercent: rushPct, rushFeeAmount: rushAmt,
      balance: total - baseAmt - addAmt + rushAmt
    };
  }

  function summaryText(result, who) {
    who = who || {};
    var cur = result.currency;
    var forWhom = [who.store, who.customer].filter(function (x) { return x; }).join("/");
    var t = "Here is Cost Summary" + (forWhom ? " for " + forWhom : "") + "\n\n";
    result.lines.forEach(function (l, k) { t += (k + 1) + ". " + l + "\n"; });
    t += "\nTotal= " + cur + " " + money(result.total) + "\n";
    if (result.baseDiscountPercent > 0) t += "Less (" + n(result.baseDiscountPercent) + "%)= " + cur + " " + money(result.baseDiscountAmount) + "\n";
    if (result.additionalDiscountPercent > 0) t += "Less (" + n(result.additionalDiscountPercent) + "%)= " + cur + " " + money(result.additionalDiscountAmount) + "\n";
    if (result.rushFeePercent > 0) t += "Add Rush Fee (" + n(result.rushFeePercent) + "%)= " + cur + " " + money(result.rushFeeAmount) + "\n";
    t += "\nBalance= " + cur + " " + money(result.balance);
    return t;
  }

  global.ArabellaPricing = global.ArabellaPricing || {};
  global.ArabellaPricing.engine = { calculate: calculate, summaryText: summaryText, PricingError: PricingError };
})(typeof window !== "undefined" ? window
  // Loaded on the server too, so the totals can be worked out again before
  // they are saved. The arithmetic above is untouched - one copy of the
  // rules, used by both sides, is the whole point.
  : (typeof globalThis !== "undefined" ? globalThis : this));

if (typeof module !== "undefined" && module.exports) {
  module.exports = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this)).ArabellaPricing;
}
