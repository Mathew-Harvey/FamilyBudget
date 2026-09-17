-- "Nobody has chosen" and "zero" were the same row, and they are not the same
-- claim.
--
-- Migration 027 seeded the allowance at 0.00, so every household started out
-- forecast as spending nothing at all on anything it did not have to buy. On
-- this one that quietly took 3,825 a month out of the projection: Today
-- reported what goes out, the plan was built on it, alerts were sent about it,
-- and the figure described nobody. Absence now means "follow what it has
-- actually been", which is the household we can see, and the number someone
-- sets still wins over it.
--
-- Removed only where it is still exactly the seeded 0.00. Anyone who really did
-- mean zero says so again, once, on a page that now shows what the choice costs.
delete from settings
 where key = 'forecast_discretionary_monthly'
   and value = '0.00';
