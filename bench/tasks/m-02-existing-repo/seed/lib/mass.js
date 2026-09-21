"use strict";

const { register } = require("./registry");

// Mass conversions, same shape as length.js.
register("kilograms", "pounds", (kg) => kg * 2.20462);
register("pounds", "kilograms", (lb) => lb / 2.20462);
register("grams", "ounces", (g) => g * 0.035274);
register("ounces", "grams", (oz) => oz / 0.035274);
