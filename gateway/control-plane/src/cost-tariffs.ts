import type { BillingRates } from "./task-billing";

export interface CostTariff {
  id: string;
  currency: "USD";
  source: "operator_supplied_estimate";
  rates: BillingRates;
  longRates: BillingRates | null;
  longThreshold: number | null;
  longInclusive: boolean;
  tiers: readonly string[];
  condition: string;
}
/** Decimal strings deliberately avoid binary floating point when importing prices.
 * The supplied Sonnet artifact 122.81600000003232 is normalized to 122.816. */
export function parseCostDecimal(value: string): number {
  if (!/^\d+(?:\.\d{1,6})?$/.test(value)) throw new Error("invalid_cost_decimal");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cost_overflow");
  return Number(amount);
}
type Row = readonly [string, string, string, string | null, string | null];
function rates([input, output, cached, write, writeHour]: Row): BillingRates {
  return { input: parseCostDecimal(input), output: parseCostDecimal(output), cached: parseCostDecimal(cached), write: write === null ? null : parseCostDecimal(write), writeHour: writeHour === null ? null : parseCostDecimal(writeHour) };
}
const rows: Array<[string, Row]> = [
  ["claude-fable-5", ["202", "1010", "20.907", "404", "404"]],
  ["claude-fable-5-1", ["202", "1010", "20.907", "404", "404"]],
  ["claude-fable-5-2", ["161.60", "808", "4.04", "202", "323.20"]],
  ["claude-haiku-5-5", ["2.02", "10.10", "0.202", "4.04", "4.04"]],
  ...["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5"].map((id): [string, Row] => [id, ["101", "505", "10.10", "202", "202"]]),
  ["claude-opus-5-5", ["80.80", "404", "4.04", "161.60", "161.60"]],
  ["claude-sonnet-4-6", ["60.60", "303", "6.06", "80.80", "122.816"]],
  ["claude-sonnet-5", ["50.50", "242.40", "5.252", "80.80", "116.352"]],
  ["claude-sonnet-5-5", ["40.40", "202", "4.04", "80.80", "80.80"]],
  ["deepseek-v4.1-flash", ["1", "4", "0.02", null, null]],
  ["glm-5.3", ["4", "14", "1", null, null]],
  ["glm-5.3-flash", ["0.4", "1.4", "0.115", null, null]],
  ["gpt-6.1-sol", ["2", "10", "0.1", "2.5", null]],
  ["gpt-6.1-terra", ["1", "5", "0.05", "1.25", null]],
  ["gpt-6-astra", ["10", "50", "1", "12", null]],
  ["gpt-6-luna", ["0.1", "0.5", "0.01", "0.125", null]],
  ["kimi-k3.1-pro", ["13", "68", "1.3", "13", "26"]],
  ["gpt-6-astra-ultrafast", ["60", "300", "6", "72", null]],
  ["gpt-6.1-sol-ultrafast", ["12", "60", "0.6", "15", null]],
];
export function getCostTariffs(): CostTariff[] {
  return rows.map(([id, row]) => {
    const luna = id === "gpt-6-luna", haiku = id === "claude-haiku-5-5";
    const forced = id.endsWith("-ultrafast");
    return { id, currency: "USD", source: "operator_supplied_estimate", rates: rates(row),
      longRates: luna ? rates(["0.2", "0.75", "0.02", "0.25", null]) : haiku ? rates(["10.10", "50.50", "1.01", "12.625", "20.20"]) : null,
      longThreshold: luna ? 272000 : haiku ? 100000 : null, longInclusive: luna,
      tiers: forced ? ["default", "ultrafast"] : id.startsWith("gpt-") ? luna ? ["default", "priority", "fast"] : ["default", "priority", "fast", "ultrafast"] : ["default"],
      condition: id === "deepseek-v4.1-flash" ? "Asia/Shanghai Mon-Fri [09:00,12:00),[14:00,18:00): all rates 2x; otherwise base" : luna ? "input >= 272000 uses long rates" : haiku ? "input > 100000 uses long rates" : forced ? "forced ultrafast; listed rates already 6x" : "all input lengths; unsupported service tiers rejected",
    };
  });
}
export function resolveCostTariff(id: string, tier: string, now: number): CostTariff | null {
  const tariff = getCostTariffs().find((item) => item.id === id);
  if (!tariff) return null;
  if (!tariff.tiers.includes(tier)) throw new Error("unsupported_service_tier");
  let factor = id.endsWith("-ultrafast") ? 1 : tier === "ultrafast" ? 6 : tier === "priority" || tier === "fast" ? 2 : 1;
  if (id === "deepseek-v4.1-flash") {
    const date = new Date(now + 8 * 3600_000);
    const day = date.getUTCDay(), hour = date.getUTCHours();
    if (day >= 1 && day <= 5 && (hour >= 9 && hour < 12 || hour >= 14 && hour < 18)) factor = 2;
  }
  const multiply = (r: BillingRates): BillingRates => ({ input: r.input * factor, output: r.output * factor, cached: r.cached * factor, write: r.write === null ? null : r.write * factor, writeHour: r.writeHour === null ? null : r.writeHour * factor });
  return { ...tariff, rates: multiply(tariff.rates), longRates: tariff.longRates && multiply(tariff.longRates) };
}
