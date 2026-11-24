
"use strict";

// ============================================
// APPLICATION SETTINGS
// ============================================

const RECIPE_FILE = "./recipes.json";
let allRecipesPromise = null;

const DAYS = [
  "Monday", "Tuesday", "Wednesday",
  "Thursday", "Friday", "Saturday", "Sunday"
];

const PLAN_DAYS = 7;
const MAX_RECIPES = 60;
const RANDOM_RECIPES = 30;
const PACKAGE_PENALTY = 0.12;

let weeklyPlan = [];
let recipePool = [];
let preferredIngredients = [];
let isGenerating = false;

// Cache previously downloaded and processed data.
const recipeCache = new Map();
const ingredientCache = new WeakMap();
const nameCache = new WeakMap();
const suitabilityCache = new WeakMap();

const $ = id => document.getElementById(id);

// ============================================
// GENERAL HELPERS
// ============================================

function setStatus(message) {
  if ($("status")) {
    $("status").textContent = message;
  }
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function roundUp(value) {
  return Math.ceil(value - 1e-7);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removePhrases(value, phrases) {
  let text = String(value || "").toLowerCase();

  for (const phrase of [...phrases].sort(
    (a, b) => b.length - a.length
  )) {
    text = text.replace(
      new RegExp(
        `\\b${escapeRegex(phrase)}\\b`, "gi"
      ),
      " "
    );
  }

  return text.replace(/\s+/g, " ").trim();
}

// ============================================
// INGREDIENT NORMALIZATION
// ============================================

function normalizeIngredient(name) {
  const cleaned = removePhrases(
    String(name || "")
      .toLowerCase()
      .replace(/[_ ,]+/g, " "),
    PREPARATION
  );

  return ALIASES[cleaned] || cleaned;
}

function cleanMeasure(measure) {
  let text = String(measure || "")
    .toLowerCase()
    .trim();

  text = text.replace(/\bcut into\b.*$/i, "");

  return removePhrases(
    removePhrases(text, PREPARATION),
    VAGUE
  )
    .replace(/,/g, "")
    .trim();
}

// ============================================
// WATER EXCLUSION
// ============================================

function isCookingWater(name) {
  const words = normalizeIngredient(name)
    .replace(/-/g, " ")
    .split(/\s+/);

  return (
    words.at(-1) === "water" &&
    words.slice(0, -1).every(
      word => WATER_WORDS.has(word)
    )
  );
}

// ============================================
// RECIPE INGREDIENTS
// ============================================

function getIngredients(meal) {
  if (ingredientCache.has(meal)) return ingredientCache.get(meal);
  const items = (meal.ingredients || []).map(raw => {
    // Preserve the original ingredient text for the grocery list.
    // Quantity parsing is best-effort; ambiguous entries remain unspecified.
    const match = raw.match(/^((?:\d+(?:\.\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+\/\d+)(?:\s+(?:\d+\/\d+))?\s*(?:(?:cups?|tsp|tbsp|tablespoons?|teaspoons?|ounces?|oz|lbs?|pounds?|grams?|g|kg|ml|liters?|cloves?|cans?|packages?|slices?|pieces?)\b)?)/i);
    const measure = match ? match[1].trim() : "";
    let name = raw.slice(match ? match[0].length : 0).trim()
      .replace(/^\([^)]*\)\s*/, "")
      .replace(/^(?:of\s+)/i, "")
      .replace(/,.*$/, "")
      .replace(/\s*\([^)]*\)/g, "")
      .replace(/^(?:large|medium|small|fresh|dried|boneless|skinless|packed)\s+/i, "").trim();
    // For entries like '1 (15 ounce) can beans', retain the full text
    // rather than inventing a numerical quantity.
    if (!name || /^(?:can|package|cup|tablespoon|teaspoon)\s/i.test(name)) name = raw;
    return {name: normalizeIngredient(name), measure, original: raw};
  }).filter(x => x.name);
  ingredientCache.set(meal, items);
  return items;
}

function ingredientNames(meal) {
  if (!nameCache.has(meal)) {
    nameCache.set(
      meal,
      new Set(
        getIngredients(meal).map(item => item.name)
      )
    );
  }

  return nameCache.get(meal);
}

// ============================================
// BALANCED RECIPE FAMILIARITY
// ============================================

function scoreRecipeSuitability(meal) {
  if (suitabilityCache.has(meal)) {
    return suitabilityCache.get(meal);
  }

  const ingredients = [...ingredientNames(meal)]
    .filter(name => !isCookingWater(name));

  const common = ingredients.filter(
    name => COMMON_INGREDIENTS.has(name)
  ).length;

  const accessibility = ingredients.length
    ? common / ingredients.length
    : 0;

  const uncommon = ingredients.length - common;

  const title = String(meal.strMeal || "")
    .toLowerCase();

  const familiarity = Math.min(
    FAMILIAR_MEAL_KEYWORDS.filter(
      keyword => title.includes(keyword)
    ).length,
    2
  );

  const score =
    accessibility * RECIPE_WEIGHTS.accessibility +
    familiarity * RECIPE_WEIGHTS.familiarity -
    uncommon * RECIPE_WEIGHTS.uncommonIngredientPenalty * 0.2;

  suitabilityCache.set(meal, score);
  return score;
}

// ============================================
// LOCAL ALLRECIPES DATASET
// ============================================
async function loadRecipeDatabase() {
  if (!allRecipesPromise) {
    allRecipesPromise = fetch(RECIPE_FILE).then(response => {
      if (!response.ok) throw new Error("Cannot load recipes.json");
      return response.json();
    }).catch(error => { allRecipesPromise = null; throw error; });
  }
  return allRecipesPromise;
}

function recipeEligible(meal) {
  // Only likely complete lunch/dinner dishes; exclude components and unknowns.
  if (meal.category !== "main") return false;
  if (!meal.ingredients || meal.ingredients.length < 4 || meal.ingredients.length > 16) return false;
  if (meal.totalTime && meal.totalTime > 90) return false;
  return true;
}

async function buildRecipePool(ingredients, limit) {
  const all = await loadRecipeDatabase();
  const terms = ingredients.flatMap(term => RECIPE_SEARCH_TERMS[term] || [term]);
  const requested = terms.map(t => t.toLowerCase());
  const candidates = all.filter(recipeEligible).map(meal => {
    const title = meal.title.toLowerCase();
    const text = meal.ingredients.join(" ").toLowerCase();
    const hits = requested.filter(term => title.includes(term) || text.includes(term)).length;
    return {meal, hits, rank: hits * 6 + (meal.rating || 0) + Math.random() * 5 - meal.ingredients.length * 0.15};
  }).filter(x => !ingredients.length || x.hits > 0);
  candidates.sort((a,b) => b.rank-a.rank);
  return candidates.slice(0, Math.max(limit, 80)).map(x => ({
    ...x.meal,
    idMeal: x.meal.id,
    strMeal: x.meal.title,
    strCategory: x.meal.mealFamily
  }));
}

// ============================================
// WEEKLY OPTIMIZATION
// ============================================

function scorePlan(plan) {
  const counts = new Map();
  const categories = new Map();

  let preferenceScore = 0;
  let suitability = 0;

  for (const meal of plan) {
    suitability += scoreRecipeSuitability(meal);

    for (const name of ingredientNames(meal)) {
      if (isCookingWater(name)) continue;

      counts.set(
        name,
        (counts.get(name) || 0) + 1
      );

      if (preferredIngredients.some(
        preferred => name.includes(preferred)
      )) {
        preferenceScore++;
      }
    }

    const category =
      meal.strCategory || "Unknown";

    categories.set(
      category,
      (categories.get(category) || 0) + 1
    );
  }

  let reuse = 0;
  let repeatedCategories = 0;

  for (const count of counts.values()) {
    reuse += Math.max(0, count - 1);
  }

  for (const count of categories.values()) {
    repeatedCategories += Math.max(0, count - 1);
  }

  return (
    reuse * RECIPE_WEIGHTS.ingredientReuse +
    preferenceScore * RECIPE_WEIGHTS.userPreference -
    counts.size * RECIPE_WEIGHTS.ingredientVariety -
    repeatedCategories *
      RECIPE_WEIGHTS.categoryRepetition +
    suitability
  );
}

function optimizeWeek(pool, days = PLAN_DAYS) {
  if (pool.length < days) {
    throw new Error(
      "Not enough recipes found. Try different ingredients."
    );
  }

  let bestPlan = null;
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 12; attempt++) {
    const plan = shuffle([...pool]).slice(0, days);

    for (let iteration = 0; iteration < 4; iteration++) {
      let improved = false;

      for (let day = 0; day < days; day++) {
        const used = new Set(
          plan
            .filter((_, index) => index !== day)
            .map(meal => meal.idMeal)
        );

        let winner = plan[day];
        let winnerScore = scorePlan(plan);

        for (const candidate of pool) {
          if (used.has(candidate.idMeal)) continue;

          const trial = [...plan];
          trial[day] = candidate;

          const score = scorePlan(trial);

          if (score > winnerScore) {
            winner = candidate;
            winnerScore = score;
          }
        }

        if (winner.idMeal !== plan[day].idMeal) {
          plan[day] = winner;
          improved = true;
        }
      }

      if (!improved) break;
    }

    const score = scorePlan(plan);

    if (score > bestScore) {
      bestScore = score;
      bestPlan = [...plan];
    }
  }

  return bestPlan;
}

// ============================================
// MEASUREMENT PARSING
// ============================================

function parseNumber(value) {
  let text = String(value).trim();

  for (const [symbol, fraction] of
    Object.entries(FRACTIONS)) {
    text = text.replaceAll(
      symbol,
      ` ${fraction} `
    );
  }

  let total = 0;

  for (const part of text.trim().split(/\s+/)) {
    if (part.includes("/")) {
      const [a, b] = part.split("/").map(Number);

      if (!Number.isFinite(a) || !b) return NaN;

      total += a / b;
    } else {
      const number = Number(part);

      if (!Number.isFinite(number)) return NaN;

      total += number;
    }
  }

  return total;
}

function parseMeasurement(name, raw) {
  const text = cleanMeasure(raw)
    .replace(/^(a|an)\s+/, "1 ")
    .replace(/\s+/g, " ")
    .trim();

  const match = text.match(
    /^(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?\s*[¼½¾⅓⅔⅛⅜⅝⅞]|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:\.\d+)?)\s*(.*)$/
  );

  if (!match) return null;

  const amount = parseNumber(match[1]);

  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }

  const unit = match[2]
    .trim()
    .replace(/\.$/, "")
    .replace(
      /^(extra large|extra small|large|medium|small)\b\s*/,
      ""
    );

  if (!unit) {
    if (name === "garlic") {
      return {
        amount,
        type: "count",
        unit: "clove"
      };
    }

    if (COUNTABLE.has(name)) {
      return {
        amount,
        type: "count",
        unit: name === "bay leaves"
          ? "leaf"
          : "whole"
      };
    }

    return null;
  }

  if (UNITS[unit]) {
    return {
      amount: amount * UNITS[unit][1],
      type: UNITS[unit][0],
      unit: ""
    };
  }

  if (COUNT_UNITS[unit]) {
    return {
      amount,
      type: "count",
      unit: COUNT_UNITS[unit]
    };
  }

  return null;
}

// ============================================
// SHOPPING QUANTITY CONVERSIONS
// ============================================

function normalizeShoppingQuantity(name, parsed) {
  if (
    WHOLE_WEIGHTS[name] &&
    parsed.type === "weight"
  ) {
    return {
      amount: parsed.amount / WHOLE_WEIGHTS[name],
      type: "count",
      unit: "whole"
    };
  }

  if (
    WHOLE_WEIGHTS[name] &&
    CHOPPED_CUP_WEIGHTS[name] &&
    parsed.type === "volume"
  ) {
    return {
      amount:
        (parsed.amount / ML_PER_CUP) *
        CHOPPED_CUP_WEIGHTS[name] /
        WHOLE_WEIGHTS[name],
      type: "count",
      unit: "whole"
    };
  }

  if (
    CUP_WEIGHTS[name] &&
    parsed.type === "volume"
  ) {
    return {
      amount:
        (parsed.amount / ML_PER_CUP) *
        CUP_WEIGHTS[name],
      type: "weight",
      unit: ""
    };
  }

  if (
    LIQUID_DENSITIES[name] &&
    parsed.type === "weight"
  ) {
    return {
      amount:
        parsed.amount / LIQUID_DENSITIES[name],
      type: "volume",
      unit: ""
    };
  }

  return parsed;
}

// ============================================
// PACKAGE OPTIMIZATION
// ============================================

function recommendPackages(required, catalog) {
  if (!(required > 0)) return null;

  const sizes = [...catalog.packages].sort(
    (a, b) => a - b
  );

  const largest = sizes.at(-1);

  const baselineCount = Math.max(
    0,
    Math.floor(required / largest) - 1
  );

  const baseline = baselineCount * largest;
  const remainder = required - baseline;

  let best = null;

  function search(total, count, start) {
    if (total + 1e-6 >= remainder) {
      const score =
        (total - remainder) / required +
        PACKAGE_PENALTY *
        (baselineCount + count - 1);

      if (
        !best ||
        score < best.score - 1e-9 ||
        (
          Math.abs(score - best.score) < 1e-9 &&
          count < best.count
        )
      ) {
        best = {
          total: baseline + total,
          count: baselineCount + count,
          score
        };
      }

      return;
    }

    if (count >= 6) return;

    for (let i = start; i < sizes.length; i++) {
      search(
        total + sizes[i],
        count + 1,
        i
      );
    }
  }

  search(0, 0, 0);
  return best;
}

// ============================================
// GROCERY FORMATTING
// ============================================

function formatCookingNumber(value) {
  return String(roundUp(value));
}

function formatWeight(grams) {
  if (grams >= G_PER_LB) {
    return `${formatCookingNumber(grams / G_PER_LB)} lb`;
  }

  if (grams >= G_PER_OZ) {
    return `${formatCookingNumber(grams / G_PER_OZ)} oz`;
  }

  return `${formatCookingNumber(grams)} g`;
}

function formatVolume(ml) {
  if (ml < 3 * ML_PER_TSP) {
    return `${formatCookingNumber(ml / ML_PER_TSP)} tsp`;
  }

  if (ml < 4 * ML_PER_TBSP) {
    return `${formatCookingNumber(ml / ML_PER_TBSP)} tbsp`;
  }

  if (ml < 4 * ML_PER_CUP) {
    const amount = formatCookingNumber(
      ml / ML_PER_CUP
    );

    return `${amount} ${
      amount === "1" ? "cup" : "cups"
    }`;
  }

  return `${formatCookingNumber(ml / 946.353)} qt`;
}

function formatCount(amount, unit) {
  const rounded = roundUp(amount);

  if (unit === "whole") {
    return String(rounded);
  }

  const plurals = {
    clove: "cloves",
    bulb: "bulbs",
    head: "heads",
    leaf: "leaves",
    bunch: "bunches",
    can: "cans",
    tin: "tins",
    slice: "slices",
    piece: "pieces",
    packet: "packets",
    package: "packages"
  };

  const label = rounded === 1
    ? unit
    : (plurals[unit] || `${unit}s`);

  return `${rounded} ${label}`;
}

function formatQuantity(parsed) {
  if (parsed.type === "weight") {
    return formatWeight(parsed.amount);
  }

  if (parsed.type === "volume") {
    return formatVolume(parsed.amount);
  }

  if (parsed.type === "count") {
    return formatCount(parsed.amount, parsed.unit);
  }

  return "";
}

function formatPackageTotal(total, type) {
  if (type === "weight") {
    return formatWeight(total);
  }

  if (total >= 3785.41) {
    return `${formatCookingNumber(total / 3785.41)} gallons`;
  }

  if (total >= 946.353) {
    return `${formatCookingNumber(total / 946.353)} qt`;
  }

  if (total >= 473.176) {
    return `${formatCookingNumber(total / 473.176)} pints`;
  }

  return `${formatCookingNumber(total)} mL`;
}

// ============================================
// GROCERY LIST
// ============================================

function renderGroceryList() {
  const list = $("grocery-list");
  list.replaceChildren();

  const groceries = new Map();

  for (const meal of weeklyPlan) {
    for (const ingredient of getIngredients(meal)) {
      const name = ingredient.name;

      if (isCookingWater(name)) continue;

      if (!groceries.has(name)) {
        groceries.set(name, {
          quantities: [],
          unspecified: false
        });
      }

      const entry = groceries.get(name);

      const parsed = parseMeasurement(
        name,
        ingredient.measure
      );

      if (!parsed) {
        entry.unspecified = true;
        continue;
      }

      entry.quantities.push(
        normalizeShoppingQuantity(name, parsed)
      );
    }
  }

  const sorted = [...groceries.entries()].sort(
    (a, b) => a[0].localeCompare(b[0])
  );

  for (const [name, entry] of sorted) {
    const quantities = [];
    const catalog = PACKAGE_CATALOG[name];

    let required = 0;
    const remaining = [];

    for (const parsed of entry.quantities) {
      if (
        catalog &&
        parsed.type === catalog.type
      ) {
        required += parsed.amount;
      } else {
        remaining.push(parsed);
      }
    }

    if (catalog && required > 0) {
      const recommendation = recommendPackages(
        required,
        catalog
      );

      if (recommendation) {
        quantities.push(
          formatPackageTotal(
            recommendation.total,
            catalog.type
          )
        );
      }
    }

    const totals = new Map();

    for (const parsed of remaining) {
      const key =
        `${parsed.type}|${parsed.unit || ""}`;

      if (!totals.has(key)) {
        totals.set(key, {
          ...parsed,
          amount: 0
        });
      }

      totals.get(key).amount += parsed.amount;
    }

    for (const total of totals.values()) {
      quantities.push(formatQuantity(total));
    }

    const item = document.createElement("li");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";

    const label = document.createElement("span");

    const display = quantities
      .filter(Boolean)
      .join(" + ");

    label.textContent = display
      ? ` ${name}: ${display}`
      : ` ${name} (quantity unspecified)`;

    item.append(checkbox, label);
    list.appendChild(item);
  }
}

// ============================================
// GENERATE WEEK
// ============================================

// ============================================
// WEEKLY PLAN ANALYSIS
// ============================================

const RANDOM_COMPARISONS = 200;

// Count how often each ingredient appears
// across different recipes.
function calculateIngredientMetrics(plan) {
  const counts = new Map();

  for (const meal of plan) {
    for (const name of ingredientNames(meal)) {
      if (isCookingWater(name)) continue;

      counts.set(
        name,
        (counts.get(name) || 0) + 1
      );
    }
  }

  const unique = counts.size;

  const reused = [...counts.values()].filter(
    count => count >= 2
  ).length;

  return {
    unique,
    reused,
    reusePercentage: unique
      ? (reused / unique) * 100
      : 0
  };
}

// Estimate unused package quantities.
//
// Only ingredients with configured package
// sizes and compatible measurements count.
// This does not estimate spoilage or actual
// food waste.

function calculatePackageLeftovers(plan) {
  const requirements = new Map();

  for (const meal of plan) {
    for (const ingredient of getIngredients(meal)) {
      const name = ingredient.name;

      if (isCookingWater(name)) continue;

      const catalog = PACKAGE_CATALOG[name];
      if (!catalog) continue;

      const parsed = parseMeasurement(
        name,
        ingredient.measure
      );

      if (!parsed) continue;

      const normalized = normalizeShoppingQuantity(
        name,
        parsed
      );

      if (normalized.type !== catalog.type) {
        continue;
      }

      requirements.set(
        name,
        (requirements.get(name) || 0) +
          normalized.amount
      );
    }
  }

  let purchased = 0;
  let unused = 0;
  let measuredIngredients = 0;

  // Weight and volume must not be added together.
  // Calculate a separate ratio for each ingredient,
  // then average those ratios.

  for (const [name, required] of requirements) {
    const catalog = PACKAGE_CATALOG[name];

    const recommendation = recommendPackages(
      required,
      catalog
    );

    if (!recommendation || !recommendation.total) {
      continue;
    }

    const leftover = Math.max(
      0,
      recommendation.total - required
    );

    unused += leftover / recommendation.total;
    purchased += 1;
    measuredIngredients++;
  }

  return {
    percentage: purchased
      ? (unused / purchased) * 100
      : null,
    measuredIngredients
  };
}

// Generate a random seven-meal combination
// without changing the user's actual plan.
function createRandomPlan(pool, days) {
  return shuffle([...pool]).slice(0, days);
}

// Compare the selected plan with random plans
// from the same recipe pool.
function compareWithRandomPlans(
  plan,
  pool,
  samples = RANDOM_COMPARISONS
) {
  if (pool.length < plan.length || !plan.length) {
    return null;
  }

  let totalUnique = 0;
  let totalReuse = 0;

  for (let i = 0; i < samples; i++) {
    const randomPlan = createRandomPlan(
      pool,
      plan.length
    );

    const metrics = calculateIngredientMetrics(
      randomPlan
    );

    totalUnique += metrics.unique;
    totalReuse += metrics.reusePercentage;
  }

  return {
    averageUnique: totalUnique / samples,
    averageReuse: totalReuse / samples,
    samples
  };
}

// Display the results in the dashboard.
function renderPlanAnalysis() {
  const section = $("plan-analysis");

  if (!section || weeklyPlan.length === 0) {
    if (section) section.hidden = true;
    return;
  }

  const metrics = calculateIngredientMetrics(
    weeklyPlan
  );

  const leftovers = calculatePackageLeftovers(
    weeklyPlan
  );

  const comparison = compareWithRandomPlans(
    weeklyPlan,
    recipePool
  );

  $("reuse-percentage").textContent =
    `${Math.round(metrics.reusePercentage)}%`;

  $("unique-ingredients").textContent =
    metrics.unique;

  $("reused-ingredients").textContent =
    metrics.reused;

  $("package-leftovers").textContent =
    leftovers.percentage === null
      ? "N/A"
      : `${Math.round(leftovers.percentage)}%`;

  $("optimized-count").textContent =
    `${metrics.unique} ingredients`;

  if (comparison) {
    $("random-count").textContent =
      `${comparison.averageUnique.toFixed(1)} ingredients`;

    const difference =
      comparison.averageUnique - metrics.unique;

    const summary = $("comparison-summary");

    if (difference > 0) {
      summary.textContent =
        `Your plan uses approximately ` +
        `${difference.toFixed(1)} fewer distinct ` +
        `ingredients than the average of ` +
        `${comparison.samples} random plans.`;
    } else if (difference < 0) {
      summary.textContent =
        `Your plan uses approximately ` +
        `${Math.abs(difference).toFixed(1)} more ` +
        `distinct ingredients than the random average.`;
    } else {
      summary.textContent =
        "Your plan uses approximately the same " +
        "number of ingredients as random plans.";
    }
  } else {
    $("random-count").textContent = "N/A";

    $("comparison-summary").textContent =
      "Not enough recipes for comparison.";
  }

  section.hidden = false;
}

// Two-week planner: each recipe is cooked once per week and portioned for repeat meals.
let plans = [[], []];
let schedules = [[], []];
let mealStatuses = [Array(14).fill("pending"), Array(14).fill("pending")];
const TRACKING_KEY = "meal-planner-two-week-progress-v1";
let weekPools = [[], []];
let weekPurchases = [new Map(), new Map()];
let weekLeftovers = [new Map(), new Map()];
let unknownQuantities = new Set();
const SLOT_NAMES = ["Lunch", "Dinner"];

function requestedCounts(week) {
  return [...document.querySelectorAll(`#week-${week}-counts input`)]
    .map(el => Math.max(1, Math.min(14, Number(el.value) || 1)));
}
function setupCounts(week) {
  const count = Number($(`week-${week}-unique`).value);
  const host = $(`week-${week}-counts`);
  const previous = [...host.querySelectorAll('input')].map(x => x.value);
  host.replaceChildren();
  for (let i=0; i<count; i++) {
    const label = document.createElement('label');
    label.textContent = `Meal ${i+1} — times eaten: `;
    const input = document.createElement('input');
    input.type='number'; input.min='1'; input.max='14'; input.value=previous[i] || '2';
    input.addEventListener('input',updateCoverage);
    label.append(input); host.append(label);
  }
  updateCoverage();
}
function updateCoverage() {
  for(let w=1;w<=2;w++) {
    const count=requestedCounts(w).reduce((a,b)=>a+b,0);
    $(`week-${w}-coverage`).textContent = `${count} of 14 lunch/dinner slots covered; ${Math.max(0,14-count)} gaps${count>14?' (too many servings)':''}`;
  }
}
function scaledRequirements(meal, servings) {
  const factor=servings / meal.servings;
  return getIngredients(meal).filter(x=>!isCookingWater(x.name)).map(x=>{
    const parsed=parseMeasurement(x.name,x.measure);
    const quantity=parsed ? normalizeShoppingQuantity(x.name,parsed) : null;
    return {name:x.name,quantity:quantity?{...quantity,amount:quantity.amount*factor}:null};
  });
}
function keyFor(name,quantity) {return `${name}|${quantity.type}|${quantity.unit||''}`;}
function addRequirements(target,meal,servings) {
  for(const x of scaledRequirements(meal,servings)) {
    if(!x.quantity) {unknownQuantities.add(x.name);continue;}
    const key=keyFor(x.name,x.quantity);
    const existing=target.get(key);
    if(existing) existing.amount+=x.quantity.amount;
    else target.set(key,{...x.quantity,name:x.name});
  }
}
function buyForWeek(plan,inventory) {
  const required=new Map();
  for(const x of plan) addRequirements(required,x.meal,x.count);
  const purchases=new Map(); const remaining=new Map(inventory);
  for(const [key,need] of required) {
    const stock=remaining.get(key)?.amount||0;
    const shortage=Math.max(0,need.amount-stock);
    let purchased=shortage;
    const catalog=PACKAGE_CATALOG[need.name];
    if(shortage>0 && catalog && catalog.type===need.type) {
      const rec=recommendPackages(shortage,catalog);
      if(rec) purchased=rec.total;
    }
    if(purchased>0) purchases.set(key,{...need,amount:purchased});
    const leftover=stock+purchased-need.amount;
    if(leftover>0.00001) remaining.set(key,{...need,amount:leftover});
    else remaining.delete(key);
  }
  return {purchases,remaining};
}
function leftoverScore(meal, count,inventory) {
  let matched=0;
  for(const x of scaledRequirements(meal,count)) {
    if(!x.quantity) continue;
    const available=inventory.get(keyFor(x.name,x.quantity))?.amount||0;
    if(available>0) matched+=Math.min(available,x.quantity.amount)/Math.max(x.quantity.amount,0.0001);
  }
  return matched;
}
function selectWeek(pool,counts,inventory,usedIds=new Set()) {
  const selected=[];
  const used=new Set(usedIds);
  for(const count of counts) {
    const currentFamilies = new Set(selected.map(x => x.meal.mealFamily));
    const available = pool.filter(m => !used.has(m.idMeal));
    // Favor different meal families, falling back only if the pool is narrow.
    const diverse = available.filter(m => m.mealFamily !== 'other' && !currentFamilies.has(m.mealFamily));
    const options = diverse.length ? diverse : available;
    if(!options.length) throw Error('Not enough distinct recipes for your requested plan.');
    const ranked=options.map(meal=>({meal,score:scoreRecipeSuitability(meal)+
      leftoverScore(meal,count,inventory)*7 + Math.random()*4 -
      Math.max(0,meal.ingredients.length-9)*0.5}));
    ranked.sort((a,b)=>b.score-a.score);
    const meal=ranked[0].meal;
    selected.push({meal,count});used.add(meal.idMeal);
  }
  return selected;
}
// Suggested calendar only: users can freely choose when to eat each meal.
// A recipe can be scheduled up to its planned number of servings.
function makeSchedule(plan) {
  const slots = Array(14).fill(null);
  let cursor = 0;
  // Spread first cooking events across the week, then fill suggested repeats.
  for (let j = 0; j < plan.length && cursor < 14; j++) {
    slots[cursor] = j;
    cursor += Math.max(1, Math.floor(14 / Math.max(plan.length, 1)));
  }
  const remaining = plan.map((x,j) => x.count - slots.filter(v => v === j).length);
  for (let i = 0; i < 14; i++) {
    if (slots[i] !== null) continue;
    const choices = plan.map((_,j) => j).filter(j => remaining[j] > 0);
    if (!choices.length) break;
    const choice = choices.sort((a,b) => {
      const lastA = slots.lastIndexOf(a, i-1), lastB = slots.lastIndexOf(b, i-1);
      return (lastB >= 0 ? lastB : -100) - (lastA >= 0 ? lastA : -100);
    })[0];
    slots[i] = choice; remaining[choice]--;
  }
  return slots;
}
function assignedCount(week, recipeIndex, schedule = schedules[week], statuses = mealStatuses[week]) {
  return schedule.filter((value, index) => value === recipeIndex && statuses[index] !== 'skipped').length;
}
function saveProgress() {
  try {
    localStorage.setItem(TRACKING_KEY, JSON.stringify({
      plans: plans.map(week => week.map(x => ({id: x.meal.idMeal, count:x.count}))),
      schedules, mealStatuses
    }));
  } catch (error) { console.warn('Could not save meal progress', error); }
}
function updateCalendarSlot(week, index, value) {
  if (mealStatuses[week][index] === 'eaten') {
    setStatus('Uncheck Eaten before changing this slot.'); renderCalendar(); return;
  }
  const next = value === '' ? null : Number(value);
  const schedule = [...schedules[week]];
  schedule[index] = next;
  const statuses = [...mealStatuses[week]];
  statuses[index] = 'pending';
  const over = plans[week].some((x,j) =>
    schedule.filter((v,i) => v === j && statuses[i] !== 'skipped').length > x.count);
  if (over) {
    setStatus('All servings of that recipe are already allocated. Skip or move another serving first.');
    renderCalendar(); return;
  }
  schedules[week] = schedule;
  mealStatuses[week] = statuses;
  saveProgress(); renderCalendar();
  setStatus('Calendar updated. The shopping list is based on portions planned for cooking.');
}
function updateMealStatus(week,index, status) {
  if (schedules[week][index] === null) return;
  const previous = mealStatuses[week][index];
  if (previous === status) return;
  if (status !== 'skipped' && previous === 'skipped') {
    const j=schedules[week][index];
    if (assignedCount(week,j) >= plans[week][j].count) {
      setStatus('No available servings remain for this recipe. Move another allocation first.');
      renderCalendar(); return;
    }
  }
  mealStatuses[week][index] = status;
  saveProgress(); renderCalendar();
  setStatus(status === 'skipped' ? 'Meal skipped: its portion is still available to schedule elsewhere.' :
    status === 'eaten' ? 'Meal marked eaten. Remaining portions updated.' : 'Meal returned to pending.');
}
function renderCalendar() {
  const host = $('two-week-calendar'); host.replaceChildren();
  for (let w = 0; w < 2; w++) {
    const section = document.createElement('section');
    const title = document.createElement('h3'); title.textContent = `Week ${w+1}`; section.append(title);
    const intro = document.createElement('p');
    intro.textContent = 'Choose your meals and mark each one Eaten, Not yet, or Skipped. A skipped portion becomes available to assign elsewhere. Cooking and storage are suggestions.';
    section.append(intro);
    const table = document.createElement('table'); table.className = 'calendar-table';
    const header = document.createElement('tr');
    for (const name of ['Day','Lunch','Dinner']) { const th=document.createElement('th');th.textContent=name;header.append(th); }
    table.append(header);
    DAYS.forEach((day,d) => {
      const tr = document.createElement('tr'); const th=document.createElement('th');th.textContent=day;tr.append(th);
      for (let t=0;t<2;t++) {
        const i=d*2+t, td=document.createElement('td'), chosen=schedules[w][i], status=mealStatuses[w][i];
        const select=document.createElement('select'); select.setAttribute('aria-label',`${day} ${SLOT_NAMES[t]} week ${w+1}`);
        const blank=document.createElement('option');blank.value='';blank.textContent='Unplanned';select.append(blank);
        plans[w].forEach((entry,j)=>{const opt=document.createElement('option');opt.value=String(j);opt.textContent=entry.meal.strMeal;select.append(opt);});
        select.value=chosen === null ? '' : String(chosen);
        select.disabled=status==='eaten';
        select.addEventListener('change',()=>updateCalendarSlot(w,i,select.value));td.append(select);
        if (chosen !== null) {
          const first=schedules[w].findIndex((v,k)=>v===chosen && mealStatuses[w][k]!=='skipped')===i;
          const note=document.createElement('div');note.textContent=first?'Suggested cook / prepare':'Portion — refrigerate or freeze safely';td.append(note);
          const controls=document.createElement('div');controls.className='meal-tracking';
          const statusLabel=document.createElement('label');statusLabel.textContent='Status: ';
          const statusSelect=document.createElement('select');statusSelect.setAttribute('aria-label',`${day} ${SLOT_NAMES[t]} meal status`);
          [['pending','Not yet'],['eaten','Eaten ✓'],['skipped','Skipped / ate out']].forEach(([value,label])=>{
            const option=document.createElement('option');option.value=value;option.textContent=label;statusSelect.append(option);
          });
          statusSelect.value=status;
          statusSelect.addEventListener('change',()=>updateMealStatus(w,i,statusSelect.value));
          statusLabel.append(statusSelect);controls.append(statusLabel);td.append(controls);
          const link=document.createElement('a');link.href=plans[w][chosen].meal.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='View recipe';td.append(link);
          if(status==='skipped')td.classList.add('meal-skipped');
          if(status==='eaten')td.classList.add('meal-eaten');
        } else td.className='meal-gap';
        tr.append(td);
      } table.append(tr);
    });section.append(table);
    const eaten=mealStatuses[w].filter((x,i)=>x==='eaten'&&schedules[w][i]!==null).length;
    const skipped=mealStatuses[w].filter((x,i)=>x==='skipped'&&schedules[w][i]!==null).length;
    const assigned=schedules[w].filter((x,i)=>x!==null&&mealStatuses[w][i]!=='skipped').length;
    const remaining=plans[w].map((x,j)=>x.count-schedules[w].filter((v,i)=>v===j&&mealStatuses[w][i]==='eaten').length);
    const unallocated=plans[w].map((x,j)=>x.count-assignedCount(w,j));
    const summary=document.createElement('p');
    summary.textContent=`${eaten} eaten · ${remaining.reduce((a,b)=>a+b,0)} portions not eaten · ${skipped} skipped slots · ${14-assigned} open or skipped slots · ${unallocated.reduce((a,b)=>a+b,0)} servings available to schedule`;
    section.append(summary);
    const list=document.createElement('ul');list.className='remaining-servings';
    plans[w].forEach((x,j)=>{
      const li=document.createElement('li');li.textContent=`${x.meal.strMeal}: ${remaining[j]} not eaten (${unallocated[j]} available to schedule)`;list.append(li);
    });section.append(list);
    host.append(section);
  }
}
function renderShopping() {
  const host=$('grocery-list');host.replaceChildren();
  for(let w=0;w<2;w++) {
    const li=document.createElement('li');const heading=document.createElement('strong');heading.textContent=`Week ${w+1} purchases`;li.append(heading);
    const ul=document.createElement('ul');
    for(const item of [...weekPurchases[w].values()].sort((a,b)=>a.name.localeCompare(b.name))) {
      const line=document.createElement('li');line.textContent=`${item.name}: ${formatQuantity(item)}`;ul.append(line);
    }
    if(!ul.children.length){const line=document.createElement('li');line.textContent='No measured purchases needed';ul.append(line);}
    li.append(ul);host.append(li);
  }
  const note=document.createElement('li');note.textContent=`Quantity estimates exclude ${unknownQuantities.size} ingredients with missing or unrecognized measurements. Check original recipes before shopping.`;host.append(note);
}
async function generateTwoWeeks(random=false) {
  if(isGenerating)return;
  const counts=[requestedCounts(1),requestedCounts(2)];
  if(counts.some(c=>c.reduce((a,b)=>a+b,0)>14)){setStatus('Each week can cover at most 14 lunch/dinner slots.');return;}
  const requested=random?[]:$('ingredient-input').value.split(',').map(normalizeIngredient).filter(Boolean);
  if(!random && !requested.length){setStatus('Enter preferred ingredients or choose Random Two Weeks.');return;}
  isGenerating=true;$('find-recipes').disabled=true;$('random-week').disabled=true;
  setStatus('Generating Week 1, calculating purchases, then planning Week 2...');
  try {
    const pool=await buildRecipePool(requested,120);
    const valid=pool.filter(m=>Number.isInteger(m.servings)&&m.servings>0&&m.servings<=100);
    if(valid.length<counts[0].length+counts[1].length)throw Error('Not enough recipes with serving counts.');
    preferredIngredients=requested;unknownQuantities=new Set();
    plans[0]=selectWeek(valid,counts[0],new Map());
    const first=buyForWeek(plans[0],new Map());weekPurchases[0]=first.purchases;weekLeftovers[0]=first.remaining;
    plans[1]=selectWeek(valid,counts[1],first.remaining,new Set(plans[0].map(x=>x.meal.idMeal)));
    const second=buyForWeek(plans[1],first.remaining);weekPurchases[1]=second.purchases;weekLeftovers[1]=second.remaining;
    schedules=plans.map(makeSchedule);mealStatuses=[Array(14).fill("pending"),Array(14).fill("pending")];saveProgress();renderCalendar();renderShopping();
    $('plan-analysis').hidden=true;
    setStatus(`Two weeks ready. Week 1: ${plans[0].reduce((n,x)=>n+x.count,0)} meals; Week 2: ${plans[1].reduce((n,x)=>n+x.count,0)} meals. Grocery amounts are estimates.`);
  }catch(error){console.error(error);setStatus(error.message||'Unable to generate plan.');}
  finally{isGenerating=false;$('find-recipes').disabled=false;$('random-week').disabled=false;}
}
function resetTwoWeeks() {
  if(isGenerating)return;
  plans=[[],[]];schedules=[[],[]];mealStatuses=[Array(14).fill("pending"),Array(14).fill("pending")];
  try { localStorage.removeItem(TRACKING_KEY); } catch {}
  weekPurchases=[new Map(),new Map()];weekLeftovers=[new Map(),new Map()];
  $('ingredient-input').value='';$('two-week-calendar').replaceChildren();$('grocery-list').replaceChildren();
  $('plan-analysis').hidden=true;setStatus('Choose ingredients and generate your two-week plan.');
}
for(let w=1;w<=2;w++){$(`week-${w}-unique`).addEventListener('change',()=>setupCounts(w));setupCounts(w);}
$('find-recipes').addEventListener('click',()=>generateTwoWeeks(false));
$('random-week').addEventListener('click',()=>generateTwoWeeks(true));
$('reset-button').addEventListener('click',resetTwoWeeks);

// Restore a previously generated plan when the page reloads.
(async function restoreMealProgress() {
  try {
    const saved=JSON.parse(localStorage.getItem(TRACKING_KEY)||'null');
    if(!saved || !Array.isArray(saved.plans) || !Array.isArray(saved.schedules))return;
    const pool=await loadRecipeDatabase();
    const byId=new Map(pool.map(m=>[String(m.id),{...m,idMeal:m.id,strMeal:m.title,strCategory:m.category}]));
    const restored=saved.plans.map(week=>week.map(x=>({meal:byId.get(String(x.id)),count:x.count})));
    if(restored.length!==2 || restored.some(week=>week.some(x=>!x.meal)))return;
    plans=restored;
    schedules=saved.schedules.map(a=>a.slice(0,14));
    mealStatuses=(saved.mealStatuses||[]).map(a=>a.slice(0,14));
    if(mealStatuses.length!==2 || mealStatuses.some(a=>a.length!==14))mealStatuses=[Array(14).fill('pending'),Array(14).fill('pending')];
    unknownQuantities=new Set();
    const first=buyForWeek(plans[0],new Map());weekPurchases[0]=first.purchases;weekLeftovers[0]=first.remaining;
    const second=buyForWeek(plans[1],first.remaining);weekPurchases[1]=second.purchases;weekLeftovers[1]=second.remaining;
    renderCalendar();renderShopping();
    setStatus('Your saved meal schedule and eaten/skipped progress were restored.');
  } catch(error) { console.warn('Unable to restore saved meal plan',error); }
})();
