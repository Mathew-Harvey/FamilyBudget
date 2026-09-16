-- The household forecast has one explicit allowance for optional day to day
-- spending. Forecast, Today, Lasting, alerts and analysis all read this value.
insert into settings (key, value)
values ('forecast_discretionary_monthly', '0.00')
on conflict (key) do nothing;
