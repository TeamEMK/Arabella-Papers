/*
 * Arabella Papers pricing calculator: RATES
 * From the July 2025 master price lists (ARB = Arabella, KPC).
 *
 * Each rate list is: [up to 25, up to 50, up to 75, up to 100, per piece above 100]
 *   - The first four are the TOTAL price for that many pieces.
 *   - null = no price in that column; the next column up is used
 *     (e.g. a price only in the 100 column is the charge for anything up to 100).
 *   - Above 100 (or when no column applies): quantity x the last number.
 *
 * When prices change, edit the numbers here, or let your MIS supply the rates from its
 * database (see "rates" in README.md).
 */
// `window` in the browser, `globalThis` under Node - the rates are read on
// both sides so a quote can be checked where it is stored.
var ArabellaPricingRates = (typeof window !== "undefined" ? window : globalThis).ArabellaPricingRates = {
  version: "2025-07",
  currency: "US$",
  baseDiscount: 50,                 // % taken off the total on every quote
  brands: [["ARA", "ARABELLA (ARB)"], ["KPC", "KPC"]],
  components: {
    // code:        [name, ARB rates, KPC rates (omit when same as ARB)]
    "INVITE":         ["Invitation", [90,100,110,120,1.2], [80,85,90,100,1]],
    "ENV-VF":         ["Envelope (V flap)", [200,210,220,250,2.5]],
    "ENV-SF":         ["Envelope (square flap)", [150,160,170,190,1.9]],
    "LIN-ENV-VF-PL":  ["Printed liner (V flap)", [200,210,220,250,2.5]],
    "LIN-ENV-SF-PL":  ["Printed liner (square flap)", [150,160,170,190,1.9]],
    "LIN-ENV-VF-PFL": ["Paper full liner (V flap)", [200,210,220,250,2.5]],
    "LIN-ENV-SF-PFL": ["Paper full liner (square flap)", [150,160,170,190,1.9]],
    "LIN-ENV-VF-PHL": ["Paper half liner (V flap)", [90,95,105,120,1.2]],
    "LIN-ENV-SF-PHL": ["Paper half liner (square flap)", [65,75,85,90,0.9]],
    "GNA":            ["GNA", [null,null,null,null,1.5]],
    "RSVPC":          ["RSVP card", [35,40,45,50,0.5]],
    "RSVP-ENV-VF":    ["RSVP envelope (V flap)", [70,80,90,100,1]],
    "RSVP-ENV-SF":    ["RSVP envelope (square flap)", [60,65,70,80,0.8]],
    "TY-FLATC":       ["Thank you card (flat)", [35,40,45,50,0.5]],
    "TY-FOLDC":       ["Thank you card (folded)", [50,55,60,65,0.65]],
    "TY-ENV-VF":      ["Thank you envelope (V flap)", [70,80,90,100,1]],
    "TY-ENV-SF":      ["Thank you envelope (square flap)", [60,65,70,80,0.8]],
    "FOL-SFF":        ["Single fold folder", [200,210,230,250,2.5], [150,165,180,200,2]],
    "FOL-POC":        ["Pocket folder", [240,260,280,300,3], [200,210,230,250,2.5]],
    "FOL-RIBPOC":     ["Ribbon pocket folder", [290,310,330,350,3.5], [210,225,250,270,2.7]],
    "DIRC":           ["Direction card", [45,50,55,65,0.65]],
    "STDC":           ["Save the date card", [45,50,55,65,0.65]],
    "ACMC":           ["Accommodation card", [45,50,55,65,0.65]],
    "BELLYB":         ["Belly band", [35,40,45,50,0.5]],
    "TAGS":           ["Tags", [null,null,null,35,0.35]],
    "RIBBON":         ["Ribbon", [null,null,null,45,0.45]],
    "RHINEST":        ["Rhinestone", [null,null,null,null,0.4]],
    "PL-FLATC":       ["Place card (flat)", [35,40,45,50,0.5]],
    "PL-ENV-FLATC":   ["Place card with envelope", [null,null,null,null,null]],   // not on the price lists: fill in
    "PL-TENT":        ["Place card (tented)", [50,55,60,65,0.65]],
    "TNC":            ["Table number card", [45,50,55,65,0.65]],
    "PR-FLATC":       ["Program card (flat)", [90,100,110,120,1.2], [80,85,90,100,1]],
    "PR-FOLDC":       ["Program card (folded)", [200,210,230,250,2.5], [150,165,180,200,2]],
    "MENUC":          ["Menu card", [90,100,110,120,1.2], [80,85,90,100,1]]
  },
  // Printing techniques (price list page 1), offered in the Ink 1 / Ink 2 / Ink 3 boxes.
  printing: {
    "PR-BELL":             ["Bell Press Printing", [null,null,null,60,0.6], [null,null,null,50,0.5]],
    "PR-LP":               ["Letterpress Printing (Invite and Envelope)", [null,null,null,200,2]],
    "PR-LP-ADDON":         ["Letterpress Printing (Add-ons)", [null,null,null,100,1]],
    "PR-UV":               ["UV Printing", [null,null,null,125,1.25], [null,null,null,100,1]],
    "PR-UV-ACR":           ["UV Printing on Acrylic / Mirror Acrylic / PVC / Suede", [null,null,null,250,2.5], [null,null,null,200,2]],
    "PR-FOIL":             ["Foil Printing", [null,null,null,125,1.25], [null,null,null,100,1]],
    "PR-FOIL-ACR":         ["Foil Printing on Acrylic / Mirror Acrylic / PVC", [null,null,null,300,3]],
    "PR-DIGITAL":          ["Digital Printing", [25,50,75,100,1]],
    "PR-DIGITAL-ACR":      ["Digital Printing on Acrylic / PVC", [null,null,null,500,5]],
    "PR-EMBOSS":           ["Embossed / Debossed Printing", [null,null,null,125,1.25], [null,null,null,100,1]],
    "PR-ENG-ACR-NAME":     ["Engraving / Etching on Acrylic (Just Name)", [null,null,null,300,3]],
    "PR-ENG-ACR-DESIGN":   ["Engraving / Etching on Acrylic (Any Design)", [null,null,null,500,5]],
    "PR-ENG-PAPER-NAME":   ["Engraving on Paper (Just Name)", [null,null,null,100,1]],
    "PR-ENG-PAPER-DESIGN": ["Engraving on Paper (Any Design)", [null,null,null,200,2]],
    "PR-GLITTER-INK":      ["Glitter Ink Printing", [null,null,null,200,2]],
    "PR-THERMO":           ["Thermography Printing", [null,null,null,125,1.25], [null,null,null,100,1]]
  }
};

if (typeof module !== "undefined" && module.exports) module.exports = ArabellaPricingRates;
