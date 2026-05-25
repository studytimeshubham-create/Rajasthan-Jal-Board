/**
 * billing-engine.js — JavaScript Billing Calculation Engine
 * ==========================================================
 * Rajasthan Jal Board (PHED) — identical logic to billing_engine.py.
 * ES6 modules. No external dependencies. All rates read from `rates` param.
 *
 * Rate keys expected in the `rates` object (2025 baseline values shown as comments):
 *   dom_slab_a_rate     7.00   dom_slab_b_rate    9.00
 *   dom_slab_c_rate    18.00   dom_slab_d_rate   22.00
 *   dom_min_15mm_low   88      dom_min_15mm_high 220
 *   dom_min_20mm      880      dom_min_25mm     2200
 *   dom_flat_rural    110
 *   nondom_slab_a_rate 40.00   nondom_slab_b_rate  73.00   nondom_slab_c_rate  97.00
 *   nondom_min_15mm   880      nondom_min_20mm    2200    nondom_min_25mm    3520
 *   ind_slab_a_rate   154.00   ind_slab_b_rate   198.00   ind_slab_c_rate   220.00
 *   ind_min_15mm     2200      ind_min_20mm      3960    ind_min_25mm      6160
 *   bulk_dom_rate      25.00   bulk_nondom_rate   97.00   bulk_ind_rate    220.00
 *   bulk_svc_40mm     220      bulk_svc_50mm     440    bulk_svc_80mm    550
 *   bulk_svc_100mm    660      bulk_svc_150mm    770
 *   bulk_min_dom_40mm 6600    ...  (similar for 50/80/100/150 × 3 categories)
 *   bulk_fixed_dom_40mm 55   ...  (similar for 50/80/100/150 × 3 categories)
 *   fixed_charge_dom  27.50   fixed_charge_nondom 55.00   fixed_charge_ind 110.00
 *   meter_svc_15mm    22.00   meter_svc_20mm      55.00   meter_svc_25mm  110.00
 *   ids_rate_mid       0.25   ids_rate_high        0.35
 *   lps_rate           0.10   lps_annual_interest  0.18
 */

const BULK_SIZES  = new Set(["40mm", "50mm", "80mm", "100mm", "150mm"]);
const SMALL_SIZES = new Set(["15mm", "20mm", "25mm"]);

// ─────────────────────────────────────────────────────────────────────────────
// FORMATTING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a number as Indian Rupees currency string.
 * @param {number} amount
 * @returns {string} e.g. "₹1,234.56"
 */
export function formatCurrency(amount) {
  const negative = amount < 0;
  amount = Math.abs(Number(amount));
  const rupees = Math.floor(amount);
  const paise  = Math.round((amount - rupees) * 100);

  let s = String(rupees);
  let formatted;
  if (s.length > 3) {
    const last3 = s.slice(-3);
    let rest = s.slice(0, -3);
    const parts = [];
    while (rest.length > 2) {
      parts.unshift(rest.slice(-2));
      rest = rest.slice(0, -2);
    }
    if (rest) parts.unshift(rest);
    formatted = parts.join(",") + "," + last3;
  } else {
    formatted = s;
  }
  const result = `₹${formatted}.${String(paise).padStart(2, "0")}`;
  return negative ? `-${result}` : result;
}

/**
 * Format a kiloliter value to two decimal places.
 * @param {number} value
 * @returns {string} e.g. "12.34 KL"
 */
export function formatKL(value) {
  return `${Number(value).toFixed(2)} KL`;
}

/**
 * Format a Date object as DD-MM-YYYY string.
 * @param {Date} dateObj
 * @returns {string} e.g. "15-06-2025"
 */
export function formatDate(dateObj) {
  if (!dateObj) return "";
  const d  = String(dateObj.getDate()).padStart(2, "0");
  const m  = String(dateObj.getMonth() + 1).padStart(2, "0");
  const y  = dateObj.getFullYear();
  return `${d}-${m}-${y}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN BILLING FUNCTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate the full itemised water bill for a consumer for one billing cycle.
 *
 * @param {number}   consumptionKL       Metered consumption in kiloliters.
 * @param {Object}   consumer            Consumer document object.
 *   @param {string}  consumer.category        "Domestic"|"Non-Domestic"|"Industrial"
 *   @param {string}  consumer.meter_size      e.g. "15mm", "40mm"
 *   @param {boolean} [consumer.is_rural_flat] Rural flat-rate flag (default false)
 *   @param {number}  [consumer.avg_6month_kl] 6-month average KL (for anomaly detection)
 * @param {Object}   rates               Rates object from charges_config/current.
 * @param {number}   [previousOutstanding=0]  Prior outstanding balance (₹).
 * @param {number}   [creditBalance=0]        Credit available (₹).
 * @param {Date}     [lastPaymentDate=null]   Due date for no-LPS payment.
 * @param {Date}     [paymentDate=null]       Actual payment date (null = today).
 *
 * @returns {Object} Full bill breakdown with keys:
 *   water_charge, slab_details, minimum_charge_applied, minimum_charge_amount,
 *   fixed_charge, meter_service_charge, ids_charge, ids_rate_pct,
 *   previous_outstanding, credit_applied, remaining_credit,
 *   lps_amount, lps_type, lps_applicable, subtotal_before_lps,
 *   total_before_rounding, total_amount, is_anomaly, is_flat_rate_rural
 */
export default function calculateBill(
  consumptionKL,
  consumer,
  rates,
  previousOutstanding = 0,
  creditBalance       = 0,
  lastPaymentDate     = null,
  paymentDate         = null,
) {
  const category     = consumer.category    || "Domestic";
  const meterSize    = consumer.meter_size  || "15mm";
  const isRuralFlat  = consumer.is_rural_flat || false;
  const avg6monthKL  = consumer.avg_6month_kl ?? null;

  const isBulk         = BULK_SIZES.has(meterSize);
  const isFlatRateRural = isRuralFlat && category === "Domestic" && meterSize === "15mm";

  // ── Anomaly detection ───────────────────────────────────────────────────────
  const isAnomaly = avg6monthKL != null && avg6monthKL > 0
    ? consumptionKL > 3 * avg6monthKL
    : false;

  // ── Water charge ────────────────────────────────────────────────────────────
  let waterCharge, slabDetails, minimumChargeApplied, minimumChargeAmount;

  if (isFlatRateRural) {
    const flatRate = Number(rates.dom_flat_rural ?? 110);
    waterCharge           = flatRate;
    slabDetails           = [{ slab: "Flat Rural", kl: consumptionKL, rate: flatRate, amount: flatRate }];
    minimumChargeApplied  = false;
    minimumChargeAmount   = 0;
  } else if (isBulk) {
    const { amount, slabs } = _calcBulkWater(consumptionKL, category, meterSize, rates);
    waterCharge             = amount;
    slabDetails             = slabs;
    minimumChargeAmount     = _getBulkMinimum(category, meterSize, rates);
    minimumChargeApplied    = waterCharge < minimumChargeAmount;
    if (minimumChargeApplied) waterCharge = minimumChargeAmount;
  } else {
    // Small meter (15–25mm)
    slabDetails = getSlabBreakdown(consumptionKL, category, meterSize, rates);
    waterCharge = slabDetails.reduce((sum, s) => sum + s.amount, 0);

    // Special exemption: Domestic 15mm functional meter, consumption ≤ 15 KL
    if (category === "Domestic" && meterSize === "15mm" && consumptionKL <= 15) {
      waterCharge          = 0;
      slabDetails          = [{ slab: "Exempt (Domestic 15mm ≤15 KL)", kl: consumptionKL, rate: 0, amount: 0 }];
      minimumChargeApplied = false;
      minimumChargeAmount  = 0;
    } else {
      minimumChargeAmount = _getSmallMinimum(consumptionKL, category, meterSize, avg6monthKL, rates);
      minimumChargeApplied = minimumChargeAmount > 0 && waterCharge < minimumChargeAmount;
      if (minimumChargeApplied) waterCharge = minimumChargeAmount;
    }
  }

  // ── Fixed charge (Capital Renovation) ──────────────────────────────────────
  let fixedCharge;
  if (isFlatRateRural) {
    fixedCharge = 0;
  } else if (isBulk) {
    fixedCharge = Number(rates[`bulk_fixed_${_catKey(category)}_${meterSize}`] ?? 0);
  } else {
    const key = { Domestic: "fixed_charge_dom", "Non-Domestic": "fixed_charge_nondom", Industrial: "fixed_charge_ind" }[category];
    fixedCharge = Number(rates[key] ?? 0);
  }

  // ── Meter Service Charge ────────────────────────────────────────────────────
  let meterServiceCharge;
  if (SMALL_SIZES.has(meterSize)) {
    const key = { "15mm": "meter_svc_15mm", "20mm": "meter_svc_20mm", "25mm": "meter_svc_25mm" }[meterSize];
    meterServiceCharge = Number(rates[key] ?? 0);
  } else if (isBulk) {
    meterServiceCharge = Number(rates[`bulk_svc_${meterSize}`] ?? 0);
  } else {
    meterServiceCharge = 0;
  }

  // ── Subtotal before IDS ─────────────────────────────────────────────────────
  const subtotalPreIds = waterCharge + fixedCharge + meterServiceCharge;

  // ── IDS ─────────────────────────────────────────────────────────────────────
  let idsRatePct = 0;
  if (consumptionKL > 40) {
    idsRatePct = Number(rates.ids_rate_high ?? 0.35);
  } else if (consumptionKL > 15) {
    idsRatePct = Number(rates.ids_rate_mid ?? 0.25);
  }
  const idsCharge = subtotalPreIds * idsRatePct;

  const subtotalBeforeLPS = subtotalPreIds + idsCharge;

  // ── Credit ──────────────────────────────────────────────────────────────────
  const creditApplied   = Math.min(Number(creditBalance), subtotalBeforeLPS);
  const remainingCredit = Number(creditBalance) - creditApplied;
  const balanceAfterCredit = subtotalBeforeLPS - creditApplied + Number(previousOutstanding);

  // ── LPS ─────────────────────────────────────────────────────────────────────
  const lpsInfo = applyLPS(subtotalBeforeLPS, lastPaymentDate, paymentDate, creditBalance, previousOutstanding, rates);

  const totalBeforeRounding = balanceAfterCredit + lpsInfo.lps_amount;
  const totalAmount         = Math.ceil(totalBeforeRounding);

  return {
    water_charge:           _r2(waterCharge),
    slab_details:           slabDetails,
    minimum_charge_applied: minimumChargeApplied,
    minimum_charge_amount:  _r2(isFlatRateRural ? 0 : minimumChargeAmount),
    fixed_charge:           _r2(fixedCharge),
    meter_service_charge:   _r2(meterServiceCharge),
    ids_charge:             _r2(idsCharge),
    ids_rate_pct:           idsRatePct,
    previous_outstanding:   _r2(Number(previousOutstanding)),
    credit_applied:         _r2(creditApplied),
    remaining_credit:       _r2(remainingCredit),
    lps_amount:             _r2(lpsInfo.lps_amount),
    lps_type:               lpsInfo.lps_type,
    lps_applicable:         lpsInfo.lps_applicable,
    subtotal_before_lps:    _r2(subtotalBeforeLPS),
    total_before_rounding:  _r2(totalBeforeRounding),
    total_amount:           totalAmount,
    is_anomaly:             isAnomaly,
    is_flat_rate_rural:     isFlatRateRural,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NAMED EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate itemised slab-wise water charge for 15–25mm meters.
 *
 * @param {number} consumptionKL
 * @param {string} category  "Domestic"|"Non-Domestic"|"Industrial"
 * @param {string} meterSize "15mm"|"20mm"|"25mm"
 * @param {Object} rates
 * @returns {Array<{slab:string, kl:number, rate:number, amount:number}>}
 */
export function getSlabBreakdown(consumptionKL, category, meterSize, rates) {
  let breakpoints;

  if (category === "Domestic") {
    breakpoints = [
      { label: "Slab A (0–8 KL)",   lower: 0,  upper: 8,    rate: Number(rates.dom_slab_a_rate   ?? 7)   },
      { label: "Slab B (8–15 KL)",  lower: 8,  upper: 15,   rate: Number(rates.dom_slab_b_rate   ?? 9)   },
      { label: "Slab C (15–40 KL)", lower: 15, upper: 40,   rate: Number(rates.dom_slab_c_rate   ?? 18)  },
      { label: "Slab D (>40 KL)",   lower: 40, upper: null, rate: Number(rates.dom_slab_d_rate   ?? 22)  },
    ];
  } else if (category === "Non-Domestic") {
    breakpoints = [
      { label: "Slab A (0–15 KL)",  lower: 0,  upper: 15,   rate: Number(rates.nondom_slab_a_rate ?? 40)  },
      { label: "Slab B (15–40 KL)", lower: 15, upper: 40,   rate: Number(rates.nondom_slab_b_rate ?? 73)  },
      { label: "Slab C (>40 KL)",   lower: 40, upper: null, rate: Number(rates.nondom_slab_c_rate ?? 97)  },
    ];
  } else if (category === "Industrial") {
    breakpoints = [
      { label: "Slab A (0–15 KL)",  lower: 0,  upper: 15,   rate: Number(rates.ind_slab_a_rate   ?? 154) },
      { label: "Slab B (15–40 KL)", lower: 15, upper: 40,   rate: Number(rates.ind_slab_b_rate   ?? 198) },
      { label: "Slab C (>40 KL)",   lower: 40, upper: null, rate: Number(rates.ind_slab_c_rate   ?? 220) },
    ];
  } else {
    return [];
  }

  const slabs = [];
  let remaining = consumptionKL;

  for (const { label, lower, upper, rate } of breakpoints) {
    if (remaining <= 0) break;
    const slabSize   = upper !== null ? upper - lower : Infinity;
    const klInSlab   = Math.min(remaining, slabSize);
    if (klInSlab > 0) {
      slabs.push({
        slab:   label,
        kl:     _r3(klInSlab),
        rate:   rate,
        amount: _r2(klInSlab * rate),
      });
    }
    remaining -= klInSlab;
  }
  return slabs;
}

/**
 * Calculate LPS (Late Payment Surcharge).
 *
 * @param {number}    billTotal         Total bill before LPS (₹).
 * @param {Date|null} lastPaymentDate   Due date (no LPS if paid on/before this).
 * @param {Date|null} paymentDate       Actual payment date (null = today).
 * @param {number}    creditBalance     Credit balance (₹); full coverage waives LPS.
 * @param {number}    outstanding       Prior outstanding balance for interest calc.
 * @param {Object}    [rates={}]        Rates object.
 * @returns {{ lps_amount: number, lps_type: string, lps_applicable: boolean }}
 */
export function applyLPS(billTotal, lastPaymentDate, paymentDate, creditBalance, outstanding, rates = {}) {
  const lpsRate        = Number(rates.lps_rate            ?? 0.10);
  const annualInterest = Number(rates.lps_annual_interest  ?? 0.18);

  // Credit covers full bill → no LPS
  if (Number(creditBalance) >= Number(billTotal)) {
    return { lps_amount: 0, lps_type: "none", lps_applicable: false };
  }

  if (!lastPaymentDate) {
    return { lps_amount: 0, lps_type: "none", lps_applicable: false };
  }

  const pdate = paymentDate ?? new Date();

  if (pdate <= lastPaymentDate) {
    return { lps_amount: 0, lps_type: "none", lps_applicable: false };
  }

  // Months overdue (approximate by month difference)
  const monthsOverdue =
    (pdate.getFullYear() - lastPaymentDate.getFullYear()) * 12 +
    (pdate.getMonth()    - lastPaymentDate.getMonth());

  if (monthsOverdue <= 2) {
    return {
      lps_amount:     _r2(billTotal * lpsRate),
      lps_type:       "10pct",
      lps_applicable: true,
    };
  } else {
    const lpsBase       = billTotal * lpsRate;
    const interestAmt   = Number(outstanding) * annualInterest * (monthsOverdue / 12);
    return {
      lps_amount:     _r2(lpsBase + interestAmt),
      lps_type:       "10pct_plus_interest",
      lps_applicable: true,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function _catKey(category) {
  return { Domestic: "dom", "Non-Domestic": "nondom", Industrial: "ind" }[category];
}

function _calcBulkWater(consumptionKL, category, meterSize, rates) {
  const rateKey = `bulk_${_catKey(category)}_rate`;
  const rate    = Number(rates[rateKey] ?? 0);
  const amount  = _r2(consumptionKL * rate);
  return {
    amount,
    slabs: [{ slab: `Bulk (${meterSize})`, kl: consumptionKL, rate, amount }],
  };
}

function _getBulkMinimum(category, meterSize, rates) {
  return Number(rates[`bulk_min_${_catKey(category)}_${meterSize}`] ?? 0);
}

function _getSmallMinimum(consumptionKL, category, meterSize, avg6monthKL, rates) {
  if (consumptionKL <= 15) return 0;

  if (category === "Domestic") {
    if (meterSize === "15mm") {
      const avg = avg6monthKL ?? consumptionKL;
      return avg <= 8
        ? Number(rates.dom_min_15mm_low  ?? 88)
        : Number(rates.dom_min_15mm_high ?? 220);
    }
    if (meterSize === "20mm") return Number(rates.dom_min_20mm ?? 880);
    if (meterSize === "25mm") return Number(rates.dom_min_25mm ?? 2200);
  } else if (category === "Non-Domestic") {
    const keyMap = { "15mm": "nondom_min_15mm", "20mm": "nondom_min_20mm", "25mm": "nondom_min_25mm" };
    return Number(rates[keyMap[meterSize]] ?? 0);
  } else if (category === "Industrial") {
    const keyMap = { "15mm": "ind_min_15mm", "20mm": "ind_min_20mm", "25mm": "ind_min_25mm" };
    return Number(rates[keyMap[meterSize]] ?? 0);
  }
  return 0;
}

/** Round to 2 decimal places */
function _r2(v) { return Math.round(v * 100) / 100; }
/** Round to 3 decimal places */
function _r3(v) { return Math.round(v * 1000) / 1000; }
