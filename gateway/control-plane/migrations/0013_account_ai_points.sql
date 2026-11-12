-- Rename the account AI ledger's amounts from micro-USD to micro-points.
--
-- 0012 shipped first and has already been applied (local fixtures, and any
-- deployment that followed it), so it is immutable: this migration preserves
-- its exact schema history and moves the amounts to the product's own unit.
--
-- One point is 1,000,000 micro-points and a point is service credit, never a
-- currency and never the upstream's billed money. The numbers themselves do
-- not change: every stored value, index, trigger, CHECK, and reservation
-- already meant "one millionth of a point" under the old name. `RENAME COLUMN`
-- rewrites the table CHECK constraints and every trigger body that references
-- these columns, so the reservation/settlement invariants survive verbatim.
--
-- Rates in `account_ai_requests` (input_rate/cached_rate/output_rate) were
-- already unit-named rather than currency-named and stay as they are; only the
-- amount columns move. `account_ai_adjustments.amount_micro_usd` carries both
-- grants and settlements, so it becomes `amount_micro_points` for both kinds.
ALTER TABLE account_ai_balances RENAME COLUMN available_micro_usd TO available_micro_points;
ALTER TABLE account_ai_balances RENAME COLUMN reserved_micro_usd TO reserved_micro_points;
ALTER TABLE account_ai_requests RENAME COLUMN reserved_micro_usd TO reserved_micro_points;
ALTER TABLE account_ai_requests RENAME COLUMN charged_micro_usd TO charged_micro_points;
ALTER TABLE account_ai_adjustments RENAME COLUMN amount_micro_usd TO amount_micro_points;
