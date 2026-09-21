/**
 * The words the box uses while it works — the status line in the chat and the
 * label at the mascot's thinking dots.
 *
 * One curated list, deliberately English in every locale: these are brand
 * whimsy in the tradition of Claude Code's own spinner ("Reticulating…",
 * "Combobulating…"), not information. Anything the user must actually
 * understand (the harness's real status events, error text) still arrives
 * through i18n; this list only ever decorates a spinner that speaks for
 * itself.
 *
 * Claude Code's vocabulary, plus the tide-pool register this crab lives in —
 * and "Clauding" naturally comes ashore as "Clawding".
 */
export const SPINNER_VERBS: readonly string[] = [
  "Accomplishing", "Actioning", "Actualizing", "Anchoring", "Architecting",
  "Baking", "Barnacling", "Beachcombing", "Beaming", "Beboppin'",
  "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing",
  "Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bubbling",
  "Burrowing", "Calculating", "Canoodling", "Caramelizing", "Cascading",
  "Catapulting", "Cerebrating", "Channelling", "Choreographing", "Churning",
  "Clacking", "Clawding", "Clawing", "Coalescing", "Cogitating",
  "Combobulating", "Composing", "Computing", "Concocting", "Considering",
  "Contemplating", "Cooking", "Crab-walking", "Crafting", "Creating",
  "Crunching", "Crystallizing", "Cultivating", "Current-surfing",
  "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
  "Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing",
  "Effecting", "Elucidating", "Embellishing", "Enchanting", "Envisioning",
  "Evaporating", "Fermenting", "Fiddle-faddling", "Finagling", "Flambéing",
  "Flibbertigibbeting", "Flowing", "Flummoxing", "Fluttering", "Forging",
  "Forming", "Frolicking", "Frosting", "Gallivanting", "Galloping",
  "Garnishing", "Generating", "Germinating", "Gitifying", "Grooving",
  "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding", "Hibernating",
  "Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining",
  "Improvising", "Incubating", "Inferring", "Infusing", "Ionizing",
  "Jitterbugging", "Julienning", "Kelp-wrangling", "Kneading", "Leavening",
  "Levitating", "Lollygagging", "Manifesting", "Marinating", "Meandering",
  "Metamorphosing", "Misting", "Molting", "Moonwalking", "Moseying",
  "Mulling", "Musing", "Mustering", "Nebulizing", "Nesting", "Noodling",
  "Nucleating", "Orbiting", "Orchestrating", "Osmosing", "Paddling",
  "Pearl-diving", "Perambulating", "Percolating", "Perusing",
  "Philosophising", "Photosynthesizing", "Pinching", "Pollinating",
  "Pondering", "Pontificating", "Pouncing", "Precipitating",
  "Prestidigitating", "Processing", "Proofing", "Propagating", "Puttering",
  "Puzzling", "Quantumizing", "Razzle-dazzling", "Razzmatazzing",
  "Recombobulating", "Reticulating", "Roosting", "Ruminating", "Sautéing",
  "Scampering", "Scheming", "Schlepping", "Scurrying", "Scuttling",
  "Seasoning", "Shellebrating", "Shell-polishing", "Shenaniganing",
  "Shimmying", "Sidling", "Simmering", "Skedaddling", "Sketching",
  "Skittering", "Slithering", "Smooshing", "Snapping", "Sock-hopping",
  "Spelunking", "Spinning", "Sprouting", "Stewing", "Sublimating",
  "Sussing", "Swirling", "Swooping", "Symbioting", "Synthesizing",
  "Tempering", "Thinking", "Thundering", "Tide-pooling", "Tinkering",
  "Tomfoolering", "Topsy-turvying", "Transfiguring", "Transmuting",
  "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing",
  "Waddling", "Wandering", "Warping", "Wave-riding", "Whatchamacalliting",
  "Whirlpooling", "Whirring", "Whisking", "Wibbling", "Working",
  "Wrangling", "Zesting", "Zigzagging",
] as const;

/**
 * One verb, avoiding an immediate repeat: the same word twice in a row reads
 * as a stuck UI, which is exactly what a spinner exists to disprove.
 */
export function pickSpinnerVerb(previous?: string | null): string {
  for (let i = 0; i < 4; i++) {
    const verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
    if (verb !== previous) return verb;
  }
  return SPINNER_VERBS[0];
}
