"use strict";

const { register } = require("./registry");

// Length conversions. Register both directions explicitly — the registry
// deliberately does not invert functions for you.
register("meters", "feet", (m) => m * 3.28084);
register("feet", "meters", (ft) => ft / 3.28084);
register("kilometers", "miles", (km) => km * 0.621371);
register("miles", "kilometers", (mi) => mi / 0.621371);
