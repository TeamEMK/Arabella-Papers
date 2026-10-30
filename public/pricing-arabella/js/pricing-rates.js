/* Wedding stationery price estimate – rates from the July 2025 master price list */
// `window` in the browser, `globalThis` under Node - the rates are read on
// both sides so a quote can be checked where it is stored.
var ArabellaPricingRates = (typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this)).ArabellaPricingRates = {
 "version": "2025-07",
 "currency": "US$",
 "baseDiscount": 0,
 "brands": [
  [
   "ARA",
   "ARABELLA (ARB)"
  ]
 ],
 "components": {
  "INVITE": [
   "Invitation",
   [
    90,
    100,
    110,
    120,
    1.2
   ]
  ],
  "ENV-VF": [
   "Envelope (V flap)",
   [
    200,
    210,
    220,
    250,
    2.5
   ]
  ],
  "ENV-SF": [
   "Envelope (square flap)",
   [
    150,
    160,
    170,
    190,
    1.9
   ]
  ],
  "LIN-ENV-VF-PL": [
   "Printed liner (V flap)",
   [
    200,
    210,
    220,
    250,
    2.5
   ]
  ],
  "LIN-ENV-SF-PL": [
   "Printed liner (square flap)",
   [
    150,
    160,
    170,
    190,
    1.9
   ]
  ],
  "LIN-ENV-VF-PFL": [
   "Paper full liner (V flap)",
   [
    200,
    210,
    220,
    250,
    2.5
   ]
  ],
  "LIN-ENV-SF-PFL": [
   "Paper full liner (square flap)",
   [
    150,
    160,
    170,
    190,
    1.9
   ]
  ],
  "LIN-ENV-VF-PHL": [
   "Paper half liner (V flap)",
   [
    90,
    95,
    105,
    120,
    1.2
   ]
  ],
  "LIN-ENV-SF-PHL": [
   "Paper half liner (square flap)",
   [
    65,
    75,
    85,
    90,
    0.9
   ]
  ],
  "GNA": [
   "GNA",
   [
    null,
    null,
    null,
    null,
    1.5
   ]
  ],
  "RSVPC": [
   "RSVP card",
   [
    35,
    40,
    45,
    50,
    0.5
   ]
  ],
  "RSVP-ENV-VF": [
   "RSVP envelope (V flap)",
   [
    70,
    80,
    90,
    100,
    1
   ]
  ],
  "RSVP-ENV-SF": [
   "RSVP envelope (square flap)",
   [
    60,
    65,
    70,
    80,
    0.8
   ]
  ],
  "TY-FLATC": [
   "Thank you card (flat)",
   [
    35,
    40,
    45,
    50,
    0.5
   ]
  ],
  "TY-FOLDC": [
   "Thank you card (folded)",
   [
    50,
    55,
    60,
    65,
    0.65
   ]
  ],
  "TY-ENV-VF": [
   "Thank you envelope (V flap)",
   [
    70,
    80,
    90,
    100,
    1
   ]
  ],
  "TY-ENV-SF": [
   "Thank you envelope (square flap)",
   [
    60,
    65,
    70,
    80,
    0.8
   ]
  ],
  "ESC-ENV-VF": [
   "Escort envelope (V flap)",
   [
    70,
    80,
    90,
    100,
    1
   ]
  ],
  "ESC-ENV-SF": [
   "Escort envelope (square flap)",
   [
    60,
    65,
    70,
    80,
    0.8
   ]
  ],
  "FOL-SFF": [
   "Single fold folder",
   [
    200,
    210,
    230,
    250,
    2.5
   ]
  ],
  "FOL-POC": [
   "Pocket folder",
   [
    240,
    260,
    280,
    300,
    3
   ]
  ],
  "FOL-RIBPOC": [
   "Ribbon pocket folder",
   [
    290,
    310,
    330,
    350,
    3.5
   ]
  ],
  "DIRC": [
   "Direction card",
   [
    45,
    50,
    55,
    65,
    0.65
   ]
  ],
  "DETC": [
   "Details card",
   [
    45,
    50,
    55,
    65,
    0.65
   ]
  ],
  "RECC": [
   "Reception card",
   [
    45,
    50,
    55,
    65,
    0.65
   ]
  ],
  "STDC": [
   "Save the date card",
   [
    45,
    50,
    55,
    65,
    0.65
   ]
  ],
  "ACMC": [
   "Accommodation card",
   [
    45,
    50,
    55,
    65,
    0.65
   ]
  ],
  "BELLYB": [
   "Belly band",
   [
    35,
    40,
    45,
    50,
    0.5
   ]
  ],
  "TAGS": [
   "Tags",
   [
    null,
    null,
    null,
    35,
    0.35
   ]
  ],
  "RIBBON": [
   "Ribbon",
   [
    null,
    null,
    null,
    45,
    0.45
   ]
  ],
  "RHINEST": [
   "Rhinestone",
   [
    null,
    null,
    null,
    null,
    0.4
   ]
  ],
  "PL-FLATC": [
   "Place card (flat)",
   [
    35,
    40,
    45,
    50,
    0.5
   ]
  ],
  "PL-ENV-FLATC": [
   "Place card with envelope",
   [
    null,
    null,
    null,
    null,
    null
   ]
  ],
  "PL-TENT": [
   "Place card (tented)",
   [
    50,
    55,
    60,
    65,
    0.65
   ]
  ],
  "TNC": [
   "Table number card",
   [
    45,
    50,
    55,
    65,
    0.65
   ]
  ],
  "PR-FLATC": [
   "Program card (flat)",
   [
    90,
    100,
    110,
    120,
    1.2
   ]
  ],
  "PR-FOLDC": [
   "Program card (folded)",
   [
    200,
    210,
    230,
    250,
    2.5
   ]
  ],
  "MENUC": [
   "Menu card",
   [
    90,
    100,
    110,
    120,
    1.2
   ]
  ]
 },
 "addons": {
  "ADD-BELLY": [
   "Belly Band / Return Address Label",
   [
    35,
    40,
    45,
    50,
    0.5
   ]
  ],
  "ADD-BELLY-GLITTER": [
   "Glitter / PL / SP Series Paper Belly Band / Return Address Label",
   [
    70,
    80,
    90,
    100,
    1
   ]
  ],
  "ADD-TAG": [
   "Tag",
   [
    null,
    null,
    null,
    35,
    0.35
   ]
  ],
  "ADD-TAG-GLITTER": [
   "Glitter Paper / PL / SP Series as a Layer for the Tag",
   [
    null,
    null,
    null,
    70,
    0.7
   ]
  ],
  "ADD-RIB-025": [
   "Ribbon 0.25″",
   [
    null,
    null,
    null,
    45,
    0.45
   ]
  ],
  "ADD-RIB-050": [
   "Ribbon 0.50″",
   [
    null,
    null,
    null,
    45,
    0.45
   ]
  ],
  "ADD-RIB-1": [
   "Ribbon 1″",
   [
    null,
    null,
    null,
    100,
    1
   ]
  ],
  "ADD-RIB-15": [
   "Ribbon 1.5″",
   [
    null,
    null,
    null,
    150,
    1.5
   ]
  ],
  "ADD-RIB-2": [
   "Ribbon 2″",
   [
    null,
    null,
    null,
    200,
    2
   ]
  ],
  "ADD-RHINESTONE": [
   "Rhinestone / Pearls",
   [
    null,
    null,
    null,
    null,
    0.4
   ]
  ],
  "ADD-VELCRO": [
   "Velcro / Grommet",
   [
    null,
    null,
    null,
    null,
    0.5
   ]
  ],
  "ADD-POCKET-BACK": [
   "Pocket at the Back",
   [
    70,
    80,
    90,
    100,
    1
   ]
  ],
  "ADD-FLAP-PAPER": [
   "Paper on the Flap",
   [
    70,
    80,
    90,
    100,
    1
   ]
  ],
  "ADD-PERFORATION": [
   "Perforation",
   [
    null,
    null,
    null,
    50,
    0.5
   ]
  ],
  "ADD-SLEEVES": [
   "Plastic Sleeves",
   [
    null,
    null,
    null,
    null,
    0.5
   ]
  ],
  "ADD-LAMINATION": [
   "Lamination",
   [
    null,
    null,
    null,
    50,
    0.5
   ]
  ],
  "ADD-GLUE": [
   "Transparent Glue",
   [
    null,
    null,
    null,
    100,
    1
   ]
  ],
  "ADD-LASER-NAME": [
   "Laser Cut Name (Paper), per name",
   [
    null,
    null,
    null,
    null,
    1
   ]
  ],
  "ADD-LASER-SIDEWAYS": [
   "Laser Cut Name (Sideways), per name",
   [
    null,
    null,
    null,
    null,
    3
   ]
  ],
  "ADD-LASER-ACRYLIC": [
   "Laser Cut Acrylic, per name",
   [
    null,
    null,
    null,
    null,
    3
   ]
  ],
  "ADD-POUCHETTE": [
   "Pouchette",
   [
    200,
    210,
    230,
    250,
    2.5
   ]
  ],
  "ADD-LASER-DESIGN-6": [
   "Laser Cut Design (As per Design) at 6.00",
   [
    null,
    null,
    null,
    null,
    6
   ]
  ],
  "ADD-LASER-DESIGN-8": [
   "Laser Cut Design (As per Design) at 8.00",
   [
    null,
    null,
    null,
    null,
    8
   ]
  ],
  "ADD-TASSEL": [
   "Tassels / String",
   [
    null,
    null,
    null,
    null,
    1
   ]
  ],
  "ADD-BOX-20": [
   "Hinged Box (As per Design) at 20.00",
   [
    null,
    null,
    null,
    null,
    20
   ]
  ],
  "ADD-BOX-25": [
   "Hinged Box (As per Design) at 25.00",
   [
    null,
    null,
    null,
    null,
    25
   ]
  ]
 },
 "edges": {
  "EDGE-GILDED": [
   "Gilded Edges",
   [
    null,
    null,
    null,
    null,
    2
   ]
  ],
  "EDGE-PAINTED": [
   "Painted Edges",
   [
    null,
    null,
    null,
    null,
    0.5
   ]
  ],
  "EDGE-BEVELED": [
   "Beveled Edges",
   [
    null,
    null,
    null,
    null,
    2
   ]
  ],
  "EDGE-DECKLED": [
   "Deckled Edge",
   [
    null,
    null,
    null,
    null,
    2
   ]
  ],
  "EDGE-BEVELED-GILDED": [
   "Beveled Edges with Gilded Foil",
   [
    null,
    null,
    null,
    null,
    4
   ]
  ],
  "EDGE-WAX-SEAL": [
   "Wax Seal",
   [
    null,
    null,
    null,
    200,
    2
   ]
  ],
  "EDGE-BEVELED-PAINTED": [
   "Beveled with Painted Edges",
   [
    null,
    null,
    null,
    null,
    2.5
   ]
  ]
 },
 "printing": {
  "PR-BELL": [
   "Bell Press Printing",
   [
    null,
    null,
    null,
    60,
    0.6
   ]
  ],
  "PR-LP": [
   "Letterpress Printing",
   [
    null,
    null,
    null,
    200,
    2
   ]
  ],
  "PR-LP-ADDON": [
   "Letterpress Printing (Add-ons)",
   [
    null,
    null,
    null,
    100,
    1
   ]
  ],
  "PR-UV": [
   "UV Printing",
   [
    null,
    null,
    null,
    125,
    1.25
   ]
  ],
  "PR-UV-ACR": [
   "UV Printing on Acrylic / Mirror Acrylic / PVC / Suede",
   [
    null,
    null,
    null,
    250,
    2.5
   ]
  ],
  "PR-FOIL": [
   "Foil Printing",
   [
    null,
    null,
    null,
    125,
    1.25
   ]
  ],
  "PR-FOIL-ACR": [
   "Foil Printing on Acrylic / Mirror Acrylic / PVC",
   [
    null,
    null,
    null,
    300,
    3
   ]
  ],
  "PR-DIGITAL": [
   "Digital Printing",
   [
    25,
    50,
    75,
    100,
    1
   ]
  ],
  "PR-DIGITAL-ACR": [
   "Digital Printing on Acrylic / PVC",
   [
    null,
    null,
    null,
    500,
    5
   ]
  ],
  "PR-EMBOSS": [
   "Embossed / Debossed Printing",
   [
    null,
    null,
    null,
    125,
    1.25
   ]
  ],
  "PR-ENG-ACR-NAME": [
   "Engraving / Etching on Acrylic (Just Name)",
   [
    null,
    null,
    null,
    300,
    3
   ]
  ],
  "PR-ENG-ACR-DESIGN": [
   "Engraving / Etching on Acrylic (Any Design)",
   [
    null,
    null,
    null,
    500,
    5
   ]
  ],
  "PR-ENG-PAPER-NAME": [
   "Engraving on Paper (Just Name)",
   [
    null,
    null,
    null,
    100,
    1
   ]
  ],
  "PR-ENG-PAPER-DESIGN": [
   "Engraving on Paper (Any Design)",
   [
    null,
    null,
    null,
    200,
    2
   ]
  ],
  "PR-GLITTER-INK": [
   "Glitter Ink Printing",
   [
    null,
    null,
    null,
    200,
    2
   ]
  ],
  "PR-THERMO": [
   "Thermography Printing",
   [
    null,
    null,
    null,
    125,
    1.25
   ]
  ]
 }
};

if (typeof module !== "undefined" && module.exports) module.exports = ArabellaPricingRates;
