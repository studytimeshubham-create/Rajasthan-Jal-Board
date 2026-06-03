// Web Billing Engine (Rajasthan Water Tariff 2025 parity)

export function parseDate(str) {
  if (!str) return new Date();
  const parts = str.split("-");
  return new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]));
}

export function formatDate(dateObj) {
  if (!dateObj) return "";
  const d = String(dateObj.getDate()).padStart(2, "0");
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const y = dateObj.getFullYear();
  return `${d}-${m}-${y}`;
}

export function addMonths(date, months) {
  const d = new Date(date.getTime());
  const currentDay = d.getDate();
  d.setDate(1); // Set to 1st to prevent overflow
  d.setMonth(d.getMonth() + months);
  
  // Get last day of the target month
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(currentDay, lastDay));
  return d;
}

export function formatCurrency(amount) {
  const amt = amount || 0;
  return "₹" + amt.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatKL(value) {
  const val = value || 0;
  return val.toFixed(2) + " KL";
}

export function getSlabBreakdown(consumptionKL, category, meterSize, rates) {
  const slabDetails = [];
  let remaining = consumptionKL;
  let slabs = [];
  
  if (category === "Domestic") {
    slabs = [
      { name: "Slab 0-8 KL", limit: 8.0, rate: parseFloat(rates.domestic_slab_a_rate || 7.00) },
      { name: "Slab 8-15 KL", limit: 7.0, rate: parseFloat(rates.domestic_slab_b_rate || 9.00) },
      { name: "Slab 15-40 KL", limit: 25.0, rate: parseFloat(rates.domestic_slab_c_rate || 18.00) },
      { name: "Slab Above 40 KL", limit: Infinity, rate: parseFloat(rates.domestic_slab_d_rate || 22.00) }
    ];
  } else if (category === "Non-Domestic") {
    slabs = [
      { name: "Slab 0-15 KL", limit: 15.0, rate: parseFloat(rates.nondomestic_slab_a_rate || 40.00) },
      { name: "Slab 15-40 KL", limit: 25.0, rate: parseFloat(rates.nondomestic_slab_b_rate || 73.00) },
      { name: "Slab Above 40 KL", limit: Infinity, rate: parseFloat(rates.nondomestic_slab_c_rate || 97.00) }
    ];
  } else if (category === "Industrial") {
    slabs = [
      { name: "Slab 0-15 KL", limit: 15.0, rate: parseFloat(rates.industrial_slab_a_rate || 154.00) },
      { name: "Slab 15-40 KL", limit: 25.0, rate: parseFloat(rates.industrial_slab_b_rate || 198.00) },
      { name: "Slab Above 40 KL", limit: Infinity, rate: parseFloat(rates.industrial_slab_c_rate || 220.00) }
    ];
  } else {
    slabs = [{ name: "Slab All", limit: Infinity, rate: 10.00 }];
  }
  
  for (const s of slabs) {
    if (remaining <= 0) break;
    const chunk = Math.min(remaining, s.limit);
    const amount = chunk * s.rate;
    slabDetails.push({
      slab: s.name,
      kl: chunk,
      rate: s.rate,
      amount: Math.round(amount * 100) / 100
    });
    remaining -= chunk;
  }
  return slabDetails;
}

export function applyLPS(billTotal, lastPaymentDate, paymentDate, creditBalance, outstanding) {
  if (creditBalance >= billTotal) {
    return { lps_amount: 0.0, lps_type: "none", lps_applicable: false };
  }
  
  const lastPay = typeof lastPaymentDate === "string" ? parseDate(lastPaymentDate) : lastPaymentDate;
  const payD = typeof paymentDate === "string" ? parseDate(paymentDate) : paymentDate;
  
  if (payD <= lastPay) {
    return { lps_amount: 0.0, lps_type: "none", lps_applicable: false };
  }
  
  // Calculate limit 2 months after lastPay
  const limit2Months = addMonths(lastPay, 2);
  const lpsBase = billTotal;
  
  if (payD <= limit2Months) {
    const lpsAmount = Math.round(lpsBase * 0.10 * 100) / 100;
    return { lps_amount: lpsAmount, lps_type: "10pct", lps_applicable: true };
  } else {
    const lpsAmount10 = lpsBase * 0.10;
    const diffTime = Math.abs(payD - lastPay);
    const daysPastDue = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    const interest = outstanding * 0.18 * (daysPastDue / 365.0);
    const totalLPS = Math.round((lpsAmount10 + interest) * 100) / 100;
    return { lps_amount: totalLPS, lps_type: "10pct_plus_interest", lps_applicable: true };
  }
}

export default function calculateBill(
  consumptionKL,
  consumer,
  rates,
  previousOutstanding = 0,
  creditBalance = 0,
  lastPaymentDate = null,
  paymentDate = null,
  avg6MonthKL = null
) {
  const category = consumer.category || "Domestic";
  const meterSize = consumer.meter_size || "15mm";
  const status = consumer.consumer_status || "Active";
  const customAttrs = consumer.custom_attributes || {};
  const isFlatRateRural = String(customAttrs.is_flat_rate_rural || false).toLowerCase() === "true" || Boolean(consumer.is_flat_rate_rural);
  
  const isBulk = !["15mm", "20mm", "25mm"].includes(meterSize);
  
  let waterCharge = 0.0;
  let slabDetails = [];
  let minChargeApplied = false;
  let minChargeAmount = 0.0;
  
  const isDomestic15mmWaiver = (
    category === "Domestic" &&
    meterSize === "15mm" &&
    status === "Active" &&
    consumptionKL <= 15.0 &&
    !isFlatRateRural
  );
  const waterSupplyType = consumer.water_supply_type || "PHED";
  const isOwnSupply = waterSupplyType === "Own Supply";
  
  if (isOwnSupply) {
    waterCharge = 0.0;
    minChargeApplied = false;
    minChargeAmount = 0.0;
    slabDetails.push({
      slab: "Own Water Supply",
      kl: consumptionKL,
      rate: 0.0,
      amount: 0.0
    });
  } else if (isFlatRateRural && category === "Domestic" && meterSize === "15mm") {
    waterCharge = parseFloat(rates.domestic_flat_rural || 110.00);
    slabDetails.push({
      slab: "Flat Rate Rural",
      kl: consumptionKL,
      rate: waterCharge,
      amount: waterCharge
    });
  } else if (isDomestic15mmWaiver) {
    waterCharge = 0.0;
    slabDetails.push({
      slab: "Domestic Waiver (<=15 KL)",
      kl: consumptionKL,
      rate: 0.0,
      amount: 0.0
    });
  } else if (isBulk) {
    const catKey = `bulk_${category.toLowerCase().replace("-", "")}_rate`;
    let defaultRate = 25.0;
    if (category === "Non-Domestic") defaultRate = 97.0;
    if (category === "Industrial") defaultRate = 220.0;
    
    const bulkRate = parseFloat(rates[catKey] || defaultRate);
    waterCharge = consumptionKL * bulkRate;
    
    slabDetails.push({
      slab: `Bulk ${category}`,
      kl: consumptionKL,
      rate: bulkRate,
      amount: waterCharge
    });
    
    const catPrefix = category === "Domestic" ? "dom" : (category === "Non-Domestic" ? "nondom" : "ind");
    const minKey = `bulk_min_${catPrefix}_${meterSize}`;
    minChargeAmount = parseFloat(rates[minKey] || 0.0);
    if (waterCharge < minChargeAmount) {
      waterCharge = minChargeAmount;
      minChargeApplied = true;
    }
  } else {
    slabDetails = getSlabBreakdown(consumptionKL, category, meterSize, rates);
    waterCharge = slabDetails.reduce((sum, s) => sum + s.amount, 0);
    
    if (category === "Domestic") {
      if (consumptionKL > 15.0) {
        if (meterSize === "15mm") {
          const avgCheck = avg6MonthKL !== null ? avg6MonthKL : consumptionKL;
          minChargeAmount = parseFloat(rates[avgCheck <= 8.0 ? "domestic_min_15mm_avg_low" : "domestic_min_15mm_avg_high"] || (avgCheck <= 8 ? 88.00 : 220.00));
        } else if (meterSize === "20mm") {
          minChargeAmount = parseFloat(rates.domestic_min_20mm || 880.00);
        } else if (meterSize === "25mm") {
          minChargeAmount = parseFloat(rates.domestic_min_25mm || 2200.00);
        }
        
        if (waterCharge < minChargeAmount) {
          waterCharge = minChargeAmount;
          minChargeApplied = true;
        }
      }
    } else {
      const catPrefix = category === "Non-Domestic" ? "nondomestic" : "industrial";
      const minKey = `${catPrefix}_min_${meterSize}`;
      minChargeAmount = parseFloat(rates[minKey] || 0.0);
      if (waterCharge < minChargeAmount) {
        waterCharge = minChargeAmount;
        minChargeApplied = true;
      }
    }
  }
  
  // Fixed charges
  let fixedCharge = 0.0;
  if (isOwnSupply) {
    fixedCharge = 0.0;
  } else if (isFlatRateRural && category === "Domestic" && meterSize === "15mm") {
    fixedCharge = 0.0;
  } else if (isBulk) {
    const catPrefix = category === "Domestic" ? "dom" : (category === "Non-Domestic" ? "nondom" : "ind");
    const fixedKey = `bulk_fixed_${catPrefix}_${meterSize}`;
    fixedCharge = parseFloat(rates[fixedKey] || 0.0);
  } else {
    const fixedKey = `fixed_charge_${category.toLowerCase().replace("-", "")}`;
    fixedCharge = parseFloat(rates[fixedKey] || 0.0);
  }
  
  // Meter service charges
  let meterServiceCharge = 0.0;
  if (isOwnSupply) {
    meterServiceCharge = 0.0;
  } else if (isBulk) {
    const svcKey = `bulk_svc_${meterSize}`;
    meterServiceCharge = parseFloat(rates[svcKey] || 0.0);
  } else {
    const svcKey = `meter_svc_${meterSize}`;
    meterServiceCharge = parseFloat(rates[svcKey] || 0.0);
  }
  
  // Sewerage & STP
  let sewerageTax = 0.0;
  let stpCharge = 0.0;
  const hasSewerConnection = Boolean(consumer.has_sewer_connection);
  const subCategory = consumer.sewerage_sub_category || null;

  if (hasSewerConnection) {
    if (waterSupplyType === "PHED") {
      sewerageTax = Math.round(waterCharge * (parseFloat(rates.sewerage_phed_pct || 20.0) / 100.0) * 100) / 100;
      stpCharge = Math.round(waterCharge * (parseFloat(rates.sewerage_stp_pct || 13.0) / 100.0) * 100) / 100;
    } else {
      if (subCategory === "Hotel") {
        sewerageTax = Math.round(parseInt(consumer.num_rooms || 0) * parseFloat(rates.sewerage_own_hotel_per_room || 31.25) * 100) / 100;
      } else if (subCategory === "Restaurant") {
        sewerageTax = parseFloat(rates.sewerage_own_restaurant || 200.00);
      } else if (subCategory === "Cinema") {
        sewerageTax = parseFloat(rates.sewerage_own_cinema || 400.00);
      } else if (subCategory === "Car/Truck Service Station") {
        sewerageTax = parseFloat(rates.sewerage_own_car_truck_service || 200.00);
      } else if (subCategory === "Scooter Service Station") {
        sewerageTax = parseFloat(rates.sewerage_own_scooter_service || 62.50);
      } else if (subCategory === "Other Industrial/Commercial") {
        sewerageTax = parseFloat(rates.sewerage_own_other_industrial || 12.50);
      } else if (subCategory === "Domestic (Own Supply)") {
        const plot = parseFloat(consumer.plot_area_sqmtr || 0.0);
        const threshold = parseFloat(rates.sewerage_own_domestic_plot_threshold || 200.0);
        const base = parseFloat(rates.sewerage_own_domestic_base || 12.50);
        const per100 = parseFloat(rates.sewerage_own_domestic_per_100sqmtr || 6.25);
        sewerageTax = Math.round((plot <= threshold ? base : base + (plot / 100.0) * per100) * 100) / 100;
      }
    }
  }

  const subtotalPreIds = waterCharge + fixedCharge + meterServiceCharge + sewerageTax + stpCharge;

  let idsRatePct = 0.0;
  let idsCharge = 0.0;
  if (!isOwnSupply) {
    if (consumptionKL > 15.0 && consumptionKL <= 40.0) {
      idsRatePct = 25.0;
    } else if (consumptionKL > 40.0) {
      idsRatePct = 35.0;
    }
    idsCharge = Math.round((idsRatePct / 100.0) * subtotalPreIds * 100) / 100;
  }
  const subtotalBeforeLps = subtotalPreIds + idsCharge;
  
  // Credit balance logic
  let creditApplied = 0.0;
  let remainingCredit = 0.0;
  if (creditBalance > 0) {
    if (creditBalance >= subtotalBeforeLps) {
      creditApplied = subtotalBeforeLps;
      remainingCredit = creditBalance - subtotalBeforeLps;
    } else {
      creditApplied = creditBalance;
      remainingCredit = 0.0;
    }
  }
  
  const subtotalAfterCredit = subtotalBeforeLps - creditApplied;
  
  // LPS
  let lpsAmount = 0.0;
  let lpsType = "none";
  let lpsApplicable = false;
  if (lastPaymentDate && paymentDate && subtotalAfterCredit > 0) {
    const lpsRes = applyLPS(subtotalBeforeLps, lastPaymentDate, paymentDate, creditBalance, previousOutstanding);
    lpsAmount = lpsRes.lps_amount;
    lpsType = lpsRes.lps_type;
    lpsApplicable = lpsRes.lps_applicable;
  }
  
  const totalBeforeRounding = subtotalAfterCredit + previousOutstanding + lpsAmount;
  const totalAmount = Math.ceil(totalBeforeRounding);
  
  const isAnomaly = avg6MonthKL !== null && consumptionKL > (3 * avg6MonthKL);
  
  return {
    water_charge: waterCharge,
    slab_details: slabDetails,
    minimum_charge_applied: minChargeApplied,
    minimum_charge_amount: minChargeAmount,
    fixed_charge: fixedCharge,
    meter_service_charge: meterServiceCharge,
    sewerage_tax: sewerageTax,
    stp_charge: stpCharge,
    ids_charge: idsCharge,
    ids_rate_pct: idsRatePct,
    previous_outstanding: previousOutstanding,
    credit_applied: creditApplied,
    remaining_credit: remainingCredit,
    lps_amount: lpsAmount,
    lps_type: lpsType,
    lps_applicable: lpsApplicable,
    subtotal_before_lps: subtotalBeforeLps,
    total_before_rounding: totalBeforeRounding,
    total_amount: totalAmount,
    is_anomaly: isAnomaly,
    is_flat_rate_rural: isFlatRateRural,
    has_sewer_connection: hasSewerConnection,
    water_supply_type: waterSupplyType,
    sewerage_sub_category: subCategory
  };
}
